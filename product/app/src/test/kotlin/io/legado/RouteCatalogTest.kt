package io.legado

import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

/**
 * `GET /api/catalog` 这个对外契约端点本身。
 * 内容与代码的一致性在 `web/test/ApiCatalog.test.ts`（双向核对），这里只管三件事：
 * 随包文件在、能解析、`version` 是**当前跑的这份构建**而不是文件里手写的旧号。
 */
class RouteCatalogTest {

    @Test
    fun `目录端点回 JSON，版本号盖的是当前构建`() {
        val dbPath = Files.createTempFile("legado-catalog", ".sqlite").toString()
        val tempDir = Files.createTempDirectory("legado-catalog-covers")
        try {
            val config = ServerConfig(host = "127.0.0.1", port = 8080, databasePath = dbPath, coverCacheDirectory = tempDir)
            testApplication {
                application { legadoApplication(config) }
                val response = client.get("/api/catalog")
                assertEquals(HttpStatusCode.OK.value, response.status.value)
                assertTrue("内容类型要是 JSON：${response.headers[HttpHeaders.ContentType]}",
                    response.headers[HttpHeaders.ContentType]?.contains("application/json") == true)
                val text = response.bodyAsText()
                val body = runCatching { Json.parseToJsonElement(text).jsonObject }
                    .getOrElse { throw AssertionError("响应不是 JSON（${response.status.value}）：${text.take(300)}") }
                val endpoints = body["endpoints"]?.jsonArray
                    ?: throw AssertionError("响应里没有 endpoints：${text.take(300)}")
                assertTrue("目录只剩 ${endpoints.size} 条，随包文件八成被截断了", endpoints.size >= 30)
                assertEquals(endpoints.size, body["count"]!!.jsonPrimitive.int)
                // 文件里写的是发版那天手填的号；响应里必须是这个进程真正的版本
                assertEquals(BuildInfo.version, body["version"]!!.jsonPrimitive.content)
                // baseUrl 必须按运行时监听地址注入：本测试起在 8080，就不能回文件里写死的 1234。
                val baseUrl = body["howToConnect"]?.jsonObject?.get("baseUrl")?.jsonPrimitive?.content
                assertEquals("howToConnect.baseUrl 应等于运行时监听地址", "http://127.0.0.1:8080", baseUrl)
                val first = endpoints[0].jsonObject
                assertTrue("每条都要带 method/path/write/purpose：$first",
                    first.containsKey("method") && first.containsKey("path") && first.containsKey("write") && first.containsKey("purpose"))
            }
        } finally {
            runCatching { Files.deleteIfExists(Path.of(dbPath)) }
            runCatching { Files.deleteIfExists(Path.of("$dbPath-wal")) }
            runCatching { Files.deleteIfExists(Path.of("$dbPath-shm")) }
            runCatching { tempDir.toFile().deleteRecursively() }
        }
    }

    /**
     * 目录里声明的路由**必须真的注册**，不能只是"文本里出现过"。
     *
     * 这条是补出来的：`/api/books/content-process` 的 POST/DELETE 曾被写进
     * `post("/books/content")` 的处理器 lambda 里 —— 那是运行期才调 `Route.post`，
     * 启动时压根不会注册。而 `ApiCatalog.test.ts` 是按源码文本扫 `*Routes.kt` 的，
     * 照样把它们算进 142 条，于是"目录说有、实际 404"两边都是绿的。
     * 判据只能真起服务打一发：路由在，参数不全应回 400；路由不在，就是 404。
     */
    @Test
    fun `阅读内容覆盖的两条写路由真的注册了`() {
        val dbPath = Files.createTempFile("legado-route-register", ".sqlite").toString()
        val tempDir = Files.createTempDirectory("legado-route-register-covers")
        try {
            val config = ServerConfig(host = "127.0.0.1", port = 8080, databasePath = dbPath, coverCacheDirectory = tempDir)
            testApplication {
                application { legadoApplication(config) }

                val post = client.post("/api/books/content-process") {
                    contentType(ContentType.Application.Json)
                    // 全字段都给空串：能反序列化，于是走到处理器自己的字段校验，
                    // 拿到 invalid_process；若路由没注册，这里根本到不了处理器，会是 404。
                    setBody("""{"sourceId":"","bookUrl":"","chapterUrl":"","kind":"","original":"","processed":""}""")
                }
                assertTrue(
                    "POST /api/books/content-process 返回 ${post.status.value} —— 404 说明它没被注册" +
                        "（八成又写进别的处理器里了）",
                    post.status != HttpStatusCode.NotFound,
                )
                assertEquals(HttpStatusCode.BadRequest.value, post.status.value)
                val postBody = post.bodyAsText()
                assertTrue("应回 invalid_process：$postBody", postBody.contains("invalid_process"))

                val delete = client.delete("/api/books/content-process")
                assertTrue(
                    "DELETE /api/books/content-process 返回 ${delete.status.value} —— 404 说明它没被注册",
                    delete.status != HttpStatusCode.NotFound,
                )
                assertEquals(HttpStatusCode.BadRequest.value, delete.status.value)
            }
        } finally {
            runCatching { Files.deleteIfExists(Path.of(dbPath)) }
            runCatching { Files.deleteIfExists(Path.of("$dbPath-wal")) }
            runCatching { Files.deleteIfExists(Path.of("$dbPath-shm")) }
            runCatching { tempDir.toFile().deleteRecursively() }
        }
    }
}
