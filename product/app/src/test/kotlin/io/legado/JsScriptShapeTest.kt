package io.legado

import io.legado.rules.JsExecutionContext
import io.legado.rules.JsSandbox
import io.legado.rules.JsScriptShape
import io.legado.rules.RuleRunner
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 书源脚本的**返回形状**：什么时候整段的结果会被吞成空。
 *
 * 起因是活体排查时发现：连 `[1,2].map(function (x) { return x * 2; }).join(',')` 都返回空。
 * 根因不在 map，在我们自己 —— 旧实现"文本里出现过 `return` 就把整段包成
 * `(function(){ … })()`"，于是"只在嵌套函数里 return、末尾是表达式"的脚本
 * 外层函数没有 return，完成值变 undefined。表现是"这条规则取到空值"，
 * 而脚本一声不响 —— 启用库里 210 份源的脚本片段同时含 `function` 与 `return`。
 *
 * 两条线都要钉住：**顶层 return 要继续能用**（大量源就靠它，去掉就直接废），
 * 嵌套 return 不再吞掉结果。
 */
class JsScriptShapeTest {
    private fun eval(script: String): String? =
        JsSandbox(RuleRunner { url -> error("这条判据不发网络请求：$url") })
            .eval(script, emptyMap(), JsExecutionContext(sourceId = "http://shape.example"))

    @Test
    fun `嵌套函数里 return 末尾表达式 结果不再被吞`() {
        assertEquals("2,4", eval("[1,2].map(function (x) { return x * 2; }).join(',')"))
        assertEquals("2,4", eval("var f = function (x) { return x * 2; }; [1,2].map(f).join(',')"))
        assertEquals("2,4", eval("var r = [1,2].map(function (x) { return x * 2; }); r.join(',')"))
        assertEquals("2", eval("[1,2].map(function (x) { return x * 2; }).length"))
        // 数组套对象这种社区常见写法（取一层字段再拼）
        assertEquals(
            "甲|乙",
            eval("""var d = org.jsoup.Jsoup.parse('<i>甲</i><i>乙</i>');""" +
                " Array.from(d.select('i')).map(function (x) { return x.text(); }).join('|')"),
        )
    }

    @Test
    fun `顶层 return 依旧有效（源大量靠它）`() {
        assertEquals("命中", eval("if (1 === 1) { return '命中'; } return '兜底';"))
        assertEquals("兜底", eval("if (1 === 2) { return '命中'; } return '兜底';"))
        // 顶层与嵌套同时存在：按顶层走（包装后仍能拿到顶层返回值）
        assertEquals("顶", eval("var f = function () { return '内'; }; f(); return '顶';"))
    }

    @Test
    fun `AST 判得对，不是靠文本猜`() {
        assertFalse(JsScriptShape.hasTopLevelReturn("[1,2].map(function (x) { return x; })"))
        assertTrue(JsScriptShape.hasTopLevelReturn("return 1;"))
        assertFalse(JsScriptShape.hasTopLevelReturn("var f = () => { return 1; }; f();"))
        assertTrue(JsScriptShape.hasTopLevelReturn("var f = function () { return 1; }; f(); return 2;"))
        // 字符串字面量里出现 return 不算（旧的文本判断会误包）
        assertFalse(JsScriptShape.hasTopLevelReturn("var s = 'please return it'; s"))
    }

    @Test
    fun `语法坏掉的脚本退回旧判断，不因解析器差异改变行为`() {
        // 解析不了 → 兜底按文本判断：含 return 就仍旧包一层
        assertTrue(JsScriptShape.hasTopLevelReturn("function ( { return 1"))
        // 求值本身失败时按现有约定返回 null（不是返回空字符串）
        assertNull(eval("function ( { return 1"))
    }

    @Test
    fun `脚本里解析 JSON 失败时报的是能读懂的话`() {   // 方法名不能带点，所以标题里没有 JSON.parse
        // 我们为了"result 已经是对象"这件事给 JSON.parse 打过兼容补丁，
        // 补丁定义在名为 sandbox-compat 的脚本里，Rhino 就按那个名字报来源：
        // 源里一句 `JSON.parse('%7B...')` 失败，界面显示成
        // `SyntaxError: Unexpected token: % (sandbox-compat#1)`，看着像我们引擎坏了。
        val out = eval(
            "try { JSON.parse('%7B%22a%22%3A1%7D'); return '居然解析成功了'; } catch (e) { return String(e.message || e); }"
        ) ?: ""
        assertTrue("要说清是脚本里的 JSON.parse 失败：$out", out.contains("JSON.parse"))
        assertFalse("不该把锅甩给我们的兼容补丁：$out", out.contains("sandbox-compat"))
    }
}
