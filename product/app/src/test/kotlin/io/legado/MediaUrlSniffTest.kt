package io.legado

import io.legado.rules.RuleRunner
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 音频 / 视频源的正文常常**就是那条直链**。上游是 App 侧自己嗅的，我们以前只认正文 JS 给
 * `yp_url` 赋值那一个约定 —— 本机库里 115 个音频源、15 个视频源、60 个文件源，
 * 没写 yp_url 的那些把地址当一段文字排出来，播放器根本不出来。
 *
 * 反向对照同样要紧：正常正文被误判成播放器，比播放器出不来更糟。
 */
class MediaUrlSniffTest {

    private fun contentOf(captured: String) = RuleRunner { url ->
        if (url == "https://m.example/c/1") """<html><body><div id="u">$captured</div></body></html>""" else error("unexpected URL: $url")
    }.content(
        """{"bookSourceUrl":"https://m.example","ruleContent":{"content":"@css:#u@html"}}""",
        "https://m.example/c/1",
    )

    @Test
    fun `a chapter whose body is only an audio URL becomes the player address`() {
        val content = contentOf("https://cdn.example/ep/12.m4a?token=a")
        assertEquals("https://cdn.example/ep/12.m4a?token=a", content.mediaUrl)
        assertEquals("https://cdn.example/ep/12.m4a?token=a", content.content)
    }

    @Test
    fun `hls and video links are recognised too`() {
        assertEquals("https://cdn.example/live/index.m3u8", contentOf("https://cdn.example/live/index.m3u8").mediaUrl)
        assertEquals("https://cdn.example/v/9.mp4", contentOf("https://cdn.example/v/9.mp4").mediaUrl)
    }

    @Test
    fun `ordinary prose is never mistaken for a media link`() {
        // 段落正文
        assertNull(contentOf("第一章正文内容，这里写了很长一段话，说完就结束。").mediaUrl)
        // 夹着链接的一句话（空格即否）
        assertNull(contentOf("本章完 https://cdn.example/a.mp3").mediaUrl)
        // 非媒体扩展名
        assertNull(contentOf("https://cdn.example/page.html").mediaUrl)
        // 多行：第一行是地址也不算媒体
        assertNull(contentOf("https://cdn.example/a.mp3\n第二段").mediaUrl)
    }
}
