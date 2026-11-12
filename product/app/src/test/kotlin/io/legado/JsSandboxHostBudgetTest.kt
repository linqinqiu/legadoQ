package io.legado

import io.legado.rules.JsExecutionContext
import io.legado.rules.JsSandbox
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 宿主侧**累计**预算的判据（审计 E 项）。
 *
 * 单次上限（8MB / 16MB）挡不住"多次小额、脚本保留"：一次 8MB 的 `copyOf` 完全合法，
 * 脚本把结果塞进 JS 数组保留，几十次就是数百 MB。这条路径不耗 Rhino 指令、也不阻塞，
 * 墙钟守卫（`observeInstructionCount`）全程失明 —— 只有累计记账拦得住。
 *
 * 判据一律**注入小预算**（1MB），不构造真实大 payload：Rhino 会把字节数组按元素装箱，
 * 十几 MB 的输入能直接把 Gradle 测试执行器打挂（审计 §4 记过这个坑）。
 *
 * 与既有三份沙箱判据同一纪律：既断言"被拦住"，也断言"沙箱随后仍可用"。
 */
class JsSandboxHostBudgetTest {

    private fun context() = JsExecutionContext(sourceId = "https://budget.example")

    private fun sandbox(budget: Long = 1024L * 1024) = JsSandbox(hostByteBudget = budget)

    /** 一次执行的结果与失败原因。`eval` 不向调用方抛异常（见 `JsSandbox.evalImpl` 的 catch），
     *  超限一律表现为「返回 null + `lastError` 有值」——判据必须按这个形状读，不能等异常。 */
    private data class Attempt(val result: String?, val error: String?)

    private fun attempt(budget: Long, script: String): Attempt {
        val sandbox = sandbox(budget)
        return Attempt(sandbox.eval(script, emptyMap(), context()), sandbox.lastError)
    }

    private fun assertStillAlive(budget: Long) {
        val result = sandbox(budget).eval("1 + 1", emptyMap(), context())
        assertNotNull("超限被拒之后，沙箱必须还能继续执行脚本", result)
        assertEquals("沙箱复活后应能算出 2，实际 $result", "2", result)
    }

    @Test
    fun `单次没超单次上限、但累计超过预算时必须中断`() {
        // 每次 400KB：远低于 8MB 的单次上限，5 次合计 2MB，超过 1MB 预算。
        val script = """
            for (var i = 0; i < 5; i++) {
                var chunk = Packages.java.util.Arrays.copyOf([1, 2, 3], 400000);
            }
            1
        """.trimIndent()
        val outcome = attempt(1L * 1024 * 1024, script)
        assertNull("累计超过预算必须被拒绝，实际返回了结果：${outcome.result}", outcome.result)
        val text = outcome.error
        assertNotNull("累计超过预算必须留下拒绝理由，实际 lastError 为空", text)
        assertTrue(
            "拒绝理由应当是累计预算，而不是内存耗尽或语法错误：$text",
            text!!.contains("累计分配宿主内存"),
        )
        assertStillAlive(1L * 1024 * 1024)
    }

    @Test
    fun `预算之内的大块分配照常放行`() {
        val script = """
            var chunk = Packages.java.util.Arrays.copyOf([1, 2, 3], 200000);
            chunk.length
        """.trimIndent()
        val outcome = attempt(4L * 1024 * 1024, script)
        assertNull("预算内的正常分配不该被拦，实际 lastError：${outcome.error}", outcome.error)
        assertEquals("预算内应照常返回数组长度", "200000", outcome.result)
        assertStillAlive(4L * 1024 * 1024)
    }

    @Test
    fun `设成不设限时行为与从前一致`() {
        val script = """
            var total = 0;
            for (var i = 0; i < 6; i++) {
                var chunk = Packages.java.util.Arrays.copyOf([1, 2, 3], 400000);
                total += 1;
            }
            total
        """.trimIndent()
        val outcome = attempt(Long.MAX_VALUE, script)
        assertNull("不设限时不该中断，实际 lastError：${outcome.error}", outcome.error)
        assertEquals("不设限时 6 次分配都应完成", "6", outcome.result)
    }
}
