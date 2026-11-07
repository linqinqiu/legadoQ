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

/** 单个阶段的耗时与失败率（解析 / 脚本 / 出站 HTTP 各算一个阶段）。 */
@Serializable
data class StageMetricSnapshot(
    val stage: String,
    val calls: Long,
    val failures: Long,
    /** 累计均值：够看出"这一阶段是不是普遍慢"，不需要保留样本。 */
    val avgLatencyMs: Long,
    val lastLatencyMs: Long,
    val maxLatencyMs: Long,
)

/** `GET /api/diagnostics` 的响应体；字段与 agent-api.json 声明的形状一致。 */
@Serializable
data class DiagnosticsSnapshot(
    val searchRequests: Long,
    val truncatedSearchRequests: Long,
    val trackedSources: Int,
    val topSources: List<SourceMetricSnapshot>,
    /** 分阶段耗时：`search` / `details` / `toc` / `content` / `js` / `http`。 */
    val stages: List<StageMetricSnapshot> = emptyList(),
)

/**
 * 进程内的轻量运行指标：给 `GET /api/diagnostics` 读数用，回答"到底是哪个书源在拖慢搜索"
 * 这类单机自托管最常问的问题（对齐 `docs/ARCHITECTURE.md §13.4`「可观测性薄」那条自陈缺口）。
 *
 * 刻意不上 Prometheus / Micrometer：这台服务没有运维栈，加一层依赖换来的收益不划算。
 * 做法是一个按书源聚合的原子计数器表 + 两个全局计数，读时快照。**不是**请求级 P99 直方图
 * （那要保留样本、还要防表无界增长）；这里只留每源累计量与均值。
 *
 * 2026-11-07 补上**分阶段耗时**（[recordStage]）：`search` / `details` / `toc` / `content` /
 * `js` / `http` 各一格。按书源那张表回答"哪个源慢"，这一张回答"慢在站点还是慢在脚本"。
 *
 * 阶段是**包含关系**，不是互斥切片：`content` 里跑 `js`，`js` 里可能发 `http`。所以读法是
 * "外层总耗时 − 内层耗时 = 这一层自己的开销"，而不是把几格相加当总时间。
 * 数据只在内存，重启清零——诊断是"这次运行"的现场，不是历史报表。
 *
 * 上限保护：书源数以千计，`snapshot()` 只回调用数最高的前 [TOP_SOURCES] 条，避免把整张表倒进响应。
 */
object Metrics {
    private const val TOP_SOURCES = 50
    /** 阶段名有上限：名字来自代码常量，但别让一次拼错把表撑大。 */
    private const val MAX_STAGES = 40

    private class Cell {
        val calls = AtomicLong()
        val failures = AtomicLong()
        val timeouts = AtomicLong()
        val matched = AtomicLong()
        val totalLatencyMs = AtomicLong()
        @Volatile var lastLatencyMs = 0L
        @Volatile var updatedAt = 0L
    }

    private class StageCell {
        val calls = AtomicLong()
        val failures = AtomicLong()
        val totalLatencyMs = AtomicLong()
        @Volatile var lastLatencyMs = 0L
        @Volatile var maxLatencyMs = 0L
    }

    private val cells = ConcurrentHashMap<String, Cell>()
    private val stageCells = ConcurrentHashMap<String, StageCell>()
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

    /**
     * 记一次阶段耗时（解析 / 脚本求值 / 出站 HTTP）。
     *
     * 与按书源那张表的分工：那张回答"哪个源慢"，这张回答"慢在哪个阶段" ——
     * 取正文慢可能是站点慢（http），也可能是规则脚本死循环（js），两者修法完全不同。
     * 只留累计均值与最大值，不留样本：单机自托管不需要 P99，也不该为此常驻内存。
     */
    fun recordStage(stage: String, latencyMs: Long, ok: Boolean) {
        if (stage.isBlank()) return
        // 表满之后丢掉新名字而不是清表：诊断读数是"这次运行"的现场，抖掉最热的几个阶段更难解释。
        if (stageCells.size >= MAX_STAGES && !stageCells.containsKey(stage)) return
        val c = stageCells.getOrPut(stage) { StageCell() }
        val ms = latencyMs.coerceAtLeast(0)
        c.calls.incrementAndGet()
        c.totalLatencyMs.addAndGet(ms)
        c.lastLatencyMs = ms
        if (ms > c.maxLatencyMs) c.maxLatencyMs = ms
        if (!ok) c.failures.incrementAndGet()
    }

    /**
     * 包一段代码并记阶段耗时；抛异常时同样记一次（算失败）再原样抛出。
     *
     * inline 是为了让调用方能在里面 `return` —— 被包的函数大多有多个提前返回。
     */
    inline fun <T> timed(stage: String, block: () -> T): T {
        val started = System.nanoTime()
        try {
            val result = block()
            recordStage(stage, (System.nanoTime() - started) / 1_000_000, true)
            return result
        } catch (error: Throwable) {
            recordStage(stage, (System.nanoTime() - started) / 1_000_000, false)
            throw error
        }
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
            // 按累计耗时倒序：第一行就该是"最值得先看"的那个阶段。
            stages = stageCells.entries
                .map { (name, c) ->
                    val calls = c.calls.get()
                    StageMetricSnapshot(
                        stage = name,
                        calls = calls,
                        failures = c.failures.get(),
                        avgLatencyMs = if (calls > 0) c.totalLatencyMs.get() / calls else 0L,
                        lastLatencyMs = c.lastLatencyMs,
                        maxLatencyMs = c.maxLatencyMs,
                    )
                }
                .filter { it.calls > 0 }
                .sortedByDescending { it.avgLatencyMs * it.calls },
        )
    }

    /** 仅供测试复位。 */
    internal fun reset() {
        cells.clear()
        stageCells.clear()
        searchRequests.set(0)
        searchTruncatedRequests.set(0)
    }
}
