package io.legado

import io.legado.rules.JsExecutionContext
import io.legado.rules.JsSandbox
import io.legado.rules.RuleExecutionException
import io.legado.rules.RuleRunner
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 响应对象的 `cookie(名)` / `cookies()` / `charset()`，以及抓取失败递给脚本的那句话。
 *
 * 两件事都来自 0.2.7 复跑 256 份桥候选的实测账：
 * - 「笔趣阁ai」停在 `java.get(u, header).cookie('hm')` —— 我们给了 `header/headers/statusCode`
 *   却没给 `cookie`，脚本拿反爬 Cookie 那一步直接 `TypeError`；
 * - 抓取失败时原来递的是 `it.stackTraceToString()`，用户看到的是
 *   `io.legado.rules.RuleExecutionException: 重定向次数超过限制 at io.legado.rules.RuleRunner…`
 *   —— 类名是我们的、行号是构建产物的，谁都读不懂。
 *
 * Cookie 值不走真网络：`fetchedFetcher` 注入整份 [RuleRunner.Fetched]，连「重定向各跳」的
 * Set-Cookie 都按真实抓取通道拼出来的形状给（一个列表，落地时一起交给响应对象）。
 */
class JsResponseCookieTest {
    private val url = "http://cookie.example/api/1"
    private val body = """{"ok":true}"""

    private fun fetched(
        setCookies: List<String> = emptyList(),
        headers: Map<String, String> = mapOf("content-type" to "application/json; charset=UTF-8"),
        status: Int = 200,
    ) = RuleRunner.Fetched(url = url, body = body, status = status, headers = headers, setCookies = setCookies)

    private fun eval(script: String, response: RuleRunner.Fetched = fetched()): String? {
        val runner = RuleRunner().apply { fetchedFetcher = { response } }
        val sandbox = JsSandbox(runner)
        val out = sandbox.eval(script, emptyMap(), JsExecutionContext(sourceId = "http://cookie.example"))
        assertTrue("脚本报错：${sandbox.lastError ?: "（无，就是返回了 null）"}", out != null)
        return out
    }

    // ── cookie(名) / cookies() ────────────────────────────────────
    @Test
    fun `cookie 按名字取到值，属性段与引号都剥掉`() {
        // 一条 Set-Cookie 的 `;` 之后全是属性（Path/Domain/Expires/SameSite），不能当值；
        // RFC 6265 允许整值带双引号，脚本要的是引号里的内容。
        val out = eval(
            "var r = java.get('$url'); [r.cookie('hm'), r.cookie('token')].join('|');",
            fetched(
                setCookies = listOf(
                    "hm=\"a b\"; Path=/; HttpOnly",
                    "token=abc; Domain=.cookie.example; SameSite=Lax",
                )
            ),
        )
        assertEquals("a b|abc", out)
    }

    @Test
    fun `cookies 给整张表，同名以后到的那条为准`() {
        // 重定向会一路累积 Set-Cookie：先入口域，再落地域；同名时浏览器行为是后者覆盖前者。
        val out = eval(
            "var c = java.get('$url').cookies(); [c.hm, c.sess, typeof c.none].join('|');",
            fetched(setCookies = listOf("hm=first; Path=/", "sess=S-1; Path=/", "hm=second; Path=/")),
        )
        assertEquals("second|S-1|undefined", out)
    }

    @Test
    fun `cookies 不给名字时 cookie() 与它同形；给不存在的名字得到 undefined`() {
        val out = eval(
            "var r = java.get('$url'); [typeof r.cookie(), typeof r.cookie('nope'), r.cookie().hm].join('|');",
            fetched(setCookies = listOf("hm=42; Path=/")),
        )
        assertEquals("object|undefined|42", out)
    }

    @Test
    fun `这一趟没给 Cookie 时两个入口都是空表或 undefined 而不是报错`() {
        val out = eval("var r = java.get('$url'); [typeof r.cookies(), typeof r.cookie('hm'), typeof r.cookie()].join('|');")
        assertEquals("object|undefined|object", out)
    }

    @Test
    fun `重定向各跳的 Set-Cookie 都进同一张表`() {
        // fetchDetailed 跟随重定向时把每一跳的 set-cookie 累积进同一个列表；
        // 这里按它交给响应对象的**最终形状**注入 —— 入口域与落地域的名字都必须读得到。
        val out = eval(
            "var c = java.get('$url').cookies(); [c.entry, c.landing].join('|');",
            fetched(setCookies = listOf("entry=1; Domain=a.example", "landing=2; Domain=b.example")),
        )
        assertEquals("1|2", out)
    }

