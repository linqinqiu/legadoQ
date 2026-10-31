package io.legado

import io.legado.rules.JsExecutionContext
import io.legado.rules.JsSandbox
import io.legado.rules.RuleRunner
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `org.jsoup.Jsoup.parse(...)` 白名单包装。
 *
 * 起因是实跑：启用库里有 **314 份**源写 `org.jsoup.*`（其中 292 份只用 `parse`），
 * 而沙箱禁了 Java 反射（`setClassShutter { false }` 是 RCE 底线，不为几个源开口子），
 * 于是这些脚本第一行就 `ReferenceError: “org” 未定义`，整源直接不可用。
 *
 * 这份判据两头都钉：白名单里的取值写法要好用（源里 Jsoup 风格与 JS 数组风格各占一半），
 * 同时**不能**顺着包装摸到网络或反射（`connect`、`Document.connection()`、`Packages`）。
 */
class JsoupBridgeTest {
    private val page = """
        <!doctype html><html><head><title>测试站</title>
        <meta property="og:url" content="https://book.example/42.html"></head>
        <body><div class="list">
          <a href="/b/1.html" title="第一">第一千二百三十四章 归零</a>
          <a href="/b/2.html">第二章<span class="tag">新</span>起风</a>
        </div><p id="note">备注<b>加粗</b>尾巴</p></body></html>
    """.trimIndent()

    private fun sandbox(blockingNetwork: Boolean = true) = JsSandbox(
        RuleRunner { url -> if (blockingNetwork) error("这条判据不该发网络请求：$url") else "" }
    )

    /** 脚本里可以直接用 `doc`（已 parse 好的整页）与 `html`（原文）。 */
    private fun eval(script: String, source: JsSandbox = sandbox()): String? {
        val out = source.eval(
            "var doc = org.jsoup.Jsoup.parse(html);\n$script",
            mapOf("html" to page),
            JsExecutionContext(sourceId = "http://jsoup.example"),
        )
        // 返回 null 就是脚本抛了：这里必须把它当成失败报出来，否则测试只剩"expected 2 but was null"，
        // 看不出是包装没生效还是判据写错。
        assertTrue("脚本报错：${source.lastError ?: "（返回了 null 但没有错误记录）"}", out != null)
        return out
    }

    @Test
    fun `Jsoup 风格的集合与属性取值的对`() {
        assertEquals("2", eval("doc.select('.list a').size()"))
        assertEquals("/b/1.html", eval("doc.select('.list a').first().attr('href')"))
        assertEquals("第一千二百三十四章 归零", eval("doc.select('.list a').eq(0).text()"))
        // 集合上的 attr 按 Jsoup 语义取第一个元素的值（源里大量这么写）
        assertEquals("/b/1.html", eval("doc.select('.list a').attr('href')"))
        assertEquals("https://book.example/42.html",
            eval("doc.selectFirst('meta[property=\"og:url\"]').attr('content')"))
        assertEquals("备注加粗尾巴", eval("doc.getElementById('note').text()"))
        // 元素 toString 就是 outerHtml：源里常见 `'' + el` 再拿正则抠里面
        assertTrue((eval("'' + doc.select('.list a').first()") ?: "").contains("href=\"/b/1.html\""))
    }

    @Test
    fun `JS 数组写法同样能用（库里两种各占一半）`() {
        assertEquals("第一千二百三十四章 归零|第二章新起风", eval(
            "var a = doc.select('.list a'); var out = [];" +
                "for (var i = 0; i < a.length; i++) out.push(a[i].text()); out.join('|');"
        ))
        assertEquals("2", eval("Array.from(doc.select('.list a')).length"))
        assertEquals("/b/1.html,/b/2.html", eval(
            "Array.from(doc.select('.list a')).map(function (x) { return x.attr('href'); }).join(',')"
        ))
        // ownText 不含子元素文字 —— 源用它区分书名与"新/ VIP"角标
        // Jsoup 的 text() 把内联 span 的文字并进来（没有空白），ownText() 才只有直接文本
        assertEquals("第二章新起风", eval("doc.select('.list a').get(1).text()"))
        // ownText 是"所有直属文本节点拼起来"，不是"第一段"：span 前后的文字都算，span 里的不算
        assertEquals("第二章起风", eval("doc.select('.list a').get(1).ownText()"))
        assertEquals("新", eval("doc.select('.list a .tag').first().ownText()"))
    }

    @Test
    fun `文档级取值与结构导航对得上`() {
        assertEquals("测试站", eval("doc.title()"))
        assertEquals("备注加粗尾巴", eval("doc.body().select('#note').text()"))
        assertEquals("b", eval("doc.getElementById('note').children().first().tagName()"))
        assertEquals("true", eval("doc.getElementById('note').parent() !== undefined"))
        assertTrue((eval("doc.html()") ?: "").contains("og:url"))
    }

    @Test
    fun `包装不打开网络与反射的口子`() {
        // Jsoup.connect 是网络出口；我们唯一的出口是带 SSRF 闸门的 java.ajax / fetchResponse。
        assertEquals("undefined", eval("typeof org.jsoup.Jsoup.connect"))
        // Document.connection() 在 Jsoup 里能顺出真实请求，白名单里不给。
        assertEquals("undefined", eval("typeof doc.connection"))
        // className 这类只读属性正面验一次（证明"没给 connect"不是把整个包装都关掉了）
        assertEquals("list", eval("doc.select('.list').first().className()"))
        // 反射口子必须仍然关着：包装不能把它带开
        val blocked = sandbox()
        assertNull(blocked.eval("Packages.java.lang.System.getProperty('user.home')", emptyMap(), null))
        assertTrue("反射应当依旧被拒，实际「${blocked.lastError}」",
            (blocked.lastError ?: "").contains("Packages") || (blocked.lastError ?: "").contains("未定义"))
    }

    @Test
    fun `选择器写坏时报的是能读懂的话`() {
        val source = sandbox()
        val out = source.eval(
            "try { org.jsoup.Jsoup.parse('<div>x</div>').select('##').size(); return '没报错'; }" +
                " catch (e) { return String(e.message || e); }",
            emptyMap(),
            JsExecutionContext(sourceId = "http://jsoup.example"),
        )
        // Jsoup 对畸形选择器会抛，包成一句能读懂的话即可；关键是别冒出"sandbox-compat 出错"这种顶罪文案
        assertTrue("报错要说清是谁的问题，实际「$out」",
            out == "没报错" || (out ?: "").contains("org.jsoup"))
        assertTrue("不该把锅甩给我们的兼容补丁：${source.lastError}",
            !(source.lastError ?: "").contains("sandbox-compat"))
    }

    @Test
    fun `空内容与脏内容都不该炸`() {
        val source = sandbox()
        assertEquals("0", source.eval(
            "org.jsoup.Jsoup.parse('').select('.nope').size()", emptyMap(),
            JsExecutionContext(sourceId = "http://jsoup.example"),
        ))
        assertEquals("undefined", source.eval(
            "typeof org.jsoup.Jsoup.parse(html).select('.list a').get(9)",
            mapOf("html" to page),
            JsExecutionContext(sourceId = "http://jsoup.example"),
        ))
    }
}
