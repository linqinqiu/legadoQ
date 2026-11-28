package io.legado

import io.legado.backup.BackupAes
import io.legado.backup.BackupImporter
import io.legado.backup.BackupStore
import io.legado.data.*
import io.legado.model.ReadingProgress
import java.nio.file.Files
import java.nio.file.Path
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.junit.Assert.*
import org.junit.Test

class BackupPreviewTest {
    private fun fixture(run: (Database, BackupStore, Path) -> Unit) {
        val directory = Files.createTempDirectory("legado-backup-preview")
        val database = Database(directory.resolve("test.sqlite").toString())
        try {
            database.initialize()
            run(database, BackupStore(directory.resolve("kept")), directory)
        } finally {
            database.close()
            directory.toFile().deleteRecursively()
        }
    }

    private fun archive(directory: Path): Path = directory.resolve("backup.zip").also { file ->
        ZipOutputStream(Files.newOutputStream(file)).use { zip ->
            mapOf(
                "bookSource.json" to """[{"bookSourceUrl":"https://preview.example/","bookSourceName":"源","enabled":true}]""",
                "replaceRule.json" to """[{"id":"preview","name":"规则","pattern":"广告","replacement":""}]""",
                "bookGroup.json" to """[{"groupId":77,"groupName":"备份分组"}]""",
                "bookshelf.json" to """[{"origin":"https://preview.example/","bookUrl":"book-1","name":"书","group":77,"durChapterIndex":3,"durChapterTime":1}]""",
                "rssSources.json" to """[{"sourceUrl":"https://rss.example/","sourceName":"RSS"}]""",
                "sourceSub.json" to """[{"url":"https://sub.example/list","type":0,"autoUpdate":true}]""",
                "cookies.json" to BackupAes.encryptBase64("""[{"url":"preview.example","cookie":"sid=secret"}]""", "pw"),
                "readConfig.json" to """[{"fontSize":22}]""",
            ).forEach { (name, text) ->
                zip.putNextEntry(ZipEntry(name))
                zip.write(text.toByteArray())
                zip.closeEntry()
            }
        }
    }

    @Test fun `同站点不同注解的书源在确认前明确提示标识合并且不写入`() = fixture { db, store, directory ->
        val file = directory.resolve("variants.json")
        Files.writeString(file, """[
            {"bookSourceUrl":"https://variants.example/##甲","bookSourceName":"版本甲"},
            {"bookSourceUrl":"https://variants.example/#乙","bookSourceName":"版本乙"},
            {"bookSourceUrl":"https://independent.example/","bookSourceName":"独立源"}
        ]""")
        val importer = BackupImporter(db, store)
        val preview = importer.preview(file)
        assertEquals(3, preview.sections.single { it.id == "sources" }.items)
        assertTrue(preview.warnings.any { it.contains("3 条有效书源") && it.contains("2 个") && it.contains("合并 1 条") })
        assertTrue(preview.warnings.any { it.contains("最后一条") && it.contains("不是全部书源版本的无损迁移") })
        assertTrue(db.listSources(null).isEmpty())
        assertTrue(store.list().isEmpty())
        val summary = importer.import(file, sections = setOf("sources"),
            libraryPolicy = preview.libraryPolicy, previewToken = preview.previewToken)
        assertEquals(2, summary.sources)
        assertEquals("版本乙", db.listSources(null).single { it.id == "https://variants.example/" }.name)
    }

    @Test fun `完整包预览不进入写事务 不写凭据或个性化文件`() = fixture { db, store, directory ->
        val groupsBefore = db.listBookGroups()
        store.keep("readConfig.json", "[]")
        val importer = BackupImporter(db, store).apply { stepHook = { error("预览不得调用 commit") } }
        val result = importer.preview(archive(directory), "pw")
        assertEquals(setOf("sources", "rules", "groups", "shelf", "rss", "subscriptions", "cookies", "kept"), result.sections.map { it.id }.toSet())
        assertTrue(result.sections.all { it.items == 1 })
        assertTrue(db.listSources(null).isEmpty())
        assertTrue(db.listReplaceRules().isEmpty())
        assertTrue(db.listBookshelf().isEmpty())
        assertTrue(db.listRssSources(null).isEmpty())
        assertTrue(db.listSubscriptions().isEmpty())
        assertEquals(groupsBefore, db.listBookGroups())
        assertNull(db.getCookieForUrl("https://preview.example/"))
        assertEquals("[]", store.read("readConfig.json"))
        assertEquals(1, store.list().size)
    }

