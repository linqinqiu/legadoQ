package io.legado

import io.legado.ops.Metrics
import io.legado.ops.SourceMetricSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * 进程内指标聚合的判据：按源累计、快照排序与上限、整批请求/截断计数、空源不聚合。
 * 每个用例前 reset()，避免并发用例串扰（Metrics 是全局 object）。
 */
class MetricsTest {

    @Before
    fun setUp() = Metrics.reset()

    private fun topOf(sourceId: String): SourceMetricSnapshot? =
        Metrics.snapshot().topSources.firstOrNull { it.sourceId == sourceId }

    @Test
    fun `按源聚合调用失败超时命中与均值`() {
        Metrics.recordSearch("a", latencyMs = 100, timedOut = false, failed = false, resultCount = 5)
        Metrics.recordSearch("a", latencyMs = 300, timedOut = true, failed = true, resultCount = 0)
        val row = topOf("a")
        assertTrue(row != null)
        assertEquals(2L, row!!.calls)
        assertEquals(1L, row.timeouts)
        assertEquals(0L, row.failures)   // 超时优先，不计进 failures
        assertEquals(1L, row.matched)
        assertEquals(200L, row.avgLatencyMs)  // (100+300)/2
    }

    @Test
    fun `失败而非超时的源计入 failures`() {
        Metrics.recordSearch("e", latencyMs = 50, timedOut = false, failed = true, resultCount = 0)
        val row = topOf("e")!!
        assertEquals(1L, row.failures)
        assertEquals(0L, row.timeouts)
    }

    @Test
    fun `空 sourceId 不聚合`() {
        Metrics.recordSearch("", latencyMs = 10, timedOut = false, failed = false, resultCount = 0)
        assertEquals(0, Metrics.snapshot().trackedSources)
    }

    @Test
    fun `整批请求与截断计数`() {
        Metrics.recordSearchRequest(truncated = false)
        Metrics.recordSearchRequest(truncated = true)
        val snap = Metrics.snapshot()
        assertEquals(2L, snap.searchRequests)
        assertEquals(1L, snap.truncatedSearchRequests)
    }

    @Test
    fun `快照按调用数降序且只留前 50 源`() {
        repeat(60) { i -> repeat(i + 1) { Metrics.recordSearch("s$i", 10, false, false, 1) } }
        val snap = Metrics.snapshot()
        assertEquals(60, snap.trackedSources)
        assertEquals(50, snap.topSources.size)
        assertEquals("s59", snap.topSources.first().sourceId)   // 调用最多的排第一
        val calls = snap.topSources.map { it.calls }
        assertEquals(calls.sortedDescending(), calls)
    }
}
