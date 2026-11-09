package io.legado.data

import io.legado.cache.BookCacheService
import io.legado.cache.CoverCache
import io.legado.localbook.LocalBookParser
import io.legado.model.BookIdentifier
import io.legado.model.BookshelfWriteRequest
import io.legado.model.LocalBookUpload
import io.legado.rules.RuleRunner
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

/**
 * `BookshelfRepository` 的判据。
 *
 * 这些用例盯的是**从 `ShelfRoutes` 搬到 Repository 时最容易搬丢的东西**：
 * 批量操作到底按什么计数、`null` 分组是「移出」还是「不动」、本地书导入是不是真的
 * 与传输层解耦。搬动过程中这些语义一旦漂移，界面上只会显示「已删除 0 本书」这类
 * 说不出所以然的结果，不会报错。
 *
 * 不用 Ktor 的 multipart：`importLocalBooks` 的入参是 `LocalBookUpload`，
 * 就是为了让这条路径能在纯单测里跑。
 */
class BookshelfRepositoryTest {

    private class Fixture(
        val database: Database,
        val directory: Path,
        val cache: BookCacheService,
        val repository: BookshelfRepository,
    ) {
        fun close() {
            cache.stop()
            runCatching { database.close() }
            directory.toFile().deleteRecursively()
        }
    }

    private fun fixture(name: String): Fixture {
        val directory = Files.createTempDirectory(name)
        val database = Database(directory.resolve("legado.sqlite").toString())
        database.initialize()
        val coverCache = CoverCache(directory.resolve("covers"))
        // 没有 fetcher 的 RuleRunner：这些用例不碰真实网络，缓存任务一启动就失败并落进日志。
        val cache = BookCacheService(database, RuleRunner(), coverCache) {}
        val repository = BookshelfRepository(database, cache, coverCache, directory.resolve("books"))
        return Fixture(database, directory, cache, repository)
    }

    private fun addBook(database: Database, url: String, coverUrl: String? = null) = database.saveBookshelf(
        BookshelfWriteRequest(
            sourceId = SOURCE,
            bookUrl = url,
            name = "探针书 $url",
            tocUrl = "$url/toc",
            coverUrl = coverUrl,
        ),
        null,
    )

    // ==================== 批量删除 ====================

