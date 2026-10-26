package io.legado

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger
import io.legado.http.SearchSourceOutcome
import io.legado.http.SearchStreamCounters
import io.legado.http.boundedConcurrentMap
import io.legado.http.searchSourceOutcome
import io.legado.http.sourceSearchConcurrency
import io.legado.model.SearchResult
import io.legado.rules.RuleRunner

class SearchConcurrencyTest {
    @Test
    fun `stream counters distinguish matched empty and failed sources`() {
        val counters = SearchStreamCounters(3)
        val result = SearchResult("source-a", "测试书", bookUrl = "https://example.com/book")

        counters.complete(SearchSourceOutcome(listOf(result), failed = false))
        counters.complete(SearchSourceOutcome(emptyList(), failed = false))
        val done = counters.complete(SearchSourceOutcome(emptyList(), failed = true)).copy(type = "done")

        assertEquals(3, done.totalSources)
        assertEquals(3, done.completedSources)
        assertEquals(1, done.matchedSources)
        assertEquals(1, done.emptySources)
        assertEquals(1, done.failedSources)
        assertEquals(1, done.resultCount)
    }

    @Test
    fun `bounded search work respects its concurrency cap and isolates failures`() = runBlocking {
        val running = AtomicInteger()
        val maximum = AtomicInteger()
        val results = boundedConcurrentMap((1..8).toList(), 3) { value ->
            val current = running.incrementAndGet()
            maximum.getAndUpdate { previous -> maxOf(previous, current) }
            try {
                delay(10)
                runCatching { if (value == 4) error("source failed") else value }.getOrNull()
            } finally { running.decrementAndGet() }
        }

        assertTrue(maximum.get() <= 3)
        assertEquals(7, results.filterNotNull().size)
    }

    @Test
    fun `source search concurrency scales between 16 and 32 workers`() {
        assertEquals(16, sourceSearchConcurrency(0))
        assertEquals(16, sourceSearchConcurrency(4))
        assertEquals(16, sourceSearchConcurrency(16))
        assertEquals(24, sourceSearchConcurrency(24))
        assertEquals(32, sourceSearchConcurrency(32))
        assertEquals(32, sourceSearchConcurrency(64))
    }

    @Test
    fun `searchSourceOutcome returns candidates directly upon search completion and isolates failures`() = runBlocking {
        val source = """{"bookSourceUrl":"https://src.example","searchUrl":"/search?k={{key}}","ruleSearch":{"bookList":"$.data","bookUrl":"/b/{{$.id}}","name":"$.title"}}"""
        val runner = RuleRunner { url ->
            if (url.contains("fail")) throw RuntimeException("network down")
            """{"data":[{"id":"1","title":"书1"},{"id":"2","title":"书2"}]}"""
        }

        val successOutcome = searchSourceOutcome(runner, source, "正常")
        assertEquals(false, successOutcome.failed)
        assertEquals(2, successOutcome.results.size)
        assertEquals("书1", successOutcome.results[0].name)
        assertEquals("书2", successOutcome.results[1].name)

        val failSource = """{"bookSourceUrl":"https://src.example","searchUrl":"/search?k={{key}}&fail=1","ruleSearch":{"bookList":"$.data","bookUrl":"/b/{{$.id}}","name":"$.title"}}"""
        val failOutcome = searchSourceOutcome(runner, failSource, "失败")
        assertEquals(true, failOutcome.failed)
        assertEquals(0, failOutcome.results.size)
    }

    /**
     * 一个源到点不许把整次搜索取消。判据是"别的源的结果还在"，不是"没抛异常"——
     * 早先那句 `if (error is CancellationException) throw error` 恰好把超时当成调用方的取消往上抛。
     */
    @Test
    fun `a single slow source times out without cancelling its siblings`() = runBlocking {
        val slowSource = """{"bookSourceUrl":"https://src.slow","searchUrl":"/search?k={{key}}&slow=1","ruleSearch":{"bookList":"$.data","bookUrl":"/b/{{$.id}}","name":"$.title"}}"""
        val fastSource = """{"bookSourceUrl":"https://src.fast","searchUrl":"/search?k={{key}}","ruleSearch":{"bookList":"$.data","bookUrl":"/b/{{$.id}}","name":"$.title"}}"""
        val runner = RuleRunner { url ->
            if (url.contains("slow")) {
                Thread.sleep(600)
                """{"data":[{"id":"9","title":"迟到的书"}]}"""
            } else {
                """{"data":[{"id":"1","title":"书1"}]}"""
            }
        }

        val outcomes = boundedConcurrentMap(listOf(slowSource, fastSource), 2) { source ->
            searchSourceOutcome(runner, source, "测试", timeoutMs = 120)
        }

        assertTrue("慢源应记为这一个源失败，而不是拖死整次搜索", outcomes[0].failed)
        assertEquals(0, outcomes[0].results.size)
        assertEquals(false, outcomes[1].failed)
        assertEquals(1, outcomes[1].results.size)
        assertEquals("书1", outcomes[1].results[0].name)
    }

    /** 反过来：调用方真的取消时不许被吞成"这个源失败了"，否则客户端停读后白烧线程也说不清。 */
    @Test
    fun `caller cancellation still propagates`() = runBlocking {
        val source = """{"bookSourceUrl":"https://src.slow","searchUrl":"/search?k={{key}}&slow=1","ruleSearch":{"bookList":"$.data","bookUrl":"/b/{{$.id}}","name":"$.title"}}"""
        val runner = RuleRunner { Thread.sleep(400); """{"data":[]}""" }
        var caught: Throwable? = null
        val job = launch {
            try {
                withTimeout(60) { searchSourceOutcome(runner, source, "测试", timeoutMs = 5_000) }
            } catch (error: Throwable) {
                caught = error
            }
        }
        job.join()
        assertTrue("调用方取消必须原样往上传", caught is CancellationException)
    }
}

