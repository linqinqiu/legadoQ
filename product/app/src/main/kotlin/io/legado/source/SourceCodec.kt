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
    /**
     * 这条源有没有任何可执行的规则（搜索/发现/详情/目录/正文里至少一个非空字段）。
     *
     * 兄弟包的备份里真实存在"只剩元数据"的条目（本机库 5,600 条里 582 条）：
     * 导入不报错、列表里也看得见，但一步都跑不出来。存成列，列表才筛得出来。
     */
    val hasRules: Boolean = true,
    val json: String,
)

/** 判"有没有规则"时认的五个对象。 */
internal val SOURCE_RULE_KEYS = listOf("ruleSearch", "ruleExplore", "ruleBookInfo", "ruleToc", "ruleContent")

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
        val warnings = runCatching {
            val obj = json.parseToJsonElement(text.trim().removePrefix("﻿")) as? JsonObject
            obj?.let { scanIncompatibilities(it) }.orEmpty()
        }.getOrDefault(emptyList())
        ValidateResponse(true, emptyList(), warnings)
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
            hasRules = hasRules(objectValue),
            json = normalizedJson,
        )
    }

    /**
     * 这条源有没有任何可执行的规则。
     *
     * 判据是"五个规则对象里至少有一个非空字段"，不看对象在不在：
     * 只剩元数据的条目通常连键都没有，也有的是 `{}` 或全空串。
     * 前端编辑器里那条提示、列表里的筛选、导入回填都用这一条 —— 不要另写一套。
     *
     * 解析不了（JSON 坏了）按"有规则"处理：那是另一种错误，由 JSON 报错条去说，
     * 别在这里把它也算成"缺规则"。
     */
    fun hasRules(text: String): Boolean = try {
        (json.parseToJsonElement(text) as? JsonObject)?.let(::hasRules) ?: true
    } catch (_: Exception) {
        true
    }

    fun hasRules(obj: JsonObject): Boolean = SOURCE_RULE_KEYS.any { key ->
        (obj[key] as? JsonObject)?.let { rule ->
            rule.keys.any { field -> rule.string(field)?.isNotBlank() == true }
        } == true
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

    /**
     * 静态扫「已知不兼容写法」，产出给人看的提示（不执行、不改校验的 valid 结论）。
     * 依据 `docs/compatibility.md` §4/§4.1/§6：这几类都是「存得下、导入不报错、但服务端跑不出」的写法，
     * 静默会让人以为跑不出是本服务的 bug，所以主动说出来。
     * 注：上游式分页占位 `<页1,页2,…>` 已对齐上游语义（S0/C-02，2026-11-12 收口），不再是兼容缺口，
     * 原来那条"本服务端不解析它"的告警已撤销——语义判据见 PagingSegmentTest / PagingDetectionTest。
     */
    private fun scanIncompatibilities(obj: JsonObject): List<String> {
        val warnings = mutableListOf<String>()

        val review = obj["ruleReview"] as? JsonObject
        val hasReviewRule = review != null && review.keys.any { key ->
            key != "enabled" && review.string(key)?.isNotBlank() == true
        }
        if (hasReviewRule) {
            warnings += "检测到段评规则（ruleReview）：详情列表服务端已只读支持（需配 detailListRule，经 API 可取；阅读器浮层接入中）；统计徽章、子评论与发帖/点赞/删除等写操作服务端不执行。"
        }

        if (obj.string("searchUrl").isNullOrBlank() && obj.string("exploreUrl").isNullOrBlank()) {
            warnings += "顶层既没有 searchUrl 也没有 exploreUrl：这个源没有可用入口，只能靠逐本书链接打开。"
        }

        /*
         * 一条规则都没有：兄弟包的备份里确实存在这种"只剩元数据"的条目
         * （本机库实测 5,600 条里 582 条）。它们导入不报错、列表里也看得见，
         * 但搜索 / 详情 / 目录 / 正文一步都跑不出来 —— 不说出来，用户只会以为
         * 是本服务端解析不了。判据与 [hasRules] 同一份。
         */
        if (!hasRules(obj)) {
            warnings += "这条书源没有任何规则字段（ruleSearch / ruleToc / ruleContent 都是空的）：搜不到书，也取不到目录与正文。" +
                "常见原因是导入的备份里这一条只剩了元数据，需要重新导入完整的那一份。"
        }

        if (obj.boolean("webView") == true) {
            warnings += "标记了 webView：服务端没有 Android WebView，需要真浏览器过 JS 挑战/风控的站点在这里跑不通（体检会记为 needs_webview，不算坏）。"
        }

        return warnings
    }

    private const val MAX_SOURCE_BYTES = 1024 * 1024
}
