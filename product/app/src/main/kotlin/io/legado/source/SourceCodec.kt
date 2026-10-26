package io.legado.source

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import io.legado.model.ValidateResponse

data class ParsedSource(
    val id: String,
    val name: String,
    val url: String,
    val group: String?,
    val enabled: Boolean,
    val isJs: Boolean,
    val hasLogin: Boolean = false,
    val json: String,
)

/** [SourceCodec.parseRss] 的结果：摊平出列表页要用的字段，规则原文整体留在 [json] 里交给引擎。 */
data class ParsedRssSource(
    val sourceUrl: String,
    val name: String,
    val group: String?,
    val icon: String?,
    val enabled: Boolean,
    val hasListRule: Boolean,
    val json: String,
)

object SourceCodec {
    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        coerceInputValues = true
    }

    fun validate(text: String): ValidateResponse = try {
        parse(text)
        ValidateResponse(true, emptyList(), emptyList())
    } catch (error: IllegalArgumentException) {
        ValidateResponse(false, listOf(error.message ?: "JSON 无效"), emptyList())
    }

    fun parse(text: String): ParsedSource {
        val cleanText = text.trim().removePrefix("\uFEFF")
        require(cleanText.toByteArray().size <= MAX_SOURCE_BYTES) { "书源不能超过 1 MiB" }
        val objectValue = try { json.parseToJsonElement(cleanText) as? JsonObject } catch (_: Exception) { null }
            ?: throw IllegalArgumentException("书源必须是 JSON 对象")
        val rawUrl = (objectValue.string("bookSourceUrl")
            ?: objectValue.string("sourceUrl")
            ?: objectValue.string("url"))?.trim()
            ?: throw IllegalArgumentException("缺少 bookSourceUrl")
        require(rawUrl.isNotBlank()) { "bookSourceUrl 不能为空" }
        val fixedUrl = when {
            rawUrl.startsWith("//") -> "https:$rawUrl"
            else -> rawUrl
        }
        // Legado source URLs may carry annotations such as `https://host/##@group` or `https://host/#module`.
        // The server only needs the reachable origin; annotations are metadata used by the Android client.
        val url = normalizeSourceUrl(fixedUrl)
        val name = (objectValue.string("bookSourceName")
            ?: objectValue.string("sourceName")
            ?: objectValue.string("name"))
            ?.takeIf { it.isNotBlank() } ?: url
        val group = objectValue.string("bookSourceGroup")
            ?: objectValue.string("sourceGroup")
            ?: objectValue.string("group")
        val enabled = objectValue.boolean("enabled")
            ?: objectValue.boolean("enable")
            ?: true
        val normalizedMap = objectValue.toMutableMap()
        normalizedMap["bookSourceUrl"] = JsonPrimitive(url)
        normalizedMap["bookSourceName"] = JsonPrimitive(name)
        val normalizedJson = json.encodeToString(
            JsonElement.serializer(),
            JsonObject(normalizedMap),
        )
        val hasLogin = !objectValue.string("loginUi").isNullOrBlank() ||
            !objectValue.string("loginUrl").isNullOrBlank() ||
            !objectValue.string("loginCheckJs").isNullOrBlank()
        return ParsedSource(
            id = url,
            name = name,
            url = url,
            group = group,
            enabled = enabled,
            isJs = !objectValue.string("mainJs").isNullOrBlank(),
            hasLogin = hasLogin,
            json = normalizedJson,
        )
    }

    /** 对外复用：把书源标识（可带 `#` / `##` 注解）归一化为服务端使用的 sourceId（备份导入时对齐书架 origin）。 */
    fun normalizeSourceId(raw: String): String = normalizeSourceUrl(raw)

    /**
     * RSS 订阅源（手机「订阅」页那些源，上游 `data/entities/RssSource.kt`）。字段名与书源不同：
     * 名称是 `sourceName`、主键是 `sourceUrl`，正文规则 `ruleContent` 是**规则字符串**而不是书源那样的规则对象。
     * `sourceUrl` 原样保留，不剥 `#` 注解 —— 上游就是拿它直接当 baseUrl 发请求的。
     */
    fun parseRss(text: String): ParsedRssSource {
        val cleanText = text.trim().removePrefix("\uFEFF")
        require(cleanText.toByteArray().size <= MAX_SOURCE_BYTES) { "RSS 源不能超过 1 MiB" }
        val source = try { json.parseToJsonElement(cleanText) as? JsonObject } catch (_: Exception) { null }
            ?: throw IllegalArgumentException("RSS 源必须是 JSON 对象")
        val url = source.string("sourceUrl") ?: throw IllegalArgumentException("缺少 sourceUrl")
        require(url.isNotBlank()) { "sourceUrl 不能为空" }
        return ParsedRssSource(
            sourceUrl = if (url.startsWith("//")) "https:$url" else url,
            name = source.string("sourceName")?.takeIf { it.isNotBlank() } ?: url,
            group = source.string("sourceGroup")?.takeIf { it.isNotBlank() },
            icon = source.string("sourceIcon")?.takeIf { it.isNotBlank() },
            enabled = source.boolean("enabled") ?: true,
            hasListRule = !source.string("ruleArticles").isNullOrBlank(),
            json = cleanText,
        )
    }

    private fun normalizeSourceUrl(rawUrl: String): String = rawUrl
        .substringBefore("##")
        .substringBefore("#")
        .trim()
        .ifBlank { rawUrl }

    private fun JsonObject.string(key: String): String? {
        val primitive = get(key) as? JsonPrimitive ?: return null
        return primitive.contentOrNull?.trim()
    }

    private fun JsonObject.boolean(key: String): Boolean? {
        val primitive = get(key) as? JsonPrimitive ?: return null
        primitive.booleanOrNull?.let { return it }
        val content = primitive.contentOrNull?.trim()?.lowercase() ?: return null
        return when (content) {
            "true", "1" -> true
            "false", "0" -> false
            else -> null
        }
    }

    private const val MAX_SOURCE_BYTES = 1024 * 1024
}
