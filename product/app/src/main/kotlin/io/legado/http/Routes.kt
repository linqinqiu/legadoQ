package io.legado.http

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import io.legado.BuildInfo
import io.legado.ai.AgentConnection

import io.legado.ai.AgentProfileStore
import io.legado.backup.BackupStore
import io.legado.cache.BookCacheService
import io.legado.cache.CoverCache
import io.legado.data.Database
import io.legado.data.queryLogs
import io.legado.localbook.TocRules
import io.legado.model.AboutInfo
import io.legado.model.ApiError
import io.legado.model.ServerInfo
import io.legado.model.ServerPortRequest
import io.legado.model.ServerPortResult
import io.legado.ops.LogCategory
import io.legado.ops.LogLevel
import io.legado.ops.LogService
import io.legado.ops.UpdateCheck
import io.legado.rules.RuleExecutionException
import io.legado.rules.RuleRunner
import io.legado.source.ExternalBrowserLogin
import io.legado.source.SourceDebugger
import io.legado.source.WebViewProxy
import io.legado.subscription.SubscriptionService
import io.legado.tts.EdgeTtsService
import io.legado.tts.TtsSessionService
import java.nio.file.Files
import java.nio.file.Path
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.Json

/**
 * HTTP 路由装配点：这里只留「目录 / 系统」两组端点与各业务组的挂载调用。
 * 各组处理器住在同包 `<组名>Routes.kt`（0.8.2 结构重排拆出，文本逐字未动），
 * 挂载顺序与拆前一致；组内静态路径互不冲突，字面段先于参数段的优先级（如
 * `PUT /sources/order` 在 `route("/sources/{id}")` 之前）在组文件内部原样保留。
 * 机器可读契约的双向核对见 `web/test/ApiCatalog.test.ts`（扫 http/ 整目录）。
 */
