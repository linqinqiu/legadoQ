package io.legado.http

import io.ktor.http.*
import io.ktor.http.content.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.legado.cache.BookCacheService
import io.legado.cache.CoverCache
import io.legado.cache.tryCacheCover
import io.legado.cache.tryFindCachedCover
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import io.legado.data.Database
import io.legado.data.BookshelfRepository
// 这几个是 `ShelfDao.kt` 里的 `Database` 扩展函数，不是成员方法 —— 不单独 import 就是「未解析引用」。
// （`BookshelfRepository` 内部也调它们，所以两边都得各自 import。）
import io.legado.data.assignBookGroup
import io.legado.data.createBookGroup
import io.legado.data.deleteBookGroup
import io.legado.data.listBookGroups
import io.legado.data.listBookshelf
import io.legado.data.updateBookshelfCover
import io.legado.model.ApiError
import io.legado.model.BatchDeleteRequest
import io.legado.model.BatchMarkReadRequest
import io.legado.model.BatchMoveGroupRequest
import io.legado.model.BookCacheRangeRequest
import io.legado.model.BookGroupAssignRequest
import io.legado.model.BookGroupCreateRequest
import io.legado.model.BookshelfInfoUpdateRequest
import io.legado.model.BookshelfSourceSwitchRequest
import io.legado.model.BookshelfStatusRequest
import io.legado.model.BookshelfWriteRequest
import io.legado.model.CachedChaptersResponse
import io.legado.model.LocalBookImportItem
import io.legado.model.LocalBookImportResponse
import io.legado.model.LocalBookUpload
import java.nio.file.Path

/**
 * 从 `Routes.kt` 拆出（0.8.2 结构重排）：书架清单、加删改、分组、换源与批量操作。
 * 处理器文本逐字未动；本函数由 `Routes.kt` 的 `apiRoutes` 挂在 `route("/api")` 内，顺序与拆前一致。
 * 契约核对：`web/test/ApiCatalog.test.ts` 把本目录全部 `*Routes.kt` 视为挂在 `/api` 之下逐条比对。
 */
