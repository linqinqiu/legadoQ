package io.legado

import io.ktor.client.*
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

/**
 * AI 外呼**失败分类**的 HTTP 层判据（用户 2026-10-23 报告的一串缺陷里最严重的三条都在这儿）。
 *
 * 为什么单开一个文件、且必须起真服务：SSRF 那批判据只断言"provider 抛 `IllegalArgumentException`"，
 * 从没验过**用户实际看到的那个状态码与那句话**。于是三类错互相顶包、带病发布，全量测试一路绿：
 *   - 填了内网地址 → 从前 500（`outcomeStatus` 压根没有 `invalid_request` 分支，落进 else）；
 *   - 域名打错一个字母 → 从前 500（DNS 失败与被拒抛的是同一个异常，上层只能一把抓）；
 *   - 阅读理解路径填内网 → 从前 502（`runCatching` 把拒绝压成 null，"被拒绝"说成"连不上"）。
 *   三种修法完全不同的事，界面上长成两个样子，用户照着报错去查网络。
 *
 * 现在的期望：**能被客户端修好的（地址不合法/被闸门拒）一律 400 并带回真因；
 * 到不了的才是 502**。四条判据把这条线钉死。
 */
class AgentErrorClassHttpTest {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    private fun tempDir(tag: String) = Files.createTempDirectory("legado-errcls-$tag")

    private fun ApplicationTestBuilder.makeClient() = createClient {
        install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
    }

    private suspend fun readJson(resp: HttpResponse): JsonElement =
        json.parseToJsonElement(resp.bodyAsText())

    private fun serverConfig(dbPath: String, home: Path) = ServerConfig(
        host = "127.0.0.1", port = 8080, databasePath = dbPath,
        coverCacheDirectory = Files.createTempDirectory("legado-errcls-covers"),
        homeDirectory = home,
    )

    private fun cleanup(dbPath: String, vararg dirs: Path) {
        runCatching { Files.deleteIfExists(Path.of(dbPath)) }
        runCatching { Files.deleteIfExists(Path.of("$dbPath-wal")) }
        runCatching { Files.deleteIfExists(Path.of("$dbPath-shm")) }
        dirs.forEach { runCatching { it.toFile().deleteRecursively() } }
    }

    /** 登记一个连接（profileStore 落临时 home，测试之间互不影响）。 */
    private suspend fun register(c: HttpClient, baseUrl: String) = c.post("/api/agent/connections") {
        contentType(ContentType.Application.Json)
        setBody("""{"name":"probe","kind":"openai-compatible","baseUrl":"$baseUrl","model":"m"}""")
    }

    private suspend fun chat(c: HttpClient, text: String = "ping"): HttpResponse =
        c.post("/api/agent/chat") {
            contentType(ContentType.Application.Json)
            setBody("""{"messages":[{"role":"user","content":"$text"}]}""")
        }

    private suspend fun comprehend(c: HttpClient): HttpResponse {
        // 正文要在 Kotlin 侧拼好再塞进 JSON 字面量：把 `.repeat(20)` 写进字符串模板里
        // 只会发出一个非法请求体，于是测到的永远是"请求体不是合法的"，根本没走到闸门。
        val text = "青阅是一款本地阅读服务。".repeat(20)
        return c.post("/api/agent/comprehend") {
            contentType(ContentType.Application.Json)
            setBody(Json.encodeToString(
                JsonObject.serializer(),
                JsonObject(mapOf("text" to JsonPrimitive(text))),
            ))
        }
    }

    @Test
    fun `private network baseUrl is a 400 with the real reason, not a 500`() = testApplication {
        val dbPath = Files.createTempFile("legado-errcls-priv", ".sqlite").toString()
        val home = tempDir("home-priv")
        try {
            application { legadoApplication(serverConfig(dbPath, home)) }
            val c = makeClient()
            assertEquals(HttpStatusCode.OK, register(c, "http://192.168.1.1/v1").status)

            val resp = chat(c)
            val body = readJson(resp).jsonObject
            assertEquals("内网地址是客户端能修的，必须 400（从前落进 else 变 500）: ${resp.status}",
                HttpStatusCode.BadRequest, resp.status)
            assertEquals("invalid_request", body["code"]?.jsonPrimitive?.content)
            val message = body["message"]?.jsonPrimitive?.content ?: ""
            // 从前这里只有一句写死的套话（甚至没有 message），用户看到"AI 请求失败：invalid_request"
            // 完全不知道该改什么。真因必须原样带回。
            assertTrue("要把闸门那句中文带回去，实际「$message」",
                message.contains("内网") || message.contains("本机"))
        } finally {
            cleanup(dbPath, home)
        }
    }

