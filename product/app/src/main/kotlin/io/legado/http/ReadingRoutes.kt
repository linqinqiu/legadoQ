package io.legado.http

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import io.legado.content.ContentProcessor
import io.legado.data.Database
import io.legado.data.cacheBookContent
import io.legado.data.cachedContent
import io.legado.data.deleteContentProcess
import io.legado.data.getContentProcess
import io.legado.data.getCachedChaptersFallback
import io.legado.data.saveContentProcess
import io.legado.data.getEnabledReplaceRulesForScope
import io.legado.data.getSource
import io.legado.data.getTocCache
import io.legado.data.listBookshelf
import io.legado.data.saveTocCache
import io.legado.localbook.LocalBookParser
import io.legado.model.ApiError
import io.legado.model.BookDetails
import io.legado.model.BookRequest
import io.legado.model.ChapterContent
import io.legado.model.ContentProcessRequest
import io.legado.model.ContentRefreshFailure
import io.legado.model.ContentRefreshRequest
import io.legado.model.ContentRefreshResult
import io.legado.model.ContentRequest
import io.legado.rules.JsSandbox
import io.legado.rules.RuleExecutionException
import io.legado.rules.RuleRunner
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

/**
 * 从 `Routes.kt` 拆出（0.8.2 结构重排）：书籍详情、目录与正文三条阅读链路。
 * 处理器文本逐字未动；本函数由 `Routes.kt` 的 `apiRoutes` 挂在 `route("/api")` 内，顺序与拆前一致。
 * 契约核对：`web/test/ApiCatalog.test.ts` 把本目录全部 `*Routes.kt` 视为挂在 `/api` 之下逐条比对。
 */
