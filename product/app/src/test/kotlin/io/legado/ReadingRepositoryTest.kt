package io.legado

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import io.legado.data.Database
import io.legado.data.cacheBookContent
import io.legado.data.saveTocCache
import io.legado.model.BookNoteWrite
import io.legado.model.Chapter
import io.legado.model.ChapterContent
import io.legado.model.ReadingLogRequest
import io.legado.model.ReadingProgress
import io.legado.reading.ReadingRepository

/**
 * P1-T4 阅读域模块：`ReadingRepository` 只是把 `io.legado.data.*` 的 DAO 扩展函数组合 / 暴露成
 * 域方法（不重复 SQL）。本测试用内存 sqlite 验证 Repository 正确把读写转发到 DAO：
 * 进度、笔记、阅读记录都经 Repository 落盘并能读回。
 */
class ReadingRepositoryTest {

    /** 复制自 `LogicalPositionTest` 的私有助手写法：开一个临时 sqlite 文件当内存库。 */
    private fun temporaryDatabase(): String =
        Files.createTempFile("legado-reading-repo-test", ".sqlite").toString()

    private fun repo(path: String): ReadingRepository =
        ReadingRepository(Database(path).also { it.initialize() })

    @Test
    fun `saveProgress via repository then getProgress round-trips`() {
        val path = temporaryDatabase()
        var repository: ReadingRepository? = null
        try {
            repository = repo(path)
            repository.saveProgress(
                ReadingProgress(
                    sourceId = "src",
                    bookUrl = "book",
                    chapterUrl = "ch",
                    chapterIndex = 3,
                    scrollPosition = 0.5,
                    charOffset = 999,
                    paragraphAnchor = "p-1",
                    positionVersion = 1,
                    positionChecksum = "cs",
                    updatedAt = 1L,
                ),
            )
            val p = repository.getProgress("src", "book")
            assertEquals(999, p?.charOffset)
            assertEquals("p-1", p?.paragraphAnchor)
            assertEquals(0.5, p?.scrollPosition)
        } finally {
            repository?.close()
            Files.deleteIfExists(java.nio.file.Path.of(path))
        }
    }

    @Test
    fun `getProgress returns null when nothing saved`() {
        val path = temporaryDatabase()
        var repository: ReadingRepository? = null
        try {
            repository = repo(path)
            assertNull(repository.getProgress("x", "y"))
        } finally {
            repository?.close()
            Files.deleteIfExists(java.nio.file.Path.of(path))
        }
    }

    @Test
    fun `addNote then listNotes and deleteNote forwards through repository`() {
        val path = temporaryDatabase()
        var repository: ReadingRepository? = null
        try {
            repository = repo(path)
            repository.addNote(
                BookNoteWrite(
                    sourceId = "src",
                    bookUrl = "book",
                    bookName = "书名",
                    chapterUrl = "ch",
                    chapterIndex = 1,
                    startOffset = 0,
                    endOffset = 5,
                    excerpt = "hello",
                    note = "想法",
                    paragraphAnchor = "p-2",
                    positionVersion = 1,
                    positionChecksum = "cs2",
                ),
            )
            val notes = repository.listNotes("src", "book")
            assertEquals(1, notes.size)
            assertEquals("hello", notes[0].excerpt)
            assertEquals("p-2", notes[0].paragraphAnchor)
            // 删除经 Repository 转发到底层 DAO
            assertTrue(repository.deleteNote(notes[0].id))
            assertEquals(0, repository.listNotes("src", "book").size)
        } finally {
            repository?.close()
            Files.deleteIfExists(java.nio.file.Path.of(path))
        }
    }

    @Test
    fun `addReadingLog then listReadingLog forwards through repository`() {
        val path = temporaryDatabase()
        var repository: ReadingRepository? = null
        try {
            repository = repo(path)
            repository.addReadingLog(
                ReadingLogRequest(
                    sourceId = "src",
                    bookUrl = "book",
                    bookName = "书名",
                    chapterIndex = 2,
                    seconds = 120,
                ),
            )
            val log = repository.listReadingLog(30)
            assertEquals(1, log.size)
            assertEquals(120, log[0].seconds)
        } finally {
            repository?.close()
            Files.deleteIfExists(java.nio.file.Path.of(path))
        }
    }

    @Test
    fun `searchBookContent forwards and returns empty when no cached content`() {
        val path = temporaryDatabase()
        var repository: ReadingRepository? = null
        try {
            repository = repo(path)
            // 没有缓存章节正文，应返回空列表而不抛异常（转发到底层 DAO）
            val hits = repository.searchBookContent("src", "book", "关键词")
            assertTrue(hits.isEmpty())
        } finally {
            repository?.close()
            Files.deleteIfExists(java.nio.file.Path.of(path))
        }
    }

