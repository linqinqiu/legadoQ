package io.legado.rules

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * ruleData 缓存（[newRuleDataCache]）的淘汰语义判据 —— 对应「目录取 0 章」这条老 bug 的根治。
 *
 * 从前超限就整表 `clear()`：长跑进程 + 多书源时，别的书刚 `@put`、还没 `@get` 的变量被一起抹掉，
 * 漫画源目录就取不到章节。改成 LRU 后，只有最久没碰的那条会走，最近用过的键留下。
 */
class RuleDataCacheLruTest {

    @Test
    fun `超上限只淘汰最久没碰的键 最近读过的留下`() {
        val cap = 3
        val cache = newRuleDataCache(cap)
        cache["a"] = mapOf("bid" to "A")
        cache["b"] = mapOf("bid" to "B")
        cache["c"] = mapOf("bid" to "C")

        // 读一次 a —— accessOrder=true 让 a 变成"最近使用"，此时最久没碰的是 b。
        assertEquals(mapOf("bid" to "A"), cache["a"])

        // 塞进第 4 条触发淘汰：走的应是最久没碰的 b，而不是整表清空。
        cache["d"] = mapOf("bid" to "D")

        assertNull("最久没碰的 b 应被淘汰", cache["b"])
        assertNotNull("刚被读过的 a 必须留下（正是搜索存完马上要 @get 的那本）", cache["a"])
        assertNotNull("c 应留下", cache["c"])
        assertNotNull("新来的 d 应留下", cache["d"])
        assertEquals("容量封顶在 maxKeys", cap, cache.size)
    }

    @Test
    fun `反复命中热键时 冷键先被挤掉`() {
        val cap = 2
        val cache = newRuleDataCache(cap)
        cache["hot"] = mapOf("k" to "H")
        cache["cold1"] = mapOf("k" to "1")
        // 反复用 hot，让它始终是最热的
        cache["hot"]
        cache["hot"] = mapOf("k" to "H")
        cache["cold2"] = mapOf("k" to "2") // 触发淘汰，应挤掉最冷的一个冷键，hot 保住
        assertNotNull("反复使用的热键不能因新键进来被误伤", cache["hot"])
        assertEquals(cap, cache.size)
    }
}
