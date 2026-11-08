package io.legado

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import io.legado.ai.McpClient
import io.legado.ai.McpException
import io.legado.ai.McpServerStore
import io.legado.ops.ServerIdentity
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetSocketAddress
import java.net.ServerSocket

/**
 * MCP 客户端的协议判据：对着一个**真的 HTTP 服务**跑，不打桩 HttpClient。
 *
 * 要钉的是"真的发出去的请求长什么样"（方法名、会话头、参数）与"真的回来什么形状"
 * （JSON / SSE 两种、分页游标、JSON-RPC 错误），以及三道安全边界：连不上要说清楚、
 * 内网地址要拒、不许指向这台服务自己。
 */
class McpClientTest {

    private fun server(handler: (method: String, body: String, exchange: HttpExchange) -> Unit): HttpServer {
        val http = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        http.createContext("/mcp") { exchange ->
            val body = exchange.requestBody.use { String(it.readBytes(), Charsets.UTF_8) }
            val method = Regex("\"method\"\\s*:\\s*\"([^\"]+)\"").find(body)?.groupValues?.get(1).orEmpty()
            handler(method, body, exchange)
        }
        http.start()
        return http
    }

    private fun reply(
        exchange: HttpExchange,
        body: String,
        status: Int = 200,
        headers: Map<String, String> = emptyMap(),
        contentType: String = "application/json",
    ) {
        headers.forEach { (key, value) -> exchange.responseHeaders.add(key, value) }
        exchange.responseHeaders.add("Content-Type", contentType)
        val bytes = body.toByteArray()
        exchange.sendResponseHeaders(status, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }

    private fun accepted(exchange: HttpExchange) {
        exchange.sendResponseHeaders(202, -1)
        exchange.close()
    }

    private fun config(port: Int, id: String = "probe") = McpServerStore.Server(
        id = id,
        name = id,
        url = "http://127.0.0.1:$port/mcp",
    )

    private fun freePort(): Int = ServerSocket(0).use { it.localPort }

    @Test
    fun `握手带会话头，两页工具按游标翻完`() {
        val sessions = mutableListOf<String?>()
        val methods = mutableListOf<String>()
        val http = server { method, body, exchange ->
            methods += method
            sessions += exchange.requestHeaders.getFirst("Mcp-Session-Id")
            when (method) {
                "initialize" -> reply(
                    exchange,
                    """{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"fake","version":"1"}}}""",
                    headers = mapOf("Mcp-Session-Id" to "s-1"),
                )
                "notifications/initialized" -> accepted(exchange)
                "tools/list" -> if (body.contains("\"cursor\":\"p2\"")) {
                    reply(
                        exchange,
                        """{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"echo","description":"回显","inputSchema":{"type":"object","properties":{"text":{"type":"string","description":"要回显的文本"}},"required":["text"]}}]}}""",
                    )
                } else {
                    reply(
                        exchange,
                        """{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"now","description":"当前时间","inputSchema":{"type":"object","properties":{}}}],"nextCursor":"p2"}}""",
                    )
                }
                else -> reply(exchange, """{"jsonrpc":"2.0","id":3,"result":{}}""")
            }
        }
        try {
            val client = McpClient(config(http.address.port))
            client.initialize()
            val tools = client.listTools()

            assertEquals(listOf("now", "echo"), tools.map { it.name })
            assertEquals("回显", tools[1].description)
            assertEquals(1, tools[1].inputSchema?.get("properties")?.jsonObject?.size)
            assertEquals("握手之后先发 initialized 通知", "notifications/initialized", methods[1])
            assertNull("握手请求不带会话头", sessions[0])
            assertEquals("会话 id 要带回去", "s-1", sessions[1])
        } finally {
            http.stop(0)
        }
    }

    @Test
    fun `SSE 形态的响应也能解出来`() {
        val http = server { method, _, exchange ->
            when (method) {
                "initialize" -> reply(
                    exchange,
                    "data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":\"2025-06-18\"}}\n\n",
                    contentType = "text/event-stream",
                )
                "notifications/initialized" -> accepted(exchange)
                // 中间夹一条进度通知，最后才是真正的结果：只取第一条的实现会拿到空。
                "tools/list" -> reply(
                    exchange,
                    buildString {
                        appendLine("data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{\"progress\":1}}")
                        appendLine()
                        appendLine("data: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[{\"name\":\"sse_tool\"}]}}")
                        appendLine()
                    },
                    contentType = "text/event-stream",
                )
                else -> reply(exchange, "")
            }
        }
        try {
            val client = McpClient(config(http.address.port))
            client.initialize()
            assertEquals(listOf("sse_tool"), client.listTools().map { it.name })
        } finally {
            http.stop(0)
        }
    }

    @Test
    fun `调用工具把参数原样发出去，并把 content 拼成文本`() {
        var captured = ""
        val http = server { method, body, exchange ->
            when (method) {
                "initialize" -> reply(exchange, """{"jsonrpc":"2.0","id":1,"result":{}}""")
                "notifications/initialized" -> accepted(exchange)
                "tools/call" -> {
                    captured = body
                    reply(
                        exchange,
                        """{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"你好"},{"type":"image","mimeType":"image/png"}],"isError":false}}""",
                    )
                }
                else -> reply(exchange, """{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}""")
            }
        }
        try {
            val client = McpClient(config(http.address.port))
            val result = client.callTool("echo", mapOf("text" to "你好"))
            assertFalse(result.isError)
            assertTrue("正文要拼进来：${result.text}", result.text.startsWith("你好"))
            assertTrue("图片不能静默丢掉：${result.text}", result.text.contains("图片"))
            assertTrue("参数要原样发：$captured", captured.contains("\"arguments\":{\"text\":\"你好\"}"))
        } finally {
            http.stop(0)
        }
    }

    @Test
    fun `会话过期回 404 时重新握手一次再重试`() {
        var inits = 0
        var listCalls = 0
        val http = server { method, _, exchange ->
            when (method) {
                "initialize" -> {
                    inits += 1
                    reply(
                        exchange,
                        """{"jsonrpc":"2.0","id":1,"result":{}}""",
                        headers = mapOf("Mcp-Session-Id" to "s-$inits"),
                    )
                }
                "notifications/initialized" -> accepted(exchange)
                "tools/list" -> {
                    listCalls += 1
                    if (listCalls == 1) {
                        reply(exchange, "", status = 404)
                    } else {
                        reply(exchange, """{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"ok_tool"}]}}""")
                    }
                }
                else -> reply(exchange, "")
            }
        }
        try {
            val client = McpClient(config(http.address.port))
            client.initialize()
            assertEquals(listOf("ok_tool"), client.listTools().map { it.name })
            assertEquals("过期后应重新握手一次", 2, inits)
        } finally {
            http.stop(0)
        }
    }

    @Test
    fun `JSON-RPC 错误码要原样带出来`() {
        val http = server { method, _, exchange ->
            when (method) {
                "initialize" -> reply(exchange, """{"jsonrpc":"2.0","id":1,"result":{}}""")
                "notifications/initialized" -> accepted(exchange)
                "tools/list" -> reply(
                    exchange,
                    """{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"Method not found"}}""",
                )
                else -> reply(exchange, "")
            }
        }
        try {
            val client = McpClient(config(http.address.port))
            val error = assertThrows(McpException::class.java) { client.listTools() }
            assertEquals(-32601, error.code)
            assertEquals("Method not found", error.message)
        } finally {
            http.stop(0)
        }
    }

    @Test
    fun `服务没起来时说人话，不是一句 NullPointerException`() {
        val port = freePort()
        val client = McpClient(config(port))
        val error = assertThrows(McpException::class.java) { client.initialize() }
        assertTrue("要说清连不上哪个地址：${error.message}", error.message.orEmpty().contains("连不上 MCP 服务"))
    }

    @Test
    fun `内网地址被拒：MCP 不是绕过出站闸门的侧门`() {
        // 端口刻意不用 8080/1234：`ServerIdentity` 是进程级全局状态（别的测试会把它设成 8080），
        // 而"指向自己"的判定在"绑回环 + 端口相同"时对任何主机都成立 —— 用同一端口会让这条
        // 判据测到的是另一道闸门，红起来的原因与内网无关。
        val client = McpClient(McpServerStore.Server(id = "lan", url = "http://192.168.1.9:9/mcp"))
        val error = assertThrows(IllegalArgumentException::class.java) { client.initialize() }
        assertTrue("应说明是内网地址：${error.message}", error.message.orEmpty().contains("内网"))
    }

    @Test
    fun `不许指向这台服务自己`() {
        // 全局状态：主机与端口一起存、一起还，别把别的测试设的值改坏。
        val originalHost = ServerIdentity.host
        val originalPort = ServerIdentity.port
        ServerIdentity.init("127.0.0.1", 1234)
        try {
            val client = McpClient(McpServerStore.Server(id = "self", url = "http://127.0.0.1:1234/api/agent/mcp"))
            val error = assertThrows(IllegalArgumentException::class.java) { client.initialize() }
            assertTrue("应说明不能指向自己：${error.message}", error.message.orEmpty().contains("自己"))
        } finally {
            ServerIdentity.init(originalHost, originalPort)
        }
    }
}
