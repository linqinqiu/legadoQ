package io.legado

import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.testing.testApplication
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 内置浏览器的代理口必须**认得出写方法**（用户 2026-10-05：「登录抓取 cookie 还是失败」）。
 *
 * 注入脚本把站点里所有方法的 fetch/XHR 一律改写到 `/browser/res`（只换 URL、保留方法），
 * 而这个路由原来只注册了 GET —— 于是「登录 = fetch POST /login」那类站点，POST 落在 405 上，
 * 请求根本没被发出去，服务端也就永远吸不到那条 `Set-Cookie`。
 * 表单走的是另一条 `/submit`（一直有 POST），所以症状是"有的源能登录、有的怎么都不行"。
 *
 * 这里钉的是"这一格路由存在且收这个方法"：参数缺失时处理器自己回 400，
 * 而**方法没注册**时 Ktor 回的是 405/404 —— 两个数一分就抓得住，不需要真去访问外站
 * （SSRF 守卫本来也不让代理打内网，见 `NetworkSecurity`）。
 */
class WebViewProxyRouteTest {

    private fun config() = ServerConfig(
        host = "127.0.0.1",
        port = 8080,
        databasePath = Files.createTempFile("legado-webview-route", ".sqlite").toString(),
        coverCacheDirectory = Files.createTempDirectory("legado-webview-route-covers"),
    )

    @Test
    fun `res 这一格收 GET 与四种写方法，缺参数时由处理器回 400 而不是路由层 405`() = testApplication {
        application { legadoApplication(config()) }
        val client = createClient {
            install(ContentNegotiation) { json() }
            followRedirects = false
        }
        val base = "/api/sources/probe-source/browser/res"
        val statuses = mapOf(
            "GET" to client.get("$base?t=&u=").status,
            "POST" to client.post("$base?t=&u=") { setBody("user=1") }.status,
            "PUT" to client.put("$base?t=&u=") { setBody("user=1") }.status,
            "PATCH" to client.patch("$base?t=&u=") { setBody("user=1") }.status,
            "DELETE" to client.delete("$base?t=&u=").status,
        )
        // 400 = 进到处理器了（缺 token / u）；404/405 = 那一格方法根本没注册
        statuses.forEach { (verb, status) ->
            assertEquals("$verb 没被 /browser/res 接住（实到 $status）", HttpStatusCode.BadRequest, status)
        }
    }

    @Test
    fun `缺参数的回话说的是人话（缺哪个点名哪个）`() = testApplication {
        application { legadoApplication(config()) }
        val client = createClient {
            install(ContentNegotiation) { json() }
            followRedirects = false
        }
        val response = client.post("/api/sources/probe-source/browser/res?t=&u=") { setBody("a=1") }
        val body = response.bodyAsText()
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertTrue("回话里没有 missing_parameter：$body", body.contains("missing_parameter"))
        assertTrue("回话没点名缺什么：$body", body.contains("token") || body.contains("缺少"))
    }
}
