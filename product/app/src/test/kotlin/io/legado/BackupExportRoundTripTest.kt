package io.legado

import io.legado.backup.BackupExporter
import io.legado.backup.BackupImporter
import io.legado.data.Database
import io.legado.data.exportSources
import io.legado.data.importSources
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
}
