package io.legado

import io.legado.rules.JsExecutionContext
import io.legado.rules.JsSandbox
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「宿主放大」类逃逸的判据。
 *
 * 与 [JsSandboxResourceLimitTest] 同源，但钉的是**另一类**：那里是「已知的具体 API 没上限」，
 * 这里是「**长度值由脚本给、开销发生在宿主**」这个模式。
 *
 * 共同点是 `JsGuard` 的指令观察器全程失明 —— 开销发生在 Kotlin 侧，一条 Rhino 指令都不产生。
 * 一句三五个 Rhino 指令的调用就能让宿主申请 2GB 或空转 20 亿次：
 *
 * - `Arrays.equals({length: 2147483000}, [])` —— `length` 是普通属性，不需要真的大数组
 * - `Arrays.fill({length: 2000000000}, 65)` —— 宿主 for 循环
 * - `System.arraycopy([1], 0, {}, 0, 2000000000)` —— 同上
 * - `sb.append(...)` 循环 —— 累计增长，绕过 `setLength` 的上限
 * - `Arrays.copyOf([1], 20000000)` —— 超过 `bytesArray` 的元素上限
 *
 * 判据一律断言「**抛错**（可被 `runCatching` 兜住）而不是 `OutOfMemoryError`」，
 * 并且断言沙箱随后仍然可用 —— 后者才是真正要保的东西。
 *
 * 注意这些用例**不会真的分配大内存**：上限检查发生在分配之前。
 * 若哪天检查被挪到分配之后，这些用例会先把测试进程打爆，那正是要暴露的信号。
 */
class JsSandboxHostAmplificationTest {

    private fun context() = JsExecutionContext(sourceId = "https://amplify.example")

    private fun eval(script: String): String? = JsSandbox().eval(script, emptyMap(), context())

    /** 跑一段脚本，返回 `(结果, 抛出的异常)`。 */
    private fun attempt(script: String): Pair<String?, Throwable?> {
        val thrown = runCatching { eval(script) }.exceptionOrNull()
        return runCatching { eval(script) }.getOrNull() to thrown
    }

    private fun assertStillAlive() {
        val result = eval("1 + 1")
        assertNotNull("恶意脚本之后沙箱必须还能继续执行", result)
        assertTrue("沙箱复活后应能算出 2，实际 $result", result == "2")
    }

    /** 断言脚本被**拒绝**（或有界地返回），且拒绝理由不是内存耗尽。 */
    private fun assertRejectedOrBounded(script: String, what: String) {
        val (value, thrown) = attempt(script)
        assertTrue(
            "$what 必须被上限拦住；实际返回了「$value」",
            thrown != null || (value?.length ?: 0) < 1_000_000,
        )
        if (thrown != null) {
            assertTrue(
                "$what 必须抛可兜住的 Exception（如 IllegalArgumentException），而不是 Error；" +
                    "实际 ${thrown::class.qualifiedName}: ${thrown.message}",
                thrown is Exception && thrown !is OutOfMemoryError,
            )
        }
        assertStillAlive()
    }

    @Test
    fun `脚本可控的 length 不能直接决定宿主分配量`() {
        // length 是个普通属性，不需要真数组。原本这一句会申请约 2GB。
        assertRejectedOrBounded(
            "Packages.java.util.Arrays.equals({length: 2147483000}, [])",
            "Arrays.equals 的脚本 length",
        )
    }

    @Test
    fun `Arrays_fill 的宿主循环被长度上限拦住`() {
        assertRejectedOrBounded(
            "Packages.java.util.Arrays.fill({length: 2000000000}, 65)",
            "Arrays.fill 的宿主循环",
        )
    }

    @Test
    fun `System_arraycopy 的宿主循环被长度上限拦住`() {
        assertRejectedOrBounded(
            "Packages.java.lang.System.arraycopy([1], 0, {}, 0, 2000000000)",
            "System.arraycopy 的宿主循环",
        )
    }

    @Test
    fun `Arrays_copyOf 不能按脚本要求放大到亿级`() {
        assertRejectedOrBounded(
            "Packages.java.util.Arrays.copyOf([1], 20000000)",
            "Arrays.copyOf 的目标长度",
        )
    }

    @Test
    fun `StringBuilder 的 append 累计增长受同一个上限约束`() {
        // 关键：这条**不经过 setLength**，所以只卡 setLength 是假防护。
        // 200 万字符就该被拒（上限 1e6）。
        assertRejectedOrBounded(
            "var sb = Packages.java.lang.StringBuilder('x');" +
                "for (var i = 0; i < 40; i++) { sb.append('a'.repeat(100000)); }" +
                "sb.length()",
            "StringBuilder.append 的累计长度",
        )
    }

    @Test
    fun `正常规模的数组操作不受影响`() {
        // 上限不能误伤真实书源：真实规则处理的是几百字节到几兆。
        assertTrue(
            "小数组的 equals 应照常可用",
            eval("Packages.java.util.Arrays.equals([1, 2, 3], [1, 2, 3])") == "true",
        )
        assertTrue(
            "小 StringBuilder 拼接应照常可用",
            eval(
                "var sb = Packages.java.lang.StringBuilder('ab'); sb.append('cd'); sb.toString()",
            ) == "abcd",
        )
        assertTrue(
            "copyOf 正常扩容应照常可用",
            eval("Packages.java.util.Arrays.copyOf([1, 2], 4).length") == "4",
        )
    }
}
