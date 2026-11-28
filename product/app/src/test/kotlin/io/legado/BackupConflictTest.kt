package io.legado

import io.legado.backup.BackupImporter
import io.legado.backup.BackupPreviewChangedException
import io.legado.backup.BackupStore
import io.legado.data.*
import io.legado.model.BackupLibraryPolicy
import io.legado.model.ReadingProgress
import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.*
import org.junit.Test

class BackupConflictTest {
    private val source = "https://conflict.example/"
    private fun fixture(run: (Database, BackupImporter, Path, BackupStore) -> Unit) {
        val dir = Files.createTempDirectory("backup-conflict")
        val db = Database(dir.resolve("test.sqlite").toString())
        try {
            db.initialize()
            val store = BackupStore(dir.resolve("kept"))
            run(db, BackupImporter(db, store), dir.resolve("backup.json"), store)
        } finally { db.close(); dir.toFile().deleteRecursively() }
    }
    private fun pack(file: Path, time: Long? = 100, chapter: Int? = 3, name: String = "备份", duplicate: Boolean = false) {
        val entry = """{"origin":"$source","bookUrl":"book","name":"$name"${time?.let { ",\"durChapterTime\":$it" }.orEmpty()}${chapter?.let { ",\"durChapterIndex\":$it,\"durChapterPos\":7" }.orEmpty()}}"""
        val previous = """{"origin":"$source","bookUrl":"book","name":"应被包内最后一条替换"}"""
        Files.writeString(file, """{"bookSource":[{"bookSourceUrl":"$source","bookSourceName":"源"}],"bookshelf":[${if (duplicate) "$previous," else ""}$entry],"readConfig":[{"fontSize":20}]}""")
    }
    private fun local(db: Database, importer: BackupImporter, file: Path) {
        pack(file, 200, 9, "本机")
        importer.import(file, sections = setOf("shelf"))
        db.transaction { connection ->
            connection.createStatement().use { it.executeUpdate("update reading_progress set paragraph_anchor='anchor',position_checksum='checksum'") }
        }
    }

    @Test fun `保守策略保留元数据与未知时间进度 预测等于实际且预览无写入`() = fixture { db, importer, file, store ->
        local(db, importer, file)
        pack(file, null)
        importer.stepHook = { error("预览不能执行写入步骤") }
        val preview = importer.preview(file)
        assertEquals(1, preview.libraryDiff!!.booksKept)
        assertEquals(1, preview.libraryDiff!!.progressKept)
        assertEquals(1, preview.libraryDiff!!.progressUnknownTime)
        assertEquals("本机", db.listBookshelf().single().name)
        assertTrue(db.listSources(null).isEmpty()); assertTrue(store.list().isEmpty())
        importer.stepHook = null
        val result = importer.import(file, libraryPolicy = preview.libraryPolicy, previewToken = preview.previewToken)
        assertEquals(preview.libraryDiff, result.libraryDiff)
        assertEquals(9, db.getProgress(source, "book")!!.chapterIndex)
        assertEquals("anchor", db.getProgress(source, "book")!!.paragraphAnchor)
        assertEquals("本机", db.listBookshelf().single().name)
    }

    @Test fun `时间严格较新才覆盖 相等或旧时间保留锚点`() = fixture { db, importer, file, _ ->
        local(db, importer, file)
        for (time in listOf(100L, 200L, 300L)) {
            pack(file, time, 4)
            val preview = importer.preview(file)
            val expected = if (time > 200) 1 else 0
            assertEquals(expected, preview.libraryDiff!!.progressApplied)
            val result = importer.import(file, sections = setOf("shelf"), libraryPolicy = preview.libraryPolicy, previewToken = preview.previewToken)
            assertEquals(preview.libraryDiff, result.libraryDiff)
            val progress = db.getProgress(source, "book")!!
            assertEquals(if (expected == 1) 4 else 9, progress.chapterIndex)
            assertEquals(if (expected == 1) null else "anchor", progress.paragraphAnchor)
            assertEquals("本机", db.listBookshelf().single().name)
        }
    }

