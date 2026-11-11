package io.legado.rules

import io.legado.ops.NetworkSecurity
import io.legado.port.logNetwork
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpRequest
import java.time.Duration

/**
 * 规则引擎里「请求构造 / 地址脚本 / 出站安全校验」这层从 `RuleRunner` 抽出（2026-11-11）。
 * 只搬**不涉及嵌套类型 `UrlOptions`/`Fetched`** 的纯函数，调用点仍是 `runner.xxx(...)`（同包）。
 * 判据：`RuleUrlScriptsTest`（地址 JS）、`LooseUrlOptionsTest`、`RuleHttpGuardTest`、`GoldenRuleTest`。
 */

/** 单跳超时上限；`capToDeadline` 与 `fetchDetailedImpl` 共用。 */
internal const val PER_HOP_TIMEOUT_MS = 20_000L

/** 地址里剩下的 `{{…}}` 当 JS 表达式求值。 */
internal val URL_VARIABLE_PATTERN = Regex("\\{\\{(.+?)}}")

/** 与上游 `AppPattern.JS_PATTERN` 一字不差：`<js>…</js>`，或 `@js:` 到串尾。 */
internal val URL_JS_PATTERN = Regex("<js>([\\w\\W]*?)</js>|@js:([\\w\\W]*)", RegexOption.IGNORE_CASE)

/** 书源自己的 `header` 字段（`{"User-Agent":"...","Referer":"..."}`）。凭据不在这里合。 */
internal fun RuleRunner.parseSourceHeaders(source: JsonObject): Map<String, String> {
    val headers = mutableMapOf<String, String>()
    val headerStr = source.string("header")?.trim()
    if (!headerStr.isNullOrBlank()) {
        runCatching {
            val elem = Json.parseToJsonElement(headerStr)
            if (elem is JsonObject) {
                elem.entries.filter { it.value is JsonPrimitive }.forEach {
                    headers[it.key] = (it.value as JsonPrimitive).contentOrNull ?: ""
                }
            }
        }
    }
    return headers
}

/**
 * 网络日志的统一上下文：**域名放在最前**。
 * `host` 供合并键与肉眼定位，`url` 截前 120 字符。
 */
internal fun RuleRunner.networkContext(url: String, sourceId: String?): Map<String, String> = mapOf(
    "host" to (runCatching { java.net.URI(url.trim()).host }.getOrNull() ?: "未知"),
    "sourceId" to (sourceId ?: ""),
    "url" to url.take(120),
)

/**
 * 把一次请求的超时压到「剩余预算」以内，预算耗尽则直接中止。
 * `deadlineMs == null` 时原样返回，一个字段都不碰。
 */
internal fun RuleRunner.capToDeadline(
    request: HttpRequest,
    deadlineMs: Long?,
    url: String,
    sourceId: String?,
): HttpRequest {
    if (deadlineMs == null) return request
    val remaining = deadlineMs - System.currentTimeMillis()
    if (remaining <= 0L) {
        logNetwork("书源 JS 执行时间已用尽，中止网络请求", networkContext(url, sourceId))
        throw RuleExecutionException("书源 JS 执行时间已用尽，已中止本次网络请求")
    }
    // `HttpRequest` 是不可变的，改超时只能重建；headerFilter 恒 true 表示原样保留全部请求头。
    return HttpRequest.newBuilder(request, java.util.function.BiPredicate<String, String> { _, _ -> true })
        .timeout(Duration.ofMillis(remaining.coerceAtMost(PER_HOP_TIMEOUT_MS)))
        .build()
}

internal fun RuleRunner.validateTarget(uri: URI) {
    try {
        NetworkSecurity.resolveAndValidateSafeHttpTarget(uri, "站点")
    } catch (e: IllegalArgumentException) {
        logNetwork("拒绝访问不安全地址", networkContext(uri.toString(), null) + mapOf("原因" to (e.message ?: "内网或本机地址")))
        throw RuleExecutionException(e.message ?: "拒绝访问内网或本机地址")
    }
}

/**
 * 地址规则里的整段 JS（上游 `AnalyzeUrl.analyzeJs` / `AppPattern.JS_PATTERN`）：
 * `<js>…</js>` 或 `@js:`（一直吃到串尾）。每段的返回值成为新的 `result`，交给下一段。
 */
internal fun RuleRunner.applyUrlScripts(rawUrl: String, keyword: String?, page: Int?, sourceUrl: String): String {
    if (!rawUrl.contains("@js:") && !rawUrl.contains("<js>", ignoreCase = true)) return rawUrl
    val matches = URL_JS_PATTERN.findAll(rawUrl).toList()
    if (matches.isEmpty()) return rawUrl
    var start = 0
    var result = rawUrl
    for (match in matches) {
        if (match.range.first > start) {
            val prefix = rawUrl.substring(start, match.range.first).trim()
            if (prefix.isNotEmpty()) result = prefix.replace("@result", result)
        }
        val code = match.groupValues[2].ifEmpty { match.groupValues[1] }
        jsSandbox.clearLastError()
        val value = jsSandbox.eval(
            code,
            mapOf(
                "result" to result,
                "key" to (keyword ?: ""),
                "keyword" to (keyword ?: ""),
                "page" to page,
                "baseUrl" to sourceUrl,
                "sourceId" to sourceUrl,
            ),
        ) ?: throw RuleExecutionException("URL 规则里的脚本执行失败：${jsSandbox.lastError ?: "脚本没有返回值"}")
        result = value
        start = match.range.last + 1
    }
    if (rawUrl.length > start) {
        val tail = rawUrl.substring(start).trim()
        if (tail.isNotEmpty()) result = tail.replace("@result", result)
    }
    return result
}

/**
 * 把书源地址里的占位写法换成真实值。`page` 只在调用方真给了页码时才传。
 * [expandScripts] 为 false 表示调用方已先执行过 URL 级 JS，避免同一段脚本跑两遍。
 */
internal fun RuleRunner.renderUrl(
    template: String,
    keyword: String,
    sourceUrl: String,
    page: Int? = null,
    expandScripts: Boolean = true,
): String {
    val expanded = if (expandScripts) applyUrlScripts(template, keyword, page, sourceUrl) else template
    val literals = expanded
        .replace("{{key}}", URLEncoder.encode(keyword, Charsets.UTF_8))
        .replace("{{keyword}}", URLEncoder.encode(keyword, Charsets.UTF_8))
        .replace("{{page}}", (page ?: 1).toString())
        .replace("<key>", URLEncoder.encode(keyword, Charsets.UTF_8))
        .replace("{{source.key}}", URLEncoder.encode(keyword, Charsets.UTF_8))
        .replace("{{source.bookSourceUrl}}", sourceUrl)
        .replace("{{cookie.removeCookie(source.key)}}", "")
    // Legado 把地址里剩下的 `{{…}}` 当 JS 表达式求值（`{{(page-1)*20}}`、`{{java.getDict(…)}}` 等）。
    val context = jsSandbox.threadContext.get()
    val evaluated = URL_VARIABLE_PATTERN.replace(literals) { match ->
        context?.lastError = null
        val value = runCatching {
            jsSandbox.eval(match.groupValues[1], mapOf(
                "key" to keyword,
                "keyword" to keyword,
                "page" to (page ?: 1),
                "baseUrl" to sourceUrl,
                "sourceId" to sourceUrl,
            ))
        }.getOrNull()
        when {
            context?.lastError != null -> match.value
            value == null || value == "undefined" || value == "null" -> ""
            else -> trimJsNumberFraction(value.trim())
        }
    }
    return if (page == null) evaluated else selectPageSegments(evaluated, page)
}
