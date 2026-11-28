package io.legado.http

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.legado.backup.BackupMigration
import io.legado.backup.BackupStore
import io.legado.backup.BackupWebDav
import io.legado.data.Database
import io.legado.model.ApiError
import io.legado.model.BackupWebDavRequest
import java.nio.file.Files
import java.nio.file.Path
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.withContext

internal fun Route.backupWebDavRoutes(database: Database, store: BackupStore, webDav: BackupWebDav = BackupWebDav()) {
    post("/backup/webdav/list") {
        if (!call.requireSameOriginWrite()) return@post
        webDavCall(call) {
            val request = call.receive<BackupWebDavRequest>()
            call.respond(runInterruptible(Dispatchers.IO) { webDav.list(request) })
        }
    }
    post("/backup/webdav/upload") {
        if (!call.requireSameOriginWrite()) return@post
        webDavCall(call) {
            val request = call.receive<BackupWebDavRequest>()
            val file = temporaryWebDavFile()
            try {
                call.respond(runInterruptible(Dispatchers.IO) {
                    Files.newOutputStream(file).use { BackupMigration.export(database, store, it) }
                    webDav.upload(request, file)
                })
            } finally { removeWebDavFile(file) }
        }
    }
    post("/backup/webdav/pull") {
        if (!call.requireSameOriginWrite()) return@post
        webDavCall(call) {
            val request = call.receive<BackupWebDavRequest>()
            val file = temporaryWebDavFile()
            try {
                runInterruptible(Dispatchers.IO) { webDav.download(request, file) }
                call.response.header(HttpHeaders.ContentDisposition, "attachment; filename=\"${request.name}\"")
                call.respondOutputStream(ContentType.Application.Zip) {
                    try {
                        runInterruptible(Dispatchers.IO) { Files.newInputStream(file).use { it.copyTo(this@respondOutputStream) }; Unit }
                    } finally { removeWebDavFile(file) }
                }
            } catch (error: Throwable) { removeWebDavFile(file); throw error }
        }
    }
}

private suspend fun temporaryWebDavFile(): Path = withContext(NonCancellable + Dispatchers.IO) {
    Files.createTempFile("legado-webdav-", ".zip")
}
private suspend fun removeWebDavFile(file: Path) = withContext(NonCancellable + Dispatchers.IO) {
    Files.deleteIfExists(file); Unit
}
private suspend fun webDavCall(call: ApplicationCall, action: suspend () -> Unit) {
    call.response.header(HttpHeaders.CacheControl, "no-store")
    try { action() } catch (error: CancellationException) { throw error }
    catch (error: BackupWebDav.Failure) {
        val status = when (error.code) {
            "invalid_webdav", "invalid_webdav_name", "webdav_blocked" -> HttpStatusCode.BadRequest
            "webdav_too_large" -> HttpStatusCode.PayloadTooLarge
            else -> HttpStatusCode.BadGateway
        }
        call.respond(status, ApiError(error.code, error.message))
    } catch (_: Exception) {
        if (!call.response.isCommitted) call.respond(HttpStatusCode.BadGateway,
            ApiError("webdav_failed", "WebDAV 操作未完成，请检查请求格式、网络、目录权限与本地留档完整性；上传失败时远端可能已留有文件，请刷新列表核对"))
    }
}
