package io.legado

import io.legado.ai.AgentConnection
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 验证"程序内部 AI 连接 API"可交付使用：
 *  1) 不新增任何 HTTP 路由（本测试全程只在进程内）；
 *  2) 连接句柄 [AgentConnection] 能读、能写、且写真正落库；
 *  3) 护栏在连接层照常生效；
 *  4) 一份多步任务（manifest → 写 → 读回）能在内部闭环完成。
 */
class AgentConnectionTest {

    private fun tempDb() = Files.createTempFile("legado-conn-test", ".sqlite").toString()
    private fun tempDir(tag: String) = Files.createTempDirectory("legado-conn-$tag")

    private fun connect(dbPath: String): Pair<Database, AgentConnection> {
        val database = Database(dbPath).apply { initialize() }
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
        return database to AgentConnection(io.legado.ai.Agent(ctx, tempDir("home")))
    }

    @Test
    fun `连接层：manifest 返回非空且含已知工具`() {
        val path = tempDb()
        try {
            val (db, conn) = connect(path)
            val manifest = conn.manifest()
            assertTrue("工具清单应非空", manifest.isNotEmpty())
            assertTrue("应含 replace.import", manifest.any { it.id == "replace.import" })
            assertTrue("应含 source.list", manifest.any { it.id == "source.list" })
            db.close()
        } finally {
            cleanup(path)
        }
    }

    @Test
    fun `连接层：写操作真实落库并通过连接读回`() {
        val path = tempDb()
        try {
            val (db, conn) = connect(path)
            // 写：导入一条净化规则
            val payload = """[{"name":"连接测试规则","pattern":"x","replacement":"y","isRegex":false}]"""
            val import = conn.call("replace.import", mapOf("json" to payload))
            assertEquals("import 应 ok：${import.code}/${import.message}", "ok", import.status)
            // 读回：按 q 过滤
            val list = conn.call("replace.list", mapOf("q" to "连接测试规则"))
            assertEquals("ok", list.status)
            val items = list.data as List<*>
            assertEquals(1, items.size)
            assertTrue(items[0].toString().contains("连接测试规则"))
            db.close()
        } finally {
            cleanup(path)
        }
    }

    @Test
    fun `连接层：批量删除无 confirm 被护栏拦截`() {
        val path = tempDb()
        try {
            val (db, conn) = connect(path)
            val res = conn.call("source.batch", mapOf("ids" to listOf("a", "b"), "action" to "delete"))
            assertEquals("error", res.status)
            assertEquals("confirm_required", res.code)
            db.close()
        } finally {
            cleanup(path)
        }
    }

    @Test
    fun `连接层：公网绑定意图被 refuseExternalBind 拒掉`() {
        assertNotNull("0.0.0.0 必须拒绝", Guardrails.refuseExternalBind("0.0.0.0"))
        assertEquals("localhost 应放行（返回 null）", null, Guardrails.refuseExternalBind("localhost"))
    }

    @Test
    fun `连接层：多步任务 manifest 到 写 到 读回 内部闭环`() {
        val path = tempDb()
        try {
            val (db, conn) = connect(path)
            // 第 1 步：看清能力面（连接方必须先看再调）
            val ids = conn.manifest().map { it.id }
            assertTrue("能力面应覆盖读/写/调试", ids.containsAll(listOf("replace.list", "replace.import", "source.health")))
            // 第 2 步：写
            val import = conn.call(
                "replace.import",
                mapOf("json" to """[{"name":"闭环规则","pattern":"z","replacement":"w","isRegex":false}]"""),
            )
            assertEquals("ok", import.status)
            // 第 3 步：读回验证写已生效
            val back = conn.call("replace.list", mapOf("q" to "闭环规则"))
            assertEquals(1, (back.data as List<*>).size)
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
