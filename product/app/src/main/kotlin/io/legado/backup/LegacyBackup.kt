package io.legado.backup

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * 老版本 Legado（V1.x / 「我的」时代）备份字段 → 现版本字段的迁移。
 *
 * 语义照上游 `help/storage/ImportOldData.kt` 的 `fromOldBookSource()` + `toNewRule()` +
 * `toNewUrl()/toNewUrls()` + `uaToHeader()`，不自行发明：老备份里书源是**扁平字段**
 * （`ruleSearchList`、`ruleBookContent`、`enable`、`serialNumber`、`httpUserAgent`…），
 * 现版本是**嵌套规则对象**（`ruleSearch.bookList`…），字段名和分隔符写法都不同。
 * 不做这层迁移，老备份导入进来就是一堆取不到值的空壳源。
 *
 * 规则文本的三处方言转换（上游注释原话：`#正则#替换内容 替换成 ##正则##替换内容`、
 * `| 替换成 ||`、`& 替换成 &&`）必须**跳过** `@CSS:`/`@XPath:`/`//`/`##`/`:` 开头与含
 * `@js:`/`<js>` 的规则，否则会把 JS 代码里的 `a || b`、URL 里的 `&` 改坏。
 */
object LegacyBackup {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    /** 老格式书源的判别键：出现任意一个、且没有现版本的 `ruleSearch`，就当作老源。 */
    private val OLD_MARKERS = setOf(
        "ruleSearchUrl", "ruleSearchList", "ruleFindUrl", "ruleBookContent",
        "ruleChapterList", "httpUserAgent", "serialNumber", "enable", "ruleBookInfoInit",
    )

    fun isOldSource(element: JsonElement): Boolean {
        val obj = element as? JsonObject ?: return false
        if (obj.containsKey("ruleSearch") || obj.containsKey("ruleContent")) return false
        return obj.keys.any { it in OLD_MARKERS }
    }

    /** 老源对象 → 现版本 JSON 文本。上游对 `bookSourceUrl` 缺失是直接抛「格式错误」的，这里同样丢弃。 */
    fun toNewSourceJson(element: JsonElement): String? {
        val old = element as? JsonObject ?: return null
        val url = old.str("bookSourceUrl") ?: return null

        val search = nested(old, mapOf(
            "bookList" to "ruleSearchList",
            "name" to "ruleSearchName",
            "author" to "ruleSearchAuthor",
            "intro" to "ruleSearchIntroduce",
            "kind" to "ruleSearchKind",
            "bookUrl" to "ruleSearchNoteUrl",
            "coverUrl" to "ruleSearchCoverUrl",
            "lastChapter" to "ruleSearchLastChapter",
            "checkKeyWord" to "ruleSearchCheckKeyword",
        ))
        val explore = nested(old, mapOf(
            "bookList" to "ruleFindList",
            "name" to "ruleFindName",
            "author" to "ruleFindAuthor",
            "intro" to "ruleFindIntroduce",
            "kind" to "ruleFindKind",
            "bookUrl" to "ruleFindNoteUrl",
            "coverUrl" to "ruleFindCoverUrl",
            "lastChapter" to "ruleFindLastChapter",
        ))
        val bookInfo = nested(old, mapOf(
            "init" to "ruleBookInfoInit",
            "name" to "ruleBookName",
            "author" to "ruleBookAuthor",
            "intro" to "ruleIntroduce",
            "kind" to "ruleBookKind",
            "coverUrl" to "ruleCoverUrl",
            "lastChapter" to "ruleBookLastChapter",
            "tocUrl" to "ruleChapterUrl",
        ))
        val toc = nested(old, mapOf(
            "chapterList" to "ruleChapterList",
            "chapterName" to "ruleChapterName",
            "chapterUrl" to "ruleContentUrl",
            "nextTocUrl" to "ruleChapterUrlNext",
        ))
        // 上游：正文规则以单个 `$` 开头（不是 `$.`）时要去掉那个 `$`
        var content = toNewRule(old.str("ruleBookContent"))
        if (content != null && content.startsWith("$") && !content.startsWith("$.")) content = content.substring(1)
        val contentRule = buildJsonObject {
            put("content", content ?: "")
            toNewRule(old.str("ruleBookContentReplace"))?.let { put("replaceRegex", it) }
            toNewRule(old.str("ruleContentUrlNext"))?.let { put("nextContentUrl", it) }
        }

        val exploreUrl = toNewUrls(old.str("ruleFindUrl"))
        val header = old.str("httpUserAgent")?.let { buildJsonObject { put("User-Agent", it) }.toString() }

        return buildJsonObject {
            put("bookSourceUrl", url)
            put("bookSourceName", old.str("bookSourceName") ?: "")
            old.str("bookSourceGroup")?.let { put("bookSourceGroup", it) }
            old.str("bookSourceComment")?.let { put("bookSourceComment", it) }
            old.str("loginUrl")?.let { put("loginUrl", it) }
            old.str("loginUi")?.let { put("loginUi", it) }
            old.str("loginCheckJs")?.let { put("loginCheckJs", it) }
            old.str("coverDecodeJs")?.let { put("coverDecodeJs", it) }
            old.str("ruleBookUrlPattern")?.let { put("bookUrlPattern", it) }
            header?.let { put("bookSourceHeader", it); put("header", it) }
            toNewUrl(old.str("ruleSearchUrl"))?.let { put("searchUrl", it) }
            exploreUrl?.let { put("exploreUrl", it) }
            put("enabled", old.bool("enable") ?: true)
            put("enabledExplore", !exploreUrl.isNullOrBlank())
            old.num("serialNumber")?.let { put("customOrder", it.toInt()) }
            if (old.str("bookSourceType") == "AUDIO") put("bookSourceType", 1)
            put("ruleSearch", search)
            put("ruleExplore", explore)
            put("ruleBookInfo", bookInfo)
            put("ruleToc", toc)
            put("ruleContent", contentRule)
        }.toString()
    }

