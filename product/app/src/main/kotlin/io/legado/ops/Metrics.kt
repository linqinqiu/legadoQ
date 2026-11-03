package io.legado.ops

import kotlinx.serialization.Serializable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/** 单书源的聚合指标；`avgLatencyMs` 为累计均值。 */
@Serializable
data class SourceMetricSnapshot(
    val sourceId: String,
    val calls: Long,
    val failures: Long,
    val timeouts: Long,
    val matched: Long,
    val avgLatencyMs: Long,
    val lastLatencyMs: Long,
    val updatedAt: Long,
)

/** `GET /api/diagnostics` 的响应体；字段与 agent-api.json 声明的形状一致。 */
@Serializable
data class DiagnosticsSnapshot(
    val searchRequests: Long,
    val truncatedSearchRequests: Long,
    val trackedSources: Int,
    val topSources: List<SourceMetricSnapshot>,
)

/**
 * 进程内的轻量运行指标：给 `GET /api/diagnostics` 读数用，回答"到底是哪个书源在拖慢搜索"
 * 这类单机自托管最常问的问题（对齐 `docs/ARCHITECTURE.md §13.4`「可观测性薄」那条自陈缺口）。
 *
 * 刻意不上 Prometheus / Micrometer：这台服务没有运维栈，加一层依赖换来的收益不划算。
 * 做法是一个按书源聚合的原子计数器表 + 两个全局计数，读时快照。**不是**请求级 P99 直方图
 * （那要保留样本、还要防表无界增长）；这里只留每源累计量与均值，`@js` 逐段耗时留到 RuleRunner
 * 拆分那一轮再补。数据只在内存，重启清零——诊断是"这次运行"的现场，不是历史报表。
 *
 * 上限保护：书源数以千计，`snapshot()` 只回调用数最高的前 [TOP_SOURCES] 条，避免把整张表倒进响应。
 */
object Metrics {
    private const val TOP_SOURCES = 50

    private class Cell {
        val calls = AtomicLong()
        val failures = AtomicLong()
        val timeouts = AtomicLong()
        val matched = AtomicLong()
        val totalLatencyMs = AtomicLong()
        @Volatile var lastLatencyMs = 0L
        @Volatile var updatedAt = 0L
    }

    private val cells = ConcurrentHashMap<String, Cell>()
    private val searchRequests = AtomicLong()
    private val searchTruncatedRequests = AtomicLong()

    private fun cell(id: String): Cell = cells.getOrPut(id) { Cell() }

    /** 记一次「某书源被搜了一遍」的结局。`sourceId` 为空的调用（单测/内部）不聚合到具名源。 */
    fun recordSearch(sourceId: String, latencyMs: Long, timedOut: Boolean, failed: Boolean, resultCount: Int) {
        if (sourceId.isBlank()) return
        val c = cell(sourceId)
        val ms = latencyMs.coerceAtLeast(0)
        c.calls.incrementAndGet()
        c.totalLatencyMs.addAndGet(ms)
        c.lastLatencyMs = ms
        c.updatedAt = System.currentTimeMillis()
        when {
            timedOut -> c.timeouts.incrementAndGet()
            failed -> c.failures.incrementAndGet()
        }
        if (resultCount > 0) c.matched.incrementAndGet()
    }

    /** 记一次整批搜索请求，以及它是否因总量截止被截断。 */
    fun recordSearchRequest(truncated: Boolean) {
        searchRequests.incrementAndGet()
        if (truncated) searchTruncatedRequests.incrementAndGet()
    }

    fun snapshot(): DiagnosticsSnapshot {
        val top = cells.entries
            .map { (id, c) ->
                val calls = c.calls.get()
                SourceMetricSnapshot(
                    sourceId = id,
                    calls = calls,
                    failures = c.failures.get(),
                    timeouts = c.timeouts.get(),
                    matched = c.matched.get(),
                    avgLatencyMs = if (calls > 0) c.totalLatencyMs.get() / calls else 0L,
                    lastLatencyMs = c.lastLatencyMs,
                    updatedAt = c.updatedAt,
                )
            }
            .filter { it.calls > 0 }
            .sortedByDescending { it.calls }
            .take(TOP_SOURCES)
        return DiagnosticsSnapshot(
            searchRequests = searchRequests.get(),
            truncatedSearchRequests = searchTruncatedRequests.get(),
            trackedSources = cells.values.count { it.calls.get() > 0 },
            topSources = top,
        )
    }

    /** 仅供测试复位。 */
    internal fun reset() {
        cells.clear()
        searchRequests.set(0)
        searchTruncatedRequests.set(0)
    }
}
