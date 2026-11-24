package io.legado.model

import kotlinx.serialization.Serializable

/**
 * 一个凭据桶的完整状态，给「凭据管理」界面如实交代：哪些来自库里、哪些只是本次会话、
 * 实际会发出哪几条、哪几条因为超过 4096 被丢下。
 *
 * 阶段 3.2 从 `data/CookieDao.kt` 归位：它是 `GET /api/cookies/buckets` 的响应体，
 * 不是 DAO 的内部结构。
 */
@Serializable
data class CookieBucketState(
    val domain: String,
    val persistentKeys: List<String> = emptyList(),
    val sessionKeys: List<String> = emptyList(),
    val sentKeys: List<String> = emptyList(),
    val droppedKeys: List<String> = emptyList(),
    /** 实际会发出去的那条 `Cookie` 头有多少字符。 */
    val headerChars: Int = 0,
    /** 只剩一条仍然超过 4096（照发，但要告诉用户）。 */
    val oversized: Boolean = false,
)

/**
 * `POST /api/cookies` 的请求体：这份凭据属于哪个站点 + 要写入的 Cookie 串。
 */
@Serializable
data class GlobalCookieWriteRequest(
    /** 站点地址或裸域名；按注册域归桶，与书源请求时 `getCookieForUrl` 的口径一致。 */
    val url: String = "",
    /** `k=v; k2=v2`（也接受 Cookie-Editor 的 JSON 导出，解析器与登录弹层共用）。 */
    val cookie: String = "",
)

/**
 * `POST /api/cookies` 的回包：写进哪个桶、合并后该桶有几个键。
 * 用带类型的模型而不是 `mapOf`：混合类型的 Map 在 kotlinx 序列化里没有可用序列化器。
 */
@Serializable
data class GlobalCookieWriteResponse(
    val ok: Boolean,
    val domain: String,
    val count: Int,
)

/** `GET /api/cookies/detail` 的回包：某个域的凭据原文（编辑前回填用）。 */
@Serializable
data class GlobalCookieDetailResponse(
    val domain: String,
    val cookie: String,
    /** 只是本次会话的键（重启即失效，不在库里）。 */
    val sessionKeys: List<String> = emptyList(),
    /** 因整条头超过 4096 字符而发不出去的键。 */
    val droppedKeys: List<String> = emptyList(),
)
