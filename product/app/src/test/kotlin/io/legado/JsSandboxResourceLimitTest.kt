package io.legado

import io.legado.rules.JsExecutionContext
import io.legado.rules.JsSandbox
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 书源 JS 是**不可信**输入：任一导入的源都能执行任意脚本。
 *
 * 两类逃逸要分开看，拦截机制完全不同：
 *
 * 1. **耗指令**的死循环（`while(true){}`）—— 由 `JsGuard` 的 `observeInstructionCount` 墙钟守卫拦。
 * 2. **不耗指令**的宿主阻塞与分配（`Thread.sleep`、GZIP 解压炸弹、`setLength` 大额分配、深度递归）
 *    —— 指令观察器**永远等不到回调**，必须靠宿主侧的硬上限拦。
 *
 * 本文件钉第 2 类。它们原本全是敞开的：一句 `Packages.java.lang.Thread.sleep(999999)`
 * 就能占死一条工作线程，一个几百字节的 GZIP 能解出几十 GB 直接 OOM，而 `JsGuard` 全程看不见。
 *
 * 判据原则：**既断言"被拦住"，也断言"沙箱还活着"** ——
 * 只证明抛了错不够，还要证明这条线程能继续跑下一个脚本（不是被打掉）。
 *
 * 两个 API 事实（踩过才知道）：
 * - `JsSandbox.eval` 取的是**最后一个表达式的值**，不要写 `return`（写了反而拿不到）；
 * - `Packages.*` 那套宿主替身需要非空 `execContext` 才装得上，裸 `eval(script)` 取不到类。
 */
class JsSandboxResourceLimitTest {

    private fun context() = JsExecutionContext(sourceId = "https://limit.example")

    private fun eval(script: String): String? = JsSandbox().eval(script, emptyMap(), context())

    private fun evalThrew(script: String): Pair<Boolean, String> {
        val thrown = runCatching { eval(script) }.exceptionOrNull()
        return (thrown != null) to (thrown?.let { "${it::class.simpleName}: ${it.message}" } ?: "")
    }

    /** 每个用例之后沙箱必须还能工作 —— 证明没有把线程/进程打掉。 */
    private fun assertStillAlive() {
        val result = eval("1 + 1")
        assertNotNull("上一条恶意脚本之后，沙箱必须还能继续执行脚本", result)
        assertEquals("沙箱复活后应能算出 2，实际 $result", "2", result)
    }

    @Test
    fun `Thread_sleep 被限制在 1 秒内而不是睡满传入值`() {
        val started = System.currentTimeMillis()
        evalThrew("Packages.java.lang.Thread.sleep(99000); 1")
        val elapsed = System.currentTimeMillis() - started
        assertTrue(
            "sleep 必须被截到 1 秒内，实际睡了 ${elapsed}ms —— MAX_SLEEP_MS 上限没生效",
            elapsed < 5_000,
        )
        assertStillAlive()
    }

    @Test
    fun `currentThread 的 sleep 同样被限制`() {
        val started = System.currentTimeMillis()
        evalThrew("Packages.java.lang.Thread.currentThread().sleep(99000); 1")
        val elapsed = System.currentTimeMillis() - started
        assertTrue("currentThread().sleep 也必须被截到 1 秒内，实际 ${elapsed}ms", elapsed < 5_000)
        assertStillAlive()
    }

    @Test
    fun `getenv 不再泄露宿主环境变量`() {
        // PATH 在 Windows/Linux 上一定存在。取值必须是空串，不能是宿主真实值。
        val text = eval("String(Packages.java.lang.System.getenv('PATH'))") ?: ""
        assertTrue(
            "getenv('PATH') 必须返回空串而不是宿主真实值，实际拿到：${text.take(60)}",
            text.isEmpty() || text == "undefined",
        )
        assertStillAlive()
    }

    @Test
    fun `安全的环境变量探测写成空串而不是抛错`() {
        // 保留 key、恒返回空串的意义：源里常见的 `if (getenv('X')) …` 不能抛 TypeError。
        assertEquals(
            "getenv 必须仍然存在（返回空串），否则探测型脚本会抛 TypeError",
            "string",
            eval("typeof Packages.java.lang.System.getenv('TZ')"),
        )
        assertStillAlive()
    }

