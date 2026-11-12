package io.legado

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.nio.file.Files
import io.legado.data.Database
import io.legado.data.batchRemoveBookshelf
import io.legado.data.getProgress
import io.legado.data.importLibrary
import io.legado.data.listBookshelf
import io.legado.data.removeBookshelf
import io.legado.data.saveBookshelf
import io.legado.model.BackupShelfEntry
import io.legado.model.BookIdentifier
import io.legado.model.BookshelfWriteRequest

/**
 * 复现「导入本地备份后，明明删掉的书又回到书架」。
 *
 * 口径：备份导入 = 合并，但**合并不能盖掉用户已经做过的删除决定**。
 * 用户删一本书 = 一本书的意图；之后再导入一份旧备份（里面当然还有这本书），
 * 不许偷偷复活它，也不许偷偷不复活 —— 结果里要能报出来「N 本曾删除，按删除保留」。
 *
 * 反向对照：
 * - 没删过的书再导入必须照常在架（不能把导入整个弄成"什么都不加"）；
 * - 删除后用户自己再手动加回这本 → 删除标记清掉，下次导入按"已存在"更新；
 * - 删除标记只认 (sourceId, bookUrl)，同书别的源、别的书都不受影响。
 */
class ShelfDeletedBookImportTest {

    private fun entry(
        sourceId: String = SOURCE,
        bookUrl: String = BOOK,
        name: String = "测试书",
        chapterIndex: Int = 0,
    ) = BackupShelfEntry(
        sourceId = sourceId,
        bookUrl = bookUrl,
        name = name,
        author = "作者",
        tocUrl = bookUrl,
        coverUrl = null,
        completed = false,
        chapterIndex = chapterIndex,
        readAt = 1_700_000_000_000,
    )

    @Test
    fun `删掉的书导入备份不许复活，且结果要报出跳过本数`() {
        val directory = Files.createTempDirectory("legado-shelf-deleted-import")
        val database = Database(directory.resolve("legado.sqlite").toString())
        try {
            database.initialize()
            database.saveBookshelf(BookshelfWriteRequest(SOURCE, BOOK, "测试书", tocUrl = BOOK), null)
            assertEquals(1, database.listBookshelf().size)

            // 用户从书架删掉它（DELETE /bookshelf → BookshelfRepository.removeBook → 同一个 DAO）
            database.removeBookshelf(SOURCE, BOOK)
            assertEquals("删除后书架必须真的是空的", 0, database.listBookshelf().size)

            // 之后再导入一份旧备份：备份里当然还带着这本书
            val result = database.importLibrary(listOf(entry()))

            assertEquals("导入备份不许复活用户删掉的书", 0, database.listBookshelf().size)
            assertEquals("跳过的这本要单独报数，不能混进 imported", 1, result.skippedDeleted)
            assertEquals(0, result.imported)
            assertEquals(0, result.updated)
        } finally {
            database.close()
        }
    }

    @Test
    fun `没删过的书再导入照常合并（反向对照：不能把导入改成一概不恢复）`() {
        val directory = Files.createTempDirectory("legado-shelf-alive-import")
        val database = Database(directory.resolve("legado.sqlite").toString())
        try {
            database.initialize()

            val first = database.importLibrary(listOf(entry()))
            assertEquals(1, first.imported)
            assertEquals(0, first.skippedDeleted)

            val second = database.importLibrary(listOf(entry(name = "测试书（备份名）")))
            assertEquals("已在架的书按合并更新，不能当成删除过的跳过", 1, second.updated)
            assertEquals(0, second.skippedDeleted)
            val shelf = database.listBookshelf()
            assertEquals(1, shelf.size)
            assertEquals("测试书（备份名）", shelf.first().name)
        } finally {
            database.close()
        }
    }

    @Test
    fun `删除后用户自己加回这本书，删除标记要清掉`() {
        val directory = Files.createTempDirectory("legado-shelf-readd")
        val database = Database(directory.resolve("legado.sqlite").toString())
        try {
            database.initialize()
            database.importLibrary(listOf(entry()))
            database.removeBookshelf(SOURCE, BOOK)
            assertEquals(0, database.listBookshelf().size)

            // 用户在搜索/详情页主动「加入书架」：这是比旧备份更新的意图
            database.saveBookshelf(BookshelfWriteRequest(SOURCE, BOOK, "测试书", tocUrl = BOOK), null)
            assertEquals(1, database.listBookshelf().size)

            val again = database.importLibrary(listOf(entry()))
            assertEquals("手加回之后，导入应当是正常合并而不是继续跳过", 1, again.updated)
            assertEquals(0, again.skippedDeleted)
            assertEquals(1, database.listBookshelf().size)
        } finally {
            database.close()
        }
    }

    @Test
    fun `删除标记只认这本书这个源，跳过时连带进度也不恢复`() {
        val directory = Files.createTempDirectory("legado-shelf-scope")
        val database = Database(directory.resolve("legado.sqlite").toString())
        try {
            database.initialize()
            database.importLibrary(listOf(entry(chapterIndex = 3)))
            assertNotNull(database.getProgress(SOURCE, BOOK))
            database.removeBookshelf(SOURCE, BOOK)
            assertNull("删书会连带删进度", database.getProgress(SOURCE, BOOK))

            val otherBook = entry(bookUrl = "$BOOK-2", name = "另一本")
            val otherSource = entry(sourceId = "$SOURCE-2", name = "同书别的源", chapterIndex = 2)
            val result = database.importLibrary(listOf(entry(chapterIndex = 9), otherBook, otherSource))

            assertEquals("只跳过被删的那一本", 1, result.skippedDeleted)
            assertEquals(2, result.imported)
            assertNull("被删的书进度不许被备份复活", database.getProgress(SOURCE, BOOK))
            assertNotNull(database.getProgress("$SOURCE-2", BOOK))
        } finally {
            database.close()
        }
    }

    @Test
    fun `批量删除也算删除决定`() {
        val directory = Files.createTempDirectory("legado-shelf-batch")
        val database = Database(directory.resolve("legado.sqlite").toString())
        try {
            database.initialize()
            database.importLibrary(listOf(entry()))
            database.batchRemoveBookshelf(listOf(BookIdentifier(SOURCE, BOOK)))
            assertEquals(0, database.listBookshelf().size)

            val result = database.importLibrary(listOf(entry()))
            assertEquals(0, database.listBookshelf().size)
            assertEquals(1, result.skippedDeleted)
        } finally {
            database.close()
        }
    }

    private companion object {
        const val SOURCE = "https://example.com/##聚合"
        const val BOOK = "https://example.com/book/1"
    }
}
