package io.legado.http

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import io.legado.AppContainer
import io.legado.model.ApiError
import io.legado.ops.NetworkSecurity
import io.legado.port.LogLevel
import io.legado.port.logSystem
import io.legado.rules.RuleExecutionException
import io.legado.http.system.systemRoutes
import kotlinx.coroutines.CancellationException

/**
 * HTTP 路由装配点：这里只留各业务组的挂载调用。
 * 各组处理器住在同包 `<组名>Routes.kt`（0.8.2 结构重排拆出，文本逐字未动），
 * 挂载顺序与拆前一致；组内静态路径互不冲突，字面段先于参数段的优先级（如
 * `PUT /sources/order` 在 `route("/sources/{id}")` 之前）在组文件内部原样保留。
 * 系统域端点（`/catalog` `/server` `/logs` `/diagnostics` `/about` `/changelog`）已拆至
 * `http/system/SystemRoutes.kt`，此处仅做装配。
 * 机器可读契约的双向核对见 `web/test/ApiCatalog.test.ts`（扫 http/ 整目录）。
 */
fun Route.apiRoutes(container: AppContainer) {
    route("/api") {
        systemRoutes(
            container.database,
            container.config.homeDirectory,
            container.config.host,
            container.config.port,
        )
        sourcesRoutes(
            container.database,
            container.runner,
            container.webView,
            container.externalLogin,
            container.debugger,
        )
        searchRoutes(container.database, container.runner)
        subscriptionsRoutes(container.database, container.subscriptions)
        backupRoutes(container.database, container.backupKeep)
        rssRoutes(container.database, container.runner)
        readingRoutes(container.database, container.runner)
        replaceRulesRoutes(container.database, container.runner)
        shelfRoutes(
            container.database,
            container.bookCache,
            container.coverCache,
            container.config.localBooksDirectory,
        )
        tocRulesRoutes(container.database, container.backupKeep, container.config.localBooksDirectory)
        prefsRoutes(container.uiPrefs)
        mediaRoutes(
            container.database,
            container.coverCache,
            container.config.localBooksDirectory,
            container.runner,
        )
        readerRoutes(container.database)
        ttsRoutes(container.edgeTts, container.ttsSessions)
        feedbackRoutes(container.feedbackService)
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
