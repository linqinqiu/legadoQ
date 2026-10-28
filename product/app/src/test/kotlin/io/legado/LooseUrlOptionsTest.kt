package io.legado

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import io.legado.content.LooseJson
import io.legado.rules.RuleRunner

/**
 * URL 尾巴 `,{options}` 的解析回归锁。
 * 用例形状全部取自库内实测（4,876 源里严格 JSON 解析失败 1,571 处），不是构造出来的理想写法。
 */
class LooseUrlOptionsTest {

    private val runner = RuleRunner()

    // —— 规范化器本体 ——
    @Test
    fun `normalizes single quoted keys and values`() {
        val strict = LooseJson.toStrict("{'method': 'POST', 'body': 's=articlename&searchkey={{key}}&Submit='}")
        assertEquals(
            """{"method": "POST", "body": "s=articlename&searchkey={{key}}&Submit="}""",
            strict
        )
    }

    @Test
    fun `normalizes bare keys and full width quotes`() {
        assertEquals("""{"webView":"true"}""", LooseJson.toStrict("{webView:“true”}"))
        assertEquals("""{"webView": true}""", LooseJson.toStrict("{webView: true}"))
    }

    @Test
    fun `escapes raw newlines inside strings and drops trailing commas`() {
        assertEquals(
            """{"method":"POST","body":"a=1&&\nb=2"}""",
            LooseJson.toStrict("""{"method":"POST","body":"a=1&&""" + "\n" + """b=2",}""")
        )
    }

    @Test
    fun `leaves already strict json untouched`() {
        val text = """{"charset":"gbk"}"""
        assertEquals(text, LooseJson.toStrict(text))
    }

    @Test
    fun `extracts the tail by brace pairing, not to end of string`() {
        val (url, tail) = LooseJson.extractTail("""https://x.dev/s,{"body":"a}b"}""")
        assertEquals("https://x.dev/s", url)
        assertEquals("""{"body":"a}b"}""", tail)
    }

    // —— 引擎侧映射 ——
    @Test
    fun `post options are applied instead of being sent as part of the url`() {
        val (url, options) = runner.splitUrlOptions("https://x.dev/search?q={{key}},{'method':'POST','body':'kw={{key}}','charset':'utf-8'}")
        assertEquals("https://x.dev/search?q={{key}}", url)
        assertEquals("POST", options?.method)
        assertEquals("kw={{key}}", options?.body)
        assertEquals(Charsets.UTF_8, options?.charset)
    }

    @Test
    fun `a body written as an object is serialized back to json`() {
        val (_, options) = runner.splitUrlOptions("""https://x.dev/s,{"method":"POST","body":{"searchTerms":"{{key}}","pageSize":"20"}}""")
        val body = checkNotNull(options?.body) { "对象 body 不能像原来那样被 string() 取成 null" }
        assertEquals("""{"searchTerms":"{{key}}","pageSize":"20"}""", body)
    }

    @Test
    fun `a nested array inside the body survives brace pairing`() {
        // 番茄 v3.4.2 的书架规则就是这么写的：body 里再套一层对象数组。
        // 括号配对只要少吞一层，整个 java.ajax 就会退化成「URL 无效」，书架分栏返回 0 本。
        val (url, options) = runner.splitUrlOptions(
            """https://fanqienovel.com/api/bookshelf/multidetail,{"method":"post","body":{"books":[{"book_id":"7677387917601279038"},{"book_id":"7593218493693037592"}]}}"""
        )
        assertEquals("https://fanqienovel.com/api/bookshelf/multidetail", url)
        assertEquals("POST", options?.method)
        assertEquals(
            """{"books":[{"book_id":"7677387917601279038"},{"book_id":"7593218493693037592"}]}""",
            options?.body
        )
    }

    @Test
    fun `headers given as a string are parsed again`() {
        val (_, options) = runner.splitUrlOptions("""https://x.dev/s,{"headers": "{Referer:'https://m.x.dev/search'}", "method":"POST"}""")
        assertEquals("https://m.x.dev/search", options?.headers?.get("Referer"))
        assertEquals("POST", options?.method)
    }

    @Test
    fun `webView is reported rather than silently ignored`() {
        assertEquals(true, runner.splitUrlOptions("https://x.dev/s,{'webView': true}").second?.webView)
        assertEquals(false, runner.splitUrlOptions("https://x.dev/s,{\"webView\": false}").second?.webView)
        // 没有参数尾巴时整个 options 为 null，不假造一个「webView=false」出来
        assertNull(runner.splitUrlOptions("https://x.dev/s").second)
    }

    @Test
    fun `an unparseable tail is still stripped from the url`() {
        // 上游 analyzeUrl() 用的是 urlNoOption：参数解析不出来也不能把 `,{...}` 当地址发出去
        val (url, options) = runner.splitUrlOptions("https://x.dev/s,{this is not json at all")
        assertTrue("括号不闭合时保持原样: $url", url.endsWith(",{this is not json at all"))
        assertNull(options)

        val broken = runner.splitUrlOptions("https://x.dev/s,{\"method\": POST,, }")
        assertEquals("https://x.dev/s", broken.first)
        assertNull("解析不出来也要把尾巴摘掉", broken.second)
    }

    @Test
    fun `method other than post or head falls back to get like upstream`() {
        assertEquals("GET", runner.splitUrlOptions("""https://x.dev/s,{"method":"delete"}""").second?.method)
        assertEquals("HEAD", runner.splitUrlOptions("""https://x.dev/s,{"method":"head"}""").second?.method)
    }
}
