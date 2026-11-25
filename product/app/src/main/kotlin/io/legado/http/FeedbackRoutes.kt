package io.legado.http

import io.legado.AppConfig
import io.legado.feedback.FeedbackService
import io.legado.feedback.MineOutcome
import io.legado.feedback.SubmitOutcome
import io.legado.model.ApiError
import io.legado.model.FEEDBACK_TOKEN_HEADER
import io.legado.model.FeedbackRequest
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.response.respondText
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.route

/**
 * 意见收集中转（2026-11-24）。挂在 `route("/api")` 之下，所以这里从 `/feedback` 起算。
 *
 * 未配置 LEGADO_SUPABASE_URL/ANON_KEY 时两条端点都回 409 feedback_not_configured —— 界面据此
 * 继续走既有的 GitHub Issue 反馈入口，不假设每个用户都有项目方的 Supabase 凭据。
 * 服务端只转发、不在本地留存任何内容；日志只记状态码（见 S1 决策，不记 key/token/正文）。
 */
fun Route.feedbackRoutes(service: FeedbackService = FeedbackService(
    baseUrl = AppConfig.supabaseUrl,
    anonKey = AppConfig.supabaseAnonKey,
)) {
    route("/feedback") {
        post {
            if (!call.requireSameOriginWrite()) return@post
            val request = runCatching { call.receive<FeedbackRequest>() }.getOrElse {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 JSON"))
                return@post
            }
            when (val outcome = service.submit(request)) {
                SubmitOutcome.NotConfigured -> call.respond(
                    HttpStatusCode.Conflict,
                    ApiError("feedback_not_configured", "这台服务没有开启匿名反馈通道"),
                )
                is SubmitOutcome.Ok -> call.respond(mapOf("ok" to true))
                SubmitOutcome.RateLimited -> call.respond(
                    HttpStatusCode.TooManyRequests,
                    ApiError("feedback_rate_limited", "提交太频繁，请稍后再试"),
                )
                is SubmitOutcome.Failed -> {
                    val badRequest = outcome.status == 400
                    call.respond(
                        if (badRequest) HttpStatusCode.BadRequest else HttpStatusCode.BadGateway,
                        ApiError(
                            if (badRequest) "invalid_feedback" else "feedback_upstream_failed",
                            if (badRequest) "反馈内容不合法" else "提交失败，请稍后重试",
                        ),
                    )
                }
            }
        }

        get("/mine") {
            val tokenHash = call.request.headers[FEEDBACK_TOKEN_HEADER]
            when (val outcome = service.mine(tokenHash)) {
                MineOutcome.NotConfigured -> call.respond(
                    HttpStatusCode.Conflict,
                    ApiError("feedback_not_configured", "这台服务没有开启匿名反馈通道"),
                )
                MineOutcome.InvalidToken -> call.respond(
                    HttpStatusCode.BadRequest,
                    ApiError("invalid_feedback_token", "反馈令牌格式不对"),
                )
                is MineOutcome.Ok -> call.respondText(outcome.body, ContentType.Application.Json)
                is MineOutcome.Failed -> call.respond(
                    HttpStatusCode.BadGateway,
                    ApiError("feedback_upstream_failed", "查询失败，请稍后重试"),
                )
            }
        }
    }
}