    /** 老书架条目 → 现版本字段（上游 `fromOldBooks` 同一套映射）。 */
    fun isOldShelfEntry(element: JsonElement): Boolean {
        val obj = element as? JsonObject ?: return false
        return obj.containsKey("bookInfoBean") || obj.containsKey("noteUrl")
    }

    fun toNewShelfJson(element: JsonElement): String? {
        val old = element as? JsonObject ?: return null
        val book = (old["bookInfoBean"] as? JsonObject) ?: buildJsonObject { }
        val bookUrl = old.str("noteUrl") ?: return null
        return buildJsonObject {
            put("bookUrl", bookUrl)
            put("name", book.str("name") ?: "")
            put("author", book.str("author") ?: "")
            put("origin", old.str("tag") ?: "")
            put("originName", book.str("origin") ?: "")
            put("tocUrl", book.str("chapterUrl") ?: bookUrl)
            book.str("coverUrl")?.let { put("coverUrl", it) }
            old.str("customCoverPath")?.let { put("customCoverUrl", it) }
            book.str("introduce")?.let { put("intro", it) }
            book.str("kind")?.let { put("kind", it) }
            old.num("durChapter")?.let { put("durChapterIndex", it.toInt()) }
            old.num("durChapterPage")?.let { put("durChapterPos", it.toInt()) }
            old.str("durChapterName")?.let { put("durChapterTitle", it) }
            old.num("finalDate")?.let { put("durChapterTime", it) }
            old.num("newChapters")?.let { put("lastCheckCount", it.toInt()) }
            old.num("serialNumber")?.let { put("order", it.toInt()) }
            old.str("variable")?.let { put("variable", it) }
        }.toString()
    }

    /** 老替换规则文件（`myBookReplaceRule.json`）与现版本同构，只是 `isEnable` 拼写不同。 */
    fun normalizeReplaceRule(element: JsonElement): String? {
        val obj = element as? JsonObject ?: return null
        val pattern = obj.str("pattern") ?: return null
        val merged = buildJsonObject {
            for ((key, value) in obj) put(key, value)
            if (!obj.containsKey("isEnabled") && obj.containsKey("isEnable")) {
                put("isEnabled", obj["isEnable"]!!.jsonPrimitive.contentOrNull?.toBooleanStrictOrNull() ?: true)
            }
            put("pattern", pattern)
        }
        return merged.toString()
    }

    private fun nested(old: JsonObject, mapping: Map<String, String>): JsonObject = buildJsonObject {
        for ((target, source) in mapping) {
            toNewRule(old.str(source))?.let { put(target, it) }
        }
    }

