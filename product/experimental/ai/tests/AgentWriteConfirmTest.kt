package io.legado

import io.legado.ai.AgentConnection
import io.legado.ai.AgentContext
import io.legado.ai.AgentModule
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
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 写操作确认闸（P0-4）：**所有** `writes = true` 的工具，不管从 `runTool` 直接调、
 * 还是经 `tool.call` 转弯调，都必须显式带 `confirm = true`。
 *
 * 为什么要单独一组用例：从前只有 `source.batch` 自己带闸，其余 25 个写工具
 * （删源、改书源、写进度、改分组、删笔记……）一句话就能调起来；而 `tool.call`
 * 是直调 handler 的，只把闸加在 `runTool` 上会被「先 search 再 call」绕过去。
 * 这里逐条把三条路都钉住，并加一条 schema 不变量 —— 参数表里没有 `confirm`，
 * 模型就永远过不了闸，等于把写工具焊死。
 */
class AgentWriteConfirmTest {

    private fun tempDb() = Files.createTempFile("legado-write-confirm", ".sqlite").toString()
    private fun tempDir(tag: String) = Files.createTempDirectory("legado-write-confirm-$tag")

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
        // 必须走 AgentModule.connect：`tool.call` 是在这里注册的，
        // 直接 new Agent(...) 的路径没有它，绕行那条路就测不到。
        val conn = AgentModule.connect(
            database = database,
            runner = runner,
            coverCache = coverCache,
            subscriptions = subscriptions,
            homeDirectory = tempDir("home"),
        )
        return database to conn
    }

    private val payload = """[{"name":"确认闸规则","pattern":"abc","replacement":"xyz","isRegex":false}]"""

    private fun ruleCount(conn: AgentConnection): Int =
        (conn.call("replace.list", mapOf("q" to "确认闸规则")).data as? List<*>)?.size ?: 0

    private fun cleanup(path: String) {
        repeat(3) {
            if (runCatching { Files.deleteIfExists(java.nio.file.Path.of(path)) }.getOrNull() == true) return
            Thread.sleep(150)
        }
        runCatching { Files.deleteIfExists(java.nio.file.Path.of("$path-wal")) }
        runCatching { Files.deleteIfExists(java.nio.file.Path.of("$path-shm")) }
    }

    @Test
    fun `写工具不带 confirm 被拦且数据没有变化`() {
        val path = tempDb()
        try {
            val (db, conn) = connect(path)
            val res = conn.call("replace.import", mapOf("json" to payload))
            assertEquals("无 confirm 必须被拦", "error", res.status)
            assertEquals("confirm_required", res.code)
            assertEquals("被拦之后不许留下半条数据", 0, ruleCount(conn))
            db.close()
        } finally {
            cleanup(path)
        }
    }

    @Test
    fun `写工具带 confirm 正常落库`() {
        val path = tempDb()
        try {
            val (db, conn) = connect(path)
            val res = conn.call("replace.import", mapOf("json" to payload, "confirm" to true))
            assertEquals("带 confirm 应放行：${res.code}/${res.message}", "ok", res.status)
            assertEquals(1, ruleCount(conn))
            db.close()
        } finally {
            cleanup(path)
        }
    }

    @Test
    fun `tool_call 转发写工具同样被拦`() {
        val path = tempDb()
        try {
            val (db, conn) = connect(path)
            val res = conn.call(
                "tool.call",
                mapOf("id" to "replace.import", "args" to mapOf("json" to payload)),
            )
            assertEquals("tool.call 不能成为绕行口", "error", res.status)
            assertEquals("confirm_required", res.code)
            assertEquals(0, ruleCount(conn))
            db.close()
        } finally {
            cleanup(path)
        }
    }

    @Test
    fun `tool_call 转发时带 confirm 可执行`() {
        val path = tempDb()
        try {
            val (db, conn) = connect(path)
            val res = conn.call(
                "tool.call",
                mapOf("id" to "replace.import", "args" to mapOf("json" to payload, "confirm" to true)),
            )
            assertEquals("确认在目标工具入参里，转发应放行：${res.code}/${res.message}", "ok", res.status)
            assertEquals(1, ruleCount(conn))
            db.close()
        } finally {
            cleanup(path)
        }
    }

    @Test
    fun `只读工具不受确认闸影响`() {
        val path = tempDb()
        try {
            val (db, conn) = connect(path)
            assertEquals("ok", conn.call("replace.list", mapOf("q" to "")).status)
            // 经 tool.call 转发只读工具也不该要确认 —— 闸判的是**目标**的 writes，不是调用者自己的。
            assertEquals("ok", conn.call("tool.call", mapOf("id" to "replace.list", "args" to mapOf("q" to ""))).status)
            db.close()
        } finally {
            cleanup(path)
        }
    }

    @Test
    fun `批量工具带 confirm 后不会再被内层要第二次`() {
        val path = tempDb()
        try {
            val (db, conn) = connect(path)
            // 外层闸与 source.batch 自己的闸读同一个 confirm 键：带上了就该一路放行，
            // 不该出现"确认了一次又被告知要确认"。
            val res = conn.call("source.batch", mapOf("ids" to listOf("nope"), "action" to "delete", "confirm" to true))
            assertFalse("带 confirm 后不应再返回 confirm_required", res.code == "confirm_required")
            db.close()
        } finally {
            cleanup(path)
        }
    }

    @Test
    fun `写工具的参数表里有 confirm 只读工具没有`() {
        val path = tempDb()
        try {
            val (db, conn) = connect(path)
            val manifest = conn.manifest().associateBy { it.id }
            for (id in listOf("replace.import", "source.upsert", "shelf.add", "progress.set", "note.add")) {
                val params = manifest[id]?.params?.map { it.name }.orEmpty()
                assertTrue("$id 是写工具，参数表必须给模型留出 confirm：$params", "confirm" in params)
            }
            val readOnly = manifest["replace.list"]?.params?.map { it.name }.orEmpty()
            assertFalse("只读工具不该被塞 confirm：$readOnly", "confirm" in readOnly)
            db.close()
        } finally {
            cleanup(path)
        }
    }
}
