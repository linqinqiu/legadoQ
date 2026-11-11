package io.legado.rules

import io.legado.content.LooseJson
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.net.URI
import java.net.URLEncoder

/**
 * 规则引擎里与「URL / 请求头 / JSON 文本」相关的**纯工具函数**：无状态、无副作用。
 * 2026-11-11 从 `RuleRunner` 抽出（同包顶层 `internal`），既给 RuleRunner 复用，也便于单独测试。
 */

/** 把 kotlinx JsonElement 转成普通 Java 结构，使 JsonPath 取值与 JS 属性访问都能正常工作。 */
internal fun JsonElement.toPlainJava(): Any? = when (this) {
    is JsonObject -> LinkedHashMap<String, Any?>().also { map -> entries.forEach { (key, value) -> map[key] = value.toPlainJava() } }
    is JsonArray -> map { it.toPlainJava() }
    is JsonPrimitive -> if (isString) content
    else content.toBooleanStrictOrNull() ?: content.toLongOrNull() ?: content.toDoubleOrNull() ?: content
    JsonNull -> null
}

/** 把页面 JSON 里的转义斜杠 `\/` 还原成 `/`（真实 URL 里不会出现反斜杠）。 */
internal fun unescapeUrlSlashes(text: String): String = text.replace("\\/", "/")

/**
 * 正文规则取回的就**是一条链接**（媒体直链，或 `xxx.php?vid=…` 这种没有媒体后缀的播放页地址）。
 * `content()` 的「段落兜底」要先让路 —— 这种正文天生只有一行、不足 500 字，
 * 不认的话会被整页 `<p>`（页脚、推荐位）覆盖掉。
 */
internal fun String.isBareUrlLine(): Boolean {
    val trimmed = unescapeUrlSlashes(trim())
    return '\n' !in trimmed &&
        (trimmed.startsWith("http://", ignoreCase = true) || trimmed.startsWith("https://", ignoreCase = true))
}

internal fun jsonOption(text: String): JsonObject? =
    runCatching { Json.parseToJsonElement(text.trim()) as? JsonObject }.getOrNull()

/** `headers` 既可能是对象，也可能是一整串 JSON（甚至单引号写的），上游两种都接。 */
internal fun headerMapOf(element: JsonElement?): Map<String, String> {
    val source = when (element) {
        is JsonObject -> element
        is JsonPrimitive -> element.contentOrNull?.let { jsonOption(it) ?: jsonOption(LooseJson.toStrict(it) ?: return emptyMap()) }
        else -> null
    } ?: return emptyMap()
    return source.entries.associate { (key, value) ->
        key to when (value) {
            is JsonPrimitive -> value.content
            else -> value.toString()
        }
    }
}

internal fun parseUri(url: String): URI {
    val trimmed = url.trim()
    if (!trimmed.startsWith("http://", ignoreCase = true) && !trimmed.startsWith("https://", ignoreCase = true)) {
        throw RuleExecutionException("URL 格式无效或包含未解析变量: $url")
    }
    // Legado 书源普遍把未转义的 JSON（含 { } " 等）直接拼进 query，Android 端 OkHttp 会自动编码，
    // 而 java.net.URI 严格按 RFC 3986 拒绝。这里先按原样解析，失败再对非法字符做百分号编码。
    runCatching { URI(trimmed) }.getOrNull()?.let { return it }
    val encoded = encodeIllegalUrlChars(trimmed)
    return runCatching { URI(encoded) }.getOrElse {
        throw RuleExecutionException("URL 解析失败: $url (${it.message})")
    }
}

/** 对 URL 中 RFC 不允许的字面字符做百分号编码。 */
internal fun encodeIllegalUrlChars(url: String): String {
    val builder = StringBuilder(url.length + 16)
    for (ch in url) {
        when {
            ch == ' ' -> builder.append("%20")
            ch.code > 127 || ch in "\"<>{}|\\^`" -> builder.append(URLEncoder.encode(ch.toString(), Charsets.UTF_8))
            else -> builder.append(ch)
        }
    }
    return builder.toString()
}

