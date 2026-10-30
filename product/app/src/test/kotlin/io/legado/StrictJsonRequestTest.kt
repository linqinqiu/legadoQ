package io.legado

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.ByteArrayContent
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.testing.testApplication
import io.legado.model.ImportRequest
import io.legado.model.ReplaceRule
import io.legado.model.SourceSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import kotlinx.serialization.json.Json

/**
 * JSON 请求体的编码闸门（2026-10-30 的事故是这一条的由来）。
 *
 * 用 GBK 发中文的客户端（cmd 里的 curl、一些脚本）以前会被 Ktor 用替换字符解出来，
 * 接口回 200，库里却存进一串 `U+FFFD` —— 「体检异常」在界面上再也认不出来。
 * 这里钉住三件事：
 * ① 非法字节在边界上 400，且**一个字段都没写进库**；
 * ② 正常 UTF-8 中文照常通过；
 * ③ 显式声明 `charset=gbk` 的请求按声明解码 —— 客户端把话说清楚就还能用。
 */
class StrictJsonRequestTest {

    private fun tempConfig(): ServerConfig {
        val dbPath = Files.createTempFile("legado-strict-json", ".sqlite").toString()
        val coverDir = Files.createTempDirectory("legado-strict-json-covers")
        return ServerConfig(
            host = "127.0.0.1", port = 8080, databasePath = dbPath, allowExternalBind = false,
            coverCacheDirectory = coverDir,
        )
    }

    private fun cleanup(config: ServerConfig) {
        runCatching { Files.deleteIfExists(java.nio.file.Path.of(config.databasePath)) }
        runCatching { config.coverCacheDirectory.toFile().deleteRecursively() }
    }

    private val sampleSource =
        """{"bookSourceUrl":"https://strict.example","bookSourceName":"编码测试源","searchUrl":"/search?k={{key}}","ruleSearch":{"bookList":"$.data","name":"$.title","bookUrl":"/b/{{$.id}}"}}"""

    private fun batchBody(group: String) =
        """{"ids":["https://strict.example"],"action":"set_group","group":"$group"}"""

    private suspend fun HttpClient.importSource() {
        val imported = post("/api/sources/import") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody(ImportRequest(listOf(sampleSource)))
        }
        assertEquals(HttpStatusCode.OK, imported.status)
    }

    private suspend fun HttpClient.sourceGroups(): List<String?> =
        get("/api/sources").body<List<SourceSummary>>().map { it.group }

    @Test
    fun `GBK 中文请求体返回 400，且分组没有被写入`() {
        val config = tempConfig()
        try {
            testApplication {
                application { legadoApplication(config) }
                val client = createClient { install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) } }
                client.importSource()

                // 同样是合法 JSON，只是字节是 GBK 的「体检异常」——以前会 200 并写进一串替换字符。
                val gbk = batchBody("体检异常").toByteArray(charset("GBK"))
                val resp = client.post("/api/sources/batch") {
                    header(HttpHeaders.ContentType, "application/json")
                    setBody(ByteArrayContent(gbk, ContentType.Application.Json))
                }
                assertEquals(HttpStatusCode.BadRequest, resp.status)
                val message = resp.bodyAsText()
                assertTrue("报错要说清楚是编码问题：$message", message.contains("UTF-8"))

                // 拒绝要拒在边界上：库里的分组保持为空，不能“先写一半再报错”。
                val groups = client.sourceGroups()
                assertEquals(1, groups.size)
                assertNull("乱码请求不该改动任何字段", groups[0])
            }
        } finally { cleanup(config) }
    }

    @Test
    fun `UTF-8 中文分组照常写入`() {
        val config = tempConfig()
        try {
            testApplication {
                application { legadoApplication(config) }
                val client = createClient { install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) } }
                client.importSource()
                val resp = client.post("/api/sources/batch") {
                    header(HttpHeaders.ContentType, "application/json")
                    setBody(ByteArrayContent(batchBody("体检异常").toByteArray(Charsets.UTF_8), ContentType.Application.Json))
                }
                assertEquals(HttpStatusCode.OK, resp.status)
                assertEquals(listOf<String?>("体检异常"), client.sourceGroups())
            }
        } finally { cleanup(config) }
    }

    @Test
    fun `GBK 的净化规则导入请求返回 400 而不是静默导入乱码`() {
        val config = tempConfig()
        try {
            testApplication {
                application { legadoApplication(config) }
                val client = createClient { install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) } }
                val rulesJson =
                    """[{"id":"gbk-rule","name":"去广告","pattern":"广告.*","replacement":"替换文案"}]"""
                val gbkBody = rulesJson.toByteArray(charset("GBK"))

                // 按原始文本读的接口以前走 receiveText：非法字节变成 U+FFFD 后照常 200 入库。
                val rejected = client.post("/api/replace-rules/import") {
                    header(HttpHeaders.ContentType, "application/json")
                    setBody(ByteArrayContent(gbkBody, ContentType.Application.Json))
                }
                assertEquals(HttpStatusCode.BadRequest, rejected.status)
                assertTrue(rejected.bodyAsText().contains("UTF-8"))
                assertTrue(client.get("/api/replace-rules").body<List<ReplaceRule>>().isEmpty())

                // 把编码说明白就照常导入，且中文一字不差。
                val contentType = ContentType.parse("application/json; charset=gbk")
                val accepted = client.post("/api/replace-rules/import") {
                    header(HttpHeaders.ContentType, contentType.toString())
                    setBody(ByteArrayContent(gbkBody, contentType))
                }
                assertEquals(HttpStatusCode.OK, accepted.status)
                assertEquals("替换文案", client.get("/api/replace-rules").body<List<ReplaceRule>>().single().replacement)
            }
        } finally { cleanup(config) }
    }

    @Test
    fun `显式声明 charset=gbk 的请求按声明解码`() {
        val config = tempConfig()
        try {
            testApplication {
                application { legadoApplication(config) }
                val client = createClient { install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) } }
                client.importSource()
                val resp = client.post("/api/sources/batch") {
                    val contentType = ContentType.parse("application/json; charset=gbk")
                    header(HttpHeaders.ContentType, contentType.toString())
                    setBody(ByteArrayContent(batchBody("体检异常").toByteArray(charset("GBK")), contentType))
                }
                assertEquals(HttpStatusCode.OK, resp.status)
                assertEquals(listOf<String?>("体检异常"), client.sourceGroups())
            }
        } finally { cleanup(config) }
    }
}
