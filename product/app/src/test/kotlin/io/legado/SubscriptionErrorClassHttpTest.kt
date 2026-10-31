package io.legado

import io.ktor.client.*
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

/**
 * 书源订阅地址的**失败分类**（照 `AgentErrorClassHttpTest` 的口径：断言用户真看到的
 * 状态码与那句话，而不是处理器抛了什么异常）。
 *
 * 触发这条的实测：门禁 subscription-check 里「解析不到的域名也在创建时就被拒」收到的是
 * `500 {"code":"internal_error","message":"服务器内部错误"}`。原因是 SSRF 闸门把
 * "地址形状/内网"（`BlockedAddressException : IllegalArgumentException`）与
 * "域名解析不了"（`UnreachableTargetException : IOException`）分成了两类，
 * 而创建订阅那里只 catch 了前者 —— 后者一路穿到兜底，填错域名的用户被引导去翻服务端日志。
 */
class SubscriptionErrorClassHttpTest {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    private fun cleanup(dbPath: String) {
        runCatching { Files.deleteIfExists(Path.of(dbPath)) }
        runCatching { Files.deleteIfExists(Path.of("$dbPath-wal")) }
        runCatching { Files.deleteIfExists(Path.of("$dbPath-shm")) }
    }

    private fun ApplicationTestBuilder.makeClient() = createClient {
        install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
    }

    private suspend fun addSubscription(client: HttpClient, url: String): HttpResponse =
        client.post("/api/subscriptions") {
            contentType(ContentType.Application.Json)
            setBody(Json.encodeToString(
                JsonObject.serializer(),
                JsonObject(mapOf("url" to JsonPrimitive(url), "enabled" to JsonPrimitive(true))),
            ))
        }

    private suspend fun bodyOf(resp: HttpResponse): JsonObject =
        json.parseToJsonElement(resp.bodyAsText()).jsonObject

    @Test
    fun `内网订阅地址回 400 并带回闸门那句中文`() = testApplication {
        val dbPath = Files.createTempFile("legado-subcls-loop", ".sqlite").toString()
        val home = Files.createTempDirectory("legado-subcls-home-loop")
        try {
            application {
                legadoApplication(
                    ServerConfig(
                        host = "127.0.0.1", port = 8080, databasePath = dbPath,
                        coverCacheDirectory = Files.createTempDirectory("legado-subcls-covers"),
                        homeDirectory = home,
                    ),
                )
            }
            val client = makeClient()
            val resp = addSubscription(client, "http://127.0.0.1:9999/sources.json")
            val body = runCatching { bodyOf(resp) }.getOrNull()
            assertEquals("内网地址该在创建时就被拒（400），实际 ${resp.status}", HttpStatusCode.BadRequest, resp.status)
            assertEquals("invalid_subscription", body?.string("code"))
            assertTrue("闸门原话要带回去，实际「${body?.string("message")}」",
                (body?.string("message") ?: "").let { it.contains("内网") || it.contains("本机") })
        } finally {
            cleanup(dbPath)
            runCatching { home.toFile().deleteRecursively() }
        }
    }

    @Test
    fun `解析不了的域名也是 400，不再顶一个 500`() = testApplication {
        val dbPath = Files.createTempFile("legado-subcls-dns", ".sqlite").toString()
        val home = Files.createTempDirectory("legado-subcls-home-dns")
        try {
            application {
                legadoApplication(
                    ServerConfig(
                        host = "127.0.0.1", port = 8080, databasePath = dbPath,
                        coverCacheDirectory = Files.createTempDirectory("legado-subcls-covers2"),
                        homeDirectory = home,
                    ),
                )
            }
            val client = makeClient()
            // `.invalid` 是 RFC 保留 TLD，永远解析不到，不需要联网也不依赖外部 DNS
            val resp = addSubscription(client, "http://legado-probe-no-such-host.invalid/sources.json")
            val body = runCatching { bodyOf(resp) }.getOrNull()
            assertEquals("填错的域名是客户端能修的，必须 400（从前穿成 500「服务器内部错误」）: ${resp.status}",
                HttpStatusCode.BadRequest, resp.status)
            assertEquals("invalid_subscription", body?.string("code"))
            val message = body?.string("message") ?: ""
            assertTrue("要说清是域名解析不了，实际「$message」",
                message.contains("无法解析") || message.contains("域名"))
            // 被拒的那条不许留下半截记录，否则下次更新它一直转圈
            val list = client.get("/api/subscriptions").bodyAsText()
            assertTrue("被拒的地址不该落库：$list", !list.contains("legado-probe-no-such-host.invalid"))
        } finally {
            cleanup(dbPath)
            runCatching { home.toFile().deleteRecursively() }
        }
    }

    private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
}
