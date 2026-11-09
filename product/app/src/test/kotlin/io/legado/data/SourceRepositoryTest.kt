package io.legado.data

import io.legado.model.SourceHealthCheckRequest
import io.legado.rules.RuleRunner
import io.legado.source.SourceCodec
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

/**
 * `SourceRepository` 的判据。
 *
 * 这一层是从 `http/SourcesRoutes.kt` 抽出来的，端点路径与回包形状一个都没动
 * （`web/test/ApiCatalog.test.ts` 逐条盯着），所以这里只盯**搬动过程中会漂移的语义**：
 * 动作名不认识时要抛（路由据此回 400 而不是 500）、回执文案跟动作对得上、
 * 体检默认不碰停用的源。
 */
class SourceRepositoryTest {

    private class Fixture(val database: Database, val directory: Path, val repository: SourceRepository) {
        fun close() {
            runCatching { database.close() }
            directory.toFile().deleteRecursively()
        }
    }

    private fun fixture(name: String): Fixture {
        val directory = Files.createTempDirectory(name)
        val database = Database(directory.resolve("legado.sqlite").toString())
        database.initialize()
        return Fixture(database, directory, SourceRepository(database, RuleRunner()))
    }

    private fun addSource(database: Database, url: String, enabled: Boolean = true): String {
        database.saveSource(
            SourceCodec.parse("""{"bookSourceUrl":"$url","bookSourceName":"探针 $url"}"""),
            null,
        )
        database.batchUpdateSources(listOf(url), if (enabled) "enable" else "disable")
        return url
    }

    // ==================== 批量整理 ====================

    @Test
    fun `动作名不认识时抛 IllegalArgumentException，路由才能翻成 400`() {
        val fixture = fixture("legado-repo-source-bad-action")
        try {
            val id = addSource(fixture.database, "https://src-probe.example/a")
            val error = runCatching { fixture.repository.batchUpdate(listOf(id), "explode", null) }.exceptionOrNull()
            assertTrue("未知动作应当抛 IllegalArgumentException，实际 $error", error is IllegalArgumentException)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `tag_group 缺标签时抛，不是把整串分组覆盖成空`() {
        val fixture = fixture("legado-repo-source-tag-noarg")
        try {
            val id = addSource(fixture.database, "https://src-probe.example/a")
            assertTrue(
                runCatching { fixture.repository.batchUpdate(listOf(id), "tag_group", null) }
                    .exceptionOrNull() is IllegalArgumentException,
            )
            assertTrue(
                runCatching { fixture.repository.batchUpdate(listOf(id), "tag_group", "   ") }
                    .exceptionOrNull() is IllegalArgumentException,
            )
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `启用停用改的是库里那一行，回执文案跟动作对得上`() {
        val fixture = fixture("legado-repo-source-enable")
        try {
            val id = addSource(fixture.database, "https://src-probe.example/a", enabled = true)

            val disabled = fixture.repository.batchUpdate(listOf(id), "disable", null)
            assertEquals(1, disabled.affected)
            assertEquals("已成功停用 1 个书源", disabled.message)
            assertTrue("库里也要真的停用", fixture.database.listSources(null).single().enabled.not())

            val enabled = fixture.repository.batchUpdate(listOf(id), "enable", null)
            assertEquals("已成功启用 1 个书源", enabled.message)
            assertTrue(fixture.database.listSources(null).single().enabled)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `set_group 传 null 是清空分组，不是不动`() {
        val fixture = fixture("legado-repo-source-group")
        try {
            val id = addSource(fixture.database, "https://src-probe.example/a")

            val moved = fixture.repository.batchUpdate(listOf(id), "set_group", "追更")
            assertEquals("已将 1 个书源移至分组“追更”", moved.message)
            assertEquals("追更", fixture.database.listSources(null).single().group)

            val cleared = fixture.repository.batchUpdate(listOf(id), "set_group", null)
            assertEquals("已清空 1 个书源的分组", cleared.message)
            assertEquals(null, fixture.database.listSources(null).single().group)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `重复 id 只算一次，空 id 被忽略`() {
        val fixture = fixture("legado-repo-source-dedup")
        try {
            val id = addSource(fixture.database, "https://src-probe.example/a")
            val result = fixture.repository.batchUpdate(listOf(id, id, "  "), "enable", null)
            assertEquals("同一个 id 出现两次不该算两个", 1, result.affected)
        } finally {
            fixture.close()
        }
    }

    // ==================== 体检 ====================

    @Test
    fun `体检默认只探启用的源，停用的不碰`() = runBlocking {
        val fixture = fixture("legado-repo-source-health-default")
        try {
            addSource(fixture.database, "https://src-probe.example/on", enabled = true)
            addSource(fixture.database, "https://src-probe.example/off", enabled = false)

            // 1 秒超时：这些源连不上，探针会很快判失败；这里只关心**探了谁**。
            val response = fixture.repository.healthCheck(SourceHealthCheckRequest(timeoutMs = 1000L))

            assertEquals("停用的源不该被探", 1, response.total)
            assertEquals("https://src-probe.example/on", response.results.single().id)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `显式点名时停用的源也会被探`() = runBlocking {
        val fixture = fixture("legado-repo-source-health-explicit")
        try {
            addSource(fixture.database, "https://src-probe.example/on", enabled = true)
            val off = addSource(fixture.database, "https://src-probe.example/off", enabled = false)

            val response = fixture.repository.healthCheck(
                SourceHealthCheckRequest(ids = listOf(off), timeoutMs = 1000L),
            )

            assertEquals(1, response.total)
            assertEquals(off, response.results.single().id)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `点名一个不存在的 id 不会凭空造出一条结果`() = runBlocking {
        val fixture = fixture("legado-repo-source-health-ghost")
        try {
            val response = fixture.repository.healthCheck(
                SourceHealthCheckRequest(ids = listOf("https://src-probe.example/ghost"), timeoutMs = 1000L),
            )
            assertEquals(0, response.total)
            assertEquals(0, response.successCount)
        } finally {
            fixture.close()
        }
    }

    // ==================== 导入 / 导出 ====================

    @Test
    fun `导入再导出能拿回同一份书源`() {
        val fixture = fixture("legado-repo-source-roundtrip")
        try {
            val json = """{"bookSourceUrl":"https://src-probe.example/rt","bookSourceName":"往返"}"""
            val imported = fixture.repository.importSources(listOf(json))
            assertEquals(1, imported.imported)

            val exported = fixture.repository.exportSources(listOf("https://src-probe.example/rt"))
            assertEquals(1, exported.size)
            assertTrue("导出内容里要有书源地址", exported.single().contains("https://src-probe.example/rt"))
        } finally {
            fixture.close()
        }
    }
}
