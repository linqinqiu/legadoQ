package io.legado

import io.legado.rules.JsExecutionContext
import io.legado.rules.JsSandbox
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 书源 JS 的 `java.t2s` / `java.s2t`。
 *
 * 本机库实测 30 条源用 `java.t2s`（11 条在 `ruleContent`）、7 条用 `java.s2t`；
 * 没绑定时调用 undefined 抛 TypeError，而正文路径不包 runCatching，表现是整章取不到。
 * 写法照社区源的真实形状（`@get:{a}` 之后 `java.t2s(tzs(result))`）。
 */
class JsScriptConvertBridgeTest {

    private val sandbox = JsSandbox()

    private fun evalOrFail(script: String): String {
        val ctx = JsExecutionContext(sourceId = "https://script.example/source")
        val out = sandbox.eval(script, emptyMap(), ctx)
        assertNull("脚本执行失败：${ctx.lastError}\n脚本：$script", ctx.lastError)
        return out ?: ""
    }

    @Test
    fun `java t2s 把繁体正文转成简体`() {
        val script = """
            function tzs(s) { return s }
            java.t2s(tzs("頭髮"))
        """.trimIndent()
        assertEquals("头发", evalOrFail(script))
    }

    @Test
    fun `java s2t 把简体转成繁体`() {
        assertEquals("頭髮", evalOrFail("java.s2t(\"头发\")"))
    }

    @Test
    fun `缺参回空串而不是字面量 undefined`() {
        // 上游对 null 返回 null；这里回空串，绝不能把 "undefined" 混进正文
        assertEquals("", evalOrFail("String(java.t2s())"))
        assertEquals("", evalOrFail("String(java.s2t(null))"))
    }
}