fun Route.apiRoutes(
    database: Database,
    runner: RuleRunner,
    coverCache: CoverCache,
    subscriptions: SubscriptionService,
    bookCache: BookCacheService,
    edgeTts: EdgeTtsService = EdgeTtsService(),
    ttsSessions: TtsSessionService = TtsSessionService(edgeTts),
    localBooksDirectory: Path = Path.of(".data/local_books"),
    /** 安装根：界面里改端口时把 `port.txt` 写在这里。 */
    homeDirectory: Path = Path.of("."),
    // 这次运行实际绑的地址与端口（`/api/server` 报给界面）。
    currentHost: String = "127.0.0.1",
    currentPort: Int = 8080,
    // AI 自定义接入面所需的可选连接句柄；基础框架不强制启用：仅在 -Dai.debug 下 AgentModule.install 返回非 null 时才有值。
    agentConnection: AgentConnection? = null,
    // 「自定义接入」持久层（连接描述存取）；传 null 时各处理器内部自行回退到 AgentProfileStore 默认实现。
    profileStore: AgentProfileStore? = null,
) {
    val webView = WebViewProxy(database)
    // 备份包里没有原生归宿的个性化条目，原样收在数据目录下的一个文件夹里（见 BackupStore 的取舍说明）。
    val backupKeep = BackupStore(localBooksDirectory.resolveSibling("backup_kept"))
    // 规则表的本机改动（手机备份套进来的启用选择与自定义规则）落在 data 下一个文件里，不建表：
    // 这张表只在切目录时被读一次，建表反而让"改了没生效"变成要查数据库的事。
    TocRules.useStore(localBooksDirectory.resolveSibling("txt_toc_rules.json"))
    // 真浏览器登录：profile 放在数据目录下（与 local_books 同级），登录态跨次启动保留。
    val externalLogin = ExternalBrowserLogin(database, localBooksDirectory.resolveSibling("external-browser-profile"))
    val debugger = SourceDebugger(runner)
    route("/api") {
        /**
         * 端点目录：给外部程序（脚本、AI 客户端）当机器可读的契约用。
         * 内容随包在 `resources/agent-api.json`，这里只把 `version` 盖成当前构建号；
         * 它与 `http/` 整目录的路由文件由 `web/test/ApiCatalog.test.ts` 双向核对 —— 手抄的清单一定会在
         * "加完接口的那天"过期，所以这条判据替人记着。
         */
        get("/catalog") {
            // baseUrl 按**运行时真实监听地址**注入，不写死 1234：产品入口是 1234，
            // 但 `gradlew :app:run` 默认 8080 —— 写死哪个都会把另一种用法的调用方指错端口。
            val rawHost = ServerIdentity.host
            val host = if (rawHost.isBlank() || rawHost == "0.0.0.0" || rawHost == "::") "127.0.0.1" else rawHost
            val hostForUrl = if (host.contains(':') && !host.startsWith("[")) "[$host]" else host
            val baseUrl = "http://$hostForUrl:${ServerIdentity.port}"
            call.respondText(RouteCatalog.serve(BuildInfo.version, baseUrl), ContentType.Application.Json)
        }
        // 服务自身 + 改端口。端口只写安装根的 `port.txt`，**重启后生效** —— 正在跑的这个进程改不了。
        get("/server") {
            call.respond(ServerInfo(host = currentHost, port = currentPort))
        }
        put("/server/port") {
            if (!call.requireSameOriginWrite()) return@put
            val request = runCatching { call.receive<ServerPortRequest>() }.getOrElse {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 JSON")); return@put
            }
            if (request.port !in 1..65535) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_port", "端口要在 1–65535 之间")); return@put
            }
            val file = homeDirectory.resolve("port.txt")
            try {
                java.nio.file.Files.createDirectories(homeDirectory)
                java.nio.file.Files.writeString(file, "${request.port}\n")
            } catch (error: Exception) {
                call.respond(HttpStatusCode.InternalServerError, ApiError("write_failed", "写不进 $file：${error.message}")); return@put
            }
            call.respond(ServerPortResult(port = request.port, restartRequired = request.port != currentPort))
        }
        sourcesRoutes(database, runner, webView, externalLogin, debugger)
        searchRoutes(database, runner)
        subscriptionsRoutes(database, subscriptions)
        // 运行日志：前端「运行日志」弹窗读这里。category/level 用枚举名过滤，limit 夹在 1~1000。
        get("/logs") {
            val params = call.request.queryParameters
            val category = params["category"]?.takeIf { it.isNotBlank() }?.let { runCatching { LogCategory.valueOf(it) }.getOrNull() }
            val level = params["level"]?.takeIf { it.isNotBlank() }?.let { runCatching { LogLevel.valueOf(it) }.getOrNull() }
            val limit = params["limit"]?.toIntOrNull()?.coerceIn(1, 1000) ?: 200
            call.respond(LogService.queryLogs(category, level, limit))
        }
        delete("/logs") {
            if (!call.requireSameOriginWrite()) return@delete
            LogService.clearLogs()
            call.respond(HttpStatusCode.NoContent)
        }
        /**
         * 更新日志：随包发出的 `CHANGELOG.md`（`app/build.gradle` 的 processResources 拷成
         * `meta/changelog.md`）。界面上那张「更新日志」页读这里。
         *
         * 两个刻意的选择：
         * ① **读 classpath，不读磁盘路径** —— jar 被单独拷到别的机器、或跑在 Docker 里时，
         *    "仓库根有个 CHANGELOG.md"这件事不成立；
         * ② 拿不到就 404 + 说明，**不返回 200 空串** —— 空串会被界面渲染成"这个版本没有任何改动"，
         *    那是把打包环节的问题说成产品事实。
         */
        get("/about") {
            call.respond(AboutInfo(BuildInfo.title, BuildInfo.version, UpdateCheck.repository))
        }
        post("/about/update-check") {
            if (!call.requireSameOriginWrite()) return@post
            call.respond(UpdateCheck.check(BuildInfo.version))
        }
        get("/changelog") {
            val text = runCatching {
                BuildInfo::class.java.classLoader.getResourceAsStream("meta/changelog.md")
                    ?.use { it.readBytes().toString(Charsets.UTF_8) }
            }.getOrNull()
            if (text.isNullOrBlank()) {
                call.respond(HttpStatusCode.NotFound, ApiError("changelog_missing", "这个构建产物里没有随包的更新日志"))
            } else {
                call.respondText(text, ContentType("text", "markdown").withCharset(Charsets.UTF_8))
            }
        }
        backupRoutes(database, backupKeep)
        rssRoutes(database, runner)
        readingRoutes(database, runner)
        replaceRulesRoutes(database, runner)
        shelfRoutes(database, bookCache, coverCache, localBooksDirectory)
        tocRulesRoutes(database, backupKeep, localBooksDirectory)
        mediaRoutes(database, coverCache, localBooksDirectory)
        readerRoutes(database)
        ttsRoutes(edgeTts, ttsSessions)
        agentApiRoutes(database, homeDirectory, agentConnection, profileStore)
    }
}

internal suspend fun ApplicationCall.respondCatching(block: suspend () -> Any) {
    try { respond(block()) }
    catch (error: CancellationException) { throw error }
    catch (error: RuleExecutionException) { respond(HttpStatusCode.BadGateway, ApiError("source_execution_failed", error.message ?: "书源执行失败")) }
    catch (error: Exception) { respond(HttpStatusCode.BadGateway, ApiError("source_execution_failed", error.message ?: "书源执行失败")) }
}