    @Test
    fun `unresolvable domain is a 502 naming DNS, not an invalid_request`() = testApplication {
        val dbPath = Files.createTempFile("legado-errcls-dns", ".sqlite").toString()
        val home = tempDir("home-dns")
        try {
            application { legadoApplication(serverConfig(dbPath, home)) }
            val c = makeClient()
            // .invalid 是 RFC 保留的"必然解析不了"域名：不需要联网就能稳定复现 DNS 失败。
            assertEquals(HttpStatusCode.OK, register(c, "https://typo-in-the-name.invalid/v1").status)

            val resp = chat(c)
            val body = readJson(resp).jsonObject
            assertEquals("地址本身没问题、只是到不了 → 502（从前被当成「请求非法」报 500）: ${resp.status}",
                HttpStatusCode.BadGateway, resp.status)
            assertEquals("upstream_unreachable", body["code"]?.jsonPrimitive?.content)
            val message = body["message"]?.jsonPrimitive?.content ?: ""
            assertTrue("要说清是解析不了，用户才知道去检查拼写，实际「$message」",
                message.contains("无法解析") || message.contains("解析"))
        } finally {
            cleanup(dbPath, home)
        }
    }

    /**
     * 阅读理解的失败分类必须与 chat **一致**。
     * 从前这两条路径分叉得很离谱：同一个内网 baseUrl，chat 报 500、comprehend 报 502
     * —— 因为 comprehend 走 `callExternalHttp` 的 `runCatching` 把异常压成 null，
     * 于是"被拒绝"被说成"连不上"。这条判据就是防止将来再分叉。
     */
    @Test
    fun `comprehend classifies the same failures the same way chat does`() = testApplication {
        val dbPath = Files.createTempFile("legado-errcls-comp", ".sqlite").toString()
        val home = tempDir("home-comp")
        try {
            application { legadoApplication(serverConfig(dbPath, home)) }
            val c = makeClient()

            assertEquals(HttpStatusCode.OK, register(c, "http://10.0.0.5/v1").status)
            val blocked = comprehend(c)
            val blockedBody = readJson(blocked).jsonObject
            assertEquals("内网地址在阅读理解也必须是 400: ${blocked.status}", HttpStatusCode.BadRequest, blocked.status)
            assertEquals("invalid_request", blockedBody["code"]?.jsonPrimitive?.content)
            val blockedMessage = blockedBody["message"]?.jsonPrimitive?.content ?: ""
            assertTrue("阅读理解也要带回真因，实际「$blockedMessage」",
                blockedMessage.contains("内网") || blockedMessage.contains("本机"))

            // 换一个解析不了的地址：同一条路径该报 502，而不是跟着上一例的写法
            c.delete("/api/agent/connections/probe")
            assertEquals(HttpStatusCode.OK, register(c, "https://also-a-typo.invalid/v1").status)
            val unreachable = comprehend(c)
            assertEquals("到不了才是 502: ${unreachable.status}", HttpStatusCode.BadGateway, unreachable.status)
            assertEquals("upstream_unreachable", readJson(unreachable).jsonObject["code"]?.jsonPrimitive?.content)
        } finally {
            cleanup(dbPath, home)
        }
    }

    /** 没登记连接仍是 409：这一条不该被分类改动带偏（配置缺失 ≠ 地址错误）。 */
    @Test
    fun `missing connection stays 409 and never collapses into invalid_request`() = testApplication {
        val dbPath = Files.createTempFile("legado-errcls-none", ".sqlite").toString()
        val home = tempDir("home-none")
        try {
            application { legadoApplication(serverConfig(dbPath, home)) }
            val c = makeClient()
            val resp = chat(c)
            assertEquals(HttpStatusCode.Conflict, resp.status)
            assertEquals("no_connection", readJson(resp).jsonObject["code"]?.jsonPrimitive?.content)
        } finally {
            cleanup(dbPath, home)
        }
    }
}
