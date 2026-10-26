package io.legado

import io.legado.http.proxyRequestHeaders
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URI

/**
 * 代取资源该带什么头 —— 抽成一处就得钉住一处。
 *
 * 端到端演不了：SSRF 闸门拒掉回环地址，本地假上游根本连不上，所以钉的是这条决策本身。
 * 它管的正是「书源登录成功、图和音频流还是 403」那个病根。
 */
class ProxyHeadersTest {

    @Test
    fun `attaches the cookie of the host being fetched right now`() {
        val jar = mapOf("https://img.example/a.png" to "session=abc")
        val headers = proxyRequestHeaders(URI("https://img.example/a.png"), referer = null, cookieFor = { jar[it] })
        assertEquals("session=abc", headers["Cookie"])
    }

    @Test
    fun `a redirect hop never carries the previous host's credential`() {
        // 主域 → 图片 CDN 两跳：第二跳只能拿到 CDN 那个域自己的凭据，这里它不在罐子里。
        val seen = mutableListOf<String>()
        val headers = proxyRequestHeaders(
            URI("https://cdn.other/a.png"),
            referer = "https://img.example/page",
            cookieFor = { uri -> seen.add(URI(uri).host); null },
        )
        assertEquals(listOf("cdn.other"), seen)
        assertFalse("跨域跳转不许带上原站的 Cookie", headers.containsKey("Cookie"))
    }

    @Test
    fun `referer is kept across hops while the cookie is re-resolved`() {
        // 与 CoverCache 原注释相反：收掉 Referer 会把「主域 → 图片域」两跳的站打回 403，
        // 这条断言钉住现在的行为，改它要连着改两条代理路。
        val headers = proxyRequestHeaders(URI("https://cdn.example/x.jpg"), referer = "https://book.example/ch/1", cookieFor = { null })
        assertEquals("https://book.example/ch/1", headers["Referer"])
    }

    @Test
    fun `range goes out as-is and a blank cookie is not a cookie header`() {
        val withRange = proxyRequestHeaders(URI("https://m.example/1.m4a"), referer = null, cookieFor = { null }, range = "bytes=0-1023")
        assertEquals("bytes=0-1023", withRange["Range"])
        assertFalse(withRange.containsKey("Cookie"))
        assertTrue(proxyRequestHeaders(URI("https://m.example/1.m4a"), referer = null, cookieFor = { "   " }).let { !it.containsKey("Cookie") })
        assertEquals("legadoQ/0.1", withRange["User-Agent"])
    }
}