    /**
     * 老规则 → 新规则。上游 `toNewRule`：先剥 `-`（倒序）与 `+`（allinone）标记，
     * 再做 `#→##`、`|→||`、`&→&&` 三处方言转换（各有排除条件），最后把标记贴回去。
     */
    internal fun toNewRule(oldRule: String?): String? {
        if (oldRule.isNullOrBlank()) return null
        var newRule = oldRule
        var reverse = false
        var allInOne = false
        if (oldRule.startsWith("-")) {
            reverse = true
            newRule = newRule.substring(1)
        }
        if (newRule.startsWith("+")) {
            allInOne = true
            newRule = newRule.substring(1)
        }
        val skipDialect = newRule.startsWith("@CSS:", ignoreCase = true) ||
            newRule.startsWith("@XPath:", ignoreCase = true) ||
            newRule.startsWith("//") || newRule.startsWith("##") || newRule.startsWith(":") ||
            newRule.contains("@js:", ignoreCase = true) || newRule.contains("<js>", ignoreCase = true)
        if (!skipDialect) {
            if (newRule.contains("#") && !newRule.contains("##")) newRule = oldRule.replace("#", "##")
            if (newRule.contains("|") && !newRule.contains("||")) {
                newRule = if (newRule.contains("##")) {
                    val parts = newRule.split("##")
                    if (parts[0].contains("|")) {
                        val rewritten = StringBuilder(parts[0].replace("|", "||"))
                        for (index in 1 until parts.size) rewritten.append("##").append(parts[index])
                        rewritten.toString()
                    } else newRule
                } else newRule.replace("|", "||")
            }
            if (newRule.contains("&") && !newRule.contains("&&") && !newRule.contains("http") && !newRule.startsWith("/")) {
                newRule = newRule.replace("&", "&&")
            }
        }
        if (allInOne) newRule = "+$newRule"
        if (reverse) newRule = "-$newRule"
        return newRule
    }

    /** 老 `exploreUrl` 是多行/`&&` 拼接的 `名称::URL`，逐条转完再用换行拼回去。 */
    internal fun toNewUrls(oldUrls: String?): String? {
        if (oldUrls.isNullOrBlank()) return null
        if (oldUrls.startsWith("@js:") || oldUrls.startsWith("<js>")) return oldUrls
        if (!oldUrls.contains("\n") && !oldUrls.contains("&&")) return toNewUrl(oldUrls)
        val parts = oldUrls.split(Regex("(&&|\\r?\\n)+"))
        return parts.mapNotNull { toNewUrl(it)?.replace(Regex("\\n\\s*"), "") }
            .joinToString("\n").takeIf { it.isNotBlank() }
    }

    /** 老 `searchUrl` 用 `=searchKey` / `=searchPage`，现版本是 `{{key}}` / `{{page}}`。 */
    internal fun toNewUrl(oldUrl: String?): String? {
        if (oldUrl.isNullOrBlank()) return null
        if (oldUrl.startsWith("<js>", ignoreCase = true)) {
            return oldUrl.replace("=searchKey", "={{key}}").replace("=searchPage", "={{page}}")
        }
        return oldUrl.replace("=searchKey", "={{key}}").replace("=searchPage", "={{page}}")
    }

    /**
     * 备份条目里的 JSON 可能是数组、可能是 `{data:[...]}` / `{bookSources:[...]}` 这类包装，
     * 也可能整个文件就只有一个源对象。全部摊平成数组，不再因为形状不同就整段导入失败。
     */
    fun elementsOf(text: String): List<JsonElement> {
        val root = json.parseToJsonElement(text.removePrefix("﻿"))
        return when (root) {
            is JsonArray -> root.toList()
            is JsonObject -> {
                val wrapped = listOf("data", "bookSources", "bookSourceJson", "sources", "rssSources", "replaceRules", "books")
                    .firstOrNull { root[it] is JsonArray }
                when {
                    wrapped != null -> (root[wrapped] as JsonArray).toList()
                    // 单对象：本身像一条记录就当一条
                    root.containsKey("bookSourceUrl") || root.containsKey("pattern") || root.containsKey("noteUrl") -> listOf(root)
                    else -> root.values.mapNotNull { (it as? JsonArray)?.toList() }.flatten()
                }
            }
            else -> emptyList()
        }
    }

    private fun JsonObject.str(key: String): String? =
        (this[key] as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }

    /** 老备份里布尔值可能被写成 `1/0` 或字符串 `"true"`，都要认。 */
    private fun JsonObject.bool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.let { primitive ->
        val raw = primitive.contentOrNull?.trim() ?: return@let null
        raw.toBooleanStrictOrNull() ?: raw.toIntOrNull()?.let { it != 0 }
    }

    private fun JsonObject.num(key: String): Long? =
        (this[key] as? JsonPrimitive)?.contentOrNull?.trim()?.toLongOrNull()
}
