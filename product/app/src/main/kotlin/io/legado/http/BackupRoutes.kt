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
import io.legado.backup.BackupImporter
import io.legado.backup.BackupStore
import io.legado.data.Database
import io.legado.model.ApiError
import java.nio.file.Files
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json

/**
 * 从 `Routes.kt` 拆出（0.8.2 结构重排）：备份包导入与「原样收下」条目读取。
 * 处理器文本逐字未动；本函数由 `Routes.kt` 的 `apiRoutes` 挂在 `route("/api")` 内，顺序与拆前一致。
 * 契约核对：`web/test/ApiCatalog.test.ts` 把本目录全部 `*Routes.kt` 视为挂在 `/api` 之下逐条比对。
 */
fun Route.backupRoutes(
    database: Database,
    backupKeep: BackupStore,
) {
        /**
         * 浏览器直传备份包导入：选一个手机导出的 zip 就能恢复，不需要 WebDAV。
         * 同一入口也收**裸 JSON**（分享书源、兄弟项目的合并导出）：容器由内容判别，不看扩展名。
         *
         * 以前只能"先把 zip 放进存储区（WebDAV 或手工拷），再在文件页点导入" —— 而 WebDAV 只绑回环时
         * 手机根本推不上来，这条路对用户等于不存在。落盘走临时文件，`BackupImporter` 全程按需读条目，
         * 解包与大小上限由它自己把关（单条目 64 MiB / 整包 256 MiB），密码只在内存里用一次、绝不写日志。
         */
        /*
         * 备份包里"收下了但服务端还没有原生界面"的那些条目（书签/字典/阅读记录/阅读样式…）。
         * 列表与原文都只读：写操作发生在导入那一次，这里给的是"你包里的东西现在在哪、能不能用"。
         */
        get("/backup/kept") {
            call.respond(backupKeep.list())
        }
        get("/backup/kept/{name}") {
            val name = call.parameters["name"]
                ?: return@get call.respond(HttpStatusCode.BadRequest, ApiError("invalid_name", "缺少条目名"))
            val body = backupKeep.read(name)
                ?: return@get call.respond(HttpStatusCode.NotFound, ApiError("not_kept", "服务器上没有这个条目"))
            call.respondText(body, ContentType.Application.Json)
        }
        post("/backup/import") {
            if (!call.requireSameOriginWrite()) return@post
            val multipart = call.receiveMultipart()
            var password: String? = null
            var upload: Pair<String, ByteArray>? = null
            multipart.forEachPart { part ->
                when (part) {
                    is PartData.FormItem -> if (part.name == "password") password = part.value
                    is PartData.FileItem -> if (upload == null) upload = (part.originalFileName ?: "backup.zip") to part.streamProvider().readBytes()
                    else -> {}
                }
                part.dispose()
            }
            val (filename, bytes) = upload
                ?: return@post call.respond(HttpStatusCode.BadRequest, ApiError("no_file", "没有收到备份包"))
            if (bytes.isEmpty()) return@post call.respond(HttpStatusCode.BadRequest, ApiError("invalid_backup", "备份包是空的"))
            /*
             * 不再按扩展名挑：兄弟项目与分享链接常见的裸 JSON（书源数组、合并导出）也要能导，
             * 而转存工具经常把 zip 改成 .json。容器由 BackupImporter 按内容（zip 头 PK）判别，
             * 这里只限制大小，避免把超大文件整个读进内存。
             */
            if (bytes.size > MAX_BACKUP_BYTES) {
                return@post call.respond(
                    HttpStatusCode.PayloadTooLarge,
                    ApiError("backup_too_large", "备份包超过 ${MAX_BACKUP_BYTES / 1024 / 1024} MiB，已拒绝"),
                )
            }
            val staged = Files.createTempFile("legado-backup-", ".bin")
            try {
                Files.write(staged, bytes)
                val summary = runCatching {
                    withContext(Dispatchers.IO) { BackupImporter(database, backupKeep).import(staged, password?.takeIf { it.isNotBlank() }) }
                }
                val result = summary.getOrElse { error ->
                    if (error is CancellationException) throw error
                    call.respond(HttpStatusCode.BadRequest, ApiError("invalid_backup", error.message ?: "备份包解析失败"))
                    return@post
                }
                call.application.log.info(
                    "backup uploaded and imported: {} (sources={}, rules={}, books={}, rss={}, groups={})",
                    filename,
                    result.sources + result.sourcesUpdated,
                    result.rules + result.rulesUpdated,
                    result.books + result.booksUpdated,
                    result.rssSources + result.rssSourcesUpdated,
                    result.bookGroups,
                )
                call.respond(result)
            } finally {
                runCatching { Files.deleteIfExists(staged) }
            }
        }
}

/** 上传上限按原始字节算；zip 解包后的限额仍由 `BackupImporter` 按条目把关。 */
private const val MAX_BACKUP_BYTES = 64L * 1024 * 1024


