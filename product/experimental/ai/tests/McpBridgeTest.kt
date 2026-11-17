package io.legado

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import io.legado.ai.Agent
import io.legado.ai.AgentContext
import io.legado.ai.McpBridge
import io.legado.ai.McpServerStore
import io.legado.cache.CoverCache
import io.legado.data.Database
import io.legado.data.getCookieForUrl
import io.legado.rules.RuleRunner
import io.legado.source.SourceDebugger
import io.legado.source.SourceHealth
import io.legado.subscription.SubscriptionService
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.nio.file.Files
import java.nio.file.Path

/**
 * MCP 桥的判据：配置 → 握手 → 工具挂进注册表 → 模型能调。
 *
 * 三条必须守住的边界：挂不上不算错（对话照常）、停用/删除要摘干净、两台服务的同名工具不许撞。
 */
class McpBridgeTest {

    private fun mcpServer(tools: List<String>, onCall: (String, String) -> String = { _, _ -> "ok" }): HttpServer {
        val http = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        http.createContext("/mcp") { exchange: HttpExchange ->
            val body = exchange.requestBody.use { String(it.readBytes(), Charsets.UTF_8) }
            val method = Regex("\"method\"\\s*:\\s*\"([^\"]+)\"").find(body)?.groupValues?.get(1).orEmpty()
            val reply = when (method) {
                "initialize" -> """{"jsonrpc":"2.0","id":1,"result":{}}"""
                "notifications/initialized" -> ""
                "tools/list" -> buildString {
                    append("""{"jsonrpc":"2.0","id":2,"result":{"tools":[""")
                    append(tools.joinToString(",") {
                        """{"name":"$it","description":"$it 的描述","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]},"annotations":{"readOnlyHint":true}}"""
                    })
                    append("]}}")
                }
                "tools/call" -> {
                    val name = Regex("\"name\"\\s*:\\s*\"([^\"]+)\"").find(body)?.groupValues?.get(1).orEmpty()
                    val text = onCall(name, body)
                    """{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"$text"}],"isError":false}}"""
                }
                else -> ""
            }
            if (method == "notifications/initialized") {
                exchange.sendResponseHeaders(202, -1)
                exchange.close()
                return@createContext
            }
            val bytes = reply.toByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json")
            exchange.sendResponseHeaders(200, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        http.start()
        return http
    }

    private fun freePort(): Int = ServerSocket(0).use { it.localPort }

    /** 真库 + 真网关：只替换 home 目录，好让 MCP 配置落在临时位置。 */
    private fun withAgent(home: Path, block: (Database, Agent) -> Unit) {
        val database = Database(Files.createTempFile("legado-mcp", ".sqlite").toString()).apply { initialize() }
        try {
            val runner = RuleRunner(database = database)
            val ctx = AgentContext(
                database = database,
                runner = runner,
                debugger = SourceDebugger(runner),
                health = SourceHealth(runner),
                subscriptions = SubscriptionService(database) { },
                coverCache = CoverCache(Files.createTempDirectory("mcp-covers"), cookieFor = { database.getCookieForUrl(it) }),
            )
            block(database, Agent(ctx, home))
        } finally {
            database.close()
        }
    }

    @Test
    fun `挂上之后工具进 mcp 组，origin 指向服务，调用真的打到服务端`() {
        val http = mcpServer(listOf("echo")) { _, body -> if (body.contains("你好")) "你说了你好" else "没有参数" }
        val home = Files.createTempDirectory("mcp-home")
        try {
            McpServerStore.register(
                home,
                McpServerStore.Server(id = "demo", name = "演示服务", url = "http://127.0.0.1:${http.address.port}/mcp"),
            )
            withAgent(home) { _, agent ->
                val statuses = agent.mcp.sync()
                assertEquals(1, statuses.size)
                assertTrue("应同步成功：${statuses[0].error}", statuses[0].ok)
                assertEquals(1, statuses[0].toolCount)

                val meta = agent.toolManifest().firstOrNull { it.id == "mcp.demo.echo" }
                assertNotNull("远端工具应挂进注册表", meta)
                assertEquals(McpBridge.GROUP, meta!!.group)
                assertEquals("mcp:demo", meta.origin)
                assertFalse("声明了 readOnlyHint 就算只读", meta.writes)
                assertEquals("参数声明要跟着带过来", listOf("text"), meta.params.map { it.name })

                val result = runBlocking { agent.runTool("mcp.demo.echo", mapOf("text" to "你好")) }
                assertEquals("ok", result.status)
                assertTrue("结果应来自服务端：${result.data}", result.data.toString().contains("你说了你好"))
            }
        } finally {
            http.stop(0)
        }
    }

    @Test
    fun `服务不可达时只是少一组工具，对话能力照旧`() {
        val home = Files.createTempDirectory("mcp-home-down")
        McpServerStore.register(
            home,
            McpServerStore.Server(id = "dead", name = "没起来", url = "http://127.0.0.1:${freePort()}/mcp"),
        )
        withAgent(home) { _, agent ->
            val statuses = agent.mcp.sync()
            assertFalse(statuses[0].ok)
            assertTrue("要说清原因：${statuses[0].error}", statuses[0].error.orEmpty().contains("连不上"))
            assertNull("挂不上就不该留工具", agent.registry.find("mcp.dead.anything"))
            // 关键：内置工具一个不少 —— 一台外部服务没起来不该让整条对话不可用。
            assertNotNull(agent.registry.find("source.list"))
            assertTrue(agent.toolManifest().size > 10)
        }
    }

    @Test
    fun `停用与删除都要把工具摘干净`() {
        val http = mcpServer(listOf("echo"))
        val home = Files.createTempDirectory("mcp-home-off")
        try {
            val url = "http://127.0.0.1:${http.address.port}/mcp"
            McpServerStore.register(home, McpServerStore.Server(id = "demo", url = url))
            withAgent(home) { _, agent ->
                agent.mcp.sync()
                assertNotNull(agent.registry.find("mcp.demo.echo"))

                McpServerStore.register(home, McpServerStore.Server(id = "demo", url = url, enabled = false))
                agent.mcp.sync(force = true)
                assertNull("停用后工具要消失", agent.registry.find("mcp.demo.echo"))

                McpServerStore.register(home, McpServerStore.Server(id = "demo", url = url))
                agent.mcp.sync(force = true)
                assertNotNull(agent.registry.find("mcp.demo.echo"))

                agent.mcp.forget("demo")
                assertNull("删除后工具要消失", agent.registry.find("mcp.demo.echo"))
            }
        } finally {
            http.stop(0)
        }
    }

    @Test
    fun `两台服务有同名工具时 id 不会撞`() {
        val first = mcpServer(listOf("echo"))
        val second = mcpServer(listOf("echo"))
        val home = Files.createTempDirectory("mcp-home-two")
        try {
            McpServerStore.register(home, McpServerStore.Server(id = "one", url = "http://127.0.0.1:${first.address.port}/mcp"))
            McpServerStore.register(home, McpServerStore.Server(id = "two", url = "http://127.0.0.1:${second.address.port}/mcp"))
            withAgent(home) { _, agent ->
                val statuses = agent.mcp.sync()
                assertTrue(statuses.all { it.ok })
                assertNotNull(agent.registry.find("mcp.one.echo"))
                assertNotNull(agent.registry.find("mcp.two.echo"))
                assertEquals("mcp:one", agent.registry.find("mcp.one.echo")!!.meta.origin)
                assertEquals("mcp:two", agent.registry.find("mcp.two.echo")!!.meta.origin)
            }
        } finally {
            first.stop(0)
            second.stop(0)
        }
    }
}