    @Test fun `显式覆盖允许回退与首章恢复 并清除旧定位锚点`() = fixture { db, importer, file, _ ->
        local(db, importer, file)
        pack(file, 100, 0)
        val policy = BackupLibraryPolicy("overwrite", "overwrite")
        val preview = importer.preview(file, libraryPolicy = policy)
        assertEquals(1, preview.libraryDiff!!.booksUpdated)
        assertEquals(1, preview.libraryDiff!!.progressApplied)
        val result = importer.import(file, sections = setOf("shelf"), libraryPolicy = policy, previewToken = preview.previewToken)
        assertEquals(preview.libraryDiff, result.libraryDiff)
        val progress = db.getProgress(source, "book")!!
        assertEquals(0, progress.chapterIndex); assertEquals(7, progress.charOffset); assertEquals(100L, progress.updatedAt)
        assertNull(progress.paragraphAnchor); assertNull(progress.positionChecksum)
        assertEquals("备份", db.listBookshelf().single().name)
    }

    @Test fun `显式覆盖无时间进度按本次导入保存 不带进度不凭空恢复`() = fixture { db, importer, file, _ ->
        val policy = BackupLibraryPolicy("overwrite", "overwrite")
        pack(file, null, 0)
        val before = System.currentTimeMillis()
        val preview = importer.preview(file, libraryPolicy = policy)
        importer.import(file, libraryPolicy = policy, previewToken = preview.previewToken)
        assertTrue(db.getProgress(source, "book")!!.updatedAt >= before)
        pack(file, null, null)
        val next = importer.preview(file, libraryPolicy = policy)
        assertEquals(0, next.libraryDiff!!.progressApplied)
        importer.import(file, libraryPolicy = policy, previewToken = next.previewToken)
        assertEquals(0, db.getProgress(source, "book")!!.chapterIndex)
        Files.writeString(file, """{"bookshelf":[{"origin":"$source","bookUrl":"new","name":"新书","durChapterIndex":0}]}""")
        val conservative = importer.preview(file)
        assertEquals(1, conservative.libraryDiff!!.booksAdded)
        assertEquals(1, conservative.libraryDiff!!.progressUnknownTime)
        assertEquals(0, conservative.libraryDiff!!.progressApplied)
        importer.import(file, libraryPolicy = conservative.libraryPolicy, previewToken = conservative.previewToken)
        assertNull(db.getProgress(source, "new"))
    }

    @Test fun `预览后同毫秒元数据修改或进度变化拒绝整包且不留文件`() = fixture { db, importer, file, store ->
        local(db, importer, file)
        pack(file, 300)
        for (change in listOf<() -> Unit>(
            { db.transaction { connection -> connection.createStatement().use { it.executeUpdate("update book_shelf set name='changed'") } } },
            { db.saveProgress(ReadingProgress(source, "book", "new", 10, 0.2)) },
            { db.removeBookshelf(source, "book") },
        )) {
            val preview = importer.preview(file)
            change()
            assertThrows(BackupPreviewChangedException::class.java) {
                importer.import(file, libraryPolicy = preview.libraryPolicy, previewToken = preview.previewToken)
            }
            assertTrue(db.listSources(null).isEmpty()); assertTrue(store.list().isEmpty())
        }
    }

