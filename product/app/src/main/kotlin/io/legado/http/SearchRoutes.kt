package io.legado.http

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import io.legado.AppConfig
import io.legado.data.Database
import io.legado.data.getSource
import io.legado.data.listExploreSources
import io.legado.data.listSearchSourceRecords
import io.legado.data.healthSearchOrder
import io.legado.model.ApiError
import io.legado.model.ExploreRequest
import io.legado.model.SearchRequest
import io.legado.model.SearchResult
import io.legado.model.SearchStreamEvent
import io.legado.rules.RuleRunner
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json

/**
 * 从 `Routes.kt` 拆出（0.8.2 结构重排）：同步搜索、WebSocket 流式搜索、发现页取书。
 * 处理器文本逐字未动；本函数由 `Routes.kt` 的 `apiRoutes` 挂在 `route("/api")` 内，顺序与拆前一致。
 * 契约核对：`web/test/ApiCatalog.test.ts` 把本目录全部 `*Routes.kt` 视为挂在 `/api` 之下逐条比对。
 */
fun Route.searchRoutes(
    database: Database,
    runner: RuleRunner,
) {
        post("/search") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<SearchRequest>()
            if (request.keyword.isBlank()) { call.respond(HttpStatusCode.BadRequest, ApiError("invalid_keyword", "请输入搜索关键词")); return@post }
            val sourceRecords = database.listSearchSourceRecords(request.sourceIds)

            // 体检过的源排在前面搜：一场体检跑几十分钟，结论存进 source_health 表后，
            // 这里按「能用的在前、快的在前」发车。截止时间一样，但先撞上的是好源 ——
            // 以前 60 秒只能搜完 280 个源且大半是死站，现在同样的时间搜到的可用结果多得多。
            // 没体检过的源保持原有相对顺序（排在体检过的后面），不因为"没体检"就被歧视。
            val ordered = orderByHealth(sourceRecords, database.healthSearchOrder())
            // 带总量截止的收集：到点返回已搜到的部分，而不是无限期挂着。
            //
            // 旧写法是 `boundedConcurrentMap(...).awaitAll()` —— 它要等**每一个**源都收尾。
            // 取值链路是阻塞式 `HttpClient.send()`，单源 30 秒的 `withTimeout` 取消不掉它，
            // 于是 65 个慢站就能把请求拖过 300 秒（selfcheck 实测红在这里）。
            val outcome = collectWithDeadline(
                ordered,
                sourceSearchConcurrency(),
                AppConfig.searchTotalTimeoutMs,
            ) { source -> readableSearchResults(runner, source.json, request.keyword) }

            // 截断要**说出来**，不能静默返回半份结果 —— 调用方分不清"就这么多"与"没搜完"。
            // 用响应头而不是改回包形状：`List<SearchResult>` 是既有契约，不能动。
            call.response.header("X-Search-Total", outcome.total.toString())
            call.response.header("X-Search-Completed", outcome.completed.toString())
            call.response.header("X-Search-Truncated", outcome.truncated.toString())
            if (outcome.truncated) {
                call.application.log.info(
                    "搜索到点截断：关键词「{}」已搜 {}/{} 个源（上限 {}ms）",
                    request.keyword, outcome.completed, outcome.total, AppConfig.searchTotalTimeoutMs,
                )
            }
            call.respond(outcome.values.flatten())
        }
        webSocket("/search/stream") {
            // 没有凭据可校验了：流式搜索同样只认"这个连接是不是本机页面发起的"
            if (!originMatchesHost(call)) {
                close(CloseReason(CloseReason.Codes.VIOLATED_POLICY, "跨站页面不能驱动本机搜索"))
                return@webSocket
            }
            val request = (incoming.receive() as? Frame.Text)?.readText()?.let { text -> runCatching { Json.decodeFromString<SearchRequest>(text) }.getOrNull() }
            if (request?.keyword.isNullOrBlank()) {
                send(Frame.Text(Json.encodeToString(SearchStreamEvent("error", message = "请输入搜索关键词"))))
                close(CloseReason(CloseReason.Codes.CANNOT_ACCEPT, "搜索条件无效"))
                return@webSocket
            }
            val sourceRecords = database.listSearchSourceRecords(request!!.sourceIds)
            send(Frame.Text(Json.encodeToString(SearchStreamEvent("start", totalSources = sourceRecords.size))))
            coroutineScope {
                val events = Channel<SearchStreamEvent>(Channel.BUFFERED)
                val counters = SearchStreamCounters(sourceRecords.size)
                val semaphore = Semaphore(sourceSearchConcurrency())
                val workers = sourceRecords.map { source -> async {
                    semaphore.withPermit {
                        if (!isActive) return@async
                        val outcome = searchSourceOutcome(runner, source.json, request.keyword)
                        if (!isActive) return@async
                        runCatching {
                            if (outcome.results.isNotEmpty()) events.send(SearchStreamEvent("results", results = outcome.results))
                            events.send(counters.complete(outcome))
                        }
                    }
                } }
                val completionJob = launch {
                    try {
                        workers.awaitAll()
                        runCatching { events.send(counters.snapshot("done")) }
                    } catch (_: CancellationException) {
                        // Workers were cancelled
                    } finally {
                        events.close()
                    }
                }
                val cancellationMonitor = launch {
                    try {
                        for (frame in incoming) {
                            if (frame is Frame.Text && frame.readText().contains("\"cancel\"")) break
                        }
                    } catch (_: Throwable) {
                        // Incoming channel closed
                    } finally {
                        workers.forEach { it.cancel() }
                        completionJob.cancel()
                        events.close()
                    }
                }
                try {
                    for (event in events) send(Frame.Text(Json.encodeToString(event)))
                } catch (_: Throwable) {
                    // Socket closed or disconnected
                } finally {
                    cancellationMonitor.cancel()
                    completionJob.cancel()
                    workers.forEach { it.cancel() }
                    events.close()
                }
            }
        }
        get("/explore/sources") {
            call.respond(database.listExploreSources())
        }
        post("/explore") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<ExploreRequest>()
            val source = database.getSource(request.sourceId) ?: run {
                call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书源不存在"))
                return@post
            }
            try {
                // 阻塞的网络取书不能占 CIO call-group 线程（见 Application.kt 对 callGroupSize 的调参说明）
                call.respond(withContext(Dispatchers.IO) { runner.explore(source.json, request.url, request.page.coerceAtLeast(1)) })
            } catch (error: Throwable) {
                if (error is CancellationException) throw error
                call.respond(HttpStatusCode.BadGateway, ApiError("explore_failed", error.message ?: "发现页取书失败"))
            }
        }
}