fun Route.readingRoutes(
    database: Database,
    runner: RuleRunner,
) {
        post("/books/details") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<BookRequest>()
            if (request.sourceId == LocalBookParser.LOC_BOOK_SOURCE_ID) {
                val shelf = database.listBookshelf().firstOrNull { it.sourceId == request.sourceId && it.bookUrl == request.bookUrl }
                    ?: run { call.respond(HttpStatusCode.NotFound, ApiError("not_found", "本地书籍不存在")); return@post }
                val cover = shelf.coverKey?.let { "/api/covers/$it" }
                call.respond(BookDetails(
                    sourceId = LocalBookParser.LOC_BOOK_SOURCE_ID,
                    name = shelf.name,
                    author = shelf.author,
                    intro = null,
                    coverUrl = cover,
                    tocUrl = shelf.tocUrl,
                ))
                return@post
            }
            val source = database.getSource(request.sourceId) ?: run { call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书源不存在")); return@post }
            call.respondCatching { withContext(Dispatchers.IO) { runner.details(source.json, request.bookUrl) } }
        }
        post("/books/chapters") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<BookRequest>()
            val cachedToc = database.getTocCache(request.sourceId, request.bookUrl)
                ?: database.getTocCache(request.sourceId, request.bookUrl.removeSuffix("/toc") + "/toc")
            if (cachedToc != null && cachedToc.isNotEmpty()) {
                call.respond(cachedToc)
                return@post
            }
            val fallbackFromContent = database.getCachedChaptersFallback(request.sourceId, request.bookUrl)
            if (request.sourceId == LocalBookParser.LOC_BOOK_SOURCE_ID) {
                if (fallbackFromContent.isNotEmpty()) {
                    call.respond(fallbackFromContent)
                } else {
                    call.respond(HttpStatusCode.NotFound, ApiError("not_found", "本地书籍目录不存在"))
                }
                return@post
            }
            val source = database.getSource(request.sourceId) ?: run {
                call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书源不存在"))
                return@post
            }
            call.respondCatching {
                try {
                    withContext(Dispatchers.IO) {
                    withTimeout(4000) {
                        val direct = runCatching { runner.chapters(source.json, request.bookUrl) }.getOrNull()
                        // 目录地址常常不等于书页地址（`tocUrl` 要从详情里再取一次），
                        // 按书页取目录会**安静地返回空列表**而不是报错，所以空结果同样要回落到详情。
                        val chapters = if (!direct.isNullOrEmpty()) direct else {
                            val details = runner.details(source.json, request.bookUrl)
                            runner.chapters(source.json, details.tocUrl).also { database.saveTocCache(request.sourceId, details.tocUrl, it) }
                        }
                        if (chapters.isNotEmpty()) {
                            database.saveTocCache(request.sourceId, request.bookUrl, chapters)
                        }
                        chapters
                    }
                    }
                } catch (error: Throwable) {
                    // 客户端真取消（JobCancellationException）要原样上抛，别兜底后对着已断的连接 respond；
                    // 本地 withTimeout 抛的 TimeoutCancellationException 才是「这次超时」，继续走回落。
                    if (error is CancellationException && error !is TimeoutCancellationException) throw error
                    if (fallbackFromContent.isNotEmpty()) {
                        fallbackFromContent
                    } else {
                        throw (error as? RuleExecutionException ?: RuleExecutionException(error.message ?: "获取章节列表失败"))
                    }
                }
            }
        }
        post("/books/content") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<ContentRequest>()
            if (request.sourceId.isBlank() || request.chapterUrl.isBlank()) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_content", "缺少书源或章节地址"))
                return@post
            }
            val bookUrl = request.bookUrl ?: if (request.chapterUrl.startsWith("local://")) {
                request.chapterUrl.substringBeforeLast('/')
            } else null
            val bookName = bookUrl?.let { url ->
                database.listBookshelf().firstOrNull { it.sourceId == request.sourceId && it.bookUrl == url }?.name
            }
            val cached = bookUrl?.let { database.cachedContent(request.sourceId, it, request.chapterUrl) }
            // AI 闭环（阅读器 AI 闭环 feature）：原始正文之上再叠一层 AI 净化/润色覆盖，命中就回覆盖版。
            // 净化优先于润色（两者互斥，同一章只存一种）。没覆盖就回原始正文，行为不变。
            fun override(base: ChapterContent): ChapterContent {
                if (bookUrl == null) return base
                val proc = database.getContentProcess(request.sourceId, bookUrl, request.chapterUrl, "ai_clean")
                    ?: database.getContentProcess(request.sourceId, bookUrl, request.chapterUrl, "ai_rewrite")
                return if (proc != null) ChapterContent(base.title, proc.processed) else base
            }

            if (request.sourceId == LocalBookParser.LOC_BOOK_SOURCE_ID) {
                if (cached != null) {
                    val rules = database.getEnabledReplaceRulesForScope(bookName, "local://")
                    val jsSandbox = JsSandbox(runner)
                    val cleaned = ContentProcessor.processContent(cached.content, rules, jsSandbox = jsSandbox, bookName = bookName, chapterTitle = cached.title)
                    val cleanedTitle = cached.title?.let { ContentProcessor.processTitle(it, rules, jsSandbox = jsSandbox, bookName = bookName) }
                    call.respond(override(ChapterContent(title = cleanedTitle ?: cached.title, content = cleaned)))
                } else {
                    call.respond(HttpStatusCode.NotFound, ApiError("not_found", "本地章节内容不存在"))
                }
                return@post
            }

            val source = database.getSource(request.sourceId) ?: run {
                call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书源不存在"))
                return@post
            }
            // 手动刷新（force）必须真的回源：上面这段缓存命中分支对它一律不算数。
            // 失败也不回旧正文 —— 用户点的是「刷新」，拿旧正文冒充成功等于骗人，交给前端报错。
            if (!request.force && cached != null && cached.content.isNotBlank()) {
                call.respond(override(cached))
            } else call.respondCatching {
                try {
                    withContext(Dispatchers.IO) {
                    runner.content(source.json, request.chapterUrl, bookName, bookUrl).also { content ->
                        bookUrl?.let { database.cacheBookContent(request.sourceId, it, request.chapterUrl, content) }
                    }
                    }
                } catch (error: Throwable) {
                    if (!request.force && cached != null && cached.content.isNotBlank()) override(cached)
                    else throw error
                }
            }
        }
        // 批量刷新正文：目录里勾选若干章，一次只回源这些章并覆盖缓存。
        // 上限与并发都压住 —— 这是用户手动动作，不是把书源当爬虫靶子；剩下的用 remaining 告诉前端。
        post("/books/content-refresh") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<ContentRefreshRequest>()
            if (request.sourceId.isBlank() || request.bookUrl.isBlank() || request.chapterUrls.isEmpty()) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_refresh", "缺少书源、书籍地址或章节列表"))
                return@post
            }
            if (request.sourceId == LocalBookParser.LOC_BOOK_SOURCE_ID) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_refresh", "本地书籍的正文来自文件本身，不需要刷新"))
                return@post
            }
            val source = database.getSource(request.sourceId) ?: run {
                call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书源不存在"))
                return@post
            }
            val bookName = database.listBookshelf().firstOrNull { it.sourceId == request.sourceId && it.bookUrl == request.bookUrl }?.name
            call.respondCatching {
                withContext(Dispatchers.IO) {
                    val outcome = refreshChapterBatch(
                        chapterUrls = request.chapterUrls,
                        fetch = { chapterUrl -> runner.content(source.json, chapterUrl, bookName, request.bookUrl) },
                        store = { chapterUrl, content ->
                            database.cacheBookContent(request.sourceId, request.bookUrl, chapterUrl, content)
                        },
                    )
                    ContentRefreshResult(outcome.refreshed, outcome.failed, outcome.remaining)
                }
            }
        }
        // AI 闭环（阅读器 AI 闭环 feature）：落一份「AI 净化/润色覆盖正文」。读者把本章交给 AI，
        // 把干净正文存这里，下一次读这一章就回覆盖版（正文实时重载，所见即所得）。
        // 这两条必须是 post("/books/content") 的**兄弟**：写进它的处理器 lambda 里等于运行期才调
        // Route.post，启动时根本不会注册 —— 目录和 ApiCatalog 的条数却已经把它们算进去了。
        post("/books/content-process") {
            if (!call.requireSameOriginWrite()) return@post
            val req = call.receive<ContentProcessRequest>()
            if (req.sourceId.isBlank() || req.bookUrl.isBlank() || req.chapterUrl.isBlank() || req.kind.isBlank() || req.processed.isBlank()) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_process", "缺少 sourceId / bookUrl / chapterUrl / kind / processed"))
                return@post
            }
            if (req.kind != "ai_clean" && req.kind != "ai_rewrite") {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_process", "kind 只能是 ai_clean 或 ai_rewrite"))
                return@post
            }
            call.respond(database.saveContentProcess(req))
        }
        // 撤掉某一章的 AI 覆盖（恢复原始正文）。
        delete("/books/content-process") {
            if (!call.requireSameOriginWrite()) return@delete
            val sourceId = call.request.queryParameters["sourceId"]
            val bookUrl = call.request.queryParameters["bookUrl"]
            val chapterUrl = call.request.queryParameters["chapterUrl"]
            val kind = call.request.queryParameters["kind"] ?: "ai_clean"
            if (sourceId.isNullOrBlank() || bookUrl.isNullOrBlank() || chapterUrl.isNullOrBlank()) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_process", "缺少 sourceId / bookUrl / chapterUrl"))
                return@delete
            }
            if (database.deleteContentProcess(sourceId, bookUrl, chapterUrl, kind)) call.respond(HttpStatusCode.NoContent)
            else call.respond(HttpStatusCode.NotFound, ApiError("not_found", "这一章没有对应的 AI 覆盖"))
        }
}

