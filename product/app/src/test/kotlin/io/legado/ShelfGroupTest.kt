package io.legado

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import io.legado.cache.CoverCache
import io.legado.data.Database
import io.legado.data.assignBookGroup
import io.legado.data.coverContentType
import io.legado.data.createBookGroup
import io.legado.data.deleteBookGroup
import io.legado.data.importLocalBook
import io.legado.data.listBookGroups
import io.legado.data.listBookshelf
import io.legado.data.saveBookshelf
import io.legado.data.saveTocCache
import io.legado.localbook.ParsedBook
import io.legado.localbook.ParsedChapter
import io.legado.model.BookshelfWriteRequest
import io.legado.model.Chapter

/**
 * 书架分组与「回收我们生成的假封面」。字段口径照上游 `data/entities/BookGroup.kt`
 * （主键 groupId、groupName、order），但不照抄它那批负数虚拟组：
 * 虚拟组和真组混在一个列表里，界面就分不清哪条能改名删除。
 */
class ShelfGroupTest {
    private class Fixture(val database: Database, val directory: java.nio.file.Path) {
        fun close() {
            database.close()
            directory.toFile().deleteRecursively()
        }
    }

    private fun fixture(name: String): Fixture {
        val directory = Files.createTempDirectory(name)
        val database = Database(directory.resolve("legado.sqlite").toString())
        database.initialize()
        return Fixture(database, directory)
    }

    private fun addBook(database: Database, url: String) = database.saveBookshelf(
        BookshelfWriteRequest(sourceId = "https://group-probe.example/", bookUrl = url, name = "探针书 $url", tocUrl = "$url/toc"),
        null,
    )

