package io.legado

import io.legado.backup.BackupArchiveException
import io.legado.backup.BackupImporter
import io.legado.backup.BackupPreviewChangedException
import io.legado.backup.BackupStore
import io.legado.data.Database
import io.legado.data.listBookshelf
import io.legado.data.listSources
import kotlinx.serialization.json.*
import java.nio.file.Files
import java.nio.file.Path
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.junit.Assert.*
import org.junit.Test

class BackupSourceArchiveTest {
    private val sources = """[
        {"bookSourceUrl":"https://variants.example/##甲","bookSourceName":"甲","extension":{"unknown":[1,2]}},
        {"bookSourceUrl":"https://variants.example/#乙","bookSourceName":"乙"},
        {"bookSourceUrl":"https://single.example/","bookSourceName":"单独"}
    ]"""
    private val shelf = """[
        {"origin":"https://variants.example/##甲","bookUrl":"one","name":"书","durChapterIndex":3,"durChapterTime":5,"unknown":"保留"},
        {"origin":"https://variants.example/#包内不存在的版本","bookUrl":"two","name":"书二"}
    ]"""

    private fun fixture(run: (Database, BackupStore, Path) -> Unit) {
        val dir = Files.createTempDirectory("legado-source-archive-")
        val db = Database(dir.resolve("test.sqlite").toString())
        try {
            db.initialize()
            run(db, BackupStore(dir.resolve("kept")), dir)
        } finally {
            db.close()
            dir.toFile().deleteRecursively()
        }
    }

    private fun json(dir: Path): Path = dir.resolve("backup.json").also {
        Files.writeString(it, """{"bookSource":$sources,"bookshelf":$shelf}""")
    }

    @Test fun `裸 JSON 留存全部原始字段顺序及书架引用 不改变执行标识`() = fixture { db, store, dir ->
        val file = json(dir)
        val importer = BackupImporter(db, store)
        val preview = importer.preview(file)
        assertTrue(store.list().isEmpty())
        assertTrue(preview.warnings.any { it.contains("留档失败") && it.contains("歧义") })
        val result = importer.import(file, sections = setOf("sources"))
        val entry = result.keptSections.single()
        val saved = Json.parseToJsonElement(requireNotNull(store.read(entry.name))).jsonObject
        assertEquals(Json.parseToJsonElement(sources), saved["bookSource"])
        assertEquals(Json.parseToJsonElement(shelf), saved["bookshelf"])
        assertEquals("legadoq-source-variants-v1", saved["format"]?.jsonPrimitive?.content)
        val conflict = saved.getValue("conflicts").jsonArray.single().jsonObject
        assertEquals("https://variants.example/", conflict["normalizedId"]?.jsonPrimitive?.content)
        assertEquals(Json.parseToJsonElement("[0,1]"), conflict["sourceIndexes"])
        assertEquals(1, conflict["winnerIndex"]?.jsonPrimitive?.int)
        assertEquals(3, entry.items)
        assertFalse(entry.appliable)
        assertEquals(entry, store.list().single())
        assertEquals(2, db.listSources(null).size)
        assertEquals("乙", db.listSources(null).single { it.id == "https://variants.example/" }.name)
        assertTrue(db.listBookshelf().isEmpty())
    }

    @Test fun `ZIP 与裸 JSON 一样保留原始版本及引用`() = fixture { db, store, dir ->
        val file = dir.resolve("backup.zip")
        ZipOutputStream(Files.newOutputStream(file)).use { zip ->
            listOf("bookSource.json" to sources, "bookshelf.json" to shelf).forEach { (name, text) ->
                zip.putNextEntry(ZipEntry(name)); zip.write(text.toByteArray()); zip.closeEntry()
            }
        }
        BackupImporter(db, store).import(file)
        val saved = Json.parseToJsonElement(requireNotNull(store.read(store.list().single().name))).jsonObject
        assertEquals(Json.parseToJsonElement(sources), saved["bookSource"])
        assertEquals(Json.parseToJsonElement(shelf), saved["bookshelf"])
        assertEquals(2, db.listBookshelf().size)
    }

    @Test fun `重复导入复用留档 另一备份不覆盖旧版本`() = fixture { db, store, dir ->
        val file = json(dir)
        val importer = BackupImporter(db, store)
        val first = importer.import(file).keptSections.single()
        val body = store.read(first.name)
        val again = importer.import(file).keptSections.single()
        assertEquals(first, again)
        assertEquals(1, store.list().size)
        Files.writeString(file, Files.readString(file).replace("\"bookSourceName\":\"乙\"", "\"bookSourceName\":\"更新乙\""))
        assertNotEquals(first.name, importer.import(file).keptSections.single().name)
        assertEquals(2, store.list().size)
        assertEquals(body, store.read(first.name))
    }

