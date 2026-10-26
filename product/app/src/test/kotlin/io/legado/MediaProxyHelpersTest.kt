package io.legado

import io.legado.http.injectBaseHref
import io.legado.http.isHlsPlaylist
import io.legado.http.mediaContentType
import io.legado.http.rewriteHlsPlaylist
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URI
import java.net.URLEncoder

/**
 * 媒体代理的纯函数：HLS 播放列表重写、Content-Type 兜底、播放页 `<base>` 注入。
 * 这些判据不联网，钉的是"发出去的地址/类型对不对"。
 */
class MediaProxyHelpersTest {

    private fun enc(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")
    private fun proxied(target: String, referer: String? = null) =
        "/api/book/media?url=${enc(target)}" + (referer?.let { "&referer=${enc(it)}" } ?: "")

    @Test
    fun `m3u8 的分片、密钥、初始化段都改写成走本代理的绝对地址`() {
        val playlist = """
            #EXTM3U
            #EXT-X-KEY:METHOD=AES-128,URI="key.bin"
            #EXTINF:4,
            seg-1.ts
            #EXT-X-MAP:URI="init.mp4"
            https://other.example/seg-2.ts
        """.trimIndent()
        val out = rewriteHlsPlaylist(playlist, URI("https://cdn.example/live/index.m3u8"), "https://m.example/c/1")

        assertTrue("相对分片要按播放列表地址解析", out.contains(proxied("https://cdn.example/live/seg-1.ts", "https://m.example/c/1")))
        assertTrue("密钥 URI 也要走代理", out.contains("URI=\"${proxied("https://cdn.example/live/key.bin", "https://m.example/c/1")}\""))
        assertTrue("初始化段也要走代理", out.contains("URI=\"${proxied("https://cdn.example/live/init.mp4", "https://m.example/c/1")}\""))
        assertTrue("绝对分片原样保留目标、只换成本代理", out.contains(proxied("https://other.example/seg-2.ts", "https://m.example/c/1")))
        assertTrue("#EXTM3U 等注释行要保留", out.startsWith("#EXTM3U"))
    }

    @Test
    fun `按扩展名或 Content-Type 认 HLS`() {
        assertTrue(isHlsPlaylist("https://cdn.example/live/index.m3u8", null))
        assertTrue(isHlsPlaylist("https://cdn.example/x", "application/vnd.apple.mpegurl"))
        assertFalse(isHlsPlaylist("https://cdn.example/v/1.mp4", "video/mp4"))
    }

    @Test
    fun `上游没给类型或只给 octet-stream 时按后缀补一个能播的类型`() {
        assertEquals("video/mp4", mediaContentType("https://cdn.example/v/1.mp4", null))
        assertEquals("video/mp4", mediaContentType("https://cdn.example/v/1.mp4", "application/octet-stream"))
        assertEquals("audio/mpeg", mediaContentType("https://cdn.example/a/1.mp3", null))
        assertEquals("application/vnd.apple.mpegurl", mediaContentType("https://cdn.example/live/index.m3u8", null))
        assertEquals("text/html", mediaContentType("https://cdn.example/player", "text/html"))
    }

    @Test
    fun `播放页注入 base，已有 base 的不动`() {
        val html = "<html><head><title>x</title></head><body>ok</body></html>"
        val out = injectBaseHref(html, URI("https://jx.example/player/?url=a"))
        assertTrue("要在 head 后插入 base", out.contains("<head><base href=\"https://jx.example/player/?url=a\">"))
        val existing = "<html><head><base href=\"https://already.example/\"></head></html>"
        assertEquals("已有 base 不重复注入", existing, injectBaseHref(existing, URI("https://jx.example/")))
        assertTrue("没有 head 就放最前面", injectBaseHref("<p>x</p>", URI("https://jx.example/")).startsWith("<base href="))
    }
}
