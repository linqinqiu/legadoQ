package io.legado

import io.legado.ops.Metrics
import io.legado.rules.RuleRunner
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * 分阶段埋点（`GET /api/diagnostics` 的 `stages`）。
 *
 * 判据盯三件事：
 * ① 累计量算得对（调用/失败/均值/最大），别把失败也计进成功均值；
 * ② `timed {}` 抛异常时**照样记一次失败**再原样抛出 —— 埋点不能改变控制流；
 * ③ 排序按"累计耗时"倒序，第一行就该是最值得看的那个阶段。
 */
class MetricsStageTest {

    @Before
    fun reset() {
        Metrics.reset()
    }

    @Test
    fun `累计调用与失败，均值按调用次数算`() {
        Metrics.recordStage("content", 100, true)
        Metrics.recordStage("content", 300, false)
        val stage = Metrics.snapshot().stages.first { it.stage == "content" }
        assertEquals(2, stage.calls.toInt())
        assertEquals(1, stage.failures.toInt())
        assertEquals("均值含失败那次", 200, stage.avgLatencyMs.toInt())
        assertEquals("最近一次", 300, stage.lastLatencyMs.toInt())
        assertEquals("最慢一次", 300, stage.maxLatencyMs.toInt())
    }

    @Test
    fun `timed 成功记成功，抛异常记失败并原样抛出`() {
        val value = Metrics.timed("js") { 42 }
        assertEquals(42, value)
        assertEquals(0, Metrics.snapshot().stages.first { it.stage == "js" }.failures.toInt())

        var thrown = false
        try {
            Metrics.timed<Unit>("js") { throw IllegalStateException("脚本炸了") }
        } catch (error: IllegalStateException) {
            thrown = true
            assertEquals("异常不能被埋点吞掉", "脚本炸了", error.message)
        }
        assertTrue("异常要原样抛出", thrown)
        val stage = Metrics.snapshot().stages.first { it.stage == "js" }
        assertEquals(2, stage.calls.toInt())
        assertEquals(1, stage.failures.toInt())
    }

    @Test
    fun `阶段按累计耗时倒序，空名字不记`() {
        Metrics.recordStage("http", 10, true)      // 10
        Metrics.recordStage("search", 400, true)   // 400
        Metrics.recordStage("toc", 50, true)
        Metrics.recordStage("toc", 50, true)       // 100
        Metrics.recordStage("", 999, true)
        val stages = Metrics.snapshot().stages.map { it.stage }
        assertEquals(listOf("search", "toc", "http"), stages)
        assertTrue("空阶段名不该出现", stages.none { it.isBlank() })
    }

    @Test
    fun `阶段表有上限，超了丢新名字但已有阶段照常累计`() {
        repeat(60) { Metrics.recordStage("stage-$it", 1, true) }
        val before = Metrics.snapshot().stages.size
        assertTrue("上限要生效，实际 $before", before <= 40)
        Metrics.recordStage("stage-0", 5, true)
        val first = Metrics.snapshot().stages.first { it.stage == "stage-0" }
        assertEquals("已有的阶段继续累计", 2, first.calls.toInt())
    }

    /**
     * `http` 那一格必须记在**抓取**这一层：`GuardedHttpClient` 拿到的是 `ofInputStream`，
     * 正文在 `send` 返回之后才读完，记在 client 上会把"正文慢"漏掉；而且 AI 的连接共用同一个
     * client，记进去会把模型调用混进书源诊断。这条用例钉住"一次抓取 = 一次 http 记录"。
     */
    @Test
    fun `一次抓取记一次 http，失败也记`() {
        val runner = RuleRunner().apply {
            fetchedFetcher = { url -> RuleRunner.Fetched(url, "<html>正文</html>", 200, emptyMap()) }
        }
        assertEquals("<html>正文</html>", runner.fetch("https://example.test/book/1"))
        val ok = Metrics.snapshot().stages.first { it.stage == "http" }
        assertEquals(1, ok.calls.toInt())
        assertEquals(0, ok.failures.toInt())

        runner.fetchedFetcher = { throw java.io.IOException("连接被重置") }
        runCatching { runner.fetch("https://example.test/book/2") }
        val failed = Metrics.snapshot().stages.first { it.stage == "http" }
        assertEquals("失败也要留一次记录", 2, failed.calls.toInt())
        assertEquals(1, failed.failures.toInt())
    }
}
