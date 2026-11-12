package io.legado.http

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import io.legado.ai.AgentConnection
import io.legado.ai.AgentProfileStore
import io.legado.backup.BackupStore
import io.legado.cache.BookCacheService
import io.legado.cache.CoverCache
import io.legado.data.Database
import io.legado.data.queryLogs
import io.legado.localbook.TocRules
import io.legado.model.ApiError
import io.legado.ops.NetworkSecurity
import io.legado.ops.UiPrefsStore
import io.legado.port.LogLevel
import io.legado.port.logSystem
import io.legado.rules.RuleExecutionException
import io.legado.rules.RuleRunner
import io.legado.source.ExternalBrowserLogin
import io.legado.source.SourceDebugger
import io.legado.source.WebViewProxy
import io.legado.subscription.SubscriptionService
import io.legado.tts.EdgeTtsService
import io.legado.tts.TtsSessionService
import io.legado.http.system.systemRoutes
import java.nio.file.Path
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.Json

/**
 * HTTP 路由装配点：这里只留各业务组的挂载调用。
 * 各组处理器住在同包 `<组名>Routes.kt`（0.8.2 结构重排拆出，文本逐字未动），
 * 挂载顺序与拆前一致；组内静态路径互不冲突，字面段先于参数段的优先级（如
 * `PUT /sources/order` 在 `route("/sources/{id}")` 之前）在组文件内部原样保留。
 * 系统域端点（`/catalog` `/server` `/logs` `/diagnostics` `/about` `/changelog`）已拆至
 * `http/system/SystemRoutes.kt`，此处仅做装配。
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
    // 界面偏好（壁纸 / 阅读设置 / 免责声明确认）落在数据目录，换端口不丢 ——
    // 它们原先在 localStorage，而 localStorage 按 origin 隔离，改端口等于换了个站点。
    val uiPrefs = UiPrefsStore(localBooksDirectory.resolveSibling(UiPrefsStore.FILE_NAME))
    // 真浏览器登录：profile 放在数据目录下（与 local_books 同级），登录态跨次启动保留。
    val externalLogin = ExternalBrowserLogin(database, localBooksDirectory.resolveSibling("external-browser-profile"))
    val debugger = SourceDebugger(runner)
    route("/api") {
        // 系统域：目录 / 服务自身 / 日志 / 诊断 / 关于 / 更新日志
        systemRoutes(database, homeDirectory, currentHost, currentPort)
        sourcesRoutes(database, runner, webView, externalLogin, debugger)
        searchRoutes(database, runner)
        subscriptionsRoutes(database, subscriptions)
        backupRoutes(database, backupKeep)
        rssRoutes(database, runner)
        readingRoutes(database, runner)
        replaceRulesRoutes(database, runner)
        shelfRoutes(database, bookCache, coverCache, localBooksDirectory)
        tocRulesRoutes(database, backupKeep, localBooksDirectory)
        prefsRoutes(uiPrefs)
        mediaRoutes(database, coverCache, localBooksDirectory, runner)
        readerRoutes(database)
        ttsRoutes(edgeTts, ttsSessions)
        agentApiRoutes(database, homeDirectory, agentConnection, profileStore)
    }
}

internal suspend fun ApplicationCall.respondCatching(block: suspend () -> Any) {
    try { respond(block()) }
    catch (error: CancellationException) { throw error }
    catch (error: Exception) {
        val failure = classifyRuleFailure(error)
        // 未知异常要把堆栈留下来：响应体里只说一句话，排查靠日志。
        if (failure.leaked) {
            Unit.logSystem(
                "书源执行时出现未分类异常",
                mapOf("路径" to request.uri, "类型" to (error::class.simpleName ?: "未知")),
                error,
                LogLevel.ERROR,
            )
        }
        respond(failure.status, failure.body)
    }
}

/** 规则执行链的失败分类结果（[leaked] 表示原文只进日志，不进响应）。 */
internal data class RuleFailure(
    val status: HttpStatusCode,
    val body: ApiError,
    /** 这一条是否"内部细节已被替换成固定文案"——是就顺带记一条日志。 */
    val leaked: Boolean = false,
)

/**
 * 规则执行链的失败分类。
 *
 * 三类的修法完全不同，前端拿到的第一句话必须能区分：
 * - 地址被出站闸门拒绝（书源里写了内网/本机）：**说清是拒绝**，别让人去查网络；
 * - 书源执行失败（上游返回非 2xx / 规则取不到值）：`message` 是上游原话，照旧带出去；
 * - 其它未分类异常：`message` 可能是 SQL 片段或文件路径，**不往外吐** —— 固定文案 + 日志。
 *
 * 状态码维持 502：这条链上的地址来自书源配置，不是调用方这一轮的请求参数，
 * 说"客户端请求非法"会把人引到错的地方（对比：AI 连接那组是自己填的 baseUrl，才用 400）。
 */
internal fun classifyRuleFailure(error: Throwable): RuleFailure = when (error) {
    is NetworkSecurity.BlockedAddressException -> RuleFailure(
        HttpStatusCode.BadGateway,
        ApiError("source_execution_failed", "书源指向被拒绝的地址（内网或本机）：${error.message ?: "已拦截"}"),
    )
    is RuleExecutionException -> RuleFailure(
        HttpStatusCode.BadGateway,
        ApiError("source_execution_failed", error.message ?: "书源执行失败"),
    )
    else -> RuleFailure(
        HttpStatusCode.BadGateway,
        ApiError("source_execution_failed", "书源执行时服务内部出错，详情已写入日志"),
        leaked = true,
    )
}
