package io.legado

import io.legado.http.orderByHealth
import io.legado.model.SourceRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 搜索按体检结论排先后 —— 让「跑几十分钟的体检」终于能被最需要它的地方用上。
 *
 * 背景：体检结论以前只活在浏览器 localStorage 里，服务端看不到。
 * 于是同步搜索在截止时间内（默认 60 秒）只能搜完一部分源，
 * 且按名称顺序发车 —— 数字开头的老站大半是死站，同样的时间搜不到多少有用结果。
 *
 * 这里钉三条规则：
 * 1. 体检通过的排最前、慢的其后、连不上的最后；
 * 2. 同档内按延迟升序（快的先搜）；
 * 3. **没体检过的源**排在体检过的之后，但**保持原有相对顺序**（稳定）——
 *    "没体检"不是"不能用"，不该被歧视。
 */
class SearchHealthOrderTest {

    private fun rec(id: String) = SourceRecord(id = id, json = "{}", version = 1, updatedAt = 0L)

    private val health = mapOf(
        "fast-ok" to (0 to 120L),
        "slow-ok" to (1 to 5000L),
        "dead" to (2 to 30000L),
    )

    @Test
    fun `体检通过的排最前 慢的其后 连不上的最后`() {
        val sources = listOf(rec("dead"), rec("slow-ok"), rec("fast-ok"))
        val ordered = orderByHealth(sources, health).map { it.id }
        assertEquals(listOf("fast-ok", "slow-ok", "dead"), ordered)
    }

    @Test
    fun `同档内按延迟升序 快的先搜`() {
        val sources = listOf(rec("slow-ok"), rec("fast-ok"))
        val ordered = orderByHealth(sources, health).map { it.id }
        assertEquals(listOf("fast-ok", "slow-ok"), ordered)
    }

    @Test
    fun `没体检过的源排在体检过的之后 且保持原有相对顺序`() {
        // "未知"不是"不能用"，只是没证据该靠前 —— 所以排在最后，但不打乱它们彼此的顺序。
        val sources = listOf(rec("unknown-b"), rec("dead"), rec("unknown-a"), rec("fast-ok"))
        val ordered = orderByHealth(sources, health).map { it.id }
        assertEquals(listOf("fast-ok", "dead", "unknown-b", "unknown-a"), ordered)
    }

    @Test
    fun `一条体检结论都没有时原样返回`() {
        val sources = listOf(rec("a"), rec("b"), rec("c"))
        val ordered = orderByHealth(sources, emptyMap())
        assertEquals(listOf("a", "b", "c"), ordered.map { it.id })
    }

    @Test
    fun `源清单为空时也安全`() {
        assertTrue(orderByHealth(emptyList(), health).isEmpty())
    }

    @Test
    fun `排序不增不减 也不改变内容`() {
        val sources = (1..50).map { rec("s$it") }
        val ordered = orderByHealth(sources, health)
        assertEquals("条数不能变", 50, ordered.size)
        assertEquals("内容不能变（只是换了顺序）", sources.map { it.id }.toSet(), ordered.map { it.id }.toSet())
    }

    @Test
    fun `体检结论的 id 与书源 id 对不上时 不崩也不丢`() {
        // 体检表里可能有已删书源的残留（体检完删了源），排序必须容忍。
        val stale = mapOf("deleted-source" to (0 to 10L))
        val sources = listOf(rec("a"), rec("b"))
        val ordered = orderByHealth(sources, stale).map { it.id }
        assertEquals(listOf("a", "b"), ordered)
    }

    @Test
    fun `延迟同为 0 时按原顺序 不抖`() {
        val tie = mapOf("a" to (0 to 0L), "b" to (0 to 0L), "c" to (0 to 0L))
        val sources = listOf(rec("c"), rec("a"), rec("b"))
        val ordered = orderByHealth(sources, tie).map { it.id }
        assertEquals("同分同延迟要保持原顺序", listOf("c", "a", "b"), ordered)
    }

    @Test
    fun `健康分档的边界 三秒是快慢线`() {
        // 分档阈值 3000ms：>=3000 算慢。这条钉住边界，免得谁随手改了阈值没人知道。
        val boundary = mapOf("ok-fast" to (0 to 2999L), "ok-slow" to (1 to 3000L))
        val sources = listOf(rec("ok-slow"), rec("ok-fast"))
        val ordered = orderByHealth(sources, boundary).map { it.id }
        assertEquals(listOf("ok-fast", "ok-slow"), ordered)
    }
}
