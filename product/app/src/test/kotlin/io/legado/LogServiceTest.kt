package io.legado

import io.legado.data.queryLogs

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import io.legado.ops.LogCategory
import io.legado.ops.LogEntry
import io.legado.ops.LogLevel
import io.legado.ops.LogService
import io.legado.ops.logNetwork

/**
 * 日志产出的三条判据。都是一次 4,000 行采样里真实踩到的形状
 * （3,039 行 ERROR、2,112 行空行、1,093 行同样的"IO 异常"）：
 * 一条日志必须是一行、级别必须说真话、同类必须合并。
 */
class LogServiceTest {

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
}
