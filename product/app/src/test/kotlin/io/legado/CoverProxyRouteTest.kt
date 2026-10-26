package io.legado

import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import java.net.URLEncoder
import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 封面代理 `/api/covers/proxy`（0.6.22）：搜索/发现/详情的外域封面改由服务端代取并落盘缓存，
 * 浏览器只加载同源地址 —— 手机端书源 App 能显示而青阅不显示的封面，根因是浏览器直连外域取不到图
 * （本机系统代理、防盗链、http 混掺），服务端直连没有这层障碍（书架走 `/covers/{key}` 所以一直正常）。
 *
 * 真抓外网图不进单测（要出网）：这里钉三条边界 —— ① 非 http(s) 地址 400；
 * ② 回环/内网地址被 SSRF 闸门拦下（回 502，不落盘）；③ 老 `/covers/{key}` 不受影响。
 */
class CoverProxyRouteTest {

    private fun config() = ServerConfig(
        host = "127.0.0.1",
        port = 8080,
        databasePath = Files.createTempFile("legado-cover-proxy", ".sqlite").toString(),
        coverCacheDirectory = Files.createTempDirectory("legado-cover-proxy-covers"),
        homeDirectory = Files.createTempDirectory("legado-cover-proxy-home"),
    )

    @Test
    fun `非 http(s) 的封面地址直接 400`() = testApplication {
        application { legadoApplication(config()) }
        val client = createClient { }
        val response = client.get("/api/covers/proxy?url=data:text/html;base64,PGI+aGk8L2I+")
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertTrue("要说清是地址无效：${response.bodyAsText()}", response.bodyAsText().contains("invalid_image"))
    }

    @Test
    fun `回环与内网地址被 SSRF 闸门拦下`() = testApplication {
        application { legadoApplication(config()) }
        val client = createClient { }
        for (target in listOf("http://127.0.0.1:9/x.png", "http://192.168.1.10/x.png")) {
            val response = client.get("/api/covers/proxy?url=${URLEncoder.encode(target, Charsets.UTF_8)}")
            assertEquals("$target 应被拦", HttpStatusCode.BadGateway, response.status)
        }
    }

    @Test
    fun `老路由 covers key 原样可用`() = testApplication {
        application { legadoApplication(config()) }
        val client = createClient { }
        val response = client.get("/api/covers/deadbeef")
        assertEquals(HttpStatusCode.NotFound, response.status)
    }
}