fun Route.shelfRoutes(
    database: Database,
    bookCache: BookCacheService,
    coverCache: CoverCache,
    localBooksDirectory: Path,
) {
    val repository = BookshelfRepository(database, bookCache, coverCache, localBooksDirectory)
    
        get("/bookshelf") {
            call.respond(database.listBookshelf())
        }
        post("/bookshelf") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<BookshelfWriteRequest>()
            if (request.sourceId.isBlank() || request.bookUrl.isBlank() || request.name.isBlank() || request.tocUrl.isBlank()) { 
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_bookshelf", "书架数据无效"))
                return@post 
            }
            val item = repository.addOrUpdateBook(request)
            // 封面**异步补**，不阻塞这次写请求。
            //
            // 写书架时必须立刻返回：缓存里已有封面就顺手带上（走 `tryFindCachedCover`，纯查缓存），
            // 没有就先空着，由这里的后台任务去抓 —— 抓图可能几秒，让用户等一次网络 IO
            // 才能把书加进书架是不可接受的。抓到了再回填。
            //
            // 判据：`ApiRoutesHttpTest` 的「returns immediately without blocking and caches
            // cover asynchronously」与「uses locally cached cover immediately」两条盯着这里。
            if (tryFindCachedCover(coverCache, request.coverUrl, request.alternateSources) == null &&
                (!request.coverUrl.isNullOrBlank() || !request.alternateSources.isNullOrEmpty())
            ) {
                application.launch(Dispatchers.IO) {
                    val cached = runCatching {
                        tryCacheCover(coverCache, request.coverUrl, request.alternateSources, referer = request.sourceId)
                    }.getOrNull()
                    if (cached != null) {
                        runCatching {
                            database.updateBookshelfCover(request.sourceId, request.bookUrl, cached.key, cached.contentType)
                        }
                    }
                }
            }
            call.respond(item)
        }
        post("/bookshelf/import-local") {
            if (!call.requireSameOriginWrite()) return@post
            // 规则走查询参数而不是 multipart 字段：字段在流里的顺序由前端拼接顺序决定，
            // 而解析发生在读到文件的那一刻 —— 依赖"对方先把规则放前面"是脆的。
            val tocRule = call.request.queryParameters["tocRule"]?.takeIf { it.isNotBlank() }
            // multipart 在**路由层**拆完、字节在路由层读完；Repository 只收「文件名 + 字节」，
            // 不认识 Ktor 的 PartData —— 传输层类型不该进数据层（见 LocalBookUpload 的注释）。
            val uploads = mutableListOf<LocalBookUpload>()
            call.receiveMultipart().forEachPart { part ->
                if (part is PartData.FileItem) {
                    val filename = part.originalFileName ?: "book.txt"
                    val bytes = runCatching { part.streamProvider().use { it.readBytes() } }.getOrNull()
                    // Kotlin 没有 `ByteArray?.isNullOrEmpty()`（那个重载只给 CharSequence/Array），
                    // 且空文件没有导入价值，直接过滤掉。
                    if (bytes != null && bytes.isNotEmpty()) uploads.add(LocalBookUpload(filename, bytes))
                }
                runCatching { part.dispose() }
            }
            try {
                call.respond(repository.importLocalBooks(uploads, tocRule))
            } catch (e: Throwable) {
                call.respond(
                    HttpStatusCode.InternalServerError,
                    LocalBookImportResponse(
                        total = uploads.size,
                        imported = 0,
                        failed = uploads.size.coerceAtLeast(1),
                        results = listOf(
                            LocalBookImportItem(
                                filename = "import",
                                success = false,
                                error = e.message ?: "导入失败",
                            ),
                        ),
                    ),
                )
            }
        }
        get("/bookshelf/groups") {
            call.respond(database.listBookGroups())
        }
        post("/bookshelf/groups") {
            if (!call.requireSameOriginWrite()) return@post
            val request = runCatching { call.receive<BookGroupCreateRequest>() }.getOrElse {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 JSON"))
                return@post
            }
            try { call.respond(database.createBookGroup(request.name)) }
            catch (error: IllegalArgumentException) { call.respond(HttpStatusCode.BadRequest, ApiError("invalid_group", error.message ?: "分组无效")) }
        }
        delete("/bookshelf/groups/{id}") {
            if (!call.requireSameOriginWrite()) return@delete
            val id = call.parameters["id"]?.toLongOrNull()
                ?: return@delete call.respond(HttpStatusCode.BadRequest, ApiError("invalid_group", "分组标识无效"))
            if (database.deleteBookGroup(id)) call.respond(HttpStatusCode.NoContent)
            else call.respond(HttpStatusCode.NotFound, ApiError("not_found", "分组不存在"))
        }
        put("/bookshelf/group") {
            if (!call.requireSameOriginWrite()) return@put
            val request = call.receive<BookGroupAssignRequest>()
            val updated = database.assignBookGroup(request.sourceId, request.bookUrl, request.groupId)
                ?: return@put call.respond(HttpStatusCode.NotFound, ApiError("not_found", "分组不存在或这本书不在书架上"))
            call.respond(updated)
        }
        delete("/bookshelf") {
            if (!call.requireSameOriginWrite()) return@delete
            val sourceId = call.request.queryParameters["sourceId"]
            val bookUrl = call.request.queryParameters["bookUrl"]
            if (sourceId.isNullOrBlank() || bookUrl.isNullOrBlank()) { 
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_bookshelf", "缺少书籍标识"))
                return@delete 
            }
            if (repository.removeBook(sourceId, bookUrl)) {
                call.respond(HttpStatusCode.NoContent)
            } else {
                call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书籍不在书架上"))
            }
        }
        post("/bookshelf/cache") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<BookCacheRangeRequest>()
            repository.enableOfflineCache(request)
            call.respond(HttpStatusCode.Accepted, mapOf("status" to "queued"))
        }
        
        get("/bookshelf/cached-chapters") {
            if (!call.requireSameOriginWrite()) return@get
            val sourceId = call.request.queryParameters["sourceId"]
            val bookUrl = call.request.queryParameters["bookUrl"]
            if (sourceId.isNullOrBlank() || bookUrl.isNullOrBlank()) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_bookshelf", "缺少书籍标识"))
                return@get
            }
            val cachedInfo = repository.getCachedChapters(sourceId, bookUrl)
            call.respond(
                CachedChaptersResponse(
                    sourceId = sourceId,
                    bookUrl = bookUrl,
                    cachedChapterUrls = cachedInfo.cachedChapterUrls,
                    cachedCount = cachedInfo.cachedCount,
                    totalChapters = cachedInfo.totalChapters,
                    cachedWordCounts = cachedInfo.cachedWordCounts,
                ),
            )
        }
        
        delete("/bookshelf/cache") {
            if (!call.requireSameOriginWrite()) return@delete
            val sourceId = call.request.queryParameters["sourceId"]
            val bookUrl = call.request.queryParameters["bookUrl"]
            val clearData = call.request.queryParameters["clearData"]?.toBooleanStrictOrNull() ?: false
            if (sourceId.isNullOrBlank() || bookUrl.isNullOrBlank()) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_bookshelf", "缺少书籍标识"))
                return@delete
            }
            repository.disableOfflineCache(sourceId, bookUrl, clearData)
            call.respond(HttpStatusCode.NoContent)
        }
        
        put("/bookshelf/status") {
            if (!call.requireSameOriginWrite()) return@put
            val request = call.receive<BookshelfStatusRequest>()
            if (request.sourceId.isBlank() || request.bookUrl.isBlank()) { 
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_bookshelf", "缺少书籍标识"))
                return@put 
            }
            repository.setCompleted(request.sourceId, request.bookUrl, request.completed)?.let { call.respond(it) }
                ?: call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书籍不在书架中"))
        }
        
        put("/bookshelf/info") {
            if (!call.requireSameOriginWrite()) return@put
            val request = call.receive<BookshelfInfoUpdateRequest>()
            if (request.sourceId.isBlank() || request.bookUrl.isBlank() || request.name.isBlank()) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_bookshelf", "书名不能为空"))
                return@put
            }
            repository.updateBookInfo(request)?.let { call.respond(it) }
                ?: call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书籍不在书架中"))
        }
        post("/bookshelf/switch-source") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<BookshelfSourceSwitchRequest>()
            val book = request.book
            if (request.oldSourceId.isBlank() || request.oldBookUrl.isBlank() 
                || book.sourceId.isBlank() || book.bookUrl.isBlank() 
                || book.name.isBlank() || book.tocUrl.isBlank()) { 
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_bookshelf", "书架数据无效"))
                return@post 
            }
            // 原样把 `book` 交给仓库：它自己可能带 `alternateSources`（书名搜索时就带着的），
            // 外层请求的备用源另行传入 —— 两者要在仓库里合并，压成一个就会丢一份封面候选。
            repository.switchSource(
                oldSourceId = request.oldSourceId,
                oldBookUrl = request.oldBookUrl,
                request = book,
                extraAlternateSources = request.alternateSources.orEmpty(),
            ).let { result ->
                call.respond(result.book)
            }
        }
        
        // 批量操作：删除多本书籍
        post("/bookshelf/batch-delete") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<BatchDeleteRequest>()
            if (request.books.isEmpty()) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "书籍列表不能为空"))
                return@post
            }
            val result = repository.batchDeleteBooks(request.books)
            call.respond(mapOf("deleted" to result.deleted, "total" to result.total))
        }
        
        // 批量操作：移动多本书籍到指定分组
        post("/bookshelf/batch-move-group") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<BatchMoveGroupRequest>()
            if (request.books.isEmpty()) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "书籍列表不能为空"))
                return@post
            }
            val result = repository.batchMoveToGroup(request.books, request.groupId)
            call.respond(mapOf("moved" to result.moved, "total" to result.total))
        }
        
        // 批量操作：把多本书标成「已读完 / 正在阅读」。
        // 必须走与单本右键**同一个**写入口（书架的 completed 标记）：这里原来改的是阅读进度
        // （已读=把进度推到最后一章、未读=直接删掉 reading_progress），于是界面上什么都不变
        // （用户 2026-10-02：「批量管理中标注已读完没有任何显示，右击标注已读完正常」），
        // 而"未读"那一支还会把用户读到哪儿抹掉 —— 那是比不显示更糟的后果。
        post("/bookshelf/batch-mark-read") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<BatchMarkReadRequest>()
            if (request.books.isEmpty()) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "书籍列表不能为空"))
                return@post
            }
            val result = repository.batchMarkAsRead(request.books, request.isRead)
            call.respond(mapOf("marked" to result.marked, "total" to result.total))
        }
}

