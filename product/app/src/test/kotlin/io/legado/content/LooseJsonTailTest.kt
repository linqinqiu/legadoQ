package io.legado.content

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * `地址,{JSON}` 尾巴的切割。
 *
 * 上游正则是 `Regex("\\s*,\\s*(?=\\{)")`（`AnalyzeUrl.paramPattern`）——**逗号前后可以有空白**。
 * 我们原来用 `indexOf(",{")`，只认逗号后紧跟 `{`：源里写成 `地址 , {"method":"POST"}`
 * （逗号后有空格，手写很常见）就切不开，整串被当成 URL，请求带着 `,{...}` 上路。
 */
class LooseJsonTailTest {

    @Test
    fun `逗号后紧跟花括号照旧能切`() {
        val (url, tail) = LooseJson.extractTail("""https://x.com/api?a=1,{"method":"POST"}""")
        assertEquals("https://x.com/api?a=1", url)
        assertEquals("""{"method":"POST"}""", tail)
    }

    @Test
    fun `逗号后有空格也能切（上游容忍，我们原来不容忍）`() {
        val (url, tail) = LooseJson.extractTail("""https://x.com/api?a=1, {"method":"POST"}""")
        assertEquals("https://x.com/api?a=1", url)
        assertEquals("""{"method":"POST"}""", tail)
    }

    @Test
    fun `逗号前后都有空白也能切`() {
        val (url, tail) = LooseJson.extractTail("""https://x.com/api?a=1 , {"method":"POST"}""")
        assertEquals("https://x.com/api?a=1", url)
        assertEquals("""{"method":"POST"}""", tail)
    }

    @Test
    fun `没有逗号加花括号时整串当 URL`() {
        assertNull(LooseJson.extractTail("https://x.com/api?a=1").second)
        assertEquals("https://x.com/api?a=1", LooseJson.extractTail("https://x.com/api?a=1").first)
    }

    @Test
    fun `逗号后不是花括号不当成选项尾巴`() {
        // 普通 URL 里带逗号极常见（路径段、多值参数），不能一律当选项切
        val (url, tail) = LooseJson.extractTail("https://x.com/a,b/c")
        assertEquals("https://x.com/a,b/c", url)
        assertNull(tail)
    }

    @Test
    fun `花括号不闭合时至少把地址部分还回去`() {
        val (url, tail) = LooseJson.extractTail("""https://x.com/api?a=1,{"method":"POST"""")
        assertEquals("https://x.com/api?a=1", url)
        assertNull("括号不闭合时不该把半截 JSON 当选项", tail)
    }

    @Test
    fun `尾巴里含嵌套花括号时按配对切完整段`() {
        val (url, tail) = LooseJson.extractTail("""https://x.com/api,{"headers":{"a":{"b":"c"}}}""")
        assertEquals("https://x.com/api", url)
        assertEquals("""{"headers":{"a":{"b":"c"}}}""", tail)
    }
}
