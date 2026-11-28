package io.legado.http

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.legado.backup.*
import io.legado.cache.BookCacheService
import io.legado.data.Database
import io.legado.data.SourceVersionBusy
import io.legado.data.SourceVersionChanged
import io.legado.data.SourceVersionSnapshotFailed
import io.legado.model.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal fun Route.backupSourceVersionRoutes(database: Database, store: BackupStore, cache: BookCacheService? = null) {
    val versions = BackupSourceVersions(database, store)
    post("/backup/source-versions/list") {
        if (!call.requireSameOriginWrite()) return@post
        sourceVersionCall(call) {
            val request = call.receive<SourceVersionListRequest>()
            call.respond(withContext(Dispatchers.IO) { versions.list(request) })
        }
    }
    post("/backup/source-versions/preview") {
        if (!call.requireSameOriginWrite()) return@post
        sourceVersionCall(call) {
            val request = call.receive<SourceVersionRequest>()
            call.respond(withContext(Dispatchers.IO) { versions.preview(request) })
        }
    }
    post("/backup/source-versions/activate") {
        if (!call.requireSameOriginWrite()) return@post
        sourceVersionCall(call) {
            val request = call.receive<SourceVersionRequest>()
            call.respond(withContext(Dispatchers.IO) {
                versions.activate(request) { ids, action -> cache?.withSourcesIdle(ids, action) ?: action() }
            })
        }
    }
}

private suspend fun sourceVersionCall(call: ApplicationCall, action: suspend () -> Unit) {
    call.response.header(HttpHeaders.CacheControl, "no-store")
    try { action() } catch (error: CancellationException) { throw error }
    catch (_: SourceVersionChanged) {
        call.respond(HttpStatusCode.Conflict, ApiError("source_version_changed", "书源或相关书架记录已变化，请重新预览；本次未应用"))
    } catch (_: SourceVersionBusy) {
        call.respond(HttpStatusCode.Conflict, ApiError("source_version_busy", "相关书籍仍在缓存，请等待完成或取消任务后重新预览"))
    } catch (_: SourceVersionSnapshotFailed) {
        call.respond(HttpStatusCode.InternalServerError, ApiError("source_version_snapshot_failed", "安全快照未完成或校验失败，本次未应用"))
    } catch (_: IllegalArgumentException) {
        call.respond(HttpStatusCode.BadRequest, ApiError("invalid_source_version", "留档、版本或关联选择无效，请重新选择完整留档并预览"))
    } catch (_: Exception) {
        call.respond(HttpStatusCode.InternalServerError, ApiError("source_version_failed", "书源版本操作未完成，请刷新核对；已提交的操作可通过安全快照恢复"))
    }
}
