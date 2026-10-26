package io.legado.http

import io.ktor.http.*
import io.ktor.http.content.PartData
import io.ktor.http.content.forEachPart
import io.ktor.http.content.streamProvider
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import io.legado.cache.BookCacheService
import io.legado.cache.CachedCover
import io.legado.cache.CoverCache
import io.legado.data.Database
import io.legado.data.assignBookGroup
import io.legado.data.batchUpdateBookshelfGroup
import io.legado.data.cachedChapterUrls
import io.legado.data.cachedChapterWordCounts
import io.legado.data.clearBookCacheContent
import io.legado.data.clearBookshelfOrder
import io.legado.data.createBookGroup
import io.legado.data.deleteBookGroup
import io.legado.data.getTocCache
import io.legado.data.importLocalBook
import io.legado.data.listBookGroups
import io.legado.data.listBookshelf
import io.legado.data.removeBookshelf
import io.legado.data.reorderBookshelf
import io.legado.data.saveBookshelf
import io.legado.data.setBookshelfCompleted
import io.legado.data.switchBookshelf
import io.legado.data.updateBookshelfCover
import io.legado.data.updateBookshelfInfo
import io.legado.localbook.LocalBookParser
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
import io.legado.model.CachedBookRequest
import io.legado.model.CachedChaptersResponse
import io.legado.model.LocalBookImportItem
import io.legado.model.LocalBookImportResponse
import io.legado.model.SearchResult
import io.legado.model.ShelfOrderRequest
import io.legado.model.ShelfOrderResult
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * 从 `Routes.kt` 拆出（0.8.2 结构重排）：书架清单、加删改、分组、排序、换源与批量操作。
 * 处理器文本逐字未动；本函数由 `Routes.kt` 的 `apiRoutes` 挂在 `route("/api")` 内，顺序与拆前一致。
 * 契约核对：`web/test/ApiCatalog.test.ts` 把本目录全部 `*Routes.kt` 视为挂在 `/api` 之下逐条比对。
 */