    @Test
    fun `批量删除按真删掉的算：没有封面的书不能被记成失败`() {
        val fixture = fixture("legado-repo-batch-delete")
        try {
            addBook(fixture.database, "$SOURCE/book/1")
            addBook(fixture.database, "$SOURCE/book/2")

            val result = fixture.repository.batchDeleteBooks(
                listOf(BookIdentifier(SOURCE, "$SOURCE/book/1"), BookIdentifier(SOURCE, "$SOURCE/book/2")),
            )

            // 外面套一层 write{autoCommit=false} 会让 commit 抛 database in auto-commit mode，
            // 整批被记成失败 —— 这条断言就是拦它的。
            assertNull("批量删除不该整批失败：${result.error}", result.error)
            assertEquals("两本都删掉了，deleted 就该是 2", 2, result.deleted)
            assertEquals(0, result.failed)
            assertTrue("书架该空了", fixture.database.listBookshelf().isEmpty())
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `批量删除里不存在的那本记进 failed，其余照删`() {
        val fixture = fixture("legado-repo-batch-delete-mixed")
        try {
            addBook(fixture.database, "$SOURCE/book/1")

            val result = fixture.repository.batchDeleteBooks(
                listOf(
                    BookIdentifier(SOURCE, "$SOURCE/book/1"),
                    BookIdentifier(SOURCE, "$SOURCE/book/ghost"),
                ),
            )

            assertNull("批量删除不该整批失败：${result.error}", result.error)
            assertEquals(1, result.deleted)
            assertEquals(1, result.failed)
            assertEquals(listOf(BookIdentifier(SOURCE, "$SOURCE/book/ghost")), result.failedBooks)
            assertEquals(2, result.total)
            assertTrue(fixture.database.listBookshelf().isEmpty())
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `批量删除空列表直接拒，不是静默返回 0`() {
        val fixture = fixture("legado-repo-batch-delete-empty")
        try {
            val error = runCatching { fixture.repository.batchDeleteBooks(emptyList()) }.exceptionOrNull()
            assertTrue("空列表应当抛 IllegalArgumentException", error is IllegalArgumentException)
        } finally {
            fixture.close()
        }
    }

    // ==================== 批量移动 / 标记 ====================

    @Test
    fun `批量移动传 null 等于移出所有分组，落到 0 号未分组`() {
        val fixture = fixture("legado-repo-batch-move")
        try {
            addBook(fixture.database, "$SOURCE/book/1")
            val group = fixture.database.createBookGroup("待读")
            fixture.database.assignBookGroup(SOURCE, "$SOURCE/book/1", group.id)

            val result = fixture.repository.batchMoveToGroup(
                listOf(BookIdentifier(SOURCE, "$SOURCE/book/1")),
                null,
            )

            assertNull("批量移动不该整批失败：${result.error}", result.error)
            assertEquals(1, result.moved)
            assertEquals(0, result.failed)
            val shelf = fixture.database.listBookshelf().single()
            assertEquals("null 是「移出」，不是「不动」", 0L, shelf.groupId)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `批量移动只动分组，书名和进度都还在`() {
        val fixture = fixture("legado-repo-batch-move-keeps")
        try {
            addBook(fixture.database, "$SOURCE/book/1")
            val group = fixture.database.createBookGroup("在追")

            fixture.repository.batchMoveToGroup(listOf(BookIdentifier(SOURCE, "$SOURCE/book/1")), group.id)

            val shelf = fixture.database.listBookshelf().single()
            assertEquals(group.id, shelf.groupId)
            assertEquals("探针书 $SOURCE/book/1", shelf.name)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `批量标记已读再取消，书还在架上`() {
        val fixture = fixture("legado-repo-batch-mark")
        try {
            addBook(fixture.database, "$SOURCE/book/1")
            val books = listOf(BookIdentifier(SOURCE, "$SOURCE/book/1"))

            val marked = fixture.repository.batchMarkAsRead(books, true)
            assertEquals(1, marked.marked)
            assertTrue(fixture.database.listBookshelf().single().completed)

            val unmarked = fixture.repository.batchMarkAsRead(books, false)
            assertEquals(1, unmarked.marked)
            assertFalse(fixture.database.listBookshelf().single().completed)
        } finally {
            fixture.close()
        }
    }

    // ==================== 本地书导入 ====================

    @Test
    fun `本地书导入吃的是文件名加字节，不依赖 multipart`() = runBlocking {
        val fixture = fixture("legado-repo-import-local")
        try {
            val txt = """
                第一章 起风
                正文一。
                第二章 落雨
                正文二。
            """.trimIndent().toByteArray(Charsets.UTF_8)

            val response = fixture.repository.importLocalBooks(
                listOf(LocalBookUpload("测试书.txt", txt)),
                tocRule = null,
            )

            assertEquals(1, response.imported)
            assertEquals(0, response.failed)
            assertEquals(1, response.results.size)

            val shelf = fixture.database.listBookshelf().single()
            assertEquals(LocalBookParser.LOC_BOOK_SOURCE_ID, shelf.sourceId)
            assertEquals(2, shelf.totalChapters)
            assertEquals("本地书要归到「本地」组", "本地", fixture.database.listBookGroups().single().name)

            // 原始文件落盘：换分章规则重切时还要读它，丢了就再也切不回来。
            val saved = Files.list(fixture.directory.resolve("books")).use { it.toList() }
            assertEquals(1, saved.size)
            assertTrue("落盘文件名要带原扩展名", saved.single().fileName.toString().endsWith(".txt"))
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `本地书导入里空字节的那一条直接跳过，不报错也不建书`() = runBlocking {
        val fixture = fixture("legado-repo-import-empty")
        try {
            val response = fixture.repository.importLocalBooks(
                listOf(LocalBookUpload("空文件.txt", ByteArray(0))),
                tocRule = null,
            )

            assertEquals(0, response.imported)
            assertEquals(0, response.failed)
            assertTrue(fixture.database.listBookshelf().isEmpty())
        } finally {
            fixture.close()
        }
    }

    // ==================== 分组 / 单本 ====================

    @Test
    fun `分组名空或超长在 Repository 层就拒，不落到库里`() {
        val fixture = fixture("legado-repo-group-validate")
        try {
            assertTrue(runCatching { fixture.repository.createGroup("   ") }.isFailure)
            assertTrue(runCatching { fixture.repository.createGroup("名".repeat(25)) }.isFailure)
            assertEquals(0, fixture.repository.listGroups().size)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `移动到不存在的分组回 null，书留在原处`() {
        val fixture = fixture("legado-repo-move-missing-group")
        try {
            addBook(fixture.database, "$SOURCE/book/1")
            val group = fixture.database.createBookGroup("原来那组")
            fixture.database.assignBookGroup(SOURCE, "$SOURCE/book/1", group.id)

            assertNull(fixture.repository.moveBookToGroup(SOURCE, "$SOURCE/book/1", 9999L))
            assertEquals(group.id, fixture.database.listBookshelf().single().groupId)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `单本删除会连带清掉进度与笔记，不是只删书架那一行`() {
        val fixture = fixture("legado-repo-remove-one")
        try {
            addBook(fixture.database, "$SOURCE/book/1")
            fixture.database.saveProgress(
                io.legado.model.ReadingProgress(
                    sourceId = SOURCE,
                    bookUrl = "$SOURCE/book/1",
                    chapterUrl = "$SOURCE/book/1/c1",
                    chapterIndex = 0,
                    scrollPosition = 0.5,
                ),
            )
            assertNotNull(fixture.database.getProgress(SOURCE, "$SOURCE/book/1"))

            assertTrue(fixture.repository.removeBook(SOURCE, "$SOURCE/book/1"))

            assertTrue(fixture.database.listBookshelf().isEmpty())
            assertNull(fixture.database.getProgress(SOURCE, "$SOURCE/book/1"))
        } finally {
            fixture.close()
        }
    }

    private companion object {
        const val SOURCE = "https://repo-probe.example/"
    }
}
