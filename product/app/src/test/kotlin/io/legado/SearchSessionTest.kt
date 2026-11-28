package io.legado

import io.legado.http.SearchSession
import io.legado.http.SearchSourceOutcome
import io.legado.model.SearchResult
import io.legado.model.SearchStreamEvent
import io.legado.model.SourceRecord
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.async
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * SearchSession 的编排契约：不发网络、不起 WS，用假 searcher 直接验
 * "事件顺序、聚合计数、结果事件、以及收集方能提前停"——这正是抽出它的目的（⑤）。
 */
class SearchSessionTest {

    private fun rec(id: String) = SourceRecord(id, "{}", 1, 0L)
    private fun matched(n: Int) = SearchSourceOutcome(
        List(n) { SearchResult(sourceId = "s", name = "书$it", bookUrl = "u$it") }, failed = false,
    )
    private val failed = SearchSourceOutcome(emptyList(), failed = true)
    private val empty = SearchSourceOutcome(emptyList(), failed = false)

    private fun run(session: SearchSession): List<SearchStreamEvent> =
        runBlocking { session.events().toList() }

    @Test
    fun `start 领先 done 收尾且聚合计数正确`() {
        val session = SearchSession(listOf(rec("a"), rec("b"), rec("c")), concurrency = 1) { s ->
            when (s.id) { "a" -> matched(2); "b" -> failed; else -> empty }
        }
        val events = run(session)
        assertEquals("start", events.first().type)
        assertEquals(3, events.first().totalSources)
        val done = events.last()
        assertEquals("done", done.type)
        assertEquals(3, done.completedSources)
        assertEquals(1, done.matchedSources)
        assertEquals(1, done.failedSources)
        assertEquals(1, done.emptySources)
        assertEquals(2, done.resultCount)
        assertEquals(false, done.truncated)
        assertEquals(null, done.message)
    }

    @Test
    fun `命中的源先发一条 results 再发 progress`() {
        val session = SearchSession(listOf(rec("a")), concurrency = 1) { matched(3) }
        val events = run(session)
        // start, results, progress, done
        assertEquals(listOf("start", "results", "progress", "done"), events.map { it.type })
        assertEquals(3, events[1].results.size)
    }

    @Test
    fun `无结果的源只发 progress 不发 results`() {
        val session = SearchSession(listOf(rec("b")), concurrency = 1) { failed }
        val events = run(session)
        assertEquals(listOf("start", "progress", "done"), events.map { it.type })
    }

    @Test
    fun `收集方 take 能提前结束不吊住`() {
        val many = (1..20).map { rec("s$it") }
        val session = SearchSession(many, concurrency = 4) { matched(1) }
        val partial = runBlocking { session.events().take(2).toList() }
        assertEquals(2, partial.size)
        assertTrue(partial.all { it.type == "start" || it.type == "results" || it.type == "progress" })
    }

    @Test
    fun `总截止保留结果如实计数且未启动排队源`() = runBlocking {
        val launched = mutableListOf<String>()
        var exited = false
        val session = SearchSession(listOf(rec("fast"), rec("slow"), rec("queued")), 1, 500) { source ->
            launched.add(source.id)
            if (source.id == "fast") matched(1) else try {
                awaitCancellation()
            } finally {
                exited = true
            }
        }
        val events = withTimeout(3_000) { session.events().toList() }
        val done = events.last()
        assertEquals(listOf("fast", "slow"), launched)
        assertTrue(exited)
        assertEquals("done", done.type)
        assertEquals(true, done.truncated)
        assertEquals(1, done.completedSources)
        assertEquals(1, done.resultCount)
        assertEquals(0, done.failedSources)
        assertEquals(1, events.sumOf { it.results.size })
        assertTrue(done.message!!.contains("1 / 3"))
    }

    @Test
    fun `取消收集不会被吞成超时完成`() = runBlocking {
        val started = CompletableDeferred<Unit>()
        val events = mutableListOf<SearchStreamEvent>()
        var exited = false
        val session = SearchSession(listOf(rec("slow"), rec("queued")), 1, 10_000) {
            started.complete(Unit)
            try { awaitCancellation() } finally { exited = true }
        }
        val job = async { session.events().toList(events) }
        withTimeout(3_000) { started.await(); job.cancelAndJoin() }
        assertTrue(job.isCancelled)
        assertTrue(exited)
        assertTrue(events.none { it.type == "done" })
    }
}
