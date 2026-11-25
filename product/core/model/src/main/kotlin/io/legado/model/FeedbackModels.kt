package io.legado.model

import kotlinx.serialization.Serializable

/**
 * 意见收集的请求体（POST /api/feedback）。
 *
 * 字段刻意不采集任何能定位到用户的东西：没有 ip / user_agent / device_id / email。
 * [tokenHash] 是前端把本地随机 token 做 SHA-256 后的 64 位十六进制串 —— 换设备或清缓存就变，
 * 既不关联真实身份，又让用户能凭同一个 token 查回自己提交过的那几条（RLS 靠它放行 select）。
 * [contact] 是用户自愿填的回复方式，与身份无关。
 */
@Serializable
data class FeedbackRequest(
    val category: String = "general",
    val content: String,
    val contact: String? = null,
    val tokenHash: String,
)

/** 提交成功回包。不回显内容，也不回 Supabase 的插入行（RLS 只开 insert，见 RLS 脚本）。 */
@Serializable
data class FeedbackSubmitResult(val ok: Boolean = true)

/** 查询请求头名：前端用同一个 hash 调 GET /api/feedback/mine。 */
const val FEEDBACK_TOKEN_HEADER = "x-feedback-token"