private val SEARCH_TIMEOUT_MS = AppConfig.searchTimeoutMs

private suspend fun readableSearchResults(runner: RuleRunner, sourceJson: String, keyword: String): List<SearchResult> =
    searchSourceOutcome(runner, sourceJson, keyword).results

internal data class SearchSourceOutcome(val results: List<SearchResult>, val failed: Boolean)

internal class SearchStreamCounters(private val totalSources: Int) {
    private val completed = AtomicInteger()
    private val matched = AtomicInteger()
    private val empty = AtomicInteger()
    private val failed = AtomicInteger()
    private val resultCount = AtomicInteger()

    fun complete(outcome: SearchSourceOutcome): SearchStreamEvent {
        when {
            outcome.results.isNotEmpty() -> {
                matched.incrementAndGet()
                resultCount.addAndGet(outcome.results.size)
            }
            outcome.failed -> failed.incrementAndGet()
            else -> empty.incrementAndGet()
        }
        completed.incrementAndGet()
        return snapshot()
    }

    fun snapshot(type: String = "progress") = SearchStreamEvent(
        type = type,
        totalSources = totalSources,
        completedSources = completed.get(),
        matchedSources = matched.get(),
        emptySources = empty.get(),
        failedSources = failed.get(),
        resultCount = resultCount.get(),
    )
}

internal suspend fun searchSourceOutcome(
    runner: RuleRunner,
    sourceJson: String,
    keyword: String,
    timeoutMs: Long = SEARCH_TIMEOUT_MS,
): SearchSourceOutcome {
    /*
     * 到点的是**这一个源**，不是整次搜索。
     * `TimeoutCancellationException` 是 `CancellationException` 的子类，而这里原来只有一句
     * `if (error is CancellationException) throw error` —— 于是库里某一个源拖过 30 秒，取消就顺着
     * `coroutineScope` 传到整棵搜索树上：别的源已经搜到的那几十本一起作废，界面收到 500
     * （selfcheck「多源并发搜索返回的是数组」红过一次就是它，`server.log` 里留的是
     * `Unhandled request failure: TimeoutCancellationException`）。
     * 真正该往上传的只有"调用方自己取消了"（客户端停读、页面关了）—— 那种情况回答也没人看。
     */
    val results = try {
        withTimeout(timeoutMs) { withContext(Dispatchers.IO) { runner.search(sourceJson, keyword) } }
    } catch (error: TimeoutCancellationException) {
        return SearchSourceOutcome(emptyList(), failed = true)
    } catch (error: CancellationException) {
        throw error
    } catch (error: Throwable) {
        return SearchSourceOutcome(emptyList(), failed = true)
    }
    return SearchSourceOutcome(results, failed = false)
}

internal fun sourceSearchConcurrency(processors: Int = Runtime.getRuntime().availableProcessors()): Int =
    processors.coerceIn(AppConfig.searchConcurrencyMin, AppConfig.searchConcurrencyMax)

