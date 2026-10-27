package io.legado

import com.sun.net.httpserver.HttpServer
import io.legado.ai.AgentProfileStore
import io.legado.ai.OpenAiCompatibleProvider
import io.legado.http.NetworkSecurity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetSocketAddress

/**
 * `OpenAiCompatibleProvider.listModels` —— 登记连接时"自动补全模型名"的那一段。
 *
 * 真起一个本机 HTTP 服务来验，而不是打桩 HttpClient：要钉的正是**真的发出去的请求长什么样**
 * （路径 `/v1/models`、Bearer 头）与**真的回来什么形状**（`data[].id`、Ollama 的 `models[].name`）。
 *
 * 回环口子显式打开（`loopbackAllowed = { true }`），因为测试服务就在 127.0.0.1；
 * 生产默认仍然关着，由 `LoopbackBaseUrlGateTest` 守。
 */
class ModelListTest {
    private fun provider() = OpenAiCompatibleProvider(loopbackAllowed = { true })

    private fun serve(status: Int, body: String, onRequest: (String?) -> Unit = {}): HttpServer {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/v1/models") { exchange ->
            onRequest(exchange.requestHeaders.getFirst("Authorization"))
            val bytes = body.toByteArray()
            exchange.sendResponseHeaders(status, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
        return server
    }

    private fun profile(port: Int, apiKey: String? = null) = AgentProfileStore.Profile(
        id = "probe",
        name = "probe",
        kind = AgentProfileStore.ProfileKind.OPENAI_COMPATIBLE,
        baseUrl = "http://127.0.0.1:$port/v1",
        apiKey = apiKey,
    )

    @Test
    fun `OpenAI 形状：取 data 里的 id，去重并排序，鉴权头带上`() {
        var authorization: String? = null
        val server = serve(200, """{"data":[{"id":"gpt-4o"},{"id":"claude-3"},{"id":"gpt-4o"}]}""") { authorization = it }
        try {
            val models = provider().listModels(profile(server.address.port, apiKey = "sk-test"))
            assertEquals(listOf("claude-3", "gpt-4o"), models)
            assertEquals("Bearer sk-test", authorization)
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun `Ollama 形状：没有 data 时读 models 里的 name`() {
        val server = serve(200, """{"models":[{"name":"llama3:8b"},{"name":"qwen2.5:7b"}]}""")
        try {
            assertEquals(listOf("llama3:8b", "qwen2.5:7b"), provider().listModels(profile(server.address.port)))
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun `非 2xx 要说清是上游拒绝，而不是返回空清单`() {
        val server = serve(401, """{"error":{"message":"bad key"}}""")
        try {
            val error = runCatching { provider().listModels(profile(server.address.port, apiKey = "sk-bad")) }.exceptionOrNull()
            assertTrue("应抛 UnreachableTargetException，实际是 $error", error is NetworkSecurity.UnreachableTargetException)
            assertTrue("错误里要有状态码，用户才知道是 key 被拒", error?.message?.contains("401") == true)
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun `返回体不是 JSON 时给出可读原因`() {
        val server = serve(200, "<html>login required</html>")
        try {
            val error = runCatching { provider().listModels(profile(server.address.port)) }.exceptionOrNull()
            assertTrue(error is NetworkSecurity.UnreachableTargetException)
            assertTrue(error?.message?.contains("不是 JSON") == true)
        } finally {
            server.stop(0)
        }
    }
}
