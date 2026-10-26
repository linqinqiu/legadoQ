package io.legado

import io.legado.ai.Agent
import io.legado.ai.AgentContext
import io.legado.ai.Guardrails
import io.legado.cache.CoverCache
import io.legado.data.Database
import io.legado.data.getCookieForUrl
import io.legado.rules.RuleRunner
import io.legado.source.SourceDebugger
import io.legado.source.SourceHealth
import io.legado.subscription.SubscriptionService
import java.nio.file.Files
import kotlin.text.isNotBlank
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 验证「进程内 AI 框架」运行正常：用真实的既有服务对象构造 Agent，
 * 跑通 读 / 写 / 护栏 三条路径。不新增任何 HTTP 路由。
 */
class AgentFrameworkTest {

    private fun tempDb(): String = Files.createTempFile("legado-agent-test", ".sqlite").toString()
    private fun tempDir(tag: String) = Files.createTempDirectory("legado-agent-$tag")

    private fun buildAgent(dbPath: String): Pair<Database, Agent> {
        val database = Database(dbPath)
        database.initialize()
        val runner = RuleRunner(database = database)
        val coverCache = CoverCache(
            directory = tempDir("covers"),
            cookieFor = { database.getCookieForUrl(it) },
        )
        val subscriptions = SubscriptionService(database) { }
        val ctx = AgentContext(
            database = database,
            runner = runner,
            debugger = SourceDebugger(runner),
            health = SourceHealth(runner),
            subscriptions = subscriptions,
            coverCache = coverCache,
        )
        return database to Agent(ctx, tempDir("home"))
    }

    /** 读路径：空库下 list replace rules 返回 ok + 空列表 */
    @Test
    fun `读路径 空库下列出净化规则返回 ok`() {
        val path = tempDb()
        try {
            val (db, agent) = buildAgent(path)
            runBlocking {
                val res = agent.runTool("replace.list", mapOf("q" to ""))
                assertEquals("ok", res.status)
                assertTrue("data 应为空列表", (res.data as? List<*>)?.isEmpty() == true)
            }
            db.close()
        } finally {
            cleanup(path)
        }
    }

    /** 写路径：import replace rules 真正落库，再读回来 */
    @Test
    fun `写路径 import 净化规则落库后可被 list 读到`() {
        val path = tempDb()
        try {
            val (db, agent) = buildAgent(path)
            val payload = """[{"name":"测试规则","pattern":"abc","replacement":"xyz","isRegex":false}]"""
            runBlocking {
                val import = agent.runTool("replace.import", mapOf("json" to payload))
                assertEquals("import 应 ok：${import.code}/${import.message}", "ok", import.status)
                val res = agent.runTool("replace.list", mapOf("q" to "测试规则"))
                assertEquals("ok", res.status)
                val list = res.data as List<*>
                assertEquals(1, list.size)
                assertTrue(list[0].toString().contains("测试规则"))
            }
            db.close()
        } finally {
            cleanup(path)
        }
    }

    /** 护栏：批量删除无 confirm 应被拦截（confirm_required） */
    @Test
    fun `护栏 无 confirm 的批量删除被拦截`() {
        val path = tempDb()
        try {
            val (db, agent) = buildAgent(path)
            runBlocking {
                val res = agent.runTool("source.batch", mapOf("ids" to listOf("nope"), "action" to "delete"))
                assertEquals("error", res.status)
                assertEquals("confirm_required", res.code)
            }
            db.close()
        } finally {
            cleanup(path)
        }
    }

    /** 护栏：refuseExternalBind 拒绝 0.0.0.0，允许回环（返回 null 表示放行） */
    @Test
    fun `护栏 refuseExternalBind 拒绝公网放行回环`() {
        assertEquals("127.0.0.1 应放行（返回 null）", null, Guardrails.refuseExternalBind("127.0.0.1"))
        assertEquals("localhost 应放行（返回 null）", null, Guardrails.refuseExternalBind("localhost"))
        assertNotNull("0.0.0.0 必须拒绝", Guardrails.refuseExternalBind("0.0.0.0"))
        assertNotNull("公网地址必须拒绝", Guardrails.refuseExternalBind("10.0.0.5"))
    }

    /** 能力面：manifest 能生成且含已知工具 */
    @Test
    fun `能力面 Agent 能生成含 replace-import 的工具清单`() {
        val path = tempDb()
        try {
            val (db, agent) = buildAgent(path)
            val manifest = agent.toolManifest()
            assertTrue("manifest 应非空", manifest.isNotEmpty())
            assertTrue("manifest 应含 replace.import 工具", manifest.any { it.id == "replace.import" })
            db.close()
        } finally {
            cleanup(path)
        }
    }

    private fun cleanup(path: String) {
        repeat(3) {
            if (runCatching { Files.deleteIfExists(java.nio.file.Path.of(path)) }.getOrNull() == true) return
            Thread.sleep(150)
        }
        runCatching { Files.deleteIfExists(java.nio.file.Path.of("$path-wal")) }
        runCatching { Files.deleteIfExists(java.nio.file.Path.of("$path-shm")) }
    }
}
