package io.legado

import io.legado.rules.BoundedJs
import io.legado.rules.GzipLimits
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.util.zip.GZIPOutputStream
import org.mozilla.javascript.Context
import org.mozilla.javascript.EvaluatorException

/**
 * 两条判据，钉的是「防护**真的会触发**」，而不是「防护的代码看起来对」。
 *
 * 它们之所以此前不存在，原因很具体：
 *
 * - **GZIP 那条**：上限原先写在 `JavaPackages` 的私有成员里，要验它就得把十几 MB 的字节数组
 *   喂进 Rhino。Rhino 把字节数组按元素装箱成 JS 数组，测试进程自己先 OOM（实测 17/20/24MB
 *   三种 payload 全部触发 `Native memory allocation (mmap) failed`，`DOS error 1455` 是 Windows
 *   页面文件被打满，挂的是 Gradle 测试执行器 —— 测的就不是被测代码）。提成顶层纯函数后，
 *   17MB 输入直接调即可，峰值内存约 35MB。
 *
 * - **墙钟守卫那条**：超时原先硬读 `AppConfig.jsTimeoutMs`（默认 30s，进程级、测试改不动）。
 *   要验「死循环会被中断」就得在 CI 里干等 30 秒。改成可注入后传 120ms，一秒内跑完。
 */
class JsGuardLimitsTest {

    // ─────────────────────────── GZIP 限量 ───────────────────────────

    @Test
    fun `解压超过上限时抛错中断，而不是把整个包解完`() {
        // 17MB 全零字节 → 压缩后约 17KB（压缩率极高，正是"压缩炸弹"的形状）
        val bomb = gzipOf(ByteArray(17 * 1024 * 1024))

        val thrown = runCatching { GzipLimits.unzipBounded(bomb) }.exceptionOrNull()

        assertTrue(
            "17MB > 16MB 上限，必须抛错中断；实际 ${if (thrown == null) "正常返回了" else "抛了 $thrown"}",
            thrown is IllegalArgumentException,
        )
        assertTrue(
            "报错文案要说清是解压超限（便于用户分辨是书源问题还是程序问题），实际：${thrown?.message}",
            thrown?.message?.contains("上限") == true,
        )
    }

    @Test
    fun `上限以内的小数据照常解压`() {
        val payload = "hello legado".toByteArray()
        val restored = GzipLimits.unzipBounded(gzipOf(payload))
        assertEquals("小数据往返必须无损（上限不能误伤真实书源）", "hello legado", String(restored))
    }

    @Test
    fun `上限是参数而不是写死的常量`() {
        // 这条钉的是「可测性」本身：上限能调小，判据才不用构造十几 MB。
        val data = ByteArray(2048) { 7 }
        val thrown = runCatching { GzipLimits.unzipBounded(gzipOf(data), maxBytes = 1024) }.exceptionOrNull()
        assertTrue("maxBytes=1024 时 2KB 的包必须被拒，实际：$thrown", thrown is IllegalArgumentException)
    }

    @Test
    fun `边界值不外溢，刚好等于上限时放行`() {
        val data = ByteArray(1024) { 3 }
        val restored = GzipLimits.unzipBounded(gzipOf(data), maxBytes = 1024)
        assertEquals("恰好等于上限必须放行（判据不能把等号写成大于）", 1024, restored.size)
    }

    @Test
    fun `非正的 maxBytes 被拒绝`() {
        val thrown = runCatching { GzipLimits.unzipBounded(gzipOf(ByteArray(8)), maxBytes = 0) }.exceptionOrNull()
        assertTrue("maxBytes=0 必须是非法参数，实际：$thrown", thrown is IllegalArgumentException)
    }

    // ─────────────────────── 墙钟守卫真的会触发 ───────────────────────

    @Test
    fun `死循环在超过注入的墙钟上限后被中断`() {
        val started = System.currentTimeMillis()
        val thrown = runCatching {
            withBoundedJs(timeoutMs = 120L) { cx ->
                cx.evaluateString(
                    cx.initSafeStandardObjects(),
                    "while (true) { }",
                    "loop.js",
                    1,
                    null,
                )
            }
        }.exceptionOrNull()
        val elapsed = System.currentTimeMillis() - started

        assertTrue(
            "死循环必须被中断（这正是这道闸存在的唯一理由），实际：${thrown ?: "它跑完了——不可能"}",
            thrown != null,
        )
        assertTrue(
            "中断必须由指令观察器抛出，而不是别的偶然异常；实际类型 ${thrown!!::class.qualifiedName}",
            thrown is EvaluatorException,
        )
        assertTrue(
            "必须在上限附近结束（120ms 上限 + 检查间隔 2 万条指令），实际耗时 ${elapsed}ms",
            elapsed < 5_000,
        )
        assertTrue(
            "报错文案要带出本次的上限值，便于用户知道调哪个环境变量；实际：${thrown.message}",
            thrown.message?.contains("120") == true,
        )
    }

    @Test
    fun `合法脚本远不触发上限`() {
        val started = System.currentTimeMillis()
        val result = withBoundedJs(timeoutMs = 120L) { cx ->
            cx.evaluateString(cx.initSafeStandardObjects(), "1 + 1", "ok.js", 1, null)
        }
        val elapsed = System.currentTimeMillis() - started

        assertEquals("合法脚本必须正常返回 2", 2.0, (result as Number).toDouble(), 0.0001)
        assertTrue("合法脚本不该被上限误伤，实际耗时 ${elapsed}ms", elapsed < 1_000)
    }

    @Test
    fun `两次进入各自独立计时，上一单元的剩余时间不会带过来`() {
        // 曾经的风险：deadline 若放在 factory 上而不是每个 Context 上，
        // 一个刚用完的超时 Context 会把下一次刚进来的执行立刻判死。
        val first = runCatching {
            withBoundedJs(timeoutMs = 120L) { cx ->
                cx.evaluateString(cx.initSafeStandardObjects(), "while (true) { }", "a.js", 1, null)
            }
        }
        assertTrue("前置条件：第一次必须超时", first.isFailure)

        // 紧接着再来一次，正常的短脚本必须能跑完
        val second = withBoundedJs(timeoutMs = 5000L) { cx ->
            cx.evaluateString(cx.initSafeStandardObjects(), "'fine'", "b.js", 1, null)
        }
        assertEquals("前一次超时不能污染后一次执行", "fine", second)
    }

    // ─────────────────────────── 辅助 ───────────────────────────

    private fun gzipOf(bytes: ByteArray): ByteArray =
        ByteArrayOutputStream().also { out ->
            GZIPOutputStream(out).use { it.write(bytes) }
        }.toByteArray()

    /**
     * 在 `BoundedJs.enter(timeoutMs)` 的上下文里跑一段脚本，并保证配对 `exit()`。
     *
     * `optimizationLevel = -1` 必须显式设：`observeInstructionCount` 只在解释模式下被回调，
     * 编译模式下这条判据会变成"什么都没观察、直接跑完 30 秒然后失败"。
     */
    private fun <T> withBoundedJs(timeoutMs: Long, block: (Context) -> T): T {
        val cx = BoundedJs.enter(timeoutMs)
        try {
            cx.optimizationLevel = -1
            return block(cx)
        } finally {
            BoundedJs.exit()
        }
    }
}