    /**
     * 有缓存正文时，命中必须带上**它属于哪一章**。
     *
     * 这条判据是补出来的：原先只有上面那条"空库返回空"，而 `searchBookContent` 的 SQL 里
     * select 了 `book_content_cache.chapter_index` —— 那张表压根没有这一列。
     * 空库查不到行，SQL 就从不报错，测试也就一直绿；真缓存了正文才炸 `no such column`。
     * 所以这里必须**真的缓存一章**再搜，否则等于没测。
     */
    @Test
    fun `searchBookContent returns cached hits with the chapter number they belong to`() {
        val path = temporaryDatabase()
        val database = Database(path).also { it.initialize() }
        try {
            val repository = ReadingRepository(database)
            // 目录三条，正文只缓存第二章 —— 前端靠命中里的章号跳章，章号错了就跳错地方。
            database.saveTocCache(
                "src",
                "book",
                listOf(
                    Chapter(0, "第一章", "ch0"),
                    Chapter(1, "第二章", "ch1"),
                    Chapter(2, "第三章", "ch2"),
                ),
            )
            // 不传章号：读正文时顺手缓存这条路径手里只有 URL，章号得从目录里查。
            database.cacheBookContent(
                "src",
                "book",
                "ch1",
                ChapterContent(title = "第二章", content = "这一章里有 关键词 出现"),
            )

            val hits = repository.searchBookContent("src", "book", "关键词")
            assertEquals(1, hits.size)
            assertEquals(1, hits[0].chapterIndex)
            assertEquals("第二章", hits[0].title)
            assertTrue("命中片段应带上下文：${hits[0].snippet}", hits[0].snippet.contains("关键词"))
        } finally {
            database.close()
            Files.deleteIfExists(java.nio.file.Path.of(path))
        }
    }

    /** 五章目录 + 只缓存第二、三章；窗口的 `cached` 必须逐章如实。 */
    private fun windowFixture(): Pair<Database, String> {
        val path = temporaryDatabase()
        val database = Database(path).also { it.initialize() }
        database.saveTocCache(
            "src",
            "book",
            (0..4).map { Chapter(it, "第${it + 1}章", "ch$it") },
        )
        database.cacheBookContent("src", "book", "ch1", ChapterContent(title = "第2章", content = "正文二"))
        database.cacheBookContent("src", "book", "ch2", ChapterContent(title = "第3章", content = "正文三"))
        return database to path
    }

    @Test
    fun `chapterWindow returns the chapters around the current one with their cached flags`() {
        val (database, path) = windowFixture()
        try {
            val window = ReadingRepository(database).chapterWindow("src", "book", 2)
            assertEquals("默认前后各一章：1/2/3", listOf(1, 2, 3), window.map { it.chapterIndex })
            // 缓存的正是第 2、3 章（ch1/ch2），所以窗口里 1/2 已缓存、3 没有。
            assertEquals(listOf(true, true, false), window.map { it.cached })
            assertEquals(listOf("第2章", "第3章", "第4章"), window.map { it.title })
        } finally {
            database.close()
            Files.deleteIfExists(java.nio.file.Path.of(path))
        }
    }

    @Test
    fun `chapterWindow clamps at both ends instead of wrapping around`() {
        val (database, path) = windowFixture()
        try {
            val repository = ReadingRepository(database)
            assertEquals("第一章没有「前一章」，不该绕到书尾", listOf(0, 1), repository.chapterWindow("src", "book", 0).map { it.chapterIndex })
            assertEquals("最后一章同理", listOf(3, 4), repository.chapterWindow("src", "book", 4).map { it.chapterIndex })
        } finally {
            database.close()
            Files.deleteIfExists(java.nio.file.Path.of(path))
        }
    }

    @Test
    fun `chapterWindow honours the before and after sizes`() {
        val (database, path) = windowFixture()
        try {
            val window = ReadingRepository(database).chapterWindow("src", "book", 2, before = 2, after = 0)
            assertEquals(listOf(0, 1, 2), window.map { it.chapterIndex })
        } finally {
            database.close()
            Files.deleteIfExists(java.nio.file.Path.of(path))
        }
    }

    @Test
    fun `chapterWindow returns empty when the book has no toc or the arguments are nonsense`() {
        val path = temporaryDatabase()
        val database = Database(path).also { it.initialize() }
        try {
            val repository = ReadingRepository(database)
            assertTrue("没有目录缓存就不该编章节出来", repository.chapterWindow("src", "no-toc", 0).isEmpty())
            database.saveTocCache("src", "book", (0..2).map { Chapter(it, "第${it + 1}章", "ch$it") })
            assertTrue("负章号是无效输入", repository.chapterWindow("src", "book", -1).isEmpty())
            assertTrue("负窗口宽度是无效输入", repository.chapterWindow("src", "book", 1, before = -1).isEmpty())
            assertTrue("窗口落在目录之外（这本书只有 0..2）", repository.chapterWindow("src", "book", 99).isEmpty())
        } finally {
            database.close()
            Files.deleteIfExists(java.nio.file.Path.of(path))
        }
    }
}
