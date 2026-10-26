package io.legado.http

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.legado.data.Database
import io.legado.model.ApiError
import io.legado.model.BookNoteUpdate
import io.legado.model.BookNoteWrite
import io.legado.model.ReadingLogRequest
import io.legado.model.ReadingProgress
import io.legado.reading.ReadingRepository

/**
 * 阅读域路由装配（P1-T4）：把原先散在 `ProgressRoutes.kt` 的阅读相关端点（reading-progress、
 * reading-log、notes、book-search）收口到「阅读域」声明里。处理器逻辑逐字沿用，只是读写经
 * `ReadingRepository` 收口，不再直接调 DAO 扩展函数。
 *
 * 由 `Routes.kt` 的 `apiRoutes` 挂在 `route("/api")` 内。契约核对：`web/test/ApiCatalog.test.ts`
 * 把本目录全部 `*Routes.kt` 视为挂在 `/api` 之下逐条比对（按缩进推导路径）—— 本文件只是把端点
 * 从 ProgressRoutes 平移过来，路径 / 方法 / 写门一个没变，目录 142 条契约不受影响。处理器缩进
 * 与拆前逐字对齐（端点声明 8 空格、lambda 体 12 空格），避免目录解析把 `/api` 前缀吃掉。
 */
fun Route.readerRoutes(
    database: Database,
) {
        val repo = ReadingRepository(database)
        get("/reading-progress") {
            val sourceId = call.request.queryParameters["sourceId"]
            val bookUrl = call.request.queryParameters["bookUrl"]
            if (sourceId.isNullOrBlank() || bookUrl.isNullOrBlank()) { call.respond(HttpStatusCode.BadRequest, ApiError("invalid_progress", "缺少 sourceId 或 bookUrl")); return@get }
            repo.getProgress(sourceId, bookUrl)?.let { call.respond(it) } ?: call.respond(HttpStatusCode.NoContent)
        }
        put("/reading-progress") {
            if (!call.requireSameOriginWrite()) return@put
            val progress = call.receive<ReadingProgress>()
            if (progress.sourceId.isBlank() || progress.bookUrl.isBlank() || progress.chapterUrl.isBlank() || progress.chapterIndex < 0 || progress.charOffset < 0 || !progress.scrollPosition.isFinite() || progress.scrollPosition !in 0.0..1.0) { call.respond(HttpStatusCode.BadRequest, ApiError("invalid_progress", "阅读进度无效")); return@put }
            call.respond(repo.saveProgress(progress))
        }
        // 阅读记录（PROPOSAL-019 D）。只增不改：POST 累加、GET 读，没有编辑/删除单条的入口。
        get("/reading-log") {
            val days = (call.request.queryParameters["days"]?.toIntOrNull() ?: 30).coerceIn(1, 365)
            call.respond(repo.listReadingLog(days))
        }
        post("/reading-log") {
            if (!call.requireSameOriginWrite()) return@post
            val entry = call.receive<ReadingLogRequest>()
            if (entry.sourceId.isBlank() || entry.bookUrl.isBlank() || entry.seconds <= 0 || entry.seconds > 24 * 3600 || entry.chapterIndex < 0) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_reading_log", "阅读记录无效"))
                return@post
            }
            call.respond(repo.addReadingLog(entry))
        }
        // 笔记 / 划线（PROPOSAL-019 E）：按书读、增、改备注、删。偏移是章节内字符偏移。
        get("/notes") {
            val sourceId = call.request.queryParameters["sourceId"]
            val bookUrl = call.request.queryParameters["bookUrl"]
            if (sourceId.isNullOrBlank() || bookUrl.isNullOrBlank()) { call.respond(HttpStatusCode.BadRequest, ApiError("invalid_note", "缺少 sourceId 或 bookUrl")); return@get }
            call.respond(repo.listNotes(sourceId, bookUrl))
        }
        // 本书正文检索（搜索本书 feature）：在已缓存章节正文里按关键词找命中，只覆盖离线缓存到的章节。
        get("/book-search") {
            val sourceId = call.request.queryParameters["sourceId"]
            val bookUrl = call.request.queryParameters["bookUrl"]
            val q = call.request.queryParameters["q"]?.trim() ?: ""
            if (sourceId.isNullOrBlank() || bookUrl.isNullOrBlank() || q.isBlank()) { call.respond(HttpStatusCode.BadRequest, ApiError("invalid_query", "缺少 sourceId / bookUrl 或搜索词为空")); return@get }
            call.respond(repo.searchBookContent(sourceId, bookUrl, q))
        }
        post("/notes") {
            if (!call.requireSameOriginWrite()) return@post
            val write = call.receive<BookNoteWrite>()
            if (write.sourceId.isBlank() || write.bookUrl.isBlank() || write.excerpt.isBlank() || write.startOffset < 0 || write.endOffset < write.startOffset) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_note", "笔记无效"))
                return@post
            }
            call.respond(repo.addNote(write))
        }
        put("/notes/{id}") {
            if (!call.requireSameOriginWrite()) return@put
            val id = call.parameters["id"]?.toLongOrNull() ?: return@put call.respond(HttpStatusCode.BadRequest, ApiError("invalid_id", "笔记 ID 无效"))
            if (repo.updateNote(id, call.receive<BookNoteUpdate>().note)) call.respond(HttpStatusCode.NoContent)
            else call.respond(HttpStatusCode.NotFound, ApiError("not_found", "笔记不存在"))
        }
        delete("/notes/{id}") {
            if (!call.requireSameOriginWrite()) return@delete
            val id = call.parameters["id"]?.toLongOrNull() ?: return@delete call.respond(HttpStatusCode.BadRequest, ApiError("invalid_id", "笔记 ID 无效"))
            if (repo.deleteNote(id)) call.respond(HttpStatusCode.NoContent)
            else call.respond(HttpStatusCode.NotFound, ApiError("not_found", "笔记不存在"))
        }
}
