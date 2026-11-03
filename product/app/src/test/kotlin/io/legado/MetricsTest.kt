package io.legado

import io.legado.ops.Metrics
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

    private fun topOf(sourceId: String): Map<String, Any>? {
        @Suppress("UNCHECKED_CAST")
        val tops = Metrics.snapshot()["topSources"] as List<Map<String, Any>>
        return tops.firstOrNull { it["sourceId"] == sourceId }
    }

    @Test
    fun `按源聚合调用失败超时命中与均值`() {
        Metrics.recordSearch("a", latencyMs = 100, timedOut = false, failed = false, resultCount = 5)
        Metrics.recordSearch("a", latencyMs = 300, timedOut = true, failed = true, resultCount = 0)
        val row = topOf("a")
        assertTrue(row != null)
        assertEquals(2L, (row!!["calls"] as Long))
        assertEquals(1L, row["timeouts"] as Long)
        assertEquals(0L, row["failures"] as Long)   // 超时优先，不计进 failures
        assertEquals(1L, row["matched"] as Long)
        assertEquals(200L, row["avgLatencyMs"] as Long)  // (100+300)/2
    }

    @Test
    fun `失败而非超时的源计入 failures`() {
        Metrics.recordSearch("e", latencyMs = 50, timedOut = false, failed = true, resultCount = 0)
        val row = topOf("e")!!
        assertEquals(1L, row["failures"] as Long)
        assertEquals(0L, row["timeouts"] as Long)
    }

    @Test
    fun `空 sourceId 不聚合`() {
        Metrics.recordSearch("", latencyMs = 10, timedOut = false, failed = false, resultCount = 0)
        assertEquals(0, (Metrics.snapshot()["trackedSources"] as Int))
    }

    @Test
    fun `整批请求与截断计数`() {
        Metrics.recordSearchRequest(truncated = false)
        Metrics.recordSearchRequest(truncated = true)
        val snap = Metrics.snapshot()
        assertEquals(2L, snap["searchRequests"] as Long)
        assertEquals(1L, snap["truncatedSearchRequests"] as Long)
    }

    @Test
    fun `快照按调用数降序且只留前 50 源`() {
        repeat(60) { i -> repeat(i + 1) { Metrics.recordSearch("s$i", 10, false, false, 1) } }
        val snap = Metrics.snapshot()
        assertEquals(60, snap["trackedSources"] as Int)
        @Suppress("UNCHECKED_CAST")
        val tops = snap["topSources"] as List<Map<String, Any>>
        assertEquals(50, tops.size)
        // 调用最多的是 s59（60 次），应排第一
        assertEquals("s59", tops.first()["sourceId"])
        val calls = tops.map { it["calls"] as Long }
        assertTrue(calls == calls.sortedDescending())
    }
}
