package io.legado

import io.legado.data.queryLogs

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import io.legado.port.LogCategory
import io.legado.ops.LogEntry
import io.legado.port.LogLevel
import io.legado.ops.LogService
import io.legado.port.LogSink
import io.legado.port.logNetwork
import io.legado.port.logParsing
import io.legado.port.logSink

/**
 * 日志产出的三条判据。都是一次 4,000 行采样里真实踩到的形状
 * （3,039 行 ERROR、2,112 行空行、1,093 行同样的"IO 异常"）：
 * 一条日志必须是一行、级别必须说真话、同类必须合并。
 */
class LogServiceTest {

    /**
     * 日志门面已下沉到 `port/Logging.kt`，实现由 infra 侧显式装进来（`LogService.install()`）。
     * 生产环境里 `Application` 的 `LogService.initialize(...)` 早就装了；
     * 这条用例验的是"便捷函数的默认级别对不对"，它必须走**同一套门面**才有意义，
     * 所以这里也要先装配 —— 而不是直接调 `LogService.log` 把门面绕过去。
     */
    @Before
    fun installSink() {
        LogService.install()
    }

    private fun find(marker: String): List<LogEntry> =
        LogService.queryLogs(limit = 1000).filter { it.message.contains(marker) }

    @Test
    fun `multi-line payloads collapse into a single line`() {
        val folded = LogService.oneLine("第一行\n第二行\r\n第三行     尾巴", 300)
        assertTrue("折行后不许再有任何换行符：[${folded}]", !folded.contains('\n') && !folded.contains('\r'))
        assertTrue("换行要留下可见的痕迹：[${folded}]", folded.contains("⏎"))
        assertTrue("连续空白要压成一个空格：[${folded}]", !folded.contains("   "))
        assertEquals("第一行⏎第二行 ⏎第三行 尾巴", folded)
        val capped = LogService.oneLine("啊".repeat(500), 40)
        assertEquals(40, capped.length)
        assertTrue("超长必须带省略号，不能悄悄截掉", capped.endsWith("…"))
    }

    @Test
    fun `the same message inside the window merges into one row with a count`() {
        val marker = "合并判据-${System.nanoTime()}"
        repeat(4) { LogService.log(LogCategory.SYSTEM, LogLevel.WARN, marker) }
        val rows = find(marker)
        assertEquals("同类日志应当并成一行，实际出现 ${rows.size} 行", 1, rows.size)
        assertEquals(4, rows.first().count)
    }

    @Test
    fun `different sources are not merged into each other`() {
        val marker = "分源判据-${System.nanoTime()}"
        LogService.log(LogCategory.SYSTEM, LogLevel.WARN, marker, mapOf("sourceId" to "甲源"))
        LogService.log(LogCategory.SYSTEM, LogLevel.WARN, marker, mapOf("sourceId" to "乙源"))
        LogService.log(LogCategory.SYSTEM, LogLevel.WARN, marker, mapOf("sourceId" to "乙源"))
        val rows = find(marker)
        assertEquals("两个源各一行", 2, rows.size)
        assertEquals("同一个源的两条要合并", listOf(1, 2), rows.map { it.count }.sorted())
    }

    @Test
    fun `network helper defaults to WARN, not ERROR`() {
        // 一个死源反复 404 是这个产品最常见的"错误"，它不该把 ERROR 的额度吃光，
        // 否则真出事时界面上满屏红，等于没有红。
        val marker = "默认级别判据-${System.nanoTime()}"
        Any().logNetwork(marker, mapOf("statusCode" to "404"))
        val row = find(marker).single()
        assertEquals(LogLevel.WARN.name, row.level)
    }

    /**
     * 端口化的**核心不变量**：门面只认 `LogSink`，没有任何一条路径绕过它直接够 `LogService`。
     *
     * 为什么这条值得单独钉住：把门面从 `ops/LogService.kt` 搬到 `port/Logging.kt` 之后，
     * 判据 5 看到的"engine → ops"确实消失了 —— 但那只能证明 **import** 没了，
     * 证明不了**运行时**没有第二条路。只要有人（哪怕是善意地在 engine 里补一句
     * `LogService.log(...)`）绕开门面，引擎就又悄悄焊回 SQLite 了，而 import 判据**看不见**。
     *
     * 换掉 `logSink` 就能拦下一切：真有一条绕过门面的直调，它照样会落进 `LogService` 的内存队列，
     * 于是 `sinkHits` 里不会有它、`find(marker)` 里却会有一条 —— 两个方向都能红。
     */
    @Test
    fun `门面是唯一出口：换掉 sink 之后引擎日志既进得了探针也进不了库`() {
        val marker = "端口不变量判据-${System.nanoTime()}"
        val sinkHits = mutableListOf<String>()
        val probe = object : LogSink {
            override fun log(
                category: LogCategory,
                level: LogLevel,
                rawMessage: String,
                context: Map<String, String>,
                exception: Throwable?,
            ) {
                sinkHits += "${category.name}|${level.name}|$rawMessage"
            }
        }

        logSink = probe
        try {
            Any().logParsing(marker, mapOf("probe" to "1"))
            // logParsing 的默认级别是 WARN，端口化之后这个默认值必须原样保留。
            assertEquals(
                "门面必须把日志交给当前 sink（而不是写死 LogService）",
                listOf("PARSING|WARN|$marker"),
                sinkHits,
            )
            // 反向：此刻日志**不该**同时落进 LogService 的内存队列。
            assertEquals(
                "换掉 sink 之后，日志仍然被 LogService 收走了 —— 说明存在绕过门面的第二条路径",
                emptyList<LogEntry>(),
                find(marker),
            )
        } finally {
            LogService.install()
        }
    }
}