/** 解析 `data:` URL 的 payload（可选 base64）。聚合类书源用它把参数从搜索一路带到详情/目录/正文。 */
internal fun dataUrlPayload(url: String): String? {
    val value = url.trim()
    if (!value.startsWith("data:", ignoreCase = true)) return null
    val comma = value.indexOf(',')
    if (comma < 0) return null
    val meta = value.substring(5, comma)
    var payload = value.substring(comma + 1)
    // 末尾可能跟一个类型标记（如 ,{"type":"qingtian2"}），取最后一个逗号之前的部分
    val typeIndex = payload.lastIndexOf(',')
    if (typeIndex > 0 && payload.substring(typeIndex + 1).trimStart().startsWith("{")) {
        payload = payload.substring(0, typeIndex)
    }
    return if (meta.contains("base64", ignoreCase = true)) {
        runCatching { String(java.util.Base64.getDecoder().decode(payload.trim()), Charsets.UTF_8) }
            .getOrElse { payload }
    } else {
        runCatching { java.net.URLDecoder.decode(payload, Charsets.UTF_8) }.getOrDefault(payload)
    }
}

/** 正文整段是直链时按这些后缀认媒体（音频 / 视频 / 播流）。`.m3u8` 与 `.ts` 是 HLS。 */
private val MEDIA_URL_SUFFIXES = setOf(".mp3", ".m4a", ".aac", ".ogg", ".wav", ".flac", ".mp4", ".m3u8", ".ts", ".webm", ".mkv", ".mov", ".flv", ".avi")

/**
 * 整段正文就是一条媒体直链时，这一章的"正文"是那个地址，不是那行字。
 * 判得保守：去空白后只剩一行、以 http(s) 开头、路径落在 [MEDIA_URL_SUFFIXES] 里。
 */
internal fun sniffMediaUrl(text: String, sourceType: Int = 0): String? {
    val trimmed = unescapeUrlSlashes(text.trim())
    if (trimmed.isEmpty() || trimmed.length > 600) return null
    fun isMedia(url: String): Boolean {
        if (!url.startsWith("http://", ignoreCase = true) && !url.startsWith("https://", ignoreCase = true)) return false
        val path = runCatching { URI(url).path }.getOrNull()?.lowercase().orEmpty()
        return path.isNotEmpty() && MEDIA_URL_SUFFIXES.any { path.endsWith(it) }
    }
    // 整段就是一条地址：原有行为，所有类型都认。
    if ('\n' !in trimmed && ' ' !in trimmed && !trimmed.contains(",{") && isMedia(trimmed)) return trimmed
    // 多行短文本里恰好一条媒体直链：只在媒体类型（音频 / 文件 / 视频）上做。
    if (sourceType != 0 && sourceType != 2) {
        val urls = Regex("""https?://[^\s"'<>]+""", RegexOption.IGNORE_CASE).findAll(trimmed).map { it.value }.toList()
        if (urls.size == 1 && isMedia(urls[0])) return urls[0]
    }
    return null
}

/** `<…>` 翻页段（非贪婪，一段一段来）：见 [selectPageSegments]。 */
private val PAGE_SEGMENT_PATTERN = Regex("<(.*?)>")

internal fun selectPageSegments(url: String, page: Int): String =
    PAGE_SEGMENT_PATTERN.replace(url) { match ->
        val options = match.groupValues[1].split(",")
        (options.getOrNull(page - 1) ?: options.last()).trim { it <= ' ' }
    }

/** Rhino 里所有数字都是 double，`{{(page-1)*20}}` 会求值成 `0.0`；网址里必须是 `0`。 */
private val JS_NUMBER_FRACTION = Regex("""-?\d+\.0+""")

internal fun trimJsNumberFraction(text: String): String =
    if (JS_NUMBER_FRACTION.matches(text)) text.substringBefore('.') else text