fun Route.shelfRoutes(
    database: Database,
    bookCache: BookCacheService,
    coverCache: CoverCache,
    localBooksDirectory: Path,
) {
        get("/bookshelf") {
            call.respond(database.listBookshelf())
        }
        post("/bookshelf") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<BookshelfWriteRequest>()
            if (request.sourceId.isBlank() || request.bookUrl.isBlank() || request.name.isBlank() || request.tocUrl.isBlank()) { call.respond(HttpStatusCode.BadRequest, ApiError("invalid_bookshelf", "书架数据无效")); return@post }
            val immediateCover = tryFindCachedCover(coverCache, request.coverUrl, request.alternateSources)
            val item = database.saveBookshelf(request, immediateCover)
            bookCache.enqueue(CachedBookRequest(request.sourceId, request.bookUrl, request.tocUrl))
            if (immediateCover == null && (!request.coverUrl.isNullOrBlank() || !request.alternateSources.isNullOrEmpty())) {
                application.launch(Dispatchers.IO) {
                    val cached = tryCacheCover(coverCache, request.coverUrl, request.alternateSources, referer = request.sourceId)
                    if (cached != null) {
                        database.updateBookshelfCover(request.sourceId, request.bookUrl, cached.key, cached.contentType)
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
            val multipart = call.receiveMultipart()
            val items = mutableListOf<LocalBookImportItem>()
            var importedCount = 0
            var failedCount = 0
            // 本地书统一归到「本地」这一组：一次导入十几本，混在线书里就再也找不着了。
            // createBookGroup 是按名字找、没有才建，所以重复导入不会堆出第二个「本地」。
            val localGroupId = database.createBookGroup("本地").id
            multipart.forEachPart { part ->
                if (part is PartData.FileItem) {
                    val originalFilename = part.originalFileName ?: "book.txt"
                    val bytes = part.streamProvider().readBytes()
                    if (bytes.isNotEmpty()) {
                        try {
                            // 先生成 bookId 再解析：EPUB 里的内嵌插图要按 `/api/books/local/asset?bookId=…`
                            // 取，解析时不知道 id 就只能把图丢掉。
                            val bookId = UUID.randomUUID().toString().replace("-", "")
                            val parsed = LocalBookParser.parse(originalFilename, bytes, tocRule, bookId)
                            val ext = if (originalFilename.contains('.')) "." + originalFilename.substringAfterLast('.') else ".txt"
                            runCatching {
                                Files.createDirectories(localBooksDirectory)
                                Files.write(localBooksDirectory.resolve("$bookId$ext"), bytes)
                            }

                            val coverKey = if (parsed.coverBytes != null && parsed.coverBytes.isNotEmpty()) {
                                coverCache.saveCoverBytes(parsed.coverBytes, parsed.coverContentType ?: "image/jpeg")
                            } else null

                            val item = database.importLocalBook(bookId, parsed, coverKey, localGroupId)
                            importedCount++
                            items.add(LocalBookImportItem(
                                filename = originalFilename,
                                success = true,
                                bookUrl = item.bookUrl,
                                name = item.name,
                                author = item.author,
                                totalChapters = item.totalChapters,
                            ))
                        } catch (error: Throwable) {
                            failedCount++
                            items.add(LocalBookImportItem(
                                filename = originalFilename,
                                success = false,
                                error = error.message ?: "解析失败"
                            ))
                        }
                    }
                }
                part.dispose()
            }
            call.respond(LocalBookImportResponse(
                total = items.size,
                imported = importedCount,
                failed = failedCount,
                results = items,
            ))
        }
        get("/bookshelf/groups") {
            call.respond(database.listBookGroups())
        }
        post("/bookshelf/groups") {
            if (!call.requireSameOriginWrite()) return@post
            val request = runCatching { call.receive<BookGroupCreateRequest>() }.getOrElse {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 JSON")); return@post
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
        put("/bookshelf/order") {
            if (!call.requireSameOriginWrite()) return@put
            val request = runCatching { call.receive<ShelfOrderRequest>() }.getOrElse {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 JSON")); return@put
            }
            if (request.books.isEmpty()) {
                call.respond(HttpStatusCode.BadRequest, ApiError("empty_order", "没有要排序的书")); return@put
            }
            call.respond(ShelfOrderResult(database.reorderBookshelf(request.books)))
        }
        delete("/bookshelf/order") {
            if (!call.requireSameOriginWrite()) return@delete
            call.respond(ShelfOrderResult(database.clearBookshelfOrder()))
        }
        delete("/bookshelf") {
            if (!call.requireSameOriginWrite()) return@delete
            val sourceId = call.request.queryParameters["sourceId"]; val bookUrl = call.request.queryParameters["bookUrl"]
            if (sourceId.isNullOrBlank() || bookUrl.isNullOrBlank()) { call.respond(HttpStatusCode.BadRequest, ApiError("invalid_bookshelf", "缺少书籍标识")); return@delete }
            bookCache.cancel(sourceId, bookUrl)
            if (sourceId == LocalBookParser.LOC_BOOK_SOURCE_ID) {
                val bookId = bookUrl.removePrefix("local://").substringBefore('/')
                if (bookId.isNotBlank()) {
                    runCatching {
                        if (Files.exists(localBooksDirectory)) {
                            Files.list(localBooksDirectory).use { stream ->
                                stream.filter { it.fileName.toString().startsWith(bookId) }.forEach { Files.deleteIfExists(it) }
                            }
                        }
                    }
                }
            }
            database.removeBookshelf(sourceId, bookUrl)?.let(coverCache::delete)
            call.respond(HttpStatusCode.NoContent)
        }
        post("/bookshelf/cache") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<BookCacheRangeRequest>()
            val item = database.listBookshelf().firstOrNull { it.sourceId == request.sourceId && it.bookUrl == request.bookUrl }
                ?: return@post call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书籍不在书架中"))
            bookCache.enqueue(CachedBookRequest(
                item.sourceId,
                item.bookUrl,
                item.tocUrl,
                request.startIndex,
                request.endIndex,
                request.count
            ))
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
            val cachedRows = database.cachedChapterWordCounts(sourceId, bookUrl)
            val cachedUrls = cachedRows.map { it.first }
            val total = database.getTocCache(sourceId, bookUrl)?.size ?: 0
            call.respond(
                CachedChaptersResponse(
                    sourceId = sourceId,
                    bookUrl = bookUrl,
                    cachedChapterUrls = cachedUrls,
                    cachedCount = cachedUrls.size,
                    totalChapters = total,
                    cachedWordCounts = cachedRows.map { it.second },
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
            bookCache.cancel(sourceId, bookUrl)
            if (clearData) {
                database.clearBookCacheContent(sourceId, bookUrl)
            }
            call.respond(HttpStatusCode.NoContent)
        }
        put("/bookshelf/status") {
            if (!call.requireSameOriginWrite()) return@put
            val request = call.receive<BookshelfStatusRequest>()
            if (request.sourceId.isBlank() || request.bookUrl.isBlank()) return@put call.respond(HttpStatusCode.BadRequest, ApiError("invalid_bookshelf", "缺少书籍标识"))
            database.setBookshelfCompleted(request.sourceId, request.bookUrl, request.completed)?.let { call.respond(it) }
                ?: call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书籍不在书架中"))
        }
        put("/bookshelf/info") {
            if (!call.requireSameOriginWrite()) return@put
            val request = call.receive<BookshelfInfoUpdateRequest>()
            if (request.sourceId.isBlank() || request.bookUrl.isBlank() || request.name.isBlank()) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_bookshelf", "书名不能为空"))
                return@put
            }
            val cover = request.coverUrl?.takeIf { it.isNotBlank() }?.let { url ->
                runCatching { coverCache.cache(url) }.getOrNull()
            }
            database.updateBookshelfInfo(request, cover)?.let { call.respond(it) }
                ?: call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书籍不在书架中"))
        }
        post("/bookshelf/switch-source") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<BookshelfSourceSwitchRequest>()
            val book = request.book
            if (request.oldSourceId.isBlank() || request.oldBookUrl.isBlank() || book.sourceId.isBlank() || book.bookUrl.isBlank() || book.name.isBlank() || book.tocUrl.isBlank()) { call.respond(HttpStatusCode.BadRequest, ApiError("invalid_bookshelf", "书架数据无效")); return@post }
            val altList = (request.alternateSources ?: emptyList()) + (book.alternateSources ?: emptyList())
            val cover = tryCacheCover(coverCache, book.coverUrl, altList, referer = book.sourceId)
            bookCache.cancel(request.oldSourceId, request.oldBookUrl)
            val (item, orphan) = database.switchBookshelf(request.oldSourceId, request.oldBookUrl, book, cover, request.alternateSources)
            orphan?.let(coverCache::delete)
            bookCache.enqueue(CachedBookRequest(book.sourceId, book.bookUrl, book.tocUrl))
            call.respond(item)
        }
        
        // 批量操作：删除多本书籍
        post("/bookshelf/batch-delete") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<BatchDeleteRequest>()
            if (request.books.isEmpty()) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "书籍列表不能为空"))
                return@post
            }
            var deletedCount = 0
            for (book in request.books) {
                if (book.sourceId.isNotBlank() && book.bookUrl.isNotBlank()) {
                    bookCache.cancel(book.sourceId, book.bookUrl)
                    if (book.sourceId == LocalBookParser.LOC_BOOK_SOURCE_ID) {
                        val bookId = book.bookUrl.removePrefix("local://").substringBefore('/')
                        if (bookId.isNotBlank()) {
                            runCatching {
                                if (Files.exists(localBooksDirectory)) {
                                    Files.list(localBooksDirectory).use { stream ->
                                        stream.filter { it.fileName.toString().startsWith(bookId) }.forEach { Files.deleteIfExists(it) }
                                    }
                                }
                            }
                        }
                    }
                    database.removeBookshelf(book.sourceId, book.bookUrl)?.let(coverCache::delete)
                    deletedCount++
                }
            }
            call.respond(mapOf("deleted" to deletedCount, "total" to request.books.size))
        }
        
        // 批量操作：移动多本书籍到指定分组
        post("/bookshelf/batch-move-group") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<BatchMoveGroupRequest>()
            if (request.books.isEmpty()) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "书籍列表不能为空"))
                return@post
            }
            val movedCount = database.batchUpdateBookshelfGroup(request.books, request.groupId)
            call.respond(mapOf("moved" to movedCount, "total" to request.books.size))
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
            var markedCount = 0
            for (book in request.books) {
                if (book.sourceId.isNotBlank() && book.bookUrl.isNotBlank()
                    && database.setBookshelfCompleted(book.sourceId, book.bookUrl, request.isRead) != null) markedCount++
            }
            call.respond(mapOf("marked" to markedCount, "total" to request.books.size))
        }
        
}

internal fun tryFindCachedCover(coverCache: CoverCache, primaryUrl: String?, alternateSources: List<SearchResult>?): CachedCover? {
    val candidates = buildList {
        primaryUrl?.takeIf { it.isNotBlank() }?.let { add(it) }
        alternateSources?.forEach { s ->
            s.coverUrl?.takeIf { it.isNotBlank() && it !in this }?.let { add(it) }
        }
    }
    for (url in candidates) {
        val cached = coverCache.getIfCached(url)
        if (cached != null) return cached
    }
    return null
}

internal fun tryCacheCover(coverCache: CoverCache, primaryUrl: String?, alternateSources: List<SearchResult>?, referer: String?): CachedCover? {
    val candidates = buildList {
        primaryUrl?.takeIf { it.isNotBlank() }?.let { add(it) }
        alternateSources?.forEach { s ->
            s.coverUrl?.takeIf { it.isNotBlank() && it !in this }?.let { add(it) }
        }
    }
    val page = referer?.takeIf { it.startsWith("http", ignoreCase = true) }
    for (url in candidates) {
        val cached = runCatching { coverCache.cache(url, page) }.getOrNull()
        if (cached != null) return cached
    }
    return null
}

