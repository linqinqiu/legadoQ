package io.legado.http

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import io.legado.data.Database
import io.legado.data.deleteRssSource
import io.legado.data.getRssSource
import io.legado.data.importRssSources
import io.legado.data.listRssSources
import io.legado.data.rssSourceIsEnabled
import io.legado.data.setRssSourceEnabled
import io.legado.model.ApiError
import io.legado.model.ImportRequest
import io.legado.model.RssArticlesRequest
import io.legado.model.RssContentRequest
import io.legado.model.RssSourceEnabledRequest
import io.legado.rules.RuleRunner
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * 从 `Routes.kt` 拆出（0.8.2 结构重排）：RSS 订阅源与文章读取。
 * 处理器文本逐字未动；本函数由 `Routes.kt` 的 `apiRoutes` 挂在 `route("/api")` 内，顺序与拆前一致。
 * 契约核对：`web/test/ApiCatalog.test.ts` 把本目录全部 `*Routes.kt` 视为挂在 `/api` 之下逐条比对。
 */
fun Route.rssRoutes(
    database: Database,
    runner: RuleRunner,
) {
        /**
         * RSS 订阅（手机「订阅」页那一栏）。与上面的 `/subscriptions` 是两回事：
         * 这里是**阅读 RSS 源**（上游 `RssSource`），`/subscriptions` 是**书源订阅地址**（上游 `RuleSub`）。
         */
        route("/rss") {
            get("/sources") {
                // 这里是 queryParameters：`call.parameters["q"]` 读的是路径参数，
                // 永远为 null，等于服务端筛选从来没生效过。
                call.respond(database.listRssSources(call.request.queryParameters["q"]))
            }
            post("/sources") {
                if (!call.requireSameOriginWrite()) return@post
                val response = database.importRssSources(call.receive<ImportRequest>().sources)
                call.application.log.info("rss source import completed: imported={}, updated={}", response.imported, response.updated)
                call.respond(response)
            }
            post("/sources/enabled") {
                if (!call.requireSameOriginWrite()) return@post
                val request = call.receive<RssSourceEnabledRequest>()
                if (database.setRssSourceEnabled(request.sourceUrl, request.enabled)) call.respond(HttpStatusCode.NoContent)
                else call.respond(HttpStatusCode.NotFound, ApiError("not_found", "订阅源不存在"))
            }
            delete("/sources") {
                if (!call.requireSameOriginWrite()) return@delete
                val sourceUrl = call.parameters["sourceUrl"]
                    ?: return@delete call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "缺少 sourceUrl"))
                if (database.deleteRssSource(sourceUrl)) call.respond(HttpStatusCode.NoContent)
                else call.respond(HttpStatusCode.NotFound, ApiError("not_found", "订阅源不存在"))
            }
            get("/tabs") {
                val sourceUrl = call.parameters["sourceUrl"]
                    ?: return@get call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "缺少 sourceUrl"))
                val payload = database.getRssSource(sourceUrl)
                    ?: return@get call.respond(HttpStatusCode.NotFound, ApiError("not_found", "订阅源不存在"))
                if (!database.rssSourceIsEnabled(sourceUrl)) {
                    call.respond(HttpStatusCode.Conflict, ApiError("rss_source_disabled", "该订阅源已停用，先在列表里点「已停用」把它启用"))
                    return@get
                }
                call.respondCatching { withContext(Dispatchers.IO) { runner.rssTabs(payload) } }
            }
            post("/articles") {
                if (!call.requireSameOriginWrite()) return@post
                val request = call.receive<RssArticlesRequest>()
                val payload = database.getRssSource(request.sourceUrl)
                    ?: return@post call.respond(HttpStatusCode.NotFound, ApiError("not_found", "订阅源不存在"))
                if (!database.rssSourceIsEnabled(request.sourceUrl)) {
                    call.respond(HttpStatusCode.Conflict, ApiError("rss_source_disabled", "该订阅源已停用，先在列表里点「已停用」把它启用"))
                    return@post
                }
                try {
                    call.respond(withContext(Dispatchers.IO) { runner.rssArticles(payload, request.url, request.page.coerceAtLeast(1)) })
                } catch (error: Throwable) {
                    if (error is CancellationException) throw error
                    call.respond(HttpStatusCode.BadGateway, ApiError("rss_articles_failed", error.message ?: "订阅列表解析失败"))
                }
            }
            post("/content") {
                if (!call.requireSameOriginWrite()) return@post
                val request = call.receive<RssContentRequest>()
                val payload = database.getRssSource(request.sourceUrl)
                    ?: return@post call.respond(HttpStatusCode.NotFound, ApiError("not_found", "订阅源不存在"))
                call.respondCatching { withContext(Dispatchers.IO) { runner.rssContent(payload, request.link) } }
            }
        }
}