    @Test fun `文件或策略变化也使预览失效 其他书变化不误拒绝`() = fixture { db, importer, file, _ ->
        pack(file)
        val preview = importer.preview(file)
        pack(file, 500)
        assertThrows(BackupPreviewChangedException::class.java) {
            importer.import(file, libraryPolicy = preview.libraryPolicy, previewToken = preview.previewToken)
        }
        assertThrows(BackupPreviewChangedException::class.java) {
            importer.import(file, sections = setOf("sources"), libraryPolicy = preview.libraryPolicy, previewToken = preview.previewToken)
        }
        pack(file)
        assertThrows(BackupPreviewChangedException::class.java) {
            importer.import(file, libraryPolicy = BackupLibraryPolicy("overwrite"), previewToken = preview.previewToken)
        }
        db.saveProgress(ReadingProgress(source, "unrelated", "chapter", 4, 0.2))
        assertEquals(1, importer.import(file, libraryPolicy = preview.libraryPolicy, previewToken = preview.previewToken).books)
        val beforeChange = importer.preview(file)
        db.saveProgress(ReadingProgress(source, "book", "local", 7, 0.5))
        val sourcesOnly = importer.import(file, sections = setOf("sources"), libraryPolicy = beforeChange.libraryPolicy, previewToken = beforeChange.previewToken)
        assertEquals(1, sourcesOnly.sources + sourcesOnly.sourcesUpdated)
        assertEquals(7, db.getProgress(source, "book")!!.chapterIndex)
    }

    @Test fun `去重取最后一条 墓碑优先 不恢复模式不写进度`() = fixture { db, importer, file, _ ->
        pack(file, duplicate = true)
        val policy = BackupLibraryPolicy(progress = "keep_local")
        var preview = importer.preview(file, libraryPolicy = policy)
        assertEquals(1, preview.libraryDiff!!.booksAdded); assertEquals(1, preview.libraryDiff!!.duplicates)
        assertEquals(0, preview.libraryDiff!!.progressApplied)
        var result = importer.import(file, libraryPolicy = policy, previewToken = preview.previewToken)
        assertEquals(preview.libraryDiff, result.libraryDiff); assertNull(db.getProgress(source, "book"))
        assertEquals("备份", db.listBookshelf().single().name)
        db.removeBookshelf(source, "book")
        preview = importer.preview(file, libraryPolicy = BackupLibraryPolicy("overwrite", "overwrite"))
        assertEquals(1, preview.libraryDiff!!.skippedDeleted)
        result = importer.import(file, libraryPolicy = preview.libraryPolicy, previewToken = preview.previewToken)
        assertEquals(preview.libraryDiff, result.libraryDiff); assertTrue(db.listBookshelf().isEmpty())
    }

    @Test fun `省略策略保留旧语义 缺时间进度仍按导入时刻合并`() = fixture { db, importer, file, _ ->
        local(db, importer, file); pack(file, null, 3)
        assertEquals(1, importer.import(file).progress)
        assertEquals("备份", db.listBookshelf().single().name)
        assertEquals(3, db.getProgress(source, "book")!!.chapterIndex)
        assertThrows(IllegalArgumentException::class.java) { importer.import(file, libraryPolicy = BackupLibraryPolicy()) }
        assertThrows(IllegalArgumentException::class.java) { importer.preview(file, libraryPolicy = BackupLibraryPolicy(progress = "typo")) }
    }

    @Test fun `采用备份信息仍保留已有书本机分组 新书按选中组映射`() = fixture { db, importer, file, _ ->
        local(db, importer, file)
        val localGroup = db.createBookGroup("本机组")
        db.assignBookGroup(source, "book", localGroup.id)
        val book = """{"origin":"$source","bookUrl":"book","name":"备份","group":77}"""
        val fresh = """{"origin":"$source","bookUrl":"new","name":"新书","group":77}"""
        Files.writeString(file, """{"bookGroup":[{"groupId":77,"groupName":"备份组"}],"bookshelf":[$book,$fresh]}""")
        val policy = BackupLibraryPolicy("overwrite", "keep_local")
        val preview = importer.preview(file, libraryPolicy = policy)
        val result = importer.import(file, sections = setOf("shelf", "groups"), libraryPolicy = policy, previewToken = preview.previewToken)
        assertEquals(preview.libraryDiff, result.libraryDiff)
        assertEquals(localGroup.id, db.listBookshelf().single { it.bookUrl == "book" }.groupId)
        assertEquals(db.listBookGroups().single { it.name == "备份组" }.id, db.listBookshelf().single { it.bookUrl == "new" }.groupId)
        assertEquals(9, db.getProgress(source, "book")!!.chapterIndex)
    }
}
