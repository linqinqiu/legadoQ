package io.legado.http.system

import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.response.respondText
import io.ktor.server.routing.*
import io.legado.BuildInfo
import io.legado.data.Database
import io.legado.model.AboutInfo
import io.legado.model.ApiError
import io.legado.model.ServerInfo
import io.legado.model.ServerPortRequest
import io.legado.model.ServerPortResult
import io.legado.port.LogCategory
import io.legado.port.LogLevel
import io.legado.ops.LogService
import io.legado.ops.Metrics
import io.legado.ops.UpdateCheck
import io.legado.http.RouteCatalog
import io.legado.ops.ServerIdentity
import io.legado.http.requireSameOriginWrite
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption

/**
 * 系统域路由：目录 / 服务自身 / 日志 / 诊断 / 关于 / 更新日志。
 *
 * 从 `Routes.kt` 装配点拆出（0.2.14 结构重排），文本逐字未动，
 * 仅按领域归入 `system` 子包。`Routes.kt` 负责装配，本文件只做业务处理。
 *
 * 注意：本函数已在 `route("/api")` 上下文中被 `Routes.kt` 调用，
 * 因此内部不再嵌套 `route("/api")`，直接注册子路径即可。
 */
fun Route.systemRoutes(
    database: Database,
    homeDirectory: Path,
    currentHost: String,
    currentPort: Int,
) {
    // 端点目录：给外部程序（脚本、AI 客户端）当机器可读的契约用。
    // 内容随包在 `resources/agent-api.json`，这里只把 `version` 盖成当前构建号；
    // 它与 `http/` 整目录的路由文件由 `web/test/ApiCatalog.test.ts` 双向核对 —— 手抄的清单一定会在
    // "加完接口的那天"过期，所以这条判据替人记着。
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
            Files.createDirectories(homeDirectory)
            Files.writeString(file, "${request.port}\n", StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING)
        } catch (error: Exception) {
            call.respond(HttpStatusCode.InternalServerError, ApiError("write_failed", "写不进 $file：${error.message}")); return@put
        }
        call.respond(ServerPortResult(port = request.port, restartRequired = request.port != currentPort))
    }
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
    // 运行指标快照：给"哪个源在拖慢搜索、超时多少"这类本地诊断用；纯读、只在内存里累计，重启清零。
    get("/diagnostics") {
        call.respond(Metrics.snapshot())
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
        call.respond(AboutInfo(BuildInfo.title, BuildInfo.version, UpdateCheck.repository, BuildInfo.buildNumber))
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
            call.respondText(text, ContentType.parse("text/markdown; charset=utf-8"))
        }
    }
}
