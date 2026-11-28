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
import io.legado.ops.Metrics
import io.legado.rules.RuleRunner
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import io.legado.rules.RuleIoCancellation
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json

/**
 * 从 `Routes.kt` 拆出（0.8.2 结构重排）：同步搜索、WebSocket 流式搜索、发现页取书。
 * 处理器文本逐字未动；本函数由 `Routes.kt` 的 `apiRoutes` 挂在 `route("/api")` 内，顺序与拆前一致。
 * 契约核对：`web/test/ApiCatalog.test.ts` 把本目录全部 `*Routes.kt` 视为挂在 `/api` 之下逐条比对。
 */
fun Route.searchRoutes(
    database: Database,
    runner: RuleRunner,
    streamTotalTimeoutMs: Long = AppConfig.searchTotalTimeoutMs,
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
            // 单源预算之外再限制整批耗时，避免大量慢源分批占满并发名额。
            val outcome = collectWithDeadline(
                ordered,
                sourceSearchConcurrency(),
                AppConfig.searchTotalTimeoutMs,
            ) { source -> readableSearchResults(runner, source.id, source.json, request.keyword) }
            Metrics.recordSearchRequest(outcome.truncated)

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
            // 全局可选令牌校验之外，仍要求连接来自同源页面。
            if (!originMatchesHost(call)) {
                close(CloseReason(CloseReason.Codes.VIOLATED_POLICY, "跨站页面不能驱动本机搜索"))
                return@webSocket
            }
            // 客户端来帧限幅（文档第6项）：单帧 ≤ WS_SEARCH_MAX_FRAME_BYTES、每连接累计 ≤ WS_SEARCH_MAX_MESSAGES 条。
            // 首帧也要过尺寸这一关——否则一个超大 Text 会在 Json.decodeFromString 里做无谓解码。
            val firstFrame = incoming.receive()
            if (wsFrameBytes(firstFrame) > WS_SEARCH_MAX_FRAME_BYTES) {
                close(CloseReason(CloseReason.Codes.TOO_BIG, "首帧超过 ${WS_SEARCH_MAX_FRAME_BYTES} 字节"))
                return@webSocket
            }
            val request = (firstFrame as? Frame.Text)?.readText()?.let { text -> runCatching { Json.decodeFromString<SearchRequest>(text) }.getOrNull() }
            if (request?.keyword.isNullOrBlank()) {
                send(Frame.Text(Json.encodeToString(SearchStreamEvent("error", message = "请输入搜索关键词"))))
                close(CloseReason(CloseReason.Codes.CANNOT_ACCEPT, "搜索条件无效"))
                return@webSocket
            }
            val sourceRecords = database.listSearchSourceRecords(request.sourceIds)
            // 页面走流式入口，也复用普通搜索的健康、权重与耗时排序。
            val ordered = orderByHealth(sourceRecords, database.healthSearchOrder())
            val session = SearchSession(ordered, sourceSearchConcurrency(), streamTotalTimeoutMs) { source ->
                searchSourceOutcome(runner, source.json, request.keyword, source.id)
            }
            coroutineScope {
                // 主收集：把领域事件流逐条翻成 Frame 发回；另开一个监听协程读到 cancel 帧就取消收集。
                val streaming = launch {
                    session.events().collect { event ->
                        send(Frame.Text(Json.encodeToString(event)))
                    }
                }
                val cancelWatch = launch {
                    // 首帧已经在上面读掉了；这里从第二条起继续读，累计到 WS_SEARCH_MAX_MESSAGES 就断开。
                    var seen = 1
                    try {
                        for (frame in incoming) {
                            seen += 1
                            if (seen > WS_SEARCH_MAX_MESSAGES) {
                                streaming.cancel()
                                close(CloseReason(CloseReason.Codes.VIOLATED_POLICY, "累计消息数超过 $WS_SEARCH_MAX_MESSAGES"))
                                break
                            }
                            if (wsFrameBytes(frame) > WS_SEARCH_MAX_FRAME_BYTES) {
                                streaming.cancel()
                                close(CloseReason(CloseReason.Codes.TOO_BIG, "单帧超过 $WS_SEARCH_MAX_FRAME_BYTES 字节"))
                                break
                            }
                            if (frame is Frame.Text && frame.readText().contains("\"cancel\"")) {
                                streaming.cancel()
                                break
                            }
                        }
                    } catch (error: CancellationException) {
                        throw error
                    } catch (_: Exception) {
                        // 连接被对端关闭：incoming 抛错，正常收尾
                    } finally {
                        // 正常 EOF、异常断连与 cancel 都必须撤销正在搜索的工作。
                        streaming.cancel()
                    }
                }
                streaming.join()
                // done 已发出、流自然收尾：撤掉那个还在等 cancel 帧的监听，别让它吊着整个 scope。
                cancelWatch.cancelAndJoin()
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
                // 阻塞的网络取书不能占住处理请求的那些线程（见 Application.kt 对 IO 并行度的调参说明）
                call.respond(withContext(Dispatchers.IO) { runner.explore(source.json, request.url, request.page.coerceAtLeast(1)) })
            } catch (error: Throwable) {
                if (error is CancellationException) throw error
                call.respond(HttpStatusCode.BadGateway, ApiError("explore_failed", error.message ?: "发现页取书失败"))
            }
        }
}

