package io.legado

import io.legado.backup.BackupExporter
import io.legado.backup.BackupImporter
import io.legado.model.ReplaceRule
import io.legado.data.Database
import io.legado.data.createBookGroup
import io.legado.data.exportReplaceRules
import io.legado.data.listBookGroups
import io.legado.data.exportSources
import io.legado.data.importSources
import io.legado.data.saveReplaceRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.util.zip.ZipInputStream

/**
 * 备份导出（第一域：书源）的往返判据。
 *
 * 只验"导出 → 导回空库 → 逐条 payload 相等"这一条主链，外加包形状（条目名 + JSON 数组）。
 * 这条判据的价值在**双向**：导入侧的字段映射此前只有单向证据（手机包能进来），
 * 现在必须能把自己吐出去的包原样吃回来。
 */
class BackupExportRoundTripTest {

    private val sources = listOf(
        """{"bookSourceUrl":"https://alpha.example/##甲","bookSourceName":"甲源","bookSourceGroup":"测试","enabled":true,"ruleSearch":{"bookList":"@css:.item","name":"@css:.name"},"ruleContent":{"content":"@css:.content"}}""",
        """{"bookSourceUrl":"https://beta.example/##乙","bookSourceName":"乙源","enabled":false}""",
    )

    @Test
    fun `导出的书源包能原样导回空库`() {
        val directory = Files.createTempDirectory("legado-backup-export")
        val source = Database(directory.resolve("source.sqlite").toString())
        val target = Database(directory.resolve("target.sqlite").toString())
        try {
            source.initialize()
            target.initialize()
            assertEquals(2, source.importSources(sources).imported)

            val bytes = ByteArrayOutputStream().also { BackupExporter.exportSources(source, it) }.toByteArray()

            // 包形状：唯一一条 bookSource.json，内容是一整个 JSON 数组
            ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
                val entry = zip.nextEntry
                assertEquals("bookSource.json", entry?.name)
                val text = zip.readBytes().toString(Charsets.UTF_8)
                assertTrue("必须是 JSON 数组：${text.take(40)}", text.startsWith("[") && text.endsWith("]"))
                assertTrue("两条书源都要在包里", text.contains("甲源") && text.contains("乙源"))
            }

            // 导回空库：数量一致，且逐条 payload 与源库完全相同
            val archive = directory.resolve("export.zip")
            Files.write(archive, bytes)
            assertEquals(2, BackupImporter(target).import(archive).sources)
            assertEquals(source.exportSources(null), target.exportSources(null))
        } finally {
            source.close()
            target.close()
            directory.toFile().deleteRecursively()
        }
    }

    @Test
    fun `空库导出的仍然是一个合法的空数组`() {
        val directory = Files.createTempDirectory("legado-backup-export-empty")
        val database = Database(directory.resolve("empty.sqlite").toString())
        try {
            database.initialize()
            val bytes = ByteArrayOutputStream().also { BackupExporter.exportSources(database, it) }.toByteArray()
            ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
                assertEquals("bookSource.json", zip.nextEntry?.name)
                assertEquals("[]", zip.readBytes().toString(Charsets.UTF_8))
            }
        } finally {
            database.close()
            directory.toFile().deleteRecursively()
        }
    }

    @Test
    fun `导出的替换规则包能原样导回空库`() {
        val directory = Files.createTempDirectory("legado-backup-export-rules")
        val source = Database(directory.resolve("source.sqlite").toString())
        val target = Database(directory.resolve("target.sqlite").toString())
        try {
            source.initialize()
            target.initialize()
            source.saveReplaceRule(
                ReplaceRule(
                    name = "去广告",
                    group = "净化",
                    pattern = "<div class=\"ad\".*?</div>",
                    replacement = "",
                    isRegex = true,
                    scope = ".*",
                    excludeScope = null,
                    scopeTitle = true,
                    scopeContent = true,
                    isEnabled = true,
                    order = 1,
                    timeoutMillisecond = 3000L,
                ),
            )
            source.saveReplaceRule(
                ReplaceRule(
                    name = "换行合并",
                    group = null,
                    pattern = "\\n+",
                    replacement = "\n",
                    isRegex = false,
                    scope = null,
                    excludeScope = ".*漫画.*",
                    scopeTitle = false,
                    scopeContent = false,
                    isEnabled = false,
                    order = 2,
                    timeoutMillisecond = 800L,
                ),
            )

            val bytes = ByteArrayOutputStream().also { BackupExporter.exportReplaceRules(source, it) }.toByteArray()

            // 包形状：唯一一条 replaceRule.json，内容是一整个 JSON 数组
            ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
                assertEquals("replaceRule.json", zip.nextEntry?.name)
                val text = zip.readBytes().toString(Charsets.UTF_8)
                assertTrue("必须是 JSON 数组：${text.take(40)}", text.startsWith("[") && text.endsWith("]"))
                assertTrue("两条规则都要在包里", text.contains("去广告") && text.contains("换行合并"))
            }

            val archive = directory.resolve("rules.zip")
            Files.write(archive, bytes)
            assertEquals("导入条数", 2, BackupImporter(target).import(archive).rules)

            // 逐字段比对：id 也一起比（导出带 id，导入按 id upsert）
            assertEquals(
                "规则字段必须逐条相同",
                source.exportReplaceRules(null).map(::comparable),
                target.exportReplaceRules(null).map(::comparable),
            )
        } finally {
            source.close()
            target.close()
            directory.toFile().deleteRecursively()
        }
    }


    @Test
    fun `导出的分组包能原样导回空库`() {
        val directory = Files.createTempDirectory("legado-backup-export-groups")
        val source = Database(directory.resolve("source.sqlite").toString())
        val target = Database(directory.resolve("target.sqlite").toString())
        try {
            source.initialize()
            target.initialize()
            source.createBookGroup("玄幻")
            source.createBookGroup("都市")

            val bytes = ByteArrayOutputStream().also { BackupExporter.exportBookGroups(source, it) }.toByteArray()

            ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
                assertEquals("bookGroup.json", zip.nextEntry?.name)
                val text = zip.readBytes().toString(Charsets.UTF_8)
                assertTrue("必须是 JSON 数组：${text.take(40)}", text.startsWith("[") && text.endsWith("]"))
                assertTrue("两个分组都要在包里", text.contains("玄幻") && text.contains("都市"))
            }

            val archive = directory.resolve("groups.zip")
            Files.write(archive, bytes)
            assertEquals("导入条数", 2, BackupImporter(target).import(archive).bookGroups)

            // 分组号由导入侧按**名字**重新映射（importBookGroupsOn 的语义），所以比名字与条数、不硬比 id：
            // 源库分组号是 3、7 时导进空库会变成 1、2，这是设计如此（见设计文档 §6 开放问题 1）。
            assertEquals(source.listBookGroups().map { it.name }, target.listBookGroups().map { it.name })
            assertEquals(2, target.listBookGroups().size)
        } finally {
            source.close()
            target.close()
            directory.toFile().deleteRecursively()
        }
    }

    /** 参与往返比对的字段；createdAt/updatedAt 是导入时按当前时间写的，不比。 */
    private fun comparable(rule: ReplaceRule): List<Any?> = listOf(
        rule.id, rule.name, rule.group, rule.pattern, rule.replacement, rule.isRegex,
        rule.scope, rule.excludeScope, rule.scopeTitle, rule.scopeContent,
        rule.isEnabled, rule.order, rule.timeoutMillisecond,
    )
}
