package io.legado.rules

import org.junit.Assert.assertEquals
import org.junit.Test

class RuleUrlSupportTest {

    @Test
    fun `非 BMP 字符按完整码点编码`() {
        assertEquals("%F0%9F%98%80", encodeIllegalUrlChars("😀"))
        assertEquals("%F0%A0%80%80", encodeIllegalUrlChars("𠀀"))
        assertEquals("%F0%9F%98%80%20%E9%9B%B7", encodeIllegalUrlChars("😀 雷"))
    }

    @Test
    fun `解析含空格和 emoji 的 URL 保留原始查询语义`() {
        val uri = parseUri("https://example.com/search?q=😀 雷")

        assertEquals("https://example.com/search?q=%F0%9F%98%80%20%E9%9B%B7", uri.toASCIIString())
        assertEquals("q=😀 雷", uri.query)
    }

    @Test
    fun `已有百分号编码与保留字符不被重复编码`() {
        val url = "https://example.com/a%20b?q=%E9%9B%B7&v=a+b#part"

        assertEquals(url, encodeIllegalUrlChars(url))
        assertEquals(url, parseUri(url).toASCIIString())
    }

    @Test
    fun `普通中文与 JSON 非法字符维持原编码`() {
        assertEquals(
            "https://example.com/?q=%E9%9B%B7%20%7B%22a%22:1%7D",
            encodeIllegalUrlChars("https://example.com/?q=雷 {\"a\":1}"),
        )
    }

    @Test
    fun `孤立代理项仍替换为问号而不抛异常`() {
        assertEquals("%3F", encodeIllegalUrlChars("\uD83D"))
        assertEquals("%3F%3F", encodeIllegalUrlChars("\uD83D\uD83D"))
    }
}
