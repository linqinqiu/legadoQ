package io.legado

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import io.legado.data.Database
import io.legado.data.clearSourceOrder
import io.legado.data.listSources
import io.legado.data.reorderSources
import io.legado.data.saveSource
import io.legado.source.SourceCodec

/**
 * 书源自定义排序（用户 2026-10-02：「自定义书源排序，优化书源编辑功能」）。
 *
 * 与书架那条同一套纪律：`source.sort_order` **可空**，只给拖到的那一列编号。
 * 全库 5,574 个源如果被一次拖动全编号，"按名称"这个默认顺序就再也回不去了 ——
 * 所以没参与过的必须保持 null，并且排在有序段之后、彼此仍按名称。
 */
class SourceOrderTest {
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

    private fun addSource(database: Database, url: String, bookSourceName: String) {
        val json = """{"bookSourceName":"$bookSourceName","bookSourceUrl":"$url","searchUrl":"/s/{{key}}"}"""
        database.saveSource(SourceCodec.parse(json), null)
    }

    @Test
    fun `没拖过的书源全是空位，列表仍按名称排`() {
        val fixture = fixture("legado-source-order-null")
        try {
            listOf("https://b.test/", "https://a.test/", "https://c.test/").forEach { addSource(fixture.database, it, "源 $it") }
            val names = fixture.database.listSources(null).map { it.url }
            assertEquals(listOf("https://a.test/", "https://b.test/", "https://c.test/"), names)
            assertTrue(fixture.database.listSources(null).all { it.sortOrder == null })
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `只给点到的那几个编号，其余的按名称跟在有序段后面`() {
        val fixture = fixture("legado-source-order-partial")
        try {
            listOf("https://a.test/", "https://b.test/", "https://c.test/", "https://d.test/")
                .forEach { addSource(fixture.database, it, "源 $it") }
            val written = fixture.database.reorderSources(listOf("https://d.test/", "https://a.test/"))
            assertEquals(2, written)
            val list = fixture.database.listSources(null)
            assertEquals(listOf("https://d.test/", "https://a.test/", "https://b.test/", "https://c.test/"), list.map { it.url })
            assertEquals(listOf(1, 2), list.map { it.sortOrder }.take(2))
            assertNull("没在这一列里的源不该被顺手钉位", list.first { it.url == "https://b.test/" }.sortOrder)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `筛选后的列表也守同一个顺序，不会一搜就退回按名称`() {
        val fixture = fixture("legado-source-order-query")
        try {
            listOf("https://alpha.test/", "https://beta.test/", "https://gamma.test/")
                .forEach { addSource(fixture.database, it, "源 $it") }
            fixture.database.reorderSources(listOf("https://gamma.test/", "https://alpha.test/"))
            val filtered = fixture.database.listSources("alpha").map { it.url }
            assertEquals(listOf("https://alpha.test/"), filtered)
            assertEquals(1, fixture.database.listSources(null).first { it.url == "https://gamma.test/" }.sortOrder)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `不存在的 id 不占位置，清除之后回到按名称`() {
        val fixture = fixture("legado-source-order-clear")
        try {
            listOf("https://a.test/", "https://b.test/").forEach { addSource(fixture.database, it, "源 $it") }
            assertEquals(1, fixture.database.reorderSources(listOf("https://ghost.test/", "https://b.test/")))
            assertEquals(1, fixture.database.clearSourceOrder())
            assertEquals(listOf("https://a.test/", "https://b.test/"), fixture.database.listSources(null).map { it.url })
            assertEquals("再清一次要说真话：0 行受影响", 0, fixture.database.clearSourceOrder())
        } finally {
            fixture.close()
        }
    }
}