    @Test fun `未选书源以及没有冲突均不创建额外留档`() = fixture { db, store, dir ->
        val file = json(dir)
        val importer = BackupImporter(db, store)
        assertTrue(importer.import(file, sections = setOf("shelf")).keptSections.isEmpty())
        assertTrue(store.list().isEmpty())
        Files.writeString(file, """[{"bookSourceUrl":"https://single.example/##单独","bookSourceName":"单独"}]""")
        assertTrue(importer.import(file).keptSections.isEmpty())
        assertTrue(store.list().isEmpty())
    }

    @Test fun `没有留档目录禁止提交冲突导入且全部域回滚`() = fixture { db, _, dir ->
        assertThrows(BackupArchiveException::class.java) { BackupImporter(db).import(json(dir)) }
        assertTrue(db.listSources(null).isEmpty())
        assertTrue(db.listBookshelf().isEmpty())
    }

    @Test fun `留档写失败回滚全部域且不产生临时文件`() = fixture { db, _, dir ->
        val blocked = dir.resolve("blocked")
        Files.writeString(blocked, "不能作目录")
        assertThrows(BackupArchiveException::class.java) { BackupImporter(db, BackupStore(blocked)).import(json(dir)) }
        assertTrue(db.listSources(null).isEmpty())
        assertTrue(db.listBookshelf().isEmpty())
        assertEquals("不能作目录", Files.readString(blocked))
    }

    @Test fun `已有留档损坏禁止覆盖并回滚数据库更新`() = fixture { db, store, dir ->
        val file = json(dir)
        val entry = BackupImporter(db, store).import(file, sections = setOf("sources")).keptSections.single()
        Files.writeString(dir.resolve("kept").resolve(entry.name), "损坏")
        assertThrows(BackupArchiveException::class.java) { BackupImporter(db, store).import(file) }
        assertTrue(db.listBookshelf().isEmpty())
        assertEquals("损坏", store.read(entry.name))
    }

    @Test fun `其他数据库步骤失败不提前创建留档`() = fixture { db, store, dir ->
        val importer = BackupImporter(db, store).apply { stepHook = { if (it == "cookies") error("失败注入") } }
        assertThrows(IllegalStateException::class.java) { importer.import(json(dir)) }
        assertTrue(db.listSources(null).isEmpty())
        assertTrue(db.listBookshelf().isEmpty())
        assertTrue(store.list().isEmpty())
    }

    @Test fun `旧格式冲突保留迁移前字段及旧书架 tag`() = fixture { db, store, dir ->
        val oldSources = """[
            {"bookSourceUrl":"https://old.example/#甲","bookSourceName":"甲","ruleSearchList":".old","oldExtension":"保留"},
            {"bookSourceUrl":"https://old.example/#乙","bookSourceName":"乙","ruleSearchList":".new"}
        ]"""
        val oldShelf = """[{"noteUrl":"old-book","tag":"https://old.example/#甲","bookInfoBean":{"name":"旧书"}}]"""
        val file = dir.resolve("old.json")
        Files.writeString(file, """{"bookSource":$oldSources,"bookshelf":$oldShelf}""")
        BackupImporter(db, store).import(file)
        val saved = Json.parseToJsonElement(requireNotNull(store.read(store.list().single().name))).jsonObject
        assertEquals(Json.parseToJsonElement(oldSources), saved["bookSource"])
        assertEquals(Json.parseToJsonElement(oldShelf), saved["bookshelf"])
        assertEquals(1, db.listSources(null).size)
        assertEquals(1, db.listBookshelf().size)
    }

    @Test fun `过期预览不能写入冲突留档或任何数据库域`() = fixture { db, store, dir ->
        val file = json(dir)
        val importer = BackupImporter(db, store)
        val preview = importer.preview(file)
        Files.writeString(file, Files.readString(file) + " ")
        assertThrows(BackupPreviewChangedException::class.java) {
            importer.import(file, libraryPolicy = preview.libraryPolicy, previewToken = preview.previewToken)
        }
        assertTrue(db.listSources(null).isEmpty())
        assertTrue(db.listBookshelf().isEmpty())
        assertTrue(store.list().isEmpty())
    }
}