    @Test fun `完整包只勾书源 其他域与原样留档都不写`() = fixture { db, store, directory ->
        val before = db.listBookGroups()
        val result = BackupImporter(db, store).import(archive(directory), "pw", setOf("sources"))
        assertEquals(1, result.sources)
        assertEquals(0, result.books + result.rules + result.cookies + result.rssSources + result.subscriptions)
        assertTrue(db.listBookshelf().isEmpty())
        assertTrue(db.listReplaceRules().isEmpty())
        assertTrue(db.listRssSources(null).isEmpty())
        assertTrue(db.listSubscriptions().isEmpty())
        assertEquals(before, db.listBookGroups())
        assertNull(db.getCookieForUrl("https://preview.example/"))
        assertTrue(store.list().isEmpty())
        assertFalse("主动不选的留档项不能报不支持", "readconfig.json" in result.skippedSections)
    }

    @Test fun `只勾个性化 不顺带恢复书源订阅原包`() = fixture { db, store, directory ->
        val result = BackupImporter(db, store).import(archive(directory), sections = setOf("kept"))
        assertEquals(listOf("readConfig.json"), result.keptSections.map { it.name })
        assertTrue(db.listSubscriptions().isEmpty())
        assertNull(store.read("sourceSub.json"))
    }

    @Test fun `只勾书源订阅 同时保留其原包但不收其他个性化`() = fixture { db, store, directory ->
        val result = BackupImporter(db, store).import(archive(directory), sections = setOf("subscriptions"))
        assertEquals(1, result.subscriptions)
        assertEquals(listOf("sourceSub.json"), store.list().map { it.name })
        assertTrue(db.listSources(null).isEmpty())
    }

    @Test fun `密码缺失或错误只给预览警告 不产生凭据`() = fixture { db, store, directory ->
        val importer = BackupImporter(db, store)
        val file = archive(directory)
        for (password in listOf(null, "wrong")) {
            val result = importer.preview(file, password)
            assertFalse(result.sections.any { it.id == "cookies" })
            assertTrue(result.warnings.any { "cookies.json" in it })
            assertTrue(result.sections.any { it.id == "sources" })
        }
        assertNull(db.getCookieForUrl("https://preview.example/"))
        assertTrue(store.list().isEmpty())
    }

    @Test fun `裸 JSON 同样可预览并且仅导入指定模块`() = fixture { db, store, directory ->
        val file = directory.resolve("backup.json")
        Files.writeString(file, """{"bookSource":[{"bookSourceUrl":"https://json.example/","bookSourceName":"JSON"}],"bookshelf":[{"origin":"https://json.example/","bookUrl":"book","name":"书"}],"readConfig":[{"fontSize":20}]}""")
        val importer = BackupImporter(db, store)
        assertEquals(setOf("sources", "shelf", "kept"), importer.preview(file).sections.map { it.id }.toSet())
        assertTrue(store.list().isEmpty())
        assertEquals(1, importer.import(file, sections = setOf("shelf")).books)
        assertTrue(db.listSources(null).isEmpty())
        assertTrue(store.list().isEmpty())
    }

    @Test fun `书架选择保留较新进度与删除决定 可选分组按名映射`() = fixture { db, store, directory ->
        val file = archive(directory)
        db.saveProgress(ReadingProgress("https://preview.example/", "book-1", "local-chapter", 99, 0.5))
        val importer = BackupImporter(db, store)
        val result = importer.import(file, sections = setOf("shelf", "groups"))
        assertEquals(0, result.progress)
        assertEquals(99, db.getProgress("https://preview.example/", "book-1")!!.chapterIndex)
        assertEquals(db.listBookGroups().single { it.name == "备份分组" }.id, db.listBookshelf().single().groupId)
        db.removeBookshelf("https://preview.example/", "book-1")
        assertEquals(1, importer.import(file, sections = setOf("shelf")).booksSkippedDeleted)
        assertTrue(db.listBookshelf().isEmpty())
    }

    @Test fun `空选择或未知模块报错并保持数据库不变`() = fixture { db, store, directory ->
        val importer = BackupImporter(db, store)
        val file = archive(directory)
        for (sections in listOf(emptySet(), setOf("sources", "unknown"))) {
            assertTrue(runCatching { importer.import(file, sections = sections) }.exceptionOrNull() is IllegalArgumentException)
        }
        assertTrue(db.listSources(null).isEmpty())
        assertTrue(store.list().isEmpty())
    }
}