internal suspend fun <T, R> boundedConcurrentMap(values: List<T>, limit: Int, action: suspend (T) -> R): List<R> = coroutineScope {
    val semaphore = Semaphore(limit.coerceAtLeast(1))
    values.map { value -> async { semaphore.withPermit { action(value) } } }.awaitAll()
}

/** 一次「带截止的收集」的结果：拿到了什么、搜完几个、共几个。 */
internal data class DeadlineCollection<R>(
    val values: List<R>,
    /** 真正跑完的输入条数（不含到点时被取消的）。 */
    val completed: Int,
    /** 输入总条数。`completed < total` 说明到点截断了。 */
    val total: Int,
) {
    val truncated: Boolean get() = completed < total
}

/**
 * 带总量截止的并发收集 —— 同步 `/api/search` 用它。
 *
 * 为什么不能用 `withTimeoutOrNull { boundedConcurrentMap(...) }`：
 * 本项目的取值链路是**阻塞式** `HttpClient.send()`，它不响应线程中断，
 * 于是 `withTimeout` 取消不掉正卡在网络上的协程 —— `withTimeoutOrNull` 会一直等
 * 那些协程真正结束才返回，截止等于没有。
 *
 * 所以这里**自己不挂在请求的协程树上等待**：把工作丢进一个独立的 supervisor scope，
 * 用轮询等到"全部完成或到点"，然后返回**已经收到的**结果。
 * 到点被取消的任务由阻塞调用自己走完后释放线程 —— 我们不再等它们。
 *
 * 代价：到点后仍有一批阻塞线程在收尾（最多 [limit] 个）。这是刻意的取舍：
 * 宁可让它们自生自灭，也不要把 HTTP 响应无限期挂着。
 */
/**
 * 按体检结论给待搜的书源排先后。
 *
 * 三条规则：
 * 1. **体检通过的排最前**，慢的其后，连不上的最后 —— 截止时间不变，
 *    但同样的时间先撞上的是能用的源。
 * 2. **同档内按延迟升序**：快的先搜，早点把结果送出去。
 * 3. **没体检过的源**排在体检过的之后，且保持原有相对顺序（稳定排序）——
 *    "没体检"不是"不能用"，不该被歧视，只是没证据表明它该靠前。
 *
 * 用 index 做 tie-breaker 保证稳定：Kotlin 的 `sortedWith` 是稳定的，
 * 但显式带上原下标更耐改（也便于写测试）。
 */
internal fun orderByHealth(
    sources: List<io.legado.model.SourceRecord>,
    health: Map<String, Pair<Int, Long>>,
): List<io.legado.model.SourceRecord> {
    if (health.isEmpty()) return sources
    // 没体检过的源给一个"比最差还差一点"的分档，让它们排在所有体检过的源之后。
    val unknownBucket = (health.values.maxOfOrNull { it.first } ?: 1) + 1
    return sources
        .withIndex()
        .sortedWith(
            compareBy(
                { (_, source) -> health[source.id]?.first ?: unknownBucket },
                { (_, source) -> health[source.id]?.second ?: Long.MAX_VALUE },
                { (index, _) -> index },
            ),
        )
        .map { it.value }
}

internal suspend fun <T, R> collectWithDeadline(
    values: List<T>,
    limit: Int,
    deadlineMs: Long,
    action: suspend (T) -> R,
): DeadlineCollection<R> {
    if (values.isEmpty()) return DeadlineCollection(emptyList(), 0, 0)
    if (deadlineMs <= 0) {
        // 不限制：保持旧行为，老老实实等完。
        val all = boundedConcurrentMap(values, limit, action)
        return DeadlineCollection(all, values.size, values.size)
    }

    val done = java.util.concurrent.atomic.AtomicInteger()
    val collected = java.util.Collections.synchronizedList(mutableListOf<R>())
    val work = CoroutineScope(Dispatchers.IO + SupervisorJob())
    try {
        val semaphore = Semaphore(limit.coerceAtLeast(1))
        values.forEach { value ->
            work.launch {
                semaphore.withPermit {
                    runCatching { action(value) }
                        .onSuccess { collected.add(it) }
                        .onFailure { /* 单个源失败不算整次失败：与流式路径口径一致 */ }
                    done.incrementAndGet()
                }
            }
        }
        val until = System.currentTimeMillis() + deadlineMs
        while (done.get() < values.size && System.currentTimeMillis() < until) {
            delay(25)
        }
    } finally {
        // 无论正常结束还是到点都收掉这个 scope：
        // 已完成的协程立即结束；卡在阻塞 IO 上的会自己走完，不再被任何人 await。
        work.cancel()
    }
    return DeadlineCollection(collected.toList(), done.get(), values.size)
}

