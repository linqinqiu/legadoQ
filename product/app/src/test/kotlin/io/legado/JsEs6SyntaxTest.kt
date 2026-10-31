package io.legado

import io.legado.rules.JsSandbox
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 书源 JS 的**语法版本**：Rhino 必须显式开 ES6，否则箭头函数与模板字符串直接 `SyntaxError`。
 *
 * 为什么单独立一条：上游两处都显式设了（`modules/rhino` 的 `RhinoScriptEngine`、
 * `AnalyzeUrl` 的 `Context.VERSION_ES6`），我们没设 —— Rhino 默认停在 ES5。
 * 影响面是实测扫出来的：启用库里有 **665 份**源的脚本写 `=>`、**429 份**写 `` `${}` `` 模板串，
 * 它们在界面上统一表现为「搜索失败 / 正文规则未提取到内容」，
 * 报错只有一句 `SyntaxError: Unexpected token`（例：🎨丁斐🅰 的正文规则
 * `list.map(x=>'<img src="'+host+x+'">').join("\n")`，整章图一张都出不来）。
 */
class JsEs6SyntaxTest {
    private val sandbox = JsSandbox()

    @Test
    fun `箭头函数能跑`() {
        assertEquals("2,4,6", sandbox.eval("[1,2,3].map(x => x * 2).join(',')"))
    }

    @Test
    fun `模板字符串能拼`() {
        assertEquals("第7章 起风", sandbox.eval("var n = 7; var t = '起风'; `第\${n}章 \${t}`"))
    }

    @Test
    fun `let 与 const 能声明`() {
        assertEquals("8", sandbox.eval("const a = 3; let b = 5; String(a + b)"))
    }

    @Test
    fun `对象解构与默认值能用在语句里`() {
        // 参数列表里的解构（`({x, y = '乙'}) => …`）Rhino 这一版还不支持，社区书源也不会这么写；
        // 语句里的解构才是常见形状（取接口字段时用）。
        assertEquals("甲|乙", sandbox.eval("var o = { x: '甲' }; var { x, y = '乙' } = o; x + '|' + y"))
    }

    @Test
    fun `语法真的写错时仍然如实报错`() {
        // 开了 ES6 不等于把错误吞掉：写坏的脚本还是失败，并且留下可读的原因。
        assertNull(sandbox.eval("var = ;"))
        assertEquals(true, sandbox.lastError?.isNotBlank())
    }
}
