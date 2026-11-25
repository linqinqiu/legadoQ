package io.legado.feedback

import io.legado.BuildInfo
import io.legado.model.FEEDBACK_TOKEN_HEADER
import io.legado.model.FeedbackRequest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** 结果的三态：配置缺失 / 成功 / 上游失败。路由据此映射成 409 / 200 / 502。 */
sealed class SubmitOutcome {
    data object NotConfigured : SubmitOutcome()
    data class Ok(val status: Int) : SubmitOutcome()
    data class Failed(val status: Int) : SubmitOutcome()
    /** 同一 token 短时间内提交过多 —— 路由映射成 429，不上游。 */
    data object RateLimited : SubmitOutcome()
}

sealed class MineOutcome {
    data object NotConfigured : MineOutcome()
    data class Ok(val body: String) : MineOutcome()
    data class Failed(val status: Int) : MineOutcome()
    data object InvalidToken : MineOutcome()
}

/**
 * 反馈中转的编排：本地校验 → 拼 Supabase REST 请求 → 调出站 →  interpretation。
 *
 * 设计要点（与用户方案一致）：
 *  - POST 带 `Prefer: return=minimal`：让 PostgREST 只 INSERT 不回查，2xx 就是成功确定信号
 *    （RLS 只开 insert 没开 select，回查会触发 PGRST116 让客户端误判失败）。
 *  - app_version 只发构建版本号；metadata 恒为空对象；不发 ip / user_agent / device_id / email。
 *  - GET /mine 把前端给的 token hash 作为 `x-feedback-token` 头透传，由 Supabase RLS 逐行匹配，
 *    服务端自己不存任何用户索引。
 */
class FeedbackService(
    private val baseUrl: String?,
    private val anonKey: String?,
    private val http: FeedbackHttp = supabaseHttp(),
    private val json: Json = Json { ignoreUnknownKeys = true },
    private val limiter: FeedbackLimiter = FeedbackLimiter(),
) {
    private val configured: Boolean get() = !baseUrl.isNullOrBlank() && !anonKey.isNullOrBlank()
    private val restUrl: String get() = baseUrl!!.trimEnd('/') + "/rest/v1/feedback"

    private fun authHeaders(): Map<String, String> = mapOf(
        "apikey" to anonKey!!,
        "Authorization" to "Bearer $anonKey",
        "Content-Type" to "application/json; charset=utf-8",
        "Accept" to "application/json",
    )

    fun submit(request: FeedbackRequest): SubmitOutcome {
        if (!configured) return SubmitOutcome.NotConfigured
        val category = request.category.lowercase()
        if (category !in setOf("bug", "feature", "general", "question")) return SubmitOutcome.Failed(400)
        val content = request.content.trim()
        if (content.isEmpty() || content.length > 2000) return SubmitOutcome.Failed(400)
        val contact = request.contact?.trim()?.takeIf { it.isNotEmpty() }
        if (contact != null && contact.length > 200) return SubmitOutcome.Failed(400)
        val tokenHash = request.tokenHash.trim()
        if (!TOKEN_HASH_REGEX.matches(tokenHash)) return SubmitOutcome.Failed(400)
        // 校验通过后才占额度：非法请求不该烧掉正常用户的配额，也不该记入窗口。
        if (!limiter.allow(tokenHash)) return SubmitOutcome.RateLimited

        val payload = buildJsonObject {
            put("app_id", "legadoQ")
            put("category", category)
            put("content", content)
            if (contact != null) put("contact", contact)
            put("app_version", BuildInfo.version.take(32))
            put("user_token_hash", tokenHash)
            put("metadata", buildJsonObject { })
        }
        val outcome = http.send(
            url = restUrl,
            method = "POST",
            headers = authHeaders() + ("Prefer" to "return=minimal"),
            body = json.encodeToString(payload),
        )
        return if (outcome.status in 200..299) SubmitOutcome.Ok(outcome.status)
        else SubmitOutcome.Failed(if (outcome.status == 0) 502 else outcome.status)
    }

    fun mine(tokenHash: String?): MineOutcome {
        if (!configured) return MineOutcome.NotConfigured
        if (tokenHash == null || !TOKEN_HASH_REGEX.matches(tokenHash.trim())) return MineOutcome.InvalidToken
        val outcome = http.send(
            url = "$restUrl?select=id,created_at,category,content&limit=20",
            method = "GET",
            headers = authHeaders() + (FEEDBACK_TOKEN_HEADER to tokenHash.trim()),
            body = null,
        )
        return if (outcome.status in 200..299) MineOutcome.Ok(outcome.body)
        else MineOutcome.Failed(if (outcome.status == 0) 502 else outcome.status)
    }

    companion object {
        /** 64 位小写十六进制 —— 与前端 SHA-256 输出的口径一致。 */
        private val TOKEN_HASH_REGEX = Regex("^[0-9a-f]{64}$")
    }
}
