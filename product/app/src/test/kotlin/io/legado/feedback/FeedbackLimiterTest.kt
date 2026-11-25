package io.legado.feedback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FeedbackLimiterTest {

    @Test
    fun `allows up to the window limit then rejects`() {
        var now = 1_000L
        val limiter = FeedbackLimiter(maxPerWindow = 3, windowMs = 5_000, clock = { now })
        val key = "a".repeat(64)

        assertTrue(limiter.allow(key))
        assertTrue(limiter.allow(key))
        assertTrue(limiter.allow(key))
        assertFalse(limiter.allow(key))
    }

    @Test
    fun `old hits fall out of the sliding window`() {
        var now = 1_000L
        val limiter = FeedbackLimiter(maxPerWindow = 2, windowMs = 5_000, clock = { now })
        val key = "b".repeat(64)

        assertTrue(limiter.allow(key))
        assertTrue(limiter.allow(key))
        assertFalse(limiter.allow(key))
        // 推进到窗口外：t=1000 的两笔都过期（cutoff=1001），两个额度都回来了。
        now = 6_001L
        assertTrue(limiter.allow(key))
        assertTrue(limiter.allow(key))
        assertFalse(limiter.allow(key))
    }

    @Test
    fun `different keys are independent`() {
        val limiter = FeedbackLimiter(maxPerWindow = 1, windowMs = 5_000, clock = { 1_000L })
        assertTrue(limiter.allow("c".repeat(64)))
        assertTrue(limiter.allow("d".repeat(64)))
        assertFalse(limiter.allow("c".repeat(64)))
    }

    @Test
    fun `distinct keys are bounded`() {
        var now = 1_000L
        val limiter = FeedbackLimiter(windowMs = 5_000, clock = { now })
        // 远超 MAX_KEYS 的独立 key，每个只提交一次：不淘汰的话内存会无限涨。
        repeat(FeedbackLimiter.MAX_KEYS * 2) { index ->
            assertTrue(limiter.allow(index.toString().padStart(64, '0')))
        }
        // 淘汰只丢计数，不影响任何 key 在全新窗口里重新可用。
        now = 6_001L
        assertTrue(limiter.allow("0".repeat(64)))
    }

    @Test
    fun `reset clears state`() {
        val limiter = FeedbackLimiter(maxPerWindow = 1, windowMs = 5_000, clock = { 1_000L })
        val key = "e".repeat(64)
        assertTrue(limiter.allow(key))
        assertFalse(limiter.allow(key))
        limiter.reset()
        assertTrue(limiter.allow(key))
    }
}
