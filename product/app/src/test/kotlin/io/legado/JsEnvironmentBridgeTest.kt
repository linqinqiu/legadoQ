package io.legado

import io.legado.rules.JsExecutionContext
import io.legado.rules.JsSandbox
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 宿主探测位 `globalThis.environment`。
 *
 * legado-E / Sigma 系书源用它决定 `[newpage]` 由谁替换；没有这个全局时取属性就抛 TypeError，
 * 而正文规则那条路径不包 runCatching（`RuleRunner.kt:959`），表现是整章正文取不到。
 * 本机库实测命中 1 条源（蓝批小说，两行重复导入）。
 */
class JsEnvironmentBridgeTest {

    private val sandbox = JsSandbox()

    private fun evalOrFail(script: String): String {
        val ctx = JsExecutionContext(sourceId = "https://env.example/source")
        val out = sandbox.eval(script, emptyMap(), ctx)
        assertNull("脚本执行失败：${ctx.lastError}\n脚本：$script", ctx.lastError)
        return out ?: ""
    }

    @Test
    fun `environment 暴露 IS_LEGADO_SIGMA 且为 false`() {
        // 我们是 Web 阅读器，不做 Sigma 的「保留标记交给阅读器分页」契约。
        assertEquals("false", evalOrFail("String(globalThis.environment.IS_LEGADO_SIGMA)"))
    }

    @Test
    fun `蓝批式 newpage 分支不再抛 TypeError`() {
        val script = """
            function replaceNewPage(content) {
                if (!globalThis.environment.IS_LEGADO_SIGMA) {
                    content = content.replace(/[ 　]*\[newpage][ 　]*/gm, "\n\n");
                }
                return content;
            }
            replaceNewPage("上[newpage]下")
        """.trimIndent()
        assertEquals("上\n\n下", evalOrFail(script))
    }
}
