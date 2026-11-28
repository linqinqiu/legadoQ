package io.legado.http

import io.legado.model.SourceRecord
import io.legado.model.SearchStreamEvent
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.atomic.AtomicInteger

/**
 * 一次流式搜索的编排（PROPOSAL 之外的解耦重构）：把「并发扇出 → 逐源结局 → 聚合进度 →
 * 收尾 done」这套逻辑从 WebSocket 处理器里搬出来，成为一个**不碰传输层**、可用假 searcher
 * 直接单测的领域对象。WS 处理器只负责把这里吐出的 [SearchStreamEvent] 流翻译成 Frame、
 * 以及收到 cancel 帧时取消对流的收集。
 *
 * 先 start；每源有结果就先发 results，再发 progress；完成或达到总预算后发 done。
 * 总预算和收集方取消都沿结构化并发传给子任务；阻塞 searcher 仍须响应取消/线程中断。
 *
 * searcher 由调用方注入（生产用 `searchSourceOutcome`，测试给假实现），因此本类不依赖
 * RuleRunner、不发网络，纯编排可测。
 */
internal class SearchSession(
    private val sources: List<SourceRecord>,
    private val concurrency: Int,
    private val totalTimeoutMs: Long = 0,
    private val searcher: suspend (SourceRecord) -> SearchSourceOutcome,
) {
    fun events(): Flow<SearchStreamEvent> = channelFlow {
        send(SearchStreamEvent(type = "start", totalSources = sources.size))
        val counters = SearchStreamCounters(sources.size)
        suspend fun searchAll() = coroutineScope {
            val sessionContext = coroutineContext
            val nextSource = AtomicInteger()
            List(concurrency.coerceAtLeast(1).coerceAtMost(sources.size)) {
                launch {
                    while (true) {
                        // 固定 worker 按已排序的索引领任务；取消传播期间不再启动排队源。
                        sessionContext.ensureActive()
                        val source = sources.getOrNull(nextSource.getAndIncrement()) ?: break
                        val outcome = searcher(source)
                        ensureActive()
                        if (outcome.results.isNotEmpty()) {
                            send(SearchStreamEvent(type = "results", results = outcome.results))
                        }
                        send(counters.complete(outcome))
                    }
                }
            }.joinAll()
        }
        val finished = if (totalTimeoutMs > 0) {
            withTimeoutOrNull(totalTimeoutMs) { searchAll(); true } ?: false
        } else {
            searchAll()
            true
        }
        val done = counters.snapshot("done")
        val truncated = !finished && done.completedSources < sources.size
        send(done.copy(
            truncated = truncated,
            message = if (truncated) "搜索已到总时限，已检查 ${done.completedSources} / ${sources.size} 个书源，已保留部分结果；可缩小范围重试" else null,
        ))
    }
}
