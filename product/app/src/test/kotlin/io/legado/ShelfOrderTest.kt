package io.legado

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import io.legado.data.Database
import io.legado.data.clearBookshelfOrder
import io.legado.data.listBookshelf
import io.legado.data.reorderBookshelf
import io.legado.data.saveBookshelf
import io.legado.model.BookIdentifier
import io.legado.model.BookshelfWriteRequest

/**
 * 书架自定义排序的落库（用户 2026-10-02：「批量管理功能在，长按书籍可移动能排顺序（自定义）」）。
 * 重点是 `sort_order` 必须**可空**：只给被拖到的那一列写位置，其余的书留在"没参与过"的状态，
 * 否则拖一本就把整架钉死在拖动那一刻的界面顺序上，之后再也排不动。
 */
class ShelfOrderTest {
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
        BookshelfWriteRequest(sourceId = "https://order-probe.example/", bookUrl = url, name = "探针书 $url", tocUrl = "$url/toc"),
        null,
    )

    private fun key(url: String) = BookIdentifier("https://order-probe.example/", url)

    @Test
    fun `新书的排序位是空的，不是 0 也不是跟着插入顺序排好的`() {
        val fixture = fixture("legado-order-null")
        try {
            addBook(fixture.database, "https://order-probe.example/1")
            addBook(fixture.database, "https://order-probe.example/2")
            assertTrue(fixture.database.listBookshelf().all { it.sortOrder == null })
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `只写点到的那几本，没被拖过的保持空`() {
        val fixture = fixture("legado-order-partial")
        try {
            listOf("1", "2", "3").forEach { addBook(fixture.database, "https://order-probe.example/$it") }
            val updated = fixture.database.reorderBookshelf(
                listOf(key("https://order-probe.example/3"), key("https://order-probe.example/1")),
            )
            assertEquals(2, updated)
            val byUrl = fixture.database.listBookshelf().associateBy { it.bookUrl }
            assertEquals(1, byUrl["https://order-probe.example/3"]?.sortOrder)
            assertEquals(2, byUrl["https://order-probe.example/1"]?.sortOrder)
            assertNull("没在这一列里的书不该被顺手钉位", byUrl["https://order-probe.example/2"]?.sortOrder)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `重复拖动覆盖同一批位置，不会累加出第二套顺序`() {
        val fixture = fixture("legado-order-again")
        try {
            listOf("1", "2").forEach { addBook(fixture.database, "https://order-probe.example/$it") }
            val urls = listOf("https://order-probe.example/1", "https://order-probe.example/2")
            fixture.database.reorderBookshelf(urls.map { key(it) })
            fixture.database.reorderBookshelf(urls.reversed().map { key(it) })
            val byUrl = fixture.database.listBookshelf().associateBy { it.bookUrl }
            assertEquals(1, byUrl["https://order-probe.example/2"]?.sortOrder)
            assertEquals(2, byUrl["https://order-probe.example/1"]?.sortOrder)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `清除自定义顺序回到从没拖过的状态`() {
        val fixture = fixture("legado-order-clear")
        try {
            listOf("1", "2").forEach { addBook(fixture.database, "https://order-probe.example/$it") }
            fixture.database.reorderBookshelf(listOf("1", "2").map { key("https://order-probe.example/$it") })
            assertEquals(2, fixture.database.clearBookshelfOrder())
            assertTrue(fixture.database.listBookshelf().all { it.sortOrder == null })
            // 再清一次不该把"0 行受影响"报成清掉了两本
            assertEquals(0, fixture.database.clearBookshelfOrder())
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `已经移架的书不会占位置，返回的写入条数要说真话`() {
        val fixture = fixture("legado-order-ghost")
        try {
            addBook(fixture.database, "https://order-probe.example/1")
            val stale = key("https://order-probe.example/gone")
            val updated = fixture.database.reorderBookshelf(listOf(stale, key("https://order-probe.example/1")))
            assertEquals(1, updated)
        } finally {
            fixture.close()
        }
    }
}
