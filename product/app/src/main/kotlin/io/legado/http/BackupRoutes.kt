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
import io.legado.backup.BackupExporter
import io.legado.backup.BackupImporter
import io.legado.backup.BackupStore
import io.legado.backup.BackupMigration
import io.legado.data.Database
import io.legado.data.core.DbSnapshot
import io.legado.model.ApiError
import io.legado.model.SnapshotRestoreRequest
import io.legado.model.SnapshotRestoreScheduled
import java.nio.file.Files
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
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
        // 启动库快照清单（只读）：列出 backups/ 里的快照与各自的 SHA-256 完整性校验结果。
        // 只"看"不"恢复"——恢复是停服期操作，绝不在服务运行时覆盖已打开的库。
        get("/backup/snapshots") {
            call.respond(DbSnapshot.list(database.dbPath))
        }
        // 排定从某快照恢复：只写标记，**不在运行时覆盖活库**；真正落库在下次启动开库前。
        post("/backup/snapshots/restore") {
            if (!call.requireSameOriginWrite()) return@post
            val name = runCatching { call.receive<SnapshotRestoreRequest>().name }
                .getOrElse { return@post call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体需为 {name}")) }
            if (DbSnapshot.scheduleRestore(database.dbPath, name)) {
                call.respond(SnapshotRestoreScheduled(scheduled = true, restartRequired = true, name = name))
            } else {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_snapshot", "快照不存在或未通过完整性校验：$name"))
            }
        }
        get("/backup/kept/{name}") {
            val name = call.parameters["name"]
                ?: return@get call.respond(HttpStatusCode.BadRequest, ApiError("invalid_name", "缺少条目名"))
            val body = backupKeep.read(name)
                ?: return@get call.respond(HttpStatusCode.NotFound, ApiError("not_kept", "服务器上没有这个条目"))
            call.respondText(body, ContentType.Application.Json)
        }
        /**
         * 导出备份，一域一包：书源 / 替换规则 / 分组 / RSS / 书架含进度 / 书源订阅。
         * 完整包走不写 domain 的 `all`，一域一包是排查用的。
         *
         * 为什么要带 `domain` 参数而不是直接叫"导出全部"：只导一域时，文件名与参数都写明范围，
         * 用户不会以为"备份好了"、恢复时才发现书架没在里面。未知域直接 400，不静默降级。
         *
         * 只读 GET：不写库、不改状态，所以不过同源写门。普通导出直接流式写 zip；
         * recovery 先校验并暂存完整 zip，再发送下载响应，避免把生成失败作为空包返回。
         */
        get("/backup/export") {
            val domain = call.request.queryParameters["domain"]?.trim()?.lowercase().orEmpty().ifBlank { "all" }
            val stamp = java.time.LocalDateTime.now()
                .format(java.time.format.DateTimeFormatter.ofPattern("yyyyMMdd-HHmm"))
            when (domain) {
                "recovery" -> {
                    // Stage completely: validation/disk/size failures must occur before sending HTTP 200.
                    var staged: java.nio.file.Path? = null
                    suspend fun cleanup() = withContext(NonCancellable + Dispatchers.IO) {
                        staged?.let { Files.deleteIfExists(it) }
                        Unit
                    }
                    try {
                        withContext(NonCancellable + Dispatchers.IO) {
                            staged = Files.createTempFile("legado-migration-", ".zip")
                        }
                        val file = requireNotNull(staged)
                        withContext(Dispatchers.IO) {
                            Files.newOutputStream(file).use { BackupMigration.export(database, backupKeep, it) }
                            require(Files.size(file) <= BodyLimits.BACKUP_BYTES) { "迁移包超过上传上限，请单独下载留档" }
                        }
                        call.response.header(HttpHeaders.ContentDisposition, "attachment; filename=\"legadoq-migration-$stamp.zip\"")
                        call.respondOutputStream(ContentType.Application.Zip) {
                            // Ktor may run this producer after respondOutputStream returns.
                            try {
                                withContext(Dispatchers.IO) {
                                    Files.newInputStream(file).use { it.copyTo(this@respondOutputStream) }
                                    Unit
                                }
                            } finally { cleanup() }
                        }
                        call.application.log.debug("migration export completed")
                    } catch (error: CancellationException) {
                        cleanup()
                        throw error
                    } catch (error: Exception) {
                        cleanup()
                        if (!call.response.isCommitted) call.respond(HttpStatusCode.InternalServerError,
                            ApiError("backup_export_failed", "迁移包生成失败，请检查留档完整性、目录空间与大小上限；可分别导出原生数据和下载留档"))
                        else throw error
                    }
                }
                // 不写 domain = 导出完整备份（界面那个按钮走的就是这条）：
                // 一域一包是排查用的，默认给"全部"才符合「导出备份」四个字。
                "all", "" -> respondZip(call, "legadoq-backup-$stamp.zip") { BackupExporter.exportAll(database, this) }
                "source" -> respondZip(call, "legadoq-sources-$stamp.zip") { BackupExporter.exportSources(database, this) }
                "replacerule", "rule" -> respondZip(call, "legadoq-replace-rules-$stamp.zip") {
                    BackupExporter.exportReplaceRules(database, this)
                }
                "group", "bookgroup" -> respondZip(call, "legadoq-book-groups-$stamp.zip") {
                    BackupExporter.exportBookGroups(database, this)
                }
                "rss", "rsssource" -> respondZip(call, "legadoq-rss-sources-$stamp.zip") {
                    BackupExporter.exportRssSources(database, this)
                }
                "shelf", "bookshelf" -> respondZip(call, "legadoq-bookshelf-$stamp.zip") {
                    BackupExporter.exportBookshelf(database, this)
                }
                "subscription", "sourcesub" -> respondZip(call, "legadoq-subscriptions-$stamp.zip") {
                    BackupExporter.exportSubscriptions(database, this)
                }
                else -> call.respond(
                    HttpStatusCode.BadRequest,
                    ApiError(
                        "invalid_domain",
                        "支持导出书源（source）、替换规则（replaceRule）、分组（group）、RSS（rss）、" +
                            "书架含进度（shelf）、书源订阅（subscription）、原生数据与留档迁移包（recovery）",
                    ),
                )
            }
        }
        post("/backup/import") {
            if (!call.requireSameOriginWrite()) return@post
            val multipart = call.receiveMultipart()
            var password: String? = null
            var sectionsJson: String? = null
            var libraryPolicyJson: String? = null
            var previewToken: String? = null
            var upload: Pair<String, ByteArray>? = null
            multipart.forEachPart { part ->
                try {
                    when (part) {
                        is PartData.FormItem -> when (part.name) {
                            "password" -> password = part.value
                            "sections" -> sectionsJson = part.value
                            "libraryPolicy" -> libraryPolicyJson = part.value
                            "previewToken" -> previewToken = part.value
                        }
                        // 边读边判：超限在读取过程中就抛 PayloadTooLargeException（→ 413），
                        // 不再先 readBytes() 把 10GB 吃满内存再回头看大小。
                        is PartData.FileItem -> if (upload == null) {
                            upload = (part.originalFileName ?: "backup.zip") to
                                withContext(Dispatchers.IO) {
                                    // streamProvider 的阻塞读取不能占用 Netty event loop，否则大包会等不到后续数据。
                                    readBounded(part.streamProvider(), BodyLimits.BACKUP_BYTES, "backup_too_large", "备份包")
                                }
                        }
                        else -> {}
                    }
                } finally {
                    // 超限抛异常时也要 dispose，避免 multipart 临时文件残留（判据：失败后 data/ 无残留）。
                    part.dispose()
                }
            }
            val (_, bytes) = upload
                ?: return@post call.respond(HttpStatusCode.BadRequest, ApiError("no_file", "没有收到备份包"))
            if (bytes.isEmpty()) return@post call.respond(HttpStatusCode.BadRequest, ApiError("invalid_backup", "备份包是空的"))
            val preview = when (call.request.queryParameters["preview"]) {
                null, "false" -> false
                "true" -> true
                else -> return@post call.respond(HttpStatusCode.BadRequest, ApiError("invalid_backup", "preview 只能是 true 或 false"))
            }
            val sections = try {
                sectionsJson?.let { Json.decodeFromString<List<String>>(it).toSet() }
            } catch (_: IllegalArgumentException) {
                return@post call.respond(HttpStatusCode.BadRequest, ApiError("invalid_backup", "sections 必须是模块 ID 的 JSON 数组"))
            }
            /*
             * 不再按扩展名挑：兄弟项目与分享链接常见的裸 JSON（书源数组、合并导出）也要能导，
             * 而转存工具经常把 zip 改成 .json。容器由 BackupImporter 按内容（zip 头 PK）判别。
             * 64MB 原始字节上限已由 readBounded 在读取过程中执行，超限直接 413，不进导入器。
             */
            val staged = Files.createTempFile("legado-backup-", ".bin")
            try {
                Files.write(staged, bytes)
                try {
                    val importer = BackupImporter(database, backupKeep)
                    val policy = libraryPolicyJson?.let { Json.decodeFromString<io.legado.model.BackupLibraryPolicy>(it).also { value -> value.validate() } }
                    val secret = password?.takeIf { it.isNotBlank() }
                    if (preview) {
                        call.respond(withContext(Dispatchers.IO) { importer.preview(staged, secret, policy ?: io.legado.model.BackupLibraryPolicy()) })
                    } else {
                        val result = withContext(Dispatchers.IO) { importer.import(staged, secret, sections, policy, previewToken) }
                        call.application.log.info("backup imported (sources={}, books={})",
                            result.sources + result.sourcesUpdated, result.books + result.booksUpdated)
                        call.respond(result)
                    }
                } catch (error: io.legado.backup.BackupPreviewChangedException) {
                    call.respond(HttpStatusCode.Conflict, ApiError("backup_preview_changed", error.message ?: "请重新预览"))
                } catch (error: io.legado.backup.BackupArchiveException) {
                    call.respond(HttpStatusCode.InternalServerError, ApiError("backup_archive_failed", error.message ?: "书源冲突版本留档失败"))
                } catch (error: IllegalArgumentException) {
                    call.respond(HttpStatusCode.BadRequest, ApiError("invalid_backup", error.message ?: "备份包解析失败"))
                } catch (error: java.util.zip.ZipException) {
                    call.respond(HttpStatusCode.BadRequest, ApiError("invalid_backup", "备份包解析失败"))
                }
            } finally {
                runCatching { Files.deleteIfExists(staged) }
            }
        }
}

/**
 * 导出包统一回包：定 `Content-Disposition`，再把 body 交给各域自己写 zip。
 *
 * 抽出来是因为域会一域一域加（书源 / 替换规则 / 分组 / 书架 / RSS），
 * 每个域都抄一遍 header + respondOutputStream 的话，加第三域时就该重了。
 */
private suspend fun respondZip(
    call: ApplicationCall,
    fileName: String,
    write: java.io.OutputStream.() -> Unit,
) {
    call.response.header(HttpHeaders.ContentDisposition, "attachment; filename=\"$fileName\"")
    call.respondOutputStream(ContentType.Application.Zip) { write() }
    // 流式响应挂起恢复时可能携带内部 content 对象；在本层收尾，勿向路由透传为 Unit。
    call.application.log.debug("backup export completed")
}