    @Test
    fun `setLength 被限制上限而不是分配任意大数组`() {
        // 不设上限时这一句会尝试分配约 2GB 的 char 数组 → OutOfMemoryError（Error，兜不住）。
        // 写成**单行、末尾是表达式**：eval 取最后一个表达式的值，多行/带 importPackage 的写法
        // 会被 JsScriptShape 判成"无返回值"而回 null（那不是被测行为，是判据写错了）。
        val n = eval(
            "var sb = Packages.java.lang.StringBuilder('x'); sb.setLength(1000000000); sb.length()",
        )?.toIntOrNull() ?: -1
        assertTrue("setLength(1e9) 必须被截到 1_000_000 以内，实际长度 $n", n in 0..1_000_000)
        assertStillAlive()
    }

    @Test
    fun `深度递归被解释栈上限挡住且不打掉线程`() {
        // 每层只消耗极少指令，墙钟守卫的检查间隔足够它把解释器栈推爆；
        // 拦截它的是 maximumInterpreterStackDepth = 1000。
        //
        // 判据只断言"没算出 100000"：Rhino 触发栈深上限时可能抛错、也可能回 undefined，
        // 那是库的实现细节，不该由判据钉死。真正要保证的是**进程没被打挂**（见 assertStillAlive）
        // 且结果不是那个需要 10 万层递归才能得出的值。
        val value = runCatching { eval("function f(n) { return f(n - 1) + 1; } f(100000)") }.getOrNull()
        assertTrue(
            "10 万层递归不能被真的算完（说明栈深上限没生效），实际结果：$value",
            value != "100000" && value != "100001",
        )
        assertStillAlive()
    }

    @Test
    fun `正常脚本不受这些上限影响`() {
        assertEquals(
            "短 sleep（10ms）应照常可用",
            "ok",
            eval("Packages.java.lang.Thread.sleep(10); 'ok'"),
        )
        assertEquals(
            "setLength 用于正常截断应照常可用",
            "abc",
            eval("var s = Packages.java.lang.StringBuilder('abcdef'); s.setLength(3); s.toString()"),
        )
        // GZIP 往返不做取值断言：`unGzip` 返回的是字节数组 JS 对象，而 `eval` 只把基本类型
        // 转成字符串（对象一律回 null）—— 那是表示层行为，不是上限误伤。这里只要求它**不抛错**，
        // "解压走限量实现"由下面那条结构性判据钉住。
        val gzipOutcome = runCatching {
            eval("cn.hutool.core.util.ZipUtil.unGzip(cn.hutool.core.util.ZipUtil.gzip('hello')); 'ok'")
        }
        assertTrue(
            "小数据 GZIP 往返不能被上限误伤（应正常完成），实际抛了：${gzipOutcome.exceptionOrNull()}",
            gzipOutcome.isSuccess,
        )
    }

    @Test
    fun `GZIP 解压走的是限量实现而不是无上限的 readBytes`() {
        // 这条是**结构性判据**，不是行为判据 —— 刻意取舍。
        //
        // 行为判据要构造"解压后 > 16MB"的压缩炸弹，但把这么大的字节数组喂进 Rhino
        // （JS 数组按元素装箱）会让**测试进程自己**先 OOM。实测 17 / 20 / 24MB 三种 payload
        // 全部触发 `Native memory allocation (mmap) failed`（DOS error 1455 = 页面文件打满），
        // 挂掉的是 Gradle 测试执行器，测不到被测代码。与其写一条会随机打爆 CI 的用例，
        // 不如钉住"解压必须走限量实现"这个结构事实；上限本身的正确性由 `unzipBounded`
        // 的实现保证。行为验证留给人工：手工喂压缩炸弹看进程是否存活。
        //
        // 2026-11-06：限量解压从 JavaPackages 抽进了 GzipLimits（`unzipBounded`），
        // 判据跟着拆成两半 —— 调用点看 JavaPackages，上限检查看 GzipLimits。
        val javaPackages = java.io.File("src/main/kotlin/io/legado/rules/JavaPackages.kt").readText()
        assertTrue(
            "`unGzip` 必须调用限量解压 `GzipLimits.unzipBounded`，不能回退到无上限的 readBytes()",
            javaPackages.contains("GzipLimits.unzipBounded(bytesOf("),
        )
        assertTrue(
            "JavaPackages 里不该再出现无上限的 `GZIPInputStream(...).readBytes()`",
            !javaPackages.contains("GZIPInputStream"),
        )
        val gzipLimits = java.io.File("src/main/kotlin/io/legado/rules/GzipLimits.kt").readText()
        assertTrue(
            "`unzipBounded` 必须真的检查输出上限（且用减法避免 Int 溢出）",
            gzipLimits.contains("out.size() > maxBytes - read"),
        )
        assertTrue(
            "上限常量必须存在，且不是 0 或负数",
            gzipLimits.contains("MAX_UNZIP_BYTES: Int = 16 * 1024 * 1024"),
        )
    }
}