    // ── charset() ─────────────────────────────────────────────────
    @Test
    fun `charset 从 content-type 里取，带不带引号都认`() {
        assertEquals("UTF-8", eval("java.get('$url').charset()"))
        assertEquals(
            "GBK",
            eval(
                "java.get('$url').charset()",
                fetched(headers = mapOf("content-type" to "text/html; charset=\"GBK\"")),
            ),
        )
        // 头参数名的大小写不受保证，站点写 `Charset=GB2312` 也得取到。
        assertEquals(
            "GB2312",
            eval(
                "java.get('$url').charset()",
                fetched(headers = mapOf("content-type" to "text/html; Charset=GB2312")),
            ),
        )
        assertEquals(
            "",
            eval(
                "java.get('$url').charset()",
                fetched(headers = mapOf("content-type" to "text/html")),
            ),
        )
    }

    // ── 抓取失败递给脚本的东西 ────────────────────────────────────
    private fun sandboxThatThrows(error: Throwable): JsSandbox =
        JsSandbox(RuleRunner().apply { fetchedFetcher = { throw error } })

    @Test
    fun `抓取失败只递一句人话，不递 Java 堆栈`() {
        val sandbox = sandboxThatThrows(RuleExecutionException("重定向次数超过限制"))
        val out = sandbox.eval(
            "String(java.get('$url'))",
            emptyMap(),
            JsExecutionContext(sourceId = "http://cookie.example"),
        )
        assertEquals("抓取失败：重定向次数超过限制", out)
        assertFalse("类名不该露给脚本/用户：$out", out!!.contains("io.legado"))
        assertFalse("行号不该露给脚本/用户：$out", out.contains("\tat "))
    }

    @Test
    fun `外层没有说明时取 cause 里那句`() {
        val sandbox = sandboxThatThrows(RuntimeException("  ", java.io.IOException("connection reset")))
        val out = sandbox.eval("String(java.post('$url', 'k=1', {}))", emptyMap(), JsExecutionContext(sourceId = "http://cookie.example"))
        assertEquals("抓取失败：connection reset", out)
    }

    @Test
    fun `ajax 同样只给一句话，仍是字符串`() {
        val sandbox = sandboxThatThrows(RuleExecutionException("上游返回 HTTP 403"))
        val out = sandbox.eval(
            "var r = java.ajax('$url'); (typeof r) + '|' + r;",
            emptyMap(),
            JsExecutionContext(sourceId = "http://cookie.example"),
        )
        assertEquals("string|抓取失败：上游返回 HTTP 403", out)
    }

    @Test
    fun `fetchFailureText 取因链上第一句非空说明`() {
        val sandbox = JsSandbox()
        assertEquals("抓取失败：重定向次数超过限制", sandbox.fetchFailureText(RuleExecutionException("重定向次数超过限制")))
        assertEquals(
            "抓取失败：connection reset",
            sandbox.fetchFailureText(RuntimeException(" ", java.io.IOException("connection reset"))),
        )
        // 连 message 都没有时才退回类名：总比给脚本一句空白强（脚本常 `if (r.body().length > 0)`）。
        assertEquals("抓取失败：IllegalStateException", sandbox.fetchFailureText(IllegalStateException()))
    }

    // ── 内部来源名不露给用户 ──────────────────────────────────────
    @Test
    fun `擦掉内部注入脚本的来源名，但保留书源自己的行号`() {
        val sandbox = JsSandbox()
        assertEquals("Unexpected token", sandbox.scrubInternalSourceTag("Unexpected token (sandbox-compat#1)"))
        assertEquals("bad value", sandbox.scrubInternalSourceTag("bad value (json-compat#3)"))
        // 书源脚本自己的来源与行号对用户有用（能指到书源的哪一行），不能一起擦
        assertEquals("sign is not defined (rule.js#7)", sandbox.scrubInternalSourceTag("sign is not defined (rule.js#7)"))
        assertEquals("x (jsLib.js#12)", sandbox.scrubInternalSourceTag("x (jsLib.js#12)"))
    }

    @Test
    fun `JSON parse 兼容层报错时不再顶着我们的模块名出去`() {
        val sandbox = JsSandbox()
        val out = sandbox.eval(
            "JSON.parse('这不是 JSON')",
            emptyMap(),
            JsExecutionContext(sourceId = "http://cookie.example"),
        )
        assertNull(out)
        val detail = sandbox.lastError ?: ""
        assertTrue("失败原因应该还是那句人话：$detail", detail.contains("JSON.parse"))
        assertFalse("内部模块名不该露给用户：$detail", detail.contains("sandbox-compat"))
        assertFalse("内部模块名不该露给用户：$detail", detail.contains("json-compat"))
    }

    @Test
    fun `书源脚本自己抛的错仍带 rule_js 行号`() {
        val sandbox = JsSandbox()
        val out = sandbox.eval(
            "undefinedFunction()",
            emptyMap(),
            JsExecutionContext(sourceId = "http://cookie.example"),
        )
        assertNull(out)
        val detail = sandbox.lastError ?: ""
        assertTrue("书源自己的行号要留着（能指到是哪一行）：$detail", detail.contains("rule.js"))
        assertFalse("不该混进内部模块名：$detail", detail.contains("sandbox-compat"))
    }
}
