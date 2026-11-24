package io.legado.model

import kotlinx.serialization.Serializable

@Serializable
data class ReplaceRule(
    val id: String = "",
    val name: String = "",
    val group: String? = null,
    val pattern: String = "",
    val replacement: String = "",
    val isRegex: Boolean = true,
    val scope: String? = null,
    val excludeScope: String? = null,
    val scopeTitle: Boolean = false,
    val scopeContent: Boolean = true,
    val isEnabled: Boolean = true,
    val order: Int = 0,
    val timeoutMillisecond: Long = 3000L,
    val createdAt: Long = 0L,
    val updatedAt: Long = 0L,
)

@Serializable
data class ReplaceRuleToggleRequest(
    val ids: List<String>,
    val enabled: Boolean,
)

@Serializable
data class ReplaceRuleImportRequest(
    val rules: List<ReplaceRule>? = null,
    val url: String? = null,
)

@Serializable
data class ReplaceRuleImportResponse(
    val imported: Int,
    val updated: Int,
    val skipped: Int,
    val total: Int,
)

@Serializable
data class ReplaceRulePreviewRequest(
    val text: String,
    val rule: ReplaceRule? = null,
    val bookName: String? = null,
    val sourceUrl: String? = null,
)

@Serializable
data class ReplaceRulePreviewResponse(
    val originalText: String,
    val cleanedText: String,
    val changed: Boolean,
    val appliedRules: List<String> = emptyList(),
)

@Serializable
data class BatchSourceRequest(
    val action: String, // "enable", "disable", "delete", "set_group"
    val ids: List<String>,
    val group: String? = null,
)

@Serializable
data class BatchSourceResponse(
    val ok: Boolean,
    val affected: Int,
    val action: String,
    val message: String? = null,
)

@Serializable
data class SourceHealthCheckRequest(
    val ids: List<String>? = null,
    val timeoutMs: Long = 5000L,
    /** 体检用的搜索关键词；书源自带 checkKeyWord 时优先用源自己的。 */
    val keyword: String? = null,
)

@Serializable
data class SourceHealthCheckItem(
    val id: String,
    val name: String,
    val ok: Boolean,
    val latencyMs: Long,
    val statusCode: Int = 0,
    /** valid · slow · empty · blocked · needs_login · needs_webview · unreachable · tls · broken · invalid */
    val statusCategory: String,
    val error: String? = null,
)

@Serializable
data class SourceHealthCheckResponse(
    val total: Int,
    val successCount: Int,
    val slowCount: Int,
    val failedCount: Int,
    val durationMs: Long,
    val results: List<SourceHealthCheckItem>,
)
