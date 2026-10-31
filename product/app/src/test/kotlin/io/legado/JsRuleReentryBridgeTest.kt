package io.legado

import io.legado.rules.JsExecutionContext
import io.legado.rules.JsSandbox
import io.legado.rules.RuleRunner
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 书源脚本调用、而我们沙箱原先没有的 `java.*` 方法。
 *
 * 起因是实跑：type-3（文件源）两份启用源在**搜索阶段**就死掉，界面只给一句
 * `TypeError: 未找到对象默认值。 (rule.js#2)`，而脚本里写的其实只是
 * `java.encodeURI(key, 'gbk')`。把全库扫了一遍（`tmp/java_bridge_gap.txt`），
 * 引用了但桥上不存在的方法按份数排：`getElement` 226、`getElements` 170、
 * `toNumChapter` 146、`encodeURI` 91、`getStringList` 72、`setContent` 72、
 * `timeFormatUTC` 59。这一条把它们逐个钉住。
 *
 * 上游口径（`AnalyzeRule.evalJS`：`bindings["java"] = this`）：脚本里的 `java` 就是**规则解析器本身**，
 * 所以 `java.setContent(x)` 之后再 `java.getString/getElements` 解析的是 x 而不是页面原文。
 */
class JsRuleReentryBridgeTest {
    private val page = "<html><body><ul class=\"list\">" +
        "<li class=\"it\" data-id=\"7\"><a href=\"/b/1.html\">第一千二百三十四章 归零</a></li>" +
        "<li class=\"it\" data-id=\"8\"><a href=\"/b/2.html\">第二十三章 起风</a></li>" +
        "<li class=\"it\" data-id=\"9\"><a href=\"/b/3.html\">终章</a></li>" +
        "</ul></body></html>"

    /** 每次新建沙箱：`lastError` 是实例级的，复用会把上一个脚本的错误带进断言。 */
    private fun eval(script: String): String? {
        val sandbox = JsSandbox(RuleRunner { url -> error("这条判据不发网络请求：$url") })
        val out = sandbox.eval(script, emptyMap(), JsExecutionContext(sourceId = "http://reentry.example"))
        // 脚本返回 null 基本都是里面抛了异常、被沙箱收成 lastError。
        // 不把它写进断言，红起来只剩「expected … but was null」，看不出是桥方法没生效还是脚本写错了。
        assertTrue("脚本报错：${sandbox.lastError ?: "（无，就是返回了 null）"}", out != null)
        return out
    }

    private fun content(script: String): String = "java.setContent('$page');$script"

    @Test
    fun `setContent 之后的取值解析的是这份内容`() {
        assertEquals("第一千二百三十四章 归零", eval(content("java.getString('class.list@tag.li.0@tag.a@text')")))
    }

    @Test
    fun `列表再入在引擎侧就能取到条目（不过 Rhino）`() {
        val runner = RuleRunner { url -> error("这条判据不发网络请求：$url") }
        val items = runner.listItemsByRule(page, ".list .it", "http://reentry.example")
        assertEquals(3, items.size)
        assertTrue(items[0].contains("data-id=\"7\""))
        // JSON 内容同一条路：取到的每条要能再被 JSON.parse
        val jsonItems = runner.listItemsByRule(
            """{"data":{"list":[{"n":"甲"},{"n":"乙"}]}}""",
            "$.data.list[*]",
            null,
        )
        assertEquals(2, jsonItems.size)
        assertTrue(jsonItems[1].contains("乙"))
    }

    @Test
    fun `getElements 给的是条目数组，脚本能按长度遍历`() {
        val out = eval(
            content(
                "var items = java.getElements('.list .it');" +
                    "var marks = [];" +
                    "for (var i = 0; i < items.length; i++) marks.push(items[i].indexOf('data-id') > 0);" +
                    "marks.join(',') + '|' + items.length;"
            )
        )
        assertEquals("true,true,true|3", out)
    }

    @Test
    fun `getStringList 与 getElements 同一份形状，JSON 条目给的是 JSON 文本`() {
        val out = eval(
            "java.setContent('{\"data\":{\"list\":[{\"n\":\"甲\"},{\"n\":\"乙\"}]}}');" +
                "var arr = java.getStringList('$.data.list[*]');" +
                "arr.length + '|' + JSON.parse(arr[1]).n;"
        )
        assertEquals("2|乙", out)
    }

    @Test
    fun `getStringList 第二个参数指定的内容优先于页面原文`() {
        // 上游签名 `getStringList(rule, mContent, isUrl)`，库里 17 处真的传第二个参数。
        val out = eval(
            "var html = '<select><option value=\"\">请选择</option><option value=\"gbk\">GBK</option></select>';" +
                "java.getStringList('option@value', html, false).join('|');"
        )
        // 上游对空属性值直接跳过（`if (url.isBlank()) continue`），那个「请选择」的空 value 不进列表
        assertEquals("gbk", out)
    }

    @Test
    fun `getStringList 传 isUrl 时把取值补成绝对地址`() {
        val out = eval(
            "java.setContent('<div id=\"b\"><a href=\"/n/1.html\">第一章</a><a href=\"/n/2.html\">第二章</a></div>'," +
                "'http://reentry.example/book/');" +
                "java.getStringList('#b@a@href', null, true).join(',');"
        )
        assertEquals("http://reentry.example/n/1.html,http://reentry.example/n/2.html", out)
    }

    @Test
    fun `getElement 提供脚本当 jQuery 用的那几个成员`() {
        val out = eval(
            content("var one = java.getElement('.list .it');[one.exists, one.attr('data-id'), one.text().indexOf('归零') > 0].join('|');")
        )
        assertEquals("true|7|true", out)
    }

    @Test
    fun `encodeURI 按声明的字符集转义`() {
        assertEquals("%E5%89%91%E6%9D%A5+%26x", eval("java.encodeURI('剑来 &x')"))
        // 「剑」的 GBK 码位是 BD A3（不是 UTF-8 的 E5 89 91）：GBK 老站的搜索词就靠这个拼
        assertEquals("%BD%A3", eval("java.encodeURI('剑', 'gbk')"))
    }

    @Test
    fun `toNumChapter 把中文序号归一成数字`() {
        // 上游 `toNumChapter` 只返回「第…章」这一段匹配，标题后面跟着的文字会被丢掉 ——
        // 社区源都拿它处理纯序号，这里照上游，不做"顺手改进"。
        assertEquals("第1234章", eval("java.toNumChapter('第一千二百三十四章 归零')"))
        assertEquals("第23章", eval("java.toNumChapter('第二十三章 起风')"))
        // 认不出来的写法原样返回
        assertEquals("终章", eval("java.toNumChapter('终章')"))
    }

    @Test
    fun `timeFormatUTC 按小时偏移格式化`() {
        assertEquals("1970-01-01 00:00:00", eval("java.timeFormatUTC(0, 'yyyy-MM-dd HH:mm:ss', 0)"))
        assertEquals("1970-01-01 08:00:00", eval("java.timeFormatUTC(0, 'yyyy-MM-dd HH:mm:ss', 8)"))
    }
}
