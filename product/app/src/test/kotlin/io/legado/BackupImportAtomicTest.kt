package io.legado

import io.legado.backup.BackupAes
import io.legado.backup.BackupImporter
import io.legado.backup.BackupStore
import io.legado.data.Database
import io.legado.data.getCookieForUrl
import io.legado.data.listBookGroups
import io.legado.data.listBookshelf
import io.legado.data.listReplaceRules
import io.legado.data.listRssSources
import io.legado.data.listSources
import java.nio.file.Files
import java.nio.file.Path
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 备份导入原子性（P0-1 2b）：六步落库是一整笔事务，任何一步失败都不许留下半套数据。
 *
 * 以前六步各自提交，中途失败会停在「书源进去了、书架没进去」这种状态；
 * 个性化条目（[BackupStore]）还在 commit 之前就写了磁盘，库回滚了文件却留着。
 */
class BackupImportAtomicTest {

    private val steps = listOf("sources", "rules", "groups", "library", "rss", "cookies")

    @Test
    fun `六步里任何一步失败 六个域都不落库`() {
        steps.forEach { failing ->
            val directory = Files.createTempDirectory("legado-backup-atomic-$failing")
            val database = Database(directory.resolve("legado.sqlite").toString())
            val store = BackupStore(directory.resolve("kept"))
            try {
                database.initialize()
                val groupsBefore = database.listBookGroups().size
                val archive = directory.resolve("backup.zip")
                writeArchive(archive, sections())

                val importer = BackupImporter(database, store).apply {
                    stepHook = { step -> if (step == failing) error("注入失败：$step") }
                }
                val failure = runCatching { importer.import(archive, PASSWORD) }
                assertTrue("第 $failing 步的注入必须真的抛出来", failure.isFailure)

                assertEquals("$failing 失败后书源不许留下", 0, database.listSources(null).size)
                assertEquals("$failing 失败后替换规则不许留下", 0, database.listReplaceRules().size)
                assertEquals("$failing 失败后分组不许留下", groupsBefore, database.listBookGroups().size)
                assertEquals("$failing 失败后书架不许留下", 0, database.listBookshelf().size)
                assertEquals("$failing 失败后 RSS 不许留下", 0, database.listRssSources(null).size)
                assertNull("$failing 失败后凭据不许留下", database.getCookieForUrl("https://cookie.example/"))
                assertTrue(
                    "$failing 失败后个性化条目文件不许落盘：${store.list().map { it.name }}",
                    store.list().isEmpty(),
                )
            } finally {
                database.close()
                directory.toFile().deleteRecursively()
            }
        }
    }

    @Test
    fun `导入成功后六域齐备 个性化条目在提交之后才落盘`() {
        val directory = Files.createTempDirectory("legado-backup-atomic-ok")
        val database = Database(directory.resolve("legado.sqlite").toString())
        val store = BackupStore(directory.resolve("kept"))
        try {
            database.initialize()
            val archive = directory.resolve("backup.zip")
            writeArchive(archive, sections())

            val summary = BackupImporter(database, store).import(archive, PASSWORD)

            assertEquals(1, summary.sources)
            assertEquals(1, summary.rules)
            assertEquals(1, summary.books)
            assertEquals(1, summary.rssSources)
            assertEquals(1, summary.cookies)
            assertEquals(1, database.listSources(null).size)
            assertEquals(1, database.listReplaceRules().size)
            assertEquals(1, database.listBookshelf().size)
            assertEquals(1, database.listRssSources(null).size)
            assertTrue(database.getCookieForUrl("https://cookie.example/")!!.contains("sid=1"))
            assertTrue("提交成功后才该有文件", store.list().any { it.name.equals("readRecord.json", true) })
        } finally {
            database.close()
            directory.toFile().deleteRecursively()
        }
    }

    @Test
    fun `同一份备份连导两次 行数稳定`() {
        val directory = Files.createTempDirectory("legado-backup-atomic-twice")
        val database = Database(directory.resolve("legado.sqlite").toString())
        val store = BackupStore(directory.resolve("kept"))
        try {
            database.initialize()
            val archive = directory.resolve("backup.zip")
            writeArchive(archive, sections())

            BackupImporter(database, store).import(archive, PASSWORD)
            val first = counts(database)
            BackupImporter(database, store).import(archive, PASSWORD)
            val second = counts(database)

            assertEquals("重复导入不许堆行：$first → $second", first, second)
            assertEquals(1, second.getValue("sources"))
            assertEquals(1, second.getValue("rules"))
            assertEquals(1, second.getValue("books"))
            assertEquals(1, second.getValue("rss"))
        } finally {
            database.close()
            directory.toFile().deleteRecursively()
        }
    }

    private fun counts(database: Database): Map<String, Int> = mapOf(
        "sources" to database.listSources(null).size,
        "rules" to database.listReplaceRules().size,
        "groups" to database.listBookGroups().size,
        "books" to database.listBookshelf().size,
        "rss" to database.listRssSources(null).size,
    )

    private fun sections(): Map<String, String> = mapOf(
        "bookSource.json" to """[{"bookSourceUrl":"https://atomic.example","bookSourceName":"示例源","enabled":true}]""",
        "replaceRule.json" to
            """[{"id":1767407348980,"name":"去广告","pattern":"广告.*","replacement":"","isRegex":true,"isEnabled":true,"order":1}]""",
        "bookGroup.json" to """[{"groupId":77,"groupName":"追更中"}]""",
        "bookshelf.json" to
            """[{"name":"书一","author":"某作者","bookUrl":"https://atomic.example/book/1","origin":"https://atomic.example","tocUrl":"https://atomic.example/book/1","group":77,"durChapterIndex":3,"durChapterTime":1782343455600}]""",
        "rssSources.json" to """[{"sourceUrl":"https://rss-a.example/","sourceName":"甲订阅","enabled":true}]""",
        "cookies.json" to BackupAes.encryptBase64("""[{"url":"cookie.example","cookie":"sid=1"}]""", PASSWORD),
        "readRecord.json" to """[{"bookName":"书一","readTime":100}]""",
    )

    private fun writeArchive(target: Path, sections: Map<String, String>) {
        ZipOutputStream(Files.newOutputStream(target)).use { zip ->
            sections.forEach { (name, body) ->
                zip.putNextEntry(ZipEntry(name))
                zip.write(body.toByteArray(Charsets.UTF_8))
                zip.closeEntry()
            }
        }
    }

    private companion object {
        const val PASSWORD = "backup-pw"
    }
}