    @Test
    fun `建组按名字找已有的一条，不会堆出第二个同名组`() {
        val fixture = fixture("legado-group-named")
        try {
            val first = fixture.database.createBookGroup("追更中")
            val again = fixture.database.createBookGroup("  追更中  ")
            assertEquals(first.id, again.id)
            // 大小写不算两个名字（与上游 SQLite 的 NOCASE 习惯一致）
            assertEquals(first.id, fixture.database.createBookGroup("追更中".uppercase()).id)
            assertEquals(1, fixture.database.listBookGroups().size)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `分组名要能上界面：空名和超长名直接拒`() {
        val fixture = fixture("legado-group-invalid")
        try {
            assertTrue(runCatching { fixture.database.createBookGroup("   ") }.isFailure)
            assertTrue(runCatching { fixture.database.createBookGroup("名".repeat(25)) }.isFailure)
            assertEquals(0, fixture.database.listBookGroups().size)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `移动分组改的是书架行，删组把书退回未分组而不是连书一起删`() {
        val fixture = fixture("legado-group-assign")
        try {
            addBook(fixture.database, "https://group-probe.example/book/1")
            addBook(fixture.database, "https://group-probe.example/book/2")
            val group = fixture.database.createBookGroup("待读")

            val moved = fixture.database.assignBookGroup("https://group-probe.example/", "https://group-probe.example/book/1", group.id)
            assertEquals(group.id, moved?.groupId)
            assertEquals(0L, fixture.database.listBookshelf().first { it.bookUrl.endsWith("/book/2") }.groupId)
            assertEquals(1, fixture.database.listBookGroups().first { it.id == group.id }.bookCount)

            // 不存在的组必须拒：否则界面上一个手滑就把书挂到空气上
            assertNull(fixture.database.assignBookGroup("https://group-probe.example/", "https://group-probe.example/book/1", 9999L))
            assertEquals(group.id, fixture.database.listBookshelf().first { it.bookUrl.endsWith("/book/1") }.groupId)

            assertTrue(fixture.database.deleteBookGroup(group.id))
            assertFalse(fixture.database.deleteBookGroup(group.id))
            // 0 是「未分组」这一档，不是一条组记录，删它必须失败而不是把全架打散
            assertFalse(fixture.database.deleteBookGroup(0L))
            val shelf = fixture.database.listBookshelf()
            assertEquals(2, shelf.size)
            assertTrue(shelf.all { it.groupId == 0L })
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `只回收我们画的那张假封面，EPUB 自带的真封面不动`() {
        val fixture = fixture("legado-cover-purge")
        try {
            val cache = CoverCache(fixture.directory.resolve("covers"))
            // 我们旧版生成器的形状：SVG + 那个写死的天空蓝角标色
            val generated = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 420"><g fill="#38bdf8"><text>本地</text></g></svg>"""
                .toByteArray(Charsets.UTF_8)
            val real = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte())

            val fakeKey = cache.saveCoverBytes(generated, "image/svg+xml")
            val realKey = cache.saveCoverBytes(real, "image/jpeg")
            // 落库路径与真服务一致：cover_cache 里的 content_type 是 importLocalBook 按
            // ParsedBook.coverContentType 登记的，不填它这两条断言查不到候选，测试会假绿
            fixture.database.importLocalBook(
                "fake1",
                ParsedBook(title = "假封面书", coverBytes = generated, coverContentType = "image/svg+xml", chapters = listOf(ParsedChapter("正文", "内容"))),
                fakeKey,
            )
            fixture.database.importLocalBook(
                "real1",
                ParsedBook(title = "真封面书", coverBytes = real, coverContentType = "image/jpeg", chapters = listOf(ParsedChapter("正文", "内容"))),
                realKey,
            )

            val purged = cache.purgeGeneratedLocalCovers(fixture.database)

            assertEquals(1, purged)
            assertNull(cache.file(fakeKey))
            assertNull(fixture.database.coverContentType(fakeKey))
            assertNull(fixture.database.listBookshelf().first { it.name == "假封面书" }.coverKey)
            // 反向对照：真封面必须原样还在，否则这条断言只是"全都删了"的伪装
            assertTrue(Files.exists(cache.file(realKey)!!))
            assertEquals(realKey, fixture.database.listBookshelf().first { it.name == "真封面书" }.coverKey)
            assertEquals(0, cache.purgeGeneratedLocalCovers(fixture.database))
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `书架更新时间：没抓过目录是 0，刷过 TOC 后有真实时间`() {
        val fixture = fixture("legado-shelf-toc-updated")
        try {
            val sourceId = "https://group-probe.example/"
            val bookUrl = "https://group-probe.example/book/9"
            val tocUrl = "$bookUrl/toc"
            fixture.database.saveBookshelf(
                BookshelfWriteRequest(sourceId = sourceId, bookUrl = bookUrl, name = "目录时间探针", tocUrl = tocUrl),
                null,
            )

            // 还没有 book_toc_cache 行 → 0；前端据此不显示「更新」行，杜绝 1970-01-01。
            assertEquals(0L, fixture.database.listBookshelf().first { it.bookUrl == bookUrl }.tocUpdatedAt)

            val before = System.currentTimeMillis()
            fixture.database.saveTocCache(sourceId, tocUrl, listOf(Chapter(index = 0, title = "第一章", url = "$bookUrl/1")))
            val after = System.currentTimeMillis()

            // 命中 SHELF_SELECT 里 toc_url = s.toc_url 那一支。
            val refreshed = fixture.database.listBookshelf().first { it.bookUrl == bookUrl }.tocUpdatedAt
            assertTrue("更新时间应落在写入区间内：$refreshed not in $before..$after", refreshed in before..after)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `本地书导入即写目录缓存，书架读出正的更新时间`() {
        val fixture = fixture("legado-shelf-local-toc-updated")
        try {
            fixture.database.importLocalBook(
                "toc1",
                ParsedBook(title = "带目录时间的本地书", coverBytes = null, coverContentType = null, chapters = listOf(ParsedChapter("正文", "内容"))),
                null,
            )
            val item = fixture.database.listBookshelf().first { it.name == "带目录时间的本地书" }
            // importLocalBook 用 toc_url 与 book_url 两个键各写一遍 book_toc_cache，二者都 > 0。
            assertTrue("本地书目录刷新时间应为正：${item.tocUpdatedAt}", item.tocUpdatedAt > 0L)
        } finally {
            fixture.close()
        }
    }
}
