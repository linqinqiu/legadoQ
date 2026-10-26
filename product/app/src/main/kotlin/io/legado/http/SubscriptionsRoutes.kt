package io.legado.http

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import io.legado.data.Database
import io.legado.data.deleteSubscription
import io.legado.data.listSubscriptions
import io.legado.data.saveSubscription
import io.legado.model.ApiError
import io.legado.model.SubscriptionWriteRequest
import io.legado.subscription.SubscriptionService
import java.net.URI

/**
 * 从 `Routes.kt` 拆出（0.8.2 结构重排）：书源订阅地址增删改与立即更新。
 * 处理器文本逐字未动；本函数由 `Routes.kt` 的 `apiRoutes` 挂在 `route("/api")` 内，顺序与拆前一致。
 * 契约核对：`web/test/ApiCatalog.test.ts` 把本目录全部 `*Routes.kt` 视为挂在 `/api` 之下逐条比对。
 */
fun Route.subscriptionsRoutes(
    database: Database,
    subscriptions: SubscriptionService,
) {
        get("/subscriptions") {
            call.respond(database.listSubscriptions())
        }
        post("/subscriptions") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<SubscriptionWriteRequest>()
            try {
                validateSubscriptionUrl(request.url)
                call.respond(database.saveSubscription(request))
            } catch (error: IllegalArgumentException) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_subscription", error.message ?: "订阅地址无效"))
            }
        }
        delete("/subscriptions/{id}") {
            if (!call.requireSameOriginWrite()) return@delete
            val id = call.parameters["id"]?.toLongOrNull() ?: return@delete call.respond(HttpStatusCode.BadRequest, ApiError("invalid_subscription", "订阅标识无效"))
            if (database.deleteSubscription(id)) call.respond(HttpStatusCode.NoContent) else call.respond(HttpStatusCode.NotFound, ApiError("not_found", "订阅不存在"))
        }
        post("/subscriptions/{id}/update") {
            if (!call.requireSameOriginWrite()) return@post
            val id = call.parameters["id"]?.toLongOrNull() ?: return@post call.respond(HttpStatusCode.BadRequest, ApiError("invalid_subscription", "订阅标识无效"))
            try { call.respond(subscriptions.updateOne(id)) }
            catch (_: NoSuchElementException) { call.respond(HttpStatusCode.NotFound, ApiError("not_found", "订阅不存在")) }
            catch (error: Throwable) { call.respond(HttpStatusCode.BadGateway, ApiError("subscription_update_failed", error.message ?: "订阅更新失败")) }
        }
        post("/subscriptions/update") {
            if (!call.requireSameOriginWrite()) return@post
            val results = subscriptions.updateAll()
            call.respond(mapOf("updated" to results.count { it.second.isSuccess }, "failed" to results.count { it.second.isFailure }))
        }
}

internal fun validateSubscriptionUrl(value: String) {
    val uri = runCatching { java.net.URI(value) }.getOrNull()
    require(uri?.scheme in setOf("http", "https") && !uri?.host.isNullOrBlank()) { "仅允许 HTTP(S) 订阅地址" }
    // 保存期就用与抓取期同一道 SSRF 闸门：内网/元数据地址当场拒掉，别等定时更新才失败
    NetworkSecurity.resolveAndValidateSafeHttpTarget(uri, "订阅")
}

