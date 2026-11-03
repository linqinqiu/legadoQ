package io.legado.http

import io.legado.model.SourceRecord
import io.legado.model.SearchStreamEvent
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

/**
 * 一次流式搜索的编排（PROPOSAL 之外的解耦重构）：把「并发扇出 → 逐源结局 → 聚合进度 →
 * 收尾 done」这套逻辑从 WebSocket 处理器里搬出来，成为一个**不碰传输层**、可用假 searcher
 * 直接单测的领域对象。WS 处理器只负责把这里吐出的 [SearchStreamEvent] 流翻译成 Frame、
 * 以及收到 cancel 帧时取消对流的收集。
 *
 * 语义与重构前的 webSocket 块逐字对齐：先 start；每源有结果就先发一条 results，
 * 再发一条由 [SearchStreamCounters] 聚合的 progress；全部收尾后发一条 done。
 * 取消靠 [channelFlow] 的结构化并发——收集方（WS）一停，这里的子协程随之取消，不残留。
 *
 * searcher 由调用方注入（生产用 `searchSourceOutcome`，测试给假实现），因此本类不依赖
 * RuleRunner、不发网络，纯编排可测。
 */
internal class SearchSession(
    private val sources: List<SourceRecord>,
    private val concurrency: Int,
    private val searcher: suspend (SourceRecord) -> SearchSourceOutcome,
) {
    fun events(): Flow<SearchStreamEvent> = channelFlow {
        send(SearchStreamEvent(type = "start", totalSources = sources.size))
        val counters = SearchStreamCounters(sources.size)
        val semaphore = Semaphore(concurrency.coerceAtLeast(1))
        sources.map { source ->
            launch {
                semaphore.withPermit {
                    val outcome = searcher(source)
                    if (outcome.results.isNotEmpty()) {
                        send(SearchStreamEvent(type = "results", results = outcome.results))
                    }
                    send(counters.complete(outcome))
                }
            }
        }.joinAll()
        send(counters.snapshot("done"))
    }
}
