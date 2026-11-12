package io.legado

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `LEGADO_JS_HOST_BYTES` 的映射判据。
 *
 * 这条环境变量是唯一能关掉累计预算的开关（`0 = 不设限`），而它此前没有任何判据：
 * `JsSandboxHostBudgetTest` 的三个用例都直接给构造参数传 `Long.MAX_VALUE`，
 * 绕过了 [AppConfig.resolveJsHostBytes] —— 也就是说「设 0 会关掉预算」这件事从未被验过，
 * 一旦解析写错（例如把 `0` 当成 0 字节上限），线上表现是**所有书源 JS 立刻全部被拒**，
 * 而沙箱判据依然全绿。
 *
 * 只测纯映射函数，不测静态字段本身：`System.getenv()` 进程级只读，
 * 想在单测里改 env 驱动 [AppConfig.jsHostBytes] 的初始化，只能起新进程。
 * 「字段确实读这个 key」由 [AppConfigEnvWiringTest] 统一对账，这里不重复。
 */
class AppConfigJsHostBytesTest {

    private val default = AppConfig.DEFAULT_JS_HOST_BYTES

    @Test
    fun `未设或解析不了时回落到 64MB 默认值`() {
        assertEquals(64L * 1024 * 1024, default)
        assertEquals(default, AppConfig.resolveJsHostBytes(null))
        assertEquals(default, AppConfig.resolveJsHostBytes(""))
        assertEquals(default, AppConfig.resolveJsHostBytes("   "))
        assertEquals(default, AppConfig.resolveJsHostBytes("64mb"))
        assertEquals(default, AppConfig.resolveJsHostBytes("1048576x"))
    }

    @Test
    fun `设 0 表示不设限`() {
        assertEquals(Long.MAX_VALUE, AppConfig.resolveJsHostBytes("0"))
        assertEquals(Long.MAX_VALUE, AppConfig.resolveJsHostBytes(" 0 "))
    }

    @Test
    fun `负数按不设限处理而不是负数上限`() {
        // 若按"上限 -5 字节"理解，第一条脚本的每一次分配都会超限，整个 JS 规则面立刻不可用。
        assertEquals(Long.MAX_VALUE, AppConfig.resolveJsHostBytes("-1"))
        assertEquals(Long.MAX_VALUE, AppConfig.resolveJsHostBytes("-9223372036854775808"))
    }

    @Test
    fun `正数按原值生效并容忍首尾空白`() {
        assertEquals(1_048_576L, AppConfig.resolveJsHostBytes("1048576"))
        assertEquals(1_048_576L, AppConfig.resolveJsHostBytes("  1048576  "))
        assertEquals(Long.MAX_VALUE, AppConfig.resolveJsHostBytes(Long.MAX_VALUE.toString()))
    }

    @Test
    fun `默认值可被调用方覆盖`() {
        assertEquals(123L, AppConfig.resolveJsHostBytes(null, 123L))
        // 覆盖的默认值同样走"非正数即不设限"这条规则。
        assertEquals(Long.MAX_VALUE, AppConfig.resolveJsHostBytes("0", 123L))
    }

    @Test
    fun `静态字段的取值永远为正`() {
        // 接线（字段是否真的读 LEGADO_JS_HOST_BYTES）由 AppConfigEnvWiringTest 统一覆盖，
        // 这里只钉住"不设限用 Long.MAX_VALUE 表达"这条不变式：字段永远不该是 0 或负数。
        assertTrue("不设限时是 Long.MAX_VALUE，任何情况下都不该是 0 或负数", AppConfig.jsHostBytes > 0)
    }
}
