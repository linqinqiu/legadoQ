package io.legado

import io.legado.rules.JsSandbox
import io.legado.rules.RuleRunner
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 失败原因的归属：沙箱是多线程共用的，`lastError` 既不能跨线程串，也不能跨请求串。
 *
 * 实测：并发抽查书源时，一本**没有任何脚本**的 CSS 正文失败，提示里却带着另一本书源
 * 的 `JSON.parse` 报错 —— 原来的 `@Volatile lastError` 是全局单值，谁最后失败就是谁。
 * 正文规则本身没有脚本却报「脚本异常」，比不报还难排查。
 */
class SandboxErrorScopeTest {

    @Test
    fun `上一个书源的脚本错误不会算到这一次头上`() {
        val sandbox = JsSandbox()
        // 先制造一条失败原因（与真实语料里的 JSON.parse 报错同形）
        sandbox.eval("JSON.parse('{bad json')")
        assertNotNull("前置条件：这条脚本要真的失败", sandbox.lastError)

        sandbox.withSourceContext(null) {
            assertNull("新上下文入口要清掉上一轮留下的失败原因", sandbox.lastError)
            sandbox.eval("1 + 1")
            assertNull("这次脚本成功，不能继承上一次的错误", sandbox.lastError)
        }
    }

    @Test
    fun `空响应的搜索给出 0 字节提示而不是 JSONPath 的非法参数`() {
        val source = """
            {
              "bookSourceUrl":"https://empty.example",
              "bookSourceName":"空响应",
              "searchUrl":"https://empty.example/search?k={{key}}",
              "ruleSearch":{"bookList":"$.list","name":"$.name","bookUrl":"$.url"}
            }
        """.trimIndent()

        val error = runCatching { RuleRunner { "" }.search(source, "词") }.exceptionOrNull()

        assertNotNull("空响应必须失败", error)
        val message = error?.message.orEmpty()
        assertTrue("要能看出是上游没给内容：$message", message.contains("0 字节"))
        assertTrue(
            "不该把 JSONPath 的 IllegalArgumentException 直接甩给用户：$message",
            !message.contains("json string can not be null or empty"),
        )
    }
}