private val SEARCH_TIMEOUT_MS = AppConfig.searchTimeoutMs

/**
 * WS `/search/stream` 客户端来帧限幅（文档第6项：恶意页面狂发消息不能耗尽服务器协程/内存）。
 *
 * 一条正常会话只需要「首条 SearchRequest + 至多一条 cancel 帧」；单帧尺寸 64 KB、累计 64 条
 * 已远远够真用例，任一超限就是异常连接，服务端立刻 close 释放 collect 协程。
 */
private const val WS_SEARCH_MAX_FRAME_BYTES = 64 * 1024
private const val WS_SEARCH_MAX_MESSAGES = 64

/**
 * 来帧字节数。这条流是 Text 协议（前端只发 JSON 文本帧，服务端也只回 Text），
 * Text 帧按 UTF-8 编码后的长度量；其它帧（Binary/Ping/Pong/Close）不计尺寸，只计入条数上限。
 */
private fun wsFrameBytes(frame: Frame): Int = when (frame) {
    is Frame.Text -> frame.readText().toByteArray(Charsets.UTF_8).size
    else -> 0
}

private suspend fun readableSearchResults(runner: RuleRunner, sourceId: String, sourceJson: String, keyword: String): List<SearchResult> =
    searchSourceOutcome(runner, sourceJson, keyword, sourceId).results

internal data class SearchSourceOutcome(val results: List<SearchResult>, val failed: Boolean, val timedOut: Boolean = false)

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
    sourceId: String = "",
    timeoutMs: Long = SEARCH_TIMEOUT_MS,
): SearchSourceOutcome {
    // 只把本层单源超时记为源失败；父级整批截止和用户取消必须继续向上传播。
    // 同时中断线程、关闭规则 HTTP 响应体；忽略中断的第三方代码仍可能延迟退出。
    val startedAt = System.currentTimeMillis()
    val outcome = try {
        val results = withTimeoutOrNull(timeoutMs) {
            RuleIoCancellation.run { runner.search(sourceJson, keyword) }
        }
        if (results == null) SearchSourceOutcome(emptyList(), failed = true, timedOut = true)
        else SearchSourceOutcome(results, failed = false)
    } catch (error: CancellationException) {
        throw error
    } catch (error: Throwable) {
        // 关闭响应体与线程中断可能先表现为 IOException；调用方已取消时不得记成源失败。
        currentCoroutineContext().ensureActive()
        SearchSourceOutcome(emptyList(), failed = true)
    }
    Metrics.recordSearch(
        sourceId = sourceId,
        latencyMs = System.currentTimeMillis() - startedAt,
        timedOut = outcome.timedOut,
        failed = outcome.failed && !outcome.timedOut,
        resultCount = outcome.results.size,
    )
    return outcome
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
 * 按体检结论给待搜的书源排先后。
 *
 * 四条规则：
 * 1. **体检通过的排最前**，慢的其后，连不上的最后 —— 截止时间不变，
 *    但同样的时间先撞上的是能用的源。
 * 2. **同一档内按 `weight` 降序**：权重是用户/备份里的明确偏好，值越大越先搜。
 *    它排在体检结论**之后**：一个自己标了高权重的死源，不该挤掉能用的源、白吃截止时间。
 * 3. **再按延迟升序**：快的先搜，早点把结果送出去。
 * 4. **没体检过的源**排在体检过的之后，且保持原有相对顺序（稳定排序）——
 *    "没体检"不是"不能用"，不该被歧视，只是没证据表明它该靠前。
 *
 * 用 index 做 tie-breaker 保证稳定：Kotlin 的 `sortedWith` 是稳定的，
 * 但显式带上原下标更耐改（也便于写测试）。
 */
internal fun orderByHealth(
    sources: List<io.legado.model.SourceRecord>,
    health: Map<String, Pair<Int, Long>>,
): List<io.legado.model.SourceRecord> {
    if (health.isEmpty() && sources.none { it.weight != 0 }) return sources
    // 没体检过的源给一个"比最差还差一点"的分档，让它们排在所有体检过的源之后。
    val unknownBucket = (health.values.maxOfOrNull { it.first } ?: 1) + 1
    return sources
        .withIndex()
        .sortedWith(
            compareBy(
                { (_, source) -> health[source.id]?.first ?: unknownBucket },
                { (_, source) -> -source.weight },
                { (_, source) -> health[source.id]?.second ?: Long.MAX_VALUE },
                { (index, _) -> index },
            ),
        )
        .map { it.value }
}

/**
 * 同步 `/api/search` 的历史独立 scope 收集：到预算返回部分结果，不 await 收尾任务。
 * 单源会中断线程并关闭响应体，但第三方代码未必配合；返回不等于全部资源已释放。
 */
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