/** 单次批量刷新最多多少章：前端每批 5 章、并发 3，再大批也只是多几趟请求。 */
private const val MAX_REFRESH_CHAPTERS = 60
private const val REFRESH_CONCURRENCY = 3
private const val MAX_REFRESH_BYTES = 2 * 1024 * 1024

/** 批量刷新的结果：`refreshed` 已落缓存，`failed` 逐章带原因，`remaining` 是超过单批上限没做的部分。 */
internal data class ChapterRefreshOutcome(
    val refreshed: List<String>,
    val failed: List<ContentRefreshFailure>,
    val remaining: Int,
)

/**
 * 批量刷新正文的调度（[refreshChapterBatch]）：去重 → 截到单批上限 → 限并发回源 → 逐章落缓存。
 *
 * 单独抽出来是为了能在测试里用假 fetch 验「去重、上限、失败只影响该章、超大正文不覆盖」；
 * 真实回源在测试环境会被 SSRF 闸门挡在回环地址之外，路由层只负责取书源和传这两个闭包。
 */
internal suspend fun refreshChapterBatch(
    chapterUrls: List<String>,
    fetch: suspend (String) -> ChapterContent,
    store: suspend (String, ChapterContent) -> Unit,
    maxChapters: Int = MAX_REFRESH_CHAPTERS,
    concurrency: Int = REFRESH_CONCURRENCY,
    maxBytes: Int = MAX_REFRESH_BYTES,
): ChapterRefreshOutcome = coroutineScope {
    val distinct = chapterUrls.filter { it.isNotBlank() }.distinct()
    val urls = distinct.take(maxChapters)
    val remaining = (distinct.size - urls.size).coerceAtLeast(0)
    val refreshed = java.util.Collections.synchronizedList(mutableListOf<String>())
    val failed = java.util.Collections.synchronizedList(mutableListOf<ContentRefreshFailure>())
    val semaphore = Semaphore(concurrency.coerceAtLeast(1))
    urls.map { chapterUrl ->
        async {
            semaphore.withPermit {
                try {
                    val content = fetch(chapterUrl)
                    if (content.content.toByteArray(Charsets.UTF_8).size > maxBytes) {
                        failed += ContentRefreshFailure(chapterUrl, "正文超过 ${maxBytes / (1024 * 1024)}MB，未覆盖缓存")
                    } else {
                        store(chapterUrl, content)
                        refreshed += chapterUrl
                    }
                } catch (error: Throwable) {
                    if (error is CancellationException) throw error
                    failed += ContentRefreshFailure(chapterUrl, error.message ?: "刷新失败")
                }
            }
        }
    }.awaitAll()
    ChapterRefreshOutcome(refreshed.toList(), failed.toList(), remaining)
}


