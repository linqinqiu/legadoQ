package io.legado

import io.legado.http.DeadlineCollection
import io.legado.http.collectWithDeadline
import kotlinx.coroutines.delay
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * 带总量截止的并发收集 —— 修的是「同步搜索把请求拖过 300 秒」那个真实故障。
 *
 * 背景（实测）：
 * - 本机 5598 个启用书源，`/api/search` 不带 sourceIds 就是全库扫。
 * - 单源并发 16~32、单源超时 30s ⇒ 全量理论 25~87 分钟。
 * - `tools/verify/selfcheck.mjs` 在 300 秒处客户端超时，报
 *   「FAIL 多源并发搜索在 300 秒内返回」。
 * - 根因不是并发不够，而是 `RuleRunner` 用**阻塞式** `HttpClient.send()`：
 *   它不响应线程中断，外面套 `withTimeout` 取消不掉，慢源一直占着并发名额。
 *
 * 这里钉的是**行为**：
 * 1. 到点必须返回（不能把调用方挂住）；
 * 2. 返回的是"已经搜到的"那些，不是空的；
 * 3. 必须能说清"搜完了几个 / 共几个"；
 * 4. 不设截止时行为与旧的一致（等完全部）。
 */
class SearchDeadlineTest {

    @Test
    fun `到点就返回 不等慢源`() {
        // 慢源用「阻塞闸门」模拟真实链路：RuleRunner 走阻塞式 HttpClient.send()，不响应协程取消。
        // 之前用 delay(30_000) 模拟，取消时 delay 会立刻抛 CancellationException 并被 runCatching
        // 吞掉，`done` 照样 +1 —— 机器繁忙时会偶发「全部算完成、truncated=false」的假失败。
        val gate = CountDownLatch(1)
        val finished = AtomicInteger()
        val started = System.currentTimeMillis()
        val outcome = try {
            kotlinx.coroutines.runBlocking {
                collectWithDeadline(
                    values = (1..40).toList(),
                    limit = 4,
                    deadlineMs = 300,
                ) { value ->
                    // 一半很快、一半很慢（模拟慢站），慢的会一直占着并发名额直到测试收尾
                    if (value % 2 == 0) {
                        delay(5)
                    } else {
                        gate.await(30, TimeUnit.SECONDS)
                    }
                    finished.incrementAndGet()
                    value
                }
            }
        } finally {
            // 到点返回后松开闸门，让被占住的线程自己收尾（它们已经不在返回值里了）
            gate.countDown()
        }
        val elapsed = System.currentTimeMillis() - started

        assertTrue("必须在截止附近返回，实际 ${elapsed}ms", elapsed < 3_000)
        assertTrue("不能白等 30 秒的慢源", elapsed < 5_000)
        assertTrue("必须拿到已经搜到的部分（不能返回空）", outcome.values.isNotEmpty())
        // 并发只有 4，慢源会占住名额，所以"快的全收到"不成立；
        // 这里只要求：返回的都是快的那些（慢的一个都没混进来），且确实有一批。
        assertTrue("返回的必须都是跑完了的那些（慢源不许混进来）", outcome.values.all { it % 2 == 0 })
        assertTrue("至少要收到几个快的，实际 ${outcome.values.size}", outcome.values.size >= 1)
        assertTrue("必须如实说被截断了", outcome.truncated)
        assertTrue("completed 必须小于 total", outcome.completed < outcome.total)
        assertEquals("total 是输入条数", 40, outcome.total)
    }

    @Test
    fun `全部能按时跑完时不标截断`() {
        val outcome = kotlinx.coroutines.runBlocking {
            collectWithDeadline(
                values = (1..20).toList(),
                limit = 8,
                deadlineMs = 10_000,
            ) { it * 2 }
        }
        assertFalse("跑完了就不该说截断", outcome.truncated)
        assertEquals("completed 应等于 total", outcome.total, outcome.completed)
        assertEquals("结果一条都不能少", 20, outcome.values.size)
        assertEquals("值要正确", 40, outcome.values.max())
    }

    @Test
    fun `不设截止时保持旧行为 等完全部`() {
        val outcome = kotlinx.coroutines.runBlocking {
            collectWithDeadline(
                values = (1..12).toList(),
                limit = 4,
                deadlineMs = 0,
            ) { delay(10); it }
        }
        assertFalse("deadlineMs=0 表示不限制", outcome.truncated)
        assertEquals(12, outcome.values.size)
    }

    @Test
    fun `单个源抛异常不算整次失败`() {
        val outcome = kotlinx.coroutines.runBlocking {
            collectWithDeadline(
                values = (1..10).toList(),
                limit = 4,
                deadlineMs = 5_000,
            ) { if (it % 3 == 0) error("这个源坏了") else it }
        }
        assertFalse("坏源不该让整次搜索失败", outcome.truncated)
        // 1..10 里 3、6、9 会抛异常 —— 坏 3 个，好 7 个。
        assertEquals("坏的那几个被跳过，其余都在", 7, outcome.values.size)
        assertTrue("好的那些要真的在里面", outcome.values.contains(1))
    }

    @Test
    fun `空输入直接返回 不空转`() {
        val outcome: DeadlineCollection<Int> = kotlinx.coroutines.runBlocking {
            collectWithDeadline(emptyList<Int>(), limit = 4, deadlineMs = 5_000) { it }
        }
        assertEquals(0, outcome.total)
        assertEquals(0, outcome.completed)
        assertTrue(outcome.values.isEmpty())
        assertFalse(outcome.truncated)
    }

    @Test
    fun `并发上限真的生效`() {
        val concurrent = AtomicInteger()
        val peak = AtomicInteger()
        kotlinx.coroutines.runBlocking {
            collectWithDeadline(
                values = (1..60).toList(),
                limit = 5,
                deadlineMs = 10_000,
            ) {
                val now = concurrent.incrementAndGet()
                peak.updateAndGet { prev -> maxOf(prev, now) }
                delay(15)
                concurrent.decrementAndGet()
                it
            }
        }
        assertTrue("并发不应超过上限 5，实测峰值 ${peak.get()}", peak.get() <= 5)
    }
}
