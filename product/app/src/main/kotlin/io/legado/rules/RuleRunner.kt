package io.legado.rules

import cn.wanghaomiao.xpath.model.JXDocument
import com.jayway.jsonpath.JsonPath
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element
import org.jsoup.nodes.Node
import org.jsoup.nodes.TextNode
import org.jsoup.select.Elements
import org.mozilla.javascript.BaseFunction
import org.mozilla.javascript.ClassShutter
import org.mozilla.javascript.Context
import org.mozilla.javascript.Function
import org.mozilla.javascript.NativeJSON
import org.mozilla.javascript.NativeObject
import org.mozilla.javascript.Scriptable
import org.mozilla.javascript.ScriptableObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.Charset
import java.time.Duration
import java.util.zip.GZIPInputStream
import java.util.zip.InflaterInputStream
import io.legado.AppConfig
import io.legado.content.ContentProcessor
import io.legado.content.LooseJson
import io.legado.content.applyReplaceEntry
import io.legado.data.Database
import io.legado.data.cookieBucketsForHosts
import io.legado.data.getCookieForUrl
import io.legado.data.getEnabledReplaceRulesForScope
import io.legado.data.getSourceLoginState
import io.legado.data.getTocCache
import io.legado.data.setCookieFromSetCookie
import io.legado.data.shelfBook
import io.legado.http.NetworkSecurity
import io.legado.model.FlexChildStyle
import io.legado.model.SourceLoginActionResult
import io.legado.model.SourceLoginCheckResult
import io.legado.model.SourceLoginUiItem
import io.legado.ops.LogLevel
import io.legado.ops.logEngine
import io.legado.ops.logNetwork
import io.legado.ops.logParsing
import io.legado.ops.logRuleExecution
import io.legado.source.WebViewProxy
import io.legado.model.BookDetails
import io.legado.model.Chapter
import io.legado.model.ChapterContent
import io.legado.model.ExploreTab
import io.legado.model.RssArticle
import io.legado.model.SearchResult

// 接入结构化日志

/**
 * A deliberately small, server-safe subset of Legado's declarative source protocol.
 * It keeps execution away from Android APIs and rejects private-network targets.
 */
class RuleRunner(private val responseFetcher: ((String) -> String)? = null, internal var database: Database? = null) {
    constructor(database: Database) : this(null, database)
    constructor(responseFetcher: (String) -> String) : this(responseFetcher, null)
    private val client = io.legado.http.NetworkSecurity.newHttpClient(connectTimeout = Duration.ofSeconds(10), followRedirects = HttpClient.Redirect.NEVER)
    private val json = Json { ignoreUnknownKeys = true }
    private val jsSandbox = JsSandbox(this)

    /**
     * Legado 的 `ruleData`：`@put:{k:…}` 存下的变量要活到**后面的调用**。
     *
     * 典型是漫画源：搜索/发现那一次 `@put:{bid:$.comic_id}`，随后 `tocUrl` / `chapterUrl` 再
     * `@get:{bid}` —— 我们的变量表原来只挂在单次解析的 NodeValue 上，搜索一结束就没了，
     * 于是目录取不到（0 章，用户 2026-10-09 报的「漫画打不开」的根因之一）。
     *
     * 键是 bookUrl（搜索/发现时存），详情解析出 tocUrl 之后再补一份 tocUrl 的键
     * （`chapters()` 那一侧拿到的是 tocUrl）。上限做了保护，避免长跑进程里无限涨。
     */
    private val ruleData = java.util.concurrent.ConcurrentHashMap<String, Map<String, String>>()

    private fun rememberRuleData(key: String?, vars: Map<String, String>) {
        if (key.isNullOrBlank() || vars.isEmpty()) return
        if (ruleData.size > MAX_RULE_DATA_KEYS) ruleData.clear()
        ruleData[key] = vars
    }

    private fun recallRuleData(key: String?): Map<String, String> = key?.let { ruleData[it] } ?: emptyMap()

    fun search(sourceJson: String, keyword: String): List<SearchResult> {
        val source = sourceJson.objectValue()
        source.string("mainJs")?.takeIf { it.isNotBlank() }?.let { return JsSourceRunner(this, source).search(keyword) }
        val rawSearchUrl = source.string("searchUrl") ?: throw RuleExecutionException("该书源未配置 searchUrl")
        val sourceUrl = source.string("bookSourceUrl") ?: throw RuleExecutionException("书源缺少 bookSourceUrl")
        // 整个搜索流程都在书源上下文内执行：规则里的 <js> 依赖 source.getVariable() 与 jsLib 工具函数
        val execContext = sourceContext(source, sourceUrl)
        return jsSandbox.withSourceContext(execContext) {
            val searchUrl = if (rawSearchUrl.trimStart().startsWith("@js:") || rawSearchUrl.trimStart().startsWith("js:") || rawSearchUrl.contains("<js>")) {
                val jsCode = if (rawSearchUrl.contains("<js>")) rawSearchUrl.substringAfter("<js>").substringBefore("</js>") else rawSearchUrl.removePrefix("@js:").removePrefix("js:")
                jsSandbox.eval(jsCode, mapOf("key" to keyword, "keyword" to keyword, "page" to 1, "baseUrl" to sourceUrl, "sourceId" to sourceUrl), execContext)
                    ?: throw RuleExecutionException("searchUrl JS 计算未返回有效地址：${execContext.lastError ?: "脚本无返回值"}")
            } else {
                rawSearchUrl
            }
            val (urlTemplate, options) = splitUrlOptions(searchUrl)
            val mergedOptions = mergeOptions(parseSourceHeaders(source), options)
            // 搜索永远只取第一页，但**页码要显式给**：`<a,b,c>` 那一段没有页码就不展开（本机 50 份源的
            // searchUrl 用这个写法），实测语料里另有 2,644 条栏目地址用它，不给页码等于留一串尖括号在网址里。
            val rendered = renderUrl(urlTemplate, keyword, sourceUrl, page = 1).absolute(sourceUrl)
            val body = fetchUrl(rendered, mergedOptions, keyword, sourceUrl, database)
            val rule = source.objectValue("ruleSearch") ?: throw RuleExecutionException("该书源未配置 ruleSearch")
            bookItems(body, rule, sourceUrl, source.sourceType())
        }
    }

    /**
     * 列表规则取值失败时，把**上游自己写的那句原因**接进报错。JSON 接口普遍带 `msg` / `message` 一类字段：
     * 实测 `https://m.lrts.me/ajax/searchBook`（本机 115 个音频源之一）匿名搜索回
     * `{"apiStatus":485,"msg":"你好，需要登录才能继续使用此功能"}`，而我们原来只报
     * `Missing property in path $['books']` —— 界面上这两种都是"无结果"，「这个源要登录」与
     * 「站点真的没内容」分不开。接上这句之后，体检按「登录」二字归进 `needs_login` 那一档。
     * HTML 不摘：整页标签塞进报错只会把有用的那句挤掉。
     */
    private fun upstreamReason(error: Throwable, body: String): String {
        val reason = "${error.javaClass.simpleName}：${(error.message ?: "列表规则取值失败").replace(Regex("\\s+"), " ").trim().take(120)}"
        val hint = if (!body.trimStart().startsWith("{")) "" else runCatching {
            val root = body.objectValue()
            listOf("msg", "message", "error", "errmsg", "info", "detail", "reason")
                .firstNotNullOfOrNull { key -> root.string(key)?.takeIf { it.isNotBlank() && it.any(Char::isLetter) } }
                .orEmpty().replace(Regex("\\s+"), " ").trim().take(120)
        }.getOrDefault("")
        return if (hint.isEmpty()) reason else "$reason｜上游那句话：「$hint」"
    }

    /** 把 `ruleSearch` / `ruleExplore` 这类「列表规则 + 字段规则」解析成书籍条目。 */
    private fun bookItems(body: String, rule: JsonObject, sourceUrl: String, sourceType: Int): List<SearchResult> {
        val listRule = rule.string("bookList") ?: throw RuleExecutionException("缺少 bookList 规则")
        // 与 chapters() 一致：`<js>…</js>` 形式的列表规则要先过沙箱预处理，直接丢给 Jsoup/json-path 会解析失败
        val items = try {
            if (isJsRule(listRule)) jsListNodes(NodeValue.document(body), listRule, body, sourceUrl) else nodes(body, listRule)
        } catch (error: RuleExecutionException) {
            throw error
        } catch (error: Exception) {
            throw RuleExecutionException(upstreamReason(error, body))
        }
        return items.mapNotNull { item ->
            val url = item.value(rule.string("bookUrl"), jsSandbox, body, sourceUrl)?.absolute(sourceUrl) ?: return@mapNotNull null
            val result = SearchResult(
                sourceId = sourceUrl,
                name = item.value(rule.string("name"), jsSandbox, body, sourceUrl) ?: return@mapNotNull null,
                author = item.value(rule.string("author"), jsSandbox, body, sourceUrl),
                bookUrl = url,
                coverUrl = item.value(rule.string("coverUrl"), jsSandbox, body, sourceUrl)?.absolute(sourceUrl),
                intro = item.value(rule.string("intro"), jsSandbox, body, sourceUrl),
                kind = item.value(rule.string("kind"), jsSandbox, body, sourceUrl)?.trim()?.takeIf { it.isNotBlank() },
                wordCount = item.value(rule.string("wordCount"), jsSandbox, body, sourceUrl)?.trim()?.takeIf { it.isNotBlank() },
                lastChapter = item.value(rule.string("lastChapter"), jsSandbox, body, sourceUrl)?.trim()?.takeIf { it.isNotBlank() },
                sourceType = sourceType,
            )
            // 这一条解析里 `@put` 下的变量（漫画源典型是 comic_id）留一份，给后面的详情/目录/正文用
            rememberRuleData(url, item.snapshotVariables())
            result
        }
    }

    /**
     * `ruleExplore` 与 `ruleSearch` 逐字段合并：前者非空的字段用它，空的取后者的。
     * 两个都缺时返回 null（调用方报错）。
     */
    private fun mergeExploreRule(explore: JsonObject?, search: JsonObject?): JsonObject? {
        if (explore == null) return search
        if (search == null) return explore
        val merged = LinkedHashMap<String, JsonElement>()
        for (key in explore.keys + search.keys) {
            val own = explore[key]
            val value = if (own is JsonPrimitive && !own.contentOrNull.isNullOrBlank()) own else search[key] ?: own
            if (value != null) merged[key] = value
        }
        return JsonObject(merged)
    }

    /**
     * 解析书源的 `exploreUrl`（Legado 的「发现」页配置）：
     * 既支持 `标题::URL` 换行或 `&#` 分隔的普通写法，也支持 `@js:` 返回 `[{title,url}]` 的聚合源写法。
     */
    fun exploreTabs(sourceJson: String): List<ExploreTab> {
        val source = sourceJson.objectValue()
        val raw = source.string("exploreUrl")?.trim().orEmpty()
        if (raw.isEmpty()) return emptyList()
        val sourceUrl = source.string("bookSourceUrl")
        return jsSandbox.withSourceContext(sourceContext(source, sourceUrl)) {
            val text = if (isJsRule(raw)) evalRuleJs(raw, mapOf("baseUrl" to sourceUrl.orEmpty(), "sourceId" to sourceUrl.orEmpty())) ?: return@withSourceContext emptyList() else raw
            parseExploreTabs(text)
        }
    }

    /** 按发现页地址取书籍列表：优先 `ruleExplore`，缺省回落到 `ruleSearch`（与 Legado 一致）。 */
    fun explore(sourceJson: String, urlTemplate: String, page: Int = 1): List<SearchResult> {
        val source = sourceJson.objectValue()
        val sourceUrl = source.string("bookSourceUrl") ?: throw RuleExecutionException("书源缺少 bookSourceUrl")
        return jsSandbox.withSourceContext(sourceContext(source, sourceUrl)) {
            val resolved = if (isJsRule(urlTemplate)) evalRuleJs(urlTemplate, mapOf("baseUrl" to sourceUrl, "sourceId" to sourceUrl, "key" to "", "keyword" to "", "page" to page)) ?: urlTemplate else urlTemplate
            val (path, options) = splitUrlOptions(resolved)
            val mergedOptions = mergeOptions(parseSourceHeaders(source), options)
            val body = fetchUrl(renderUrl(path, "", sourceUrl, page).absolute(sourceUrl), mergedOptions, null, sourceUrl, database)
            /*
             * `ruleExplore` 常常**存在但是空的**：实测全库 5,574 个源里 2,857 个的
             * `ruleExplore.bookList` 是空串，其中 2,828 个的 `ruleSearch.bookList` 可用。
             * 原来写的是 `ruleExplore ?: ruleSearch` —— 非 null 就选中它，于是这半个库点开
             * 发现分栏一律报「缺少 bookList 规则」（用户 2026-10-08 报的就是这个）。
             * 改成**逐字段**回落：explore 里非空的用它，空的取 search 的（Legado 的发现页同理）。
             */
            val rule = mergeExploreRule(source.objectValue("ruleExplore"), source.objectValue("ruleSearch"))
                ?: throw RuleExecutionException("该书源未配置 ruleExplore/ruleSearch")
            bookItems(body, rule, sourceUrl, source.sourceType())
        }
    }

    /**
     * RSS 源的栏目（上游 `RssSource.sortUrl`）：与书源 `exploreUrl` 同一套 `标题::地址` 写法，
     * 也支持整段 JS 返回 `[{title,url}]` 的聚合源（`RssSourceExtensions.sortUrls`）。
     * 没配 sortUrl 时上游直接拿 sourceUrl 当唯一栏目页，这里保持一致，不让界面出现空的页签条。
     */
    fun rssTabs(sourceJson: String): List<ExploreTab> {
        val source = sourceJson.objectValue()
        val sourceUrl = source.string("sourceUrl") ?: throw RuleExecutionException("RSS 源缺少 sourceUrl")
        val raw = source.string("sortUrl")?.trim().orEmpty()
        if (raw.isEmpty()) return listOf(ExploreTab(source.string("sourceName")?.trim()?.takeIf { it.isNotEmpty() } ?: sourceUrl, sourceUrl, supportsPaging(sourceUrl)))
        return jsSandbox.withSourceContext(sourceContext(source, sourceUrl)) {
            val text = if (isJsRule(raw)) evalRuleJs(raw, mapOf("baseUrl" to sourceUrl, "sourceId" to sourceUrl, "key" to "", "page" to 1))
                ?: return@withSourceContext emptyList() else raw
            parseExploreTabs(text)
        }
    }

    /**
     * 取 RSS 栏目页的文章列表，字段映射逐条照上游 `model/rss/RssParserByRule.kt`：
     * `ruleArticles` 取列表（`-` 前缀＝倒序，同书源目录）、标题为空的条目丢掉，
     * 图片地址按上游第 125 行用 sourceUrl 归一，文章链接用栏目页地址归一。
     */
    fun rssArticles(sourceJson: String, urlTemplate: String, page: Int = 1): List<RssArticle> {
        val source = sourceJson.objectValue()
        val sourceUrl = source.string("sourceUrl") ?: throw RuleExecutionException("RSS 源缺少 sourceUrl")
        val rawListRule = source.string("ruleArticles")?.trim()
            ?: throw RuleExecutionException("该订阅源没有配置 ruleArticles，服务端无法解析列表")
        return jsSandbox.withSourceContext(sourceContext(source, sourceUrl)) {
            val resolved = if (isJsRule(urlTemplate)) evalRuleJs(urlTemplate, mapOf("baseUrl" to sourceUrl, "sourceId" to sourceUrl, "key" to "", "page" to page)) ?: urlTemplate else urlTemplate
            val (path, options) = splitUrlOptions(resolved)
            val mergedOptions = mergeOptions(parseSourceHeaders(source), options)
            val pageUrl = renderUrl(path, "", sourceUrl, page).absolute(sourceUrl)
            val body = fetchUrl(pageUrl, mergedOptions, null, sourceUrl, database)
            val reverse = rawListRule.startsWith("-")
            val listRule = rawListRule.removePrefix("-").trim()
            val nodes0 = if (isJsRule(listRule)) jsListNodes(NodeValue.document(body), listRule, body, pageUrl) else nodes(body, listRule)
            val items = nodes0.mapNotNull { item ->
                val title = item.value(source.string("ruleTitle"), jsSandbox, body, pageUrl)?.trim().orEmpty()
                if (title.isBlank()) return@mapNotNull null
                val link = item.value(source.string("ruleLink"), jsSandbox, body, pageUrl)?.trim()?.absolute(pageUrl).orEmpty()
                val description = item.value(source.string("ruleDescription"), jsSandbox, body, pageUrl)?.trim()?.takeIf { it.isNotEmpty() }
                // 上游只要求标题非空；我们连链接和描述都没有的话，点进去必然是空白页，不如不列
                if (link.isBlank() && description == null) return@mapNotNull null
                RssArticle(
                    origin = sourceUrl,
                    title = title,
                    link = link,
                    pubDate = item.value(source.string("rulePubDate"), jsSandbox, body, pageUrl)?.trim()?.takeIf { it.isNotEmpty() },
                    description = description,
                    image = item.value(source.string("ruleImage"), jsSandbox, body, pageUrl)?.trim()?.absolute(sourceUrl)?.takeIf { it.isNotEmpty() },
                )
            }
            if (reverse) items.asReversed() else items
        }
    }

    /**
     * RSS 正文。注意 `RssSource.ruleContent` 是**一条规则字符串**，
     * 与 `BookSource.ruleContent`（规则对象）同名不同形，不能共用 [content]。
     */
    fun rssContent(sourceJson: String, link: String): ChapterContent {
        val source = sourceJson.objectValue()
        val sourceUrl = source.string("sourceUrl") ?: throw RuleExecutionException("RSS 源缺少 sourceUrl")
        val ruleContent = source.string("ruleContent")?.trim()
            ?: throw RuleExecutionException("该订阅源没有配置 ruleContent，只能直接打开原页")
        return jsSandbox.withSourceContext(sourceContext(source, sourceUrl)) {
            val (path, options) = splitUrlOptions(link)
            val mergedOptions = mergeOptions(parseSourceHeaders(source), options)
            val body = fetchUrl(path.absolute(sourceUrl), mergedOptions, null, sourceUrl, database)
            val root = NodeValue.document(body)
            val text = root.value(ruleContent, jsSandbox, body, link)?.preserveContentImages(link)?.cleanContent().orEmpty()
            if (text.isBlank()) {
                val detail = jsSandbox.lastError?.let { "，脚本异常：$it" } ?: ""
                throw RuleExecutionException("正文规则未提取到内容$detail")
            }
            ChapterContent(root.value(source.string("ruleTitle"), jsSandbox, body, link), text)
        }
    }

    private fun evalRuleJs(rule: String, bindings: Map<String, Any?>): String? {
        val trimmed = rule.trim()
        val code = if (trimmed.contains("<js>")) trimmed.substringAfter("<js>").substringBefore("</js>") else trimmed.removePrefix("@js:").removePrefix("js:")
        return jsSandbox.eval(code, bindings)
    }

    private fun parseExploreTabs(text: String): List<ExploreTab> = text.trim().let { trimmed ->
        if (trimmed.startsWith("[")) {
            val array = runCatching { Json.parseToJsonElement(trimmed) as? JsonArray }.getOrNull()
            if (array != null) {
                return array.mapNotNull { element ->
                    val tab = element as? JsonObject ?: return@mapNotNull null
                    val title = (tab.string("title") ?: tab.string("name"))?.trim()?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                    val url = (tab.string("url") ?: tab.string("bookSourceUrl"))?.trim()?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                    ExploreTab(title, url, supportsPaging(url))
                }
            }
        }
        // 与上游一致（legado-with-MD3 的 exploreKinds）：exploreUrl 的分栏分隔符是 `&&` 与换行
        // —— 实测本库 110 个源的 exploreUrl 用 `&&`，原来只按行切、这些源的分栏全被并成一条。
        // `&#` 是 RSS sortUrl（与本函数共享）的方言，一并保留。
        trimmed.split(Regex("&&|&#|\n+")).mapNotNull { entry ->
            val title = entry.substringBefore("::").trim()
            val url = entry.substringAfter("::", "").trim()
            if (title.isEmpty() || url.isEmpty()) null else ExploreTab(title, url, supportsPaging(url))
        }.toList()
    }

    /**
     * 构造当前书源的 JS 执行上下文（含 jsLib，规则 JS 因此可以调用书源工具函数）。
     *
     * 注意：Legado 约定里 `loginUrl` 可以不是网址，而是**整段登录用 JS**（聚合源普遍如此），
     * 其中的工具函数同样会被正文/目录规则调用，因此也要并入脚本库。
     */
    private fun sourceContext(source: JsonObject, sourceUrl: String?): JsExecutionContext {
        val library = buildString {
            source.string("jsLib")?.takeIf { it.isNotBlank() }?.let { append(it) }
            loginScript(source)?.let {
                if (isNotEmpty()) append("\n")
                append(it)
            }
        }.takeIf { it.isNotBlank() }
        return JsExecutionContext(sourceId = sourceUrl, database = database, jsLib = library)
    }

    /**
     * 上游 `BaseSource.getLoginJs()` 的口径：`loginUrl` 整串被 `<js>…</js>` 或 `@js:` 包住时取内层，
     * 否则**原样当脚本文本**；是网址（http/https 开头）时它不是脚本。
     * 库内实测：纯网址 293 个、`@js:` 4 个、含 `<js>` 9 个、裸 `function login(){…}` 等 195 个。
     */
    private fun loginScript(source: JsonObject): String? {
        val raw = source.string("loginUrl")?.trim().orEmpty()
        if (raw.isEmpty() || raw.startsWith("http://", true) || raw.startsWith("https://", true)) return null
        val unwrapped = if (raw.contains("<js>")) raw.substringAfter("<js>").substringBefore("</js>")
            else raw.removePrefix("@js:").removePrefix("js:").removePrefix("@javascript:")
        return unwrapped.trim().takeIf { it.isNotEmpty() }
    }

    /** 界面据此决定「内置浏览器」是直开 loginUrl，还是先执行登录脚本拿地址。 */
    fun loginIsScript(sourceJson: String): Boolean = loginScript(sourceJson.objectValue()) != null

    /**
     * 让登录脚本告诉我们要打开哪个地址。
     *
     * `loginUrl` 是整段 JS 的书源（实测 208 个），真正的登录页只有脚本自己知道 —— 它们普遍写成
     * `function login(openBrowser, checkMode){ java.startBrowserAwait(真实地址, "扫码登录") … }`。
     * 我们原来直接把 `loginUrl` 当网址打开，等于把一段 JS 交给浏览器导航，落到了书源主页；
     * 上游是靠执行按钮脚本来打开正确页面的。这里按同一条路走：以 `login(true, false)` 跑一遍，
     * 取它请求打开的地址。
     */
    fun loginBrowserStartUrl(sourceJson: String): String? {
        val source = sourceJson.objectValue()
        if (loginScript(source) == null) return null
        val sourceUrl = source.string("bookSourceUrl")
        val execContext = sourceContext(source, sourceUrl)
        jsSandbox.eval(
            "if (typeof login === 'function') { login(true, false); }",
            mapOf("baseUrl" to sourceUrl.orEmpty(), "sourceId" to sourceUrl.orEmpty(), "result" to emptyMap<String, String>()),
            execContext,
        )
        return execContext.openUrl?.trim()?.takeIf { it.startsWith("http://") || it.startsWith("https://") }
    }

    fun details(sourceJson: String, bookUrl: String): BookDetails {
        val source = sourceJson.objectValue()
        source.string("mainJs")?.takeIf { it.isNotBlank() }?.let { return JsSourceRunner(this, source).details(bookUrl) }
        return jsSandbox.withSourceContext(sourceContext(source, source.string("bookSourceUrl"))) {
            declarativeDetails(source, bookUrl)
        }
    }

    /**
     * 解析 `data:;base64,<载荷>,<类型标记>` 形式的数据地址，返回解码后的载荷；非数据地址返回 null。
     *
     * 聚合类书源用它把 book_id/来源/分栏等参数从搜索结果一路带到详情、目录和正文。
     */
    private fun dataUrlPayload(url: String): String? {
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

    private fun declarativeDetails(
        source: JsonObject,
        bookUrl: String,
        traces: MutableList<DebugTrace>? = null,
    ): BookDetails {
        val sourceUrl = source.string("bookSourceUrl")
        val rule = source.objectValue("ruleBookInfo") ?: throw RuleExecutionException("该书源未配置 ruleBookInfo")
        val initRule = rule.string("init")

        // 聚合源把 bookUrl 当作参数载体（data:;base64,<载荷>,{"type":"qingtian"}），
        // 这类地址无法直接 HTTP 请求，需要先取出解码后的载荷交给规则。
        val dataPayload = dataUrlPayload(bookUrl)
        val body: String
        val baseDoc: NodeValue
        if (dataPayload != null) {
            body = dataPayload
            baseDoc = NodeValue.json(dataPayload)
        } else {
            val (url, options) = splitUrlOptions(bookUrl)
            val mergedOptions = mergeOptions(parseSourceHeaders(source), options)
            body = fetchUrl(url, mergedOptions, null, sourceUrl, database)
            baseDoc = NodeValue.document(body)
        }

        // 搜索/发现时 `@put` 下的变量灌回来：`tocUrl` 常写成 `@get:{bid}`（漫画源就是这样）
        val seedVars = recallRuleData(bookUrl)
        baseDoc.seedVariables(seedVars)

        // init 常写成「JS + 后置取值路径」的规则链（如 <js>…</js>$.data）：必须求值，不能当路径用。
        // 纯路径（如 $.data）仍走原有 at() 语义，避免把 JSON 对象退化成字符串。
        traces?.add(DebugTrace("「响应」", bookUrl.take(160), "${body.length} 字节", ""))
        val root = when {
            initRule.isNullOrBlank() -> baseDoc
            initRule.contains("<js>") || initRule.trimStart().startsWith("@js:") || initRule.trimStart().startsWith("js:") ->
                runCatching { baseDoc.value(initRule, jsSandbox, body, bookUrl) }.getOrNull()
                    ?.takeIf { it.isNotBlank() }?.let { NodeValue.document(it) } ?: baseDoc
            else -> baseDoc.at(initRule)
        }
        // `at()` / `NodeValue.document()` 会另起一个节点，变量得再灌一次
        root.seedVariables(seedVars)
        fun value(key: String): String? {
            val ruleText = rule.string(key).orEmpty()
            val outcome = runCatching { root.value(rule.string(key), jsSandbox, body, bookUrl) }
            traces?.add(
                DebugTrace(
                    field = key,
                    rule = ruleText,
                    value = outcome.getOrNull()?.take(MAX_TRACE_CHARS) ?: "",
                    failure = outcome.exceptionOrNull()?.let { it.javaClass.simpleName + "：" + (it.message ?: "") }
                        ?: outcome.getOrNull()?.let { "取到空值" }.orEmpty(),
                )
            )
            return outcome.getOrNull()
        }
        val name = (value("name") ?: "").trim()
        val tocUrl = value("tocUrl")?.absolute(bookUrl) ?: bookUrl
        // 目录那一侧（chapters）拿到的是 tocUrl，把变量也挂到 tocUrl 上 —— chapterUrl 常写 `@get:{bid}`。
        // **必须带上详情这一步新 put 的变量**：只回灌搜索那一次的表，`ruleBookInfo` 里
        // `@put:{cid:$.comic_id}` 存下的 cid 就到不了目录，chapterUrl 里的 `@get:{cid}`
        // 会解成空串，拼出 `comic_id=&chapter_id=…` 这种请求 —— 上游回 422，
        // 界面上只看到「上游返回 HTTP 422」，看不出是变量没传过去（漫画源实测）。
        rememberRuleData(tocUrl, recallRuleData(bookUrl) + root.snapshotVariables())
        return BookDetails(
            sourceId = source.string("bookSourceUrl")!!,
            name = name.ifBlank { "未命名书籍" },
            author = value("author"), intro = value("intro"),
            coverUrl = value("coverUrl")?.absolute(bookUrl),
            tocUrl = tocUrl,
            kind = value("kind")?.trim()?.takeIf { it.isNotBlank() },
            wordCount = value("wordCount")?.trim()?.takeIf { it.isNotBlank() },
            lastChapter = value("lastChapter")?.trim()?.takeIf { it.isNotBlank() },
            sourceType = source.sourceType(),
        )
    }

    /**
     * 调试专用：跑一遍详情规则，同时把「字段 → 规则原文 → 取到的值/失败原因」逐条带出来。
     * 只在 `/debug` 链路上用，正常取值走的是无 trace 的那条路径，不给热路径加开销。
     */
    fun debugDetails(sourceJson: String, bookUrl: String): Pair<BookDetails, List<DebugTrace>> {
        val traces = mutableListOf<DebugTrace>()
        return declarativeDetails(sourceJson.objectValue(), bookUrl, traces) to traces
    }

    fun chapters(sourceJson: String, tocUrl: String): List<Chapter> {
        val source = sourceJson.objectValue()
        source.string("mainJs")?.takeIf { it.isNotBlank() }?.let { return JsSourceRunner(this, source).chapters(tocUrl) }
        val sourceUrl = source.string("bookSourceUrl")
        return jsSandbox.withSourceContext(sourceContext(source, sourceUrl)) {
            val rule = source.objectValue("ruleToc") ?: throw RuleExecutionException("该书源未配置 ruleToc")
            val rawListRule = rule.string("chapterList") ?: throw RuleExecutionException("缺少 ruleToc.chapterList")
            // 上游允许 `-` 前缀表示倒序目录、`+` 表示显式正序（BookChapterList.analyzeChapterList）。
            val normalized = rawListRule.trimStart()
            val reverse = normalized.startsWith("-")
            val listRule = normalized.removePrefix("-").removePrefix("+").trim()
            val nextRule = rule.string("nextTocUrl").orEmpty().trim()

            // 目录分页：`nextTocUrl` 可以返回 1 个下一页、也可以一次返回多个入口页。
            // 上游用 visited 集合做回环守卫，这里再叠一层页数上限，避免坏规则把请求打成长尾。
            val collected = LinkedHashMap<String, Triple<String, String, Boolean>>()
            val queue = ArrayDeque(listOf(tocUrl))
            val visited = mutableSetOf(tocUrl)
            var pages = 0
            while (queue.isNotEmpty() && pages < MAX_TOC_PAGES) {
                val pageUrl = queue.removeFirst()
                val (pageChapters, nextUrls) = parseTocPage(source, sourceUrl, rule, listRule, nextRule, pageUrl)
                pageChapters.forEach { (name, url, isVolume) ->
                    val key = if (url.isNotBlank()) url else "vol:$name"
                    if (!collected.containsKey(key)) collected[key] = Triple(name, url, isVolume)
                }
                nextUrls.forEach { if (visited.add(it)) queue.addLast(it) }
                pages++
            }
            val ordered = if (reverse) collected.values.reversed() else collected.values.toList()
            ordered.mapIndexed { index, (name, url, isVolume) ->
                Chapter(index, name.ifBlank { if (isVolume) "" else "第 ${index + 1} 章" }, url, isVolume)
            }
        }
    }

    /** 解析目录的**一页**，返回（本页章节 名称→URL，本页声明的下一页地址）。 */
    private fun parseTocPage(
        source: JsonObject,
        sourceUrl: String?,
        rule: JsonObject,
        listRule: String,
        nextRule: String,
        pageUrl: String,
    ): Pair<List<Triple<String, String, Boolean>>, List<String>> {
        val dataPayload = dataUrlPayload(pageUrl)
        // `chapterUrl` 常写 `@get:{bid}`（漫画源就是这样）：把搜索/详情那一次 @put 的变量灌进来
        val seedVars = recallRuleData(pageUrl)
        val body: String
        val chapterNodes: List<NodeValue>
        if (dataPayload != null) {
            // 聚合源的目录地址同样是参数载体，由 chapterList 的 JS 自行取回目录
            body = dataPayload
            chapterNodes = jsListNodes(NodeValue.json(dataPayload), listRule, body, pageUrl)
        } else {
            val (url, options) = splitUrlOptions(pageUrl)
            val mergedOptions = mergeOptions(parseSourceHeaders(source), options)
            body = fetchUrl(url, mergedOptions, null, sourceUrl, database)
            val baseDoc = NodeValue.document(body)
            chapterNodes = if (isJsRule(listRule)) jsListNodes(baseDoc, listRule, body, pageUrl) else nodes(body, listRule)
        }
        // 条目节点是现造的，变量得逐个灌（`@get:{bid}` 就写在 chapterUrl 里）
        if (seedVars.isNotEmpty()) chapterNodes.forEach { it.seedVariables(seedVars) }
        val isVolumeRule = rule.string("isVolume")?.trim()
        val items = chapterNodes.mapNotNull { node ->
            val isVolume = isVolumeRule?.let { node.value(it, jsSandbox, body, pageUrl) }
                ?.trim()?.let { it.isNotEmpty() && it != "0" && it != "false" } ?: false
            val chapterHref = node.value(rule.string("chapterUrl"), jsSandbox, body, pageUrl)?.absolute(pageUrl)
            val name = node.value(rule.string("chapterName"), jsSandbox, body, pageUrl).orEmpty()
            // 卷分组头可无正文地址；普通章节没有地址则丢弃（维持原行为）。
            if (chapterHref == null && !isVolume) return@mapNotNull null
            Triple(name, chapterHref ?: "", isVolume)
        }
        val nextRaw = if (nextRule.isEmpty()) "" else NodeValue.document(body)
            .also { it.seedVariables(seedVars) }
            .value(nextRule, jsSandbox, body, pageUrl)
            .orEmpty()
            .trim()
        return items to parseNextTocUrls(nextRaw, pageUrl)
    }

    /**
     * `nextTocUrl` 的求值结果可能是三种：单个地址、多行地址（上游「一次给多个入口页」的老写法），
     * 或 JS 返回的 **JSON 数组** —— 如懒人听书 `@js:` 拼出的分页列表，`NativeJSON.stringify` 会把它
     * 序列化成一行 `["url1","url2"]`。三种都要拆成一个个地址：否则整个数组会被当成**一个** URL 去请求，
     * 报「URL 格式无效或包含未解析变量」、整本目录取不到（音频源就这样）。
     */
    private fun parseNextTocUrls(raw: String, pageUrl: String): List<String> {
        if (raw.isEmpty()) return emptyList()
        val candidates: List<String> = if (raw.startsWith("[")) {
            val parsed = runCatching { Json.parseToJsonElement(raw) as? JsonArray }.getOrNull()
            if (parsed != null) parsed.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
            else raw.lineSequence().toList()
        } else {
            raw.lineSequence().toList()
        }
        return candidates.map { it.trim() }.filter { it.isNotEmpty() }.map { it.absolute(pageUrl) }.distinct()
    }

    private fun isJsRule(rule: String): Boolean {
        val trimmed = rule.trimStart()
        return trimmed.startsWith("@js:") || trimmed.startsWith("js:") || (rule.contains("<js>") && rule.contains("</js>"))
    }

    /** `<js>` 形式的列表规则：求值得到 JSON 数组后逐项包装成可继续取值的节点。 */
    private fun jsListNodes(base: NodeValue, listRule: String, body: String, baseUrl: String): List<NodeValue> {
        val trimmed = listRule.trim()
        val postRule = if (trimmed.contains("</js>")) trimmed.substringAfter("</js>").trim() else ""
        // 有尾随规则时只把 `<js>…</js>` 段交给 value()，拿到 JS 的输出文本；
        // 若连尾随规则一起交给 value()，通配路径的结果会被序列化成 Java toString，再也解析不出条目。
        val jsOnly = if (postRule.isBlank()) trimmed else trimmed.substringBefore("</js>").trim() + "</js>"
        val produced = base.value(jsOnly, jsSandbox, body, baseUrl) ?: return emptyList()
        if (postRule.isNotBlank()) return nodes(produced, postRule)
        val parsed = runCatching { Json.parseToJsonElement(produced) }.getOrNull() as? JsonArray ?: return emptyList()
        return parsed.map { NodeValue.json(it.toPlainJava()) }
    }

    /** 把 kotlinx JsonElement 转成普通 Java 结构，使 JsonPath 取值与 JS 属性访问都能正常工作。 */
    private fun JsonElement.toPlainJava(): Any? = when (this) {
        is JsonObject -> LinkedHashMap<String, Any?>().also { map -> entries.forEach { (key, value) -> map[key] = value.toPlainJava() } }
        is JsonArray -> map { it.toPlainJava() }
        is JsonPrimitive -> if (isString) content
        else content.toBooleanStrictOrNull() ?: content.toLongOrNull() ?: content.toDoubleOrNull() ?: content
        JsonNull -> null
    }

    /**
     * 把 `book.*` / `chapter.*` 的真值喂进执行上下文。
     *
     * 上游是把 Book / BookChapter 对象直接交给 Rhino，所以书源 JS 里 `book.origin`、
     * `chapter.title` 随手就能用。我们的桥对象建好了，但除登录流程外**从来没人填值**：
     * content() 只 copy 了一个 chapterUrl，于是库里 449 个引用 book./chapter. 的源
     * 取到的是空串 —— 不报错，只是拼出来的请求地址和标题不对、脚本自己判空走进另一条分支。
     * 这里把书架与目录缓存里查得到的字段补上（查不到就维持原样，绝不编造）。
     */
    private fun readingContext(
        base: JsExecutionContext,
        sourceId: String?,
        bookUrl: String?,
        bookName: String?,
        chapterUrl: String?,
    ): JsExecutionContext {
        val withChapter = base.copy(chapterUrl = chapterUrl)
        val db = database ?: return withChapter
        if (sourceId.isNullOrBlank() || bookUrl.isNullOrBlank()) return withChapter
        val shelf = db.shelfBook(sourceId, bookUrl) ?: return withChapter
        val chapters = db.getTocCache(sourceId, shelf.tocUrl)
        val index = chapters?.indexOfFirst { it.url == chapterUrl }?.takeIf { it >= 0 }
        return withChapter.copy(
            bookUrl = bookUrl,
            bookName = bookName?.takeIf { it.isNotBlank() } ?: shelf.name,
            bookAuthor = shelf.author,
            bookTocUrl = shelf.tocUrl,
            chapterIndex = index ?: shelf.chapterIndex,
            chapterTitle = index?.let { chapters?.getOrNull(it)?.title },
        )
    }

    fun content(sourceJson: String, chapterUrl: String, bookName: String? = null, bookUrl: String? = null): ChapterContent {
        val source = sourceJson.objectValue()
        val sourceUrl = source.string("bookSourceUrl")
        val sourceName = source.string("bookSourceName")
        val replaceRules = database?.getEnabledReplaceRulesForScope(bookName, sourceUrl, sourceName).orEmpty()

        if (source.string("mainJs")?.isNotBlank() == true) {
            val result = JsSourceRunner(this, source).content(chapterUrl)
            if (replaceRules.isEmpty()) return result
            val cleanedTitle = result.title?.let { ContentProcessor.processTitle(it, replaceRules, jsSandbox, bookName) }
            val cleanedText = ContentProcessor.processContent(result.content, replaceRules, jsSandbox, bookName, result.title)
            return ChapterContent(cleanedTitle, cleanedText)
        }

        val execContext = readingContext(sourceContext(source, sourceUrl), sourceUrl, bookUrl, bookName, chapterUrl)
        return jsSandbox.withSourceContext(execContext) {
            val rule = source.objectValue("ruleContent") ?: throw RuleExecutionException("该书源未配置 ruleContent")
            val contentRule = rule.string("content") ?: throw RuleExecutionException("缺少 ruleContent.content")
            val nextRule = rule.string("nextContentUrl").orEmpty().trim()
            val replaceRegex = rule.string("replaceRegex")
            // 不 trim 每条：`##正则##替换` 的替换串里前后空格是有意义的（上游也原样保留）
            val patterns = replaceRegex?.split(Regex("[\r\n]+|&&"))?.filter { it.isNotBlank() }.orEmpty()

            // 正文分页：`nextContentUrl` 非空的源实测 1,693 个，以前被整个忽略，长章只拿到第一页。
            // 与目录同一套走法：visited 回环守卫 + 页数上限，翻页文本按上游一样直接串接。
            val pageTexts = mutableListOf<String>()
            val queue = ArrayDeque(listOf(chapterUrl))
            val visited = mutableSetOf(chapterUrl)
            var firstRoot: NodeValue? = null
            var firstBody: String? = null
            while (queue.isNotEmpty() && pageTexts.size < MAX_CONTENT_PAGES) {
                val pageUrl = queue.removeFirst()
                val (root, body) = contentPage(source, sourceUrl, pageUrl, recallRuleData(bookUrl))
                if (firstRoot == null) { firstRoot = root; firstBody = body }
                var pageText = root.value(contentRule, jsSandbox, body, pageUrl)?.preserveContentImages(pageUrl)?.cleanContent().orEmpty()
                if (pageText.length < 500) {
                    val paragraphs = Regex("(?i)<p[^>]*>([\\s\\S]*?)</p>").findAll(body)
                        .map { it.groupValues[1].cleanContent() }
                        .filter { it.length > 2 && !it.contains("按←键返回") && !it.contains("加入书签") && !it.contains("仅放置最近浏览") }
                        .toList()
                    if (paragraphs.size >= 5) {
                        val candidate = paragraphs.joinToString("\n\n")
                        if (candidate.length > pageText.length) pageText = candidate
                    }
                }
                for (entry in patterns) {
                    pageText = applyReplaceEntry(entry, pageText)
                }
                pageTexts += pageText
                if (nextRule.isNotEmpty()) {
                    root.value(nextRule, jsSandbox, body, pageUrl).orEmpty()
                        .lineSequence()
                        .map { it.trim() }
                        .filter { it.isNotEmpty() }
                        .map { it.absolute(pageUrl) }
                        .distinct()
                        .forEach { if (visited.add(it)) queue.addLast(it) }
                }
            }
            val root = firstRoot ?: throw RuleExecutionException("正文页取不到内容")
            // 音频 / EPUB 直链：正文 JS 给 `yp_url` 赋了媒体地址 —— 这一章的"正文"就是那个地址。
            // 必须**先**判它：Rhino 会把赋值表达式的值当成脚本返回值（`yp_url = $.data.path` 的结果
            // 就是那串地址），于是 `pageText` 非空、根本走不到"文本为空"分支，mediaUrl 就丢了。
            val media = execContext.mediaUrl
            if (!media.isNullOrBlank()) {
                return@withSourceContext ChapterContent(
                    root.value(rule.string("title"), jsSandbox, firstBody, chapterUrl), media, media,
                )
            }
            var text = pageTexts.filter { it.isNotBlank() }.joinToString("\n\n")
            if (text.isBlank()) {
                val detail = jsSandbox.lastError?.let { "，脚本异常：$it" } ?: ""
                throw RuleExecutionException("正文规则未提取到内容$detail")
            }

            // subContent：原版「副文规则，拼接在正文后面」（歌词/副内容等），缺省不影响既有行为。
            val subRule = rule.string("subContent")?.trim()
            if (!subRule.isNullOrEmpty()) {
                val sub = root.value(subRule, jsSandbox, firstBody, chapterUrl)?.cleanContent().orEmpty()
                if (sub.isNotBlank()) text = if (text.isBlank()) sub else "$text\n\n$sub"
            }

            var title = root.value(rule.string("title"), jsSandbox, firstBody, chapterUrl)
            if (replaceRules.isNotEmpty()) {
                text = ContentProcessor.processContent(text, replaceRules, jsSandbox, bookName, title)
                if (title != null) {
                    title = ContentProcessor.processTitle(title, replaceRules, jsSandbox, bookName)
                }
            }
            // 音频 / 视频源的正文常常**就是那条直链**（`ruleContent` 取回 `https://…/1.m4a`）。
            // 上游是 App 侧自己嗅的，我们以前只认 `yp_url` 那一个约定，于是没写 yp_url 的那批
            // 音频 / 视频源把地址当一段文字排出来，播放器根本不出来（本机库里音频 115、视频 15、文件 60 个源）。
            val sniffed = sniffMediaUrl(text)
            if (sniffed != null) ChapterContent(title, sniffed, sniffed) else ChapterContent(title, text)
        }
    }

    /** 取正文的一页，返回（可继续取值的根节点，原始响应体）。聚合源的 `data:` 章节地址由规则自己取回正文。 */
    private fun contentPage(source: JsonObject, sourceUrl: String?, pageUrl: String, vars: Map<String, String> = emptyMap()): Pair<NodeValue, String> {
        val dataPayload = dataUrlPayload(pageUrl)
        if (dataPayload != null) return NodeValue.json(dataPayload).also { it.seedVariables(vars) } to dataPayload
        val (url, options) = splitUrlOptions(pageUrl)
        val mergedOptions = mergeOptions(parseSourceHeaders(source), options)
        val body = fetchUrl(url, mergedOptions, null, sourceUrl, database)
        return NodeValue.document(body).also { it.seedVariables(vars) } to body
    }

    /**
     * 整段正文就是一条媒体直链时，这一章的"正文"是那个地址，不是那行字。
     *
     * 判得保守：必须去掉首尾空白后**只剩一行**、以 http(s) 开头、路径落在 [MEDIA_URL_SUFFIXES] 里。
     * 带空格的、`地址,{"headers":…}` 那种带选项形态的一律不当媒体（后者交给 `splitUrlOptions`，
     * 从我们这儿嗅出去会留下半截 JSON）；多行或夹着文字的也不当 —— 「本章完 https://…」这类
     * 正常正文被误判成播放器，比播放器出不来更糟。
     */
    private fun sniffMediaUrl(text: String): String? {
        val trimmed = text.trim()
        if (trimmed.isEmpty() || trimmed.length > 600 || '\n' in trimmed) return null
        if (' ' in trimmed || trimmed.contains(",{")) return null
        if (!trimmed.startsWith("http://", ignoreCase = true) && !trimmed.startsWith("https://", ignoreCase = true)) return null
        val path = runCatching { URI(trimmed).path }.getOrNull()?.lowercase().orEmpty()
        if (path.isEmpty()) return null
        return if (MEDIA_URL_SUFFIXES.any { path.endsWith(it) }) trimmed else null
    }

    fun parseLoginUi(sourceJson: String): List<SourceLoginUiItem> {
        val source = sourceJson.objectValue()
        val sourceUrl = source.string("bookSourceUrl") ?: ""
        val loginUiStr = source.string("loginUi")?.trim()
        val loginUrl = source.string("loginUrl")?.trim()
        val jsLib = source.string("jsLib")?.trim()

        if (loginUiStr.isNullOrBlank()) {
            if (!loginUrl.isNullOrBlank() && (loginUrl.startsWith("http://") || loginUrl.startsWith("https://"))) {
                return listOf(
                    SourceLoginUiItem(
                        name = "打开登录网页",
                        type = "button",
                        action = loginUrl,
                        style = FlexChildStyle(layout_flexBasisPercent = 1.0f),
                    ),
                )
            }
            return emptyList()
        }

        val rawJson = if (loginUiStr.startsWith("@js:") || loginUiStr.startsWith("js:") || loginUiStr.contains("<js>")) {
            val jsCode = if (loginUiStr.contains("<js>")) loginUiStr.substringAfter("<js>").substringBefore("</js>") else loginUiStr.removePrefix("@js:").removePrefix("js:")
            val execContext = sourceContext(source, sourceUrl)
                .copy(sourceName = source.string("bookSourceName") ?: sourceUrl)
            jsSandbox.eval(jsCode, mapOf("sourceId" to sourceUrl, "baseUrl" to sourceUrl), execContext) ?: "[]"
        } else {
            loginUiStr
        }

        return runCatching {
            json.decodeFromString<List<SourceLoginUiItem>>(rawJson)
        }.getOrElse { emptyList() }
    }

    fun executeLoginAction(
        sourceJson: String,
        actionCode: String,
        loginData: Map<String, String>,
        isLongClick: Boolean = false,
        browserCompleted: Boolean = false,
    ): SourceLoginActionResult {
        val source = sourceJson.objectValue()
        val sourceUrl = source.string("bookSourceUrl") ?: ""
        val sourceName = source.string("bookSourceName") ?: sourceUrl

        // 脚本库（jsLib + loginUrl 形式的 JS）由执行上下文统一注入，这里只拼动作本身
        val execContext = sourceContext(source, sourceUrl).copy(
            sourceName = sourceName,
            initialLoginInfo = loginData.toMutableMap(),
            isLongClick = isLongClick,
            browserCompleted = browserCompleted,
        )

        val trimmedAction = actionCode.trim()
        if (trimmedAction.startsWith("http://") || trimmedAction.startsWith("https://")) {
            return SourceLoginActionResult(
                success = true,
                openUrl = trimmedAction,
            )
        }

        // 上游两条路径要分清：菜单「确定」走 `BaseSource.login()`，那是 `login.apply(this)`（不带实参）；
        // 而 loginUi 按钮的 action 是**原样执行的 JS**，`login(true,false)` 这类带实参的调用必须保留实参，
        // 否则脚本里靠 `checkMode` 分支的源会被当成"打开浏览器"那条路走。
        val bareLogin = trimmedAction.equals("login", ignoreCase = true) ||
            trimmedAction.replace("\\s".toRegex(), "").let { it == "login()" || it == "login();" }
        val fullScript = if (bareLogin) {
            "if (typeof login === 'function') { login.apply(this); } else { throw new Error('该书源脚本未定义 login()'); }"
        } else {
            trimmedAction
        }

        val bindings = mapOf(
            "result" to loginData,
            "baseUrl" to sourceUrl,
            "sourceId" to sourceUrl,
            "bookSourceUrl" to sourceUrl,
            "isLongClick" to isLongClick,
        )

        jsSandbox.eval(fullScript, bindings, execContext)
        val state = database?.getSourceLoginState(sourceUrl)
        val failure = execContext.lastError

        return SourceLoginActionResult(
            success = failure == null,
            error = failure,
            toastMessages = execContext.toastMessages,
            openUrl = execContext.openUrl,
            copyText = execContext.copyText,
            updatedLoginInfo = execContext.initialLoginInfo.ifEmpty { state?.loginInfo ?: emptyMap() },
            updatedLoginHeader = state?.loginHeader,
            updatedVariable = state?.sourceVariable,
            reRenderUi = execContext.reRenderUi,
        )
    }

    fun checkLoginStatus(sourceJson: String): SourceLoginCheckResult {
        val source = sourceJson.objectValue()
        val sourceUrl = source.string("bookSourceUrl") ?: ""
        val loginCheckJs = source.string("loginCheckJs")?.trim()
        val loginUrl = source.string("loginUrl") ?: ""
        val jsLib = source.string("jsLib") ?: ""

        if (loginCheckJs.isNullOrBlank()) {
            val jar = database?.cookieBucketsForHosts(WebViewProxy.credentialDomains(sourceJson)).orEmpty()
            val state = database?.getSourceLoginState(sourceUrl)
            val hasCookie = jar.isNotEmpty()
            val hasInfo = state?.loginInfo?.isNotEmpty() == true
            val hasHeader = state?.loginHeader?.isNotEmpty() == true
            val hasCredential = hasCookie || hasInfo || hasHeader
            // 无 loginCheckJs 时只能"以有无凭据"判断，无法真正验证登录是否有效；
            // 保持 loggedIn 的既有语义（有凭据即视为可用，兼容测试），但如实标注未验证。
            return SourceLoginCheckResult(
                loggedIn = hasCredential,
                hasCredential = hasCredential,
                verified = false,
                message = if (hasCredential) "已捕获登录凭据（未能自动验证有效性）" else "未登录",
            )
        }

        val execContext = sourceContext(source, sourceUrl)
        val result = jsSandbox.eval(loginCheckJs, mapOf("sourceId" to sourceUrl, "baseUrl" to sourceUrl), execContext)?.trim()
        val isSuccess = result == "true" || (result != null && result.isNotBlank() && result != "false" && result != "0" && !result.contains("未登录"))
        val jar = database?.cookieBucketsForHosts(WebViewProxy.credentialDomains(sourceJson)).orEmpty()
        val state = database?.getSourceLoginState(sourceUrl)
        val hasCredential = isSuccess || jar.isNotEmpty() || state?.loginInfo?.isNotEmpty() == true || state?.loginHeader?.isNotEmpty() == true
        return SourceLoginCheckResult(
            loggedIn = isSuccess,
            hasCredential = hasCredential,
            verified = isSuccess,
            // 上游的 loginCheckJs 是**响应改写器**（`WebBook.kt:77` 拿它处理正文响应，顺带识别掉登录），
            // 不是"登录状态查询"。我们把它当布尔判定用是一种借用，措辞上不能说得比这更肯定。
            message = if (isSuccess) "按书源 loginCheckJs 试判为已登录" else (result ?: "未登录"),
        )
    }

    internal fun fetch(url: String, sourceId: String? = null, database: Database? = null): String {
        val (cleanUrl, options) = splitUrlOptions(url)
        // 凭据（库内登录头 + 该域名的 Cookie 罐）由 buildRequest 按**每一跳的地址**合，这里不再预置
        return fetchUrl(cleanUrl, options, null, sourceId, database ?: this.database)
    }

    /** 书源自己的 `header` 字段（`{"User-Agent":"...","Referer":"..."}`）。凭据不在这里合，见 [effectiveHeaders]。 */
    private fun parseSourceHeaders(source: JsonObject): Map<String, String> {
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

    private fun mergeOptions(sourceHeaders: Map<String, String>, options: UrlOptions?): UrlOptions {
        if (sourceHeaders.isEmpty()) return options ?: UrlOptions()
        val combined = sourceHeaders.toMutableMap()
        options?.headers?.let { combined.putAll(it) }
        return (options ?: UrlOptions()).copy(headers = combined)
    }

    internal data class UrlOptions(
        val method: String = "GET",
        val body: String? = null,
        val headers: Map<String, String> = emptyMap(),
        val charset: Charset = Charsets.UTF_8,
        /** 上游 `UrlOption.useWebView()`：非 false/空即视为要用 WebView 取渲染后的 HTML。服务端抓不到，但要如实标出来。 */
        val webView: Boolean = false,
    )

    /**
     * 切出 URL 尾巴上的 `,{options}`。
     *
     * 上游语义（`AnalyzeUrl.kt:253-259`）：先严格 JSON，失败退回宽松 JSON 并提示「格式不规范」；
     * **两种都解析不出来时，URL 仍然要用去掉尾巴的那一段**（`urlNoOption`），而不是把 `,{...}` 一起当地址发出去。
     * 我们原来只在严格解析成功时才摘尾巴，失败就整串当 URL —— 直接报「URL 格式无效或包含未解析变量」，
     * 库内实测这种写法有 1,571 处（单引号键值、裸键、全角引号、字符串里裸换行、尾随逗号）。
     */
    internal fun splitUrlOptions(value: String): Pair<String, UrlOptions?> {
        val (urlPart, tail) = LooseJson.extractTail(value)
        if (tail == null) return value to null
        val strict = jsonOption(tail)
        val options = strict ?: jsonOption(LooseJson.toStrict(tail) ?: return urlPart to null) ?: return urlPart to null
        if (strict == null) logParsing(
            "书源链接参数 JSON 写法不规范，已按宽松模式解析",
            // 以前这里是 `System.getLogger(...).log(INFO, "…: {0}", tail.take(160))`：
            // 走的是另一条输出通道（不进库、不进「运行日志」），而且 tail 里带裸换行，
            // 一次采样里 4000 行中有 2112 行是它冲出来的空行与 `'method': 'POST',` 碎片。
            // 现在交给 LogService 折成一行、按"同一种写法"合并计数。
            mapOf("rule" to tail.take(40), "片段" to tail),
        )

        val method = (options.string("method") ?: "GET").trim().uppercase()
        return urlPart to UrlOptions(
            method = if (method == "POST" || method == "HEAD") method else "GET",
            // body 写成对象/数组时要序列化回 JSON 文本（上游 `UrlOption.getBody()` = `GSON.toJson(it)`），
            // 原来用 string() 取，对象直接被丢掉 → POST 变成空 body。
            body = when (val raw = options["body"]) {
                null -> null
                is JsonPrimitive -> raw.contentOrNull
                else -> raw.toString()
            },
            headers = headerMapOf(options["headers"]),
            charset = runCatching { Charset.forName(options.string("charset") ?: "UTF-8") }.getOrDefault(Charsets.UTF_8),
            webView = when (val raw = options["webView"]) {
                null, JsonNull -> false
                is JsonPrimitive -> raw.contentOrNull?.trim()?.lowercase()?.let { it.isNotEmpty() && it != "false" } ?: false
                else -> true
            },
        )
    }

    private fun jsonOption(text: String): JsonObject? =
        runCatching { Json.parseToJsonElement(text.trim()) as? JsonObject }.getOrNull()

    /** `headers` 既可能是对象，也可能是一整串 JSON（甚至单引号写的），上游两种都接。 */
    private fun headerMapOf(element: JsonElement?): Map<String, String> {
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

    private fun parseUri(url: String): URI {
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
    private fun encodeIllegalUrlChars(url: String): String {
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

    private fun fetchUrl(
        url: String,
        options: UrlOptions?,
        keyword: String?,
        sourceId: String? = null,
        database: Database? = null,
    ): String {
        responseFetcher?.let { return it(url) }
        val db = database ?: this.database
        var request = buildRequest(parseUri(url), options, keyword, sourceId, db)
        // 首次连接偶发失败（连接复用/握手抖动）时重试一次：书源 JS 常在内部 try/catch 吞掉 ajax 异常，
        // 不重试会表现为「规则执行成功但内容为空」这类极难排查的现象。
        var transientAttempt = 0
        repeat(4) {
            val response = try {
                client.send(request, HttpResponse.BodyHandlers.ofInputStream())
            } catch (error: java.io.IOException) {
                // 第一次失败是要重试的信号，不是事故；重试还失败才是。以前两次都记 ERROR，
                // 于是一个偶发抖动在日志里和"这本书源彻底读不了"长得一模一样。
                if (transientAttempt == 0) {
                    transientAttempt++
                    logNetwork("首次连接失败，重试一次", networkContext(url, sourceId) + mapOf("原因" to (error.message ?: error.javaClass.simpleName)), error, LogLevel.WARN)
                    client.send(request, HttpResponse.BodyHandlers.ofInputStream())
                } else {
                    logNetwork("网络请求 IO 异常（已重试）", networkContext(url, sourceId) + mapOf("尝试" to (transientAttempt + 1).toString()), error, LogLevel.ERROR)
                    throw error
                }
            }
            val setCookies = response.headers().allValues("set-cookie")
            if (setCookies.isNotEmpty() && db != null && !sourceId.isNullOrBlank()) {
                // 用「当前这一跳」的地址归档：重定向后落地的域名与入口域名可以完全不同，
                // 按入口地址存会把 A 站的 Cookie 发给 B 站。
                val cookieUrl = request.uri().toString()
                setCookies.forEach { cookieStr ->
                    db.setCookieFromSetCookie(cookieUrl, cookieStr)
                }
            }
            if (response.statusCode() !in 300..399) {
                if (response.statusCode() !in 200..299) {
                    runCatching { response.body().close() }
                    val status = response.statusCode()
                    logNetwork(
                        "上游返回错误状态码",
                        networkContext(url, sourceId) + mapOf("statusCode" to status.toString()),
                        // 4xx 是"这个源/这个地址不给看"，5xx 才是"对面坏了"。
                        // 两者以前都记 ERROR：5,574 个源里一堆 403/404 是常态，ERROR 因此失去意义。
                        level = if (status in 400..499) LogLevel.WARN else LogLevel.ERROR,
                    )
                    throw RuleExecutionException("上游返回 HTTP $status")
                }
                val bytes = response.body().use { readLimited(it) }
                if (bytes.size > MAX_BODY_BYTES) {
                    logNetwork("响应体过大", networkContext(url, sourceId) + mapOf("size" to bytes.size.toString()))
                    throw RuleExecutionException("上游响应超过 2 MiB 限制")
                }
                val charset = (options?.charset) ?: Charsets.UTF_8
                return decodeBody(bytes, response.headers().firstValue("content-encoding").orElse(""), charset)
            }
            runCatching { response.body().close() }
            val location = response.headers().firstValue("location").orElseThrow { 
                logNetwork("重定向缺少 Location", networkContext(url, sourceId))
                RuleExecutionException("重定向缺少 Location") 
            }
            val redirect = request.uri().resolve(location); validateTarget(redirect)
            request = buildRequest(redirect, options, keyword, sourceId, db)
        }
        logNetwork("重定向次数超限", networkContext(url, sourceId))
        throw RuleExecutionException("重定向次数超过限制")
    }

    /**
     * 网络日志的统一上下文：**域名放在最前**。
     *
     * 原来只有 `url` 截前 120 字符，一行里既看不出是哪个源、也看不出是哪台机器 ——
     * `sourceId` 是裸域名串，用户在界面上看到的是「00小说网」这种名字。
     * 这里给 `host`（合并键与肉眼定位都靠它）并保留截断后的 url。
     */
    private fun networkContext(url: String, sourceId: String?): Map<String, String> = mapOf(
        "host" to (runCatching { java.net.URI(url.trim()).host }.getOrNull() ?: "未知"),
        "sourceId" to (sourceId ?: ""),
        "url" to url.take(120),
    )

    private fun buildRequest(
        initial: URI,
        options: UrlOptions?,
        keyword: String?,
        sourceId: String?,
        db: Database?,
    ): HttpRequest {
        validateTarget(initial)
        val builder = HttpRequest.newBuilder(initial)
            .timeout(Duration.ofSeconds(20))
            .header("Accept-Encoding", "gzip, deflate")
        val headers = effectiveHeaders(initial, options, sourceId, db)
        // 书源给了 User-Agent 就**别再加我们自己的**：`HttpRequest.Builder.header()` 是**追加**不是覆盖，
        // 两个 UA 会一起发出去，站点按第一个判 —— 懒人听书的详情接口因此返回空数据
        // （45 字节 `{"data":{}}`，搜索却照常出结果，极易误判成"书源坏了"）。
        if (headers.keys.none { it.equals("User-Agent", ignoreCase = true) }) {
            builder.header("User-Agent", "legadoQ/0.1")
        }
        // Java HttpClient 禁止设置这几个头，书源里 `"Connection": "keep-alive"` 极常见 ——
        // 原样传进去直接抛 `IllegalArgumentException：restricted header name`，整个搜索/正文全废
        // （实测懒人听书源：搜索「失败」、什么都搜不到）。这些头由 HttpClient 自己管，过滤掉即可。
        headers
            .filterKeys { it.lowercase() !in RESTRICTED_HEADERS }
            .forEach { (name, value) -> builder.header(name, value) }
        val method = options?.method?.uppercase() ?: "GET"
        val body = options?.body
        if (method != "GET" && body != null) {
            val rendered = keyword?.let { renderUrl(body, it, initial.toString()) } ?: body
            builder.method(method, HttpRequest.BodyPublishers.ofString(rendered, options?.charset ?: Charsets.UTF_8))
        } else {
            builder.method(method, HttpRequest.BodyPublishers.noBody())
        }
        return builder.build()
    }

    /**
     * 逐跳合成请求头。凭据必须按**这一跳真正要访问的地址**查，不是按书源的 `bookSourceUrl`：
     * 阅读类站点的书页域名和接口域名经常不是一个（书页 `www.x.com`、接口 `api.x.com`），
     * 按书源域名查会让「在内置浏览器里登录留下的 Cookie」永远发不出去，登录看起来成功却对阅读毫无影响。
     * 优先级照上游 `AnalyzeUrl.setCookie()`：库内登录头 → 该域名的 Cookie 罐 → 本次 URL 自带的 options.headers。
     * Cookie 按键位合并而不是整串覆盖，否则临时 cookie 会把登录留下的其它键抹掉。
     */
    internal fun effectiveHeaders(uri: URI, options: UrlOptions?, sourceId: String?, db: Database?): Map<String, String> {
        val byKey = LinkedHashMap<String, Pair<String, String>>()
        fun put(name: String, value: String) {
            val key = name.lowercase()
            val previous = byKey[key]
            byKey[key] = when {
                key == "cookie" && previous != null -> previous.first to mergeCookieStrings(previous.second, value)
                else -> name to value
            }
        }
        if (db != null && !sourceId.isNullOrBlank()) {
            parseHeaderJson(db.getSourceLoginState(sourceId)?.loginHeader).forEach { (name, value) -> put(name, value) }
            db.getCookieForUrl(uri.toString())?.let { put("Cookie", it) }
        }
        options?.headers?.forEach { (name, value) -> put(name, value) }
        // 不能写成 apply { ... put(...) }：那个 put 会绑到上面那个局部 put 上，返回的表永远是空的
        val out = LinkedHashMap<String, String>()
        byKey.values.forEach { (name, value) -> out[name] = value }
        return out
    }

    /** 库内登录头存的是 JSON 对象（`{"Authorization":"...","Cookie":"..."}`）；旧数据里的裸串当 Cookie。 */
    internal fun parseHeaderJson(raw: String?): Map<String, String> {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return emptyMap()
        val parsed = runCatching { Json.parseToJsonElement(text) }.getOrNull()
        if (parsed is JsonObject) {
            return parsed.entries
                .filter { it.value is JsonPrimitive }
                .mapNotNull { (key, value) -> (value as JsonPrimitive).contentOrNull?.let { key to it } }
                .toMap()
        }
        return mapOf("Cookie" to text)
    }

    /**
     * 合并两段 Cookie 串，后者按键覆盖前者。进来的都已经是 `k=v; k=v` 形态
     * （落库时 `Database.parseCookieString` 已把 Cookie-Editor 的 JSON / Netscape 归一化过），
     * 这里只按第一个 `=` 切，值里再带 `=` 的照原样保留。
     */
    internal fun mergeCookieStrings(base: String?, override: String?): String {
        val merged = linkedMapOf<String, String>()
        listOf(base, override).forEach { raw ->
            raw?.split(';')?.forEach { piece ->
                val entry = piece.trim()
                val split = entry.indexOf('=')
                if (split > 0) merged[entry.substring(0, split)] = entry.substring(split + 1)
            }
        }
        return merged.entries.joinToString("; ") { "${it.key}=${it.value}" }
    }

    private fun decodeBody(bytes: ByteArray, contentEncoding: String, charset: Charset): String {
        val encoding = contentEncoding.lowercase()
        val decoded = when {
            encoding.contains("gzip") -> GZIPInputStream(bytes.inputStream()).use(::readAll)
            encoding.contains("deflate") -> InflaterInputStream(bytes.inputStream()).use(::readAll)
            else -> bytes
        }
        return decoded.toString(charset)
    }

    private fun readAll(input: InputStream): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) return output.toByteArray()
            output.write(buffer, 0, count)
            // 2 MiB 上限原本只卡在压缩字节上：一个 gzip 炸弹就能在解压时无限膨胀直接把进程顶爆。
            if (output.size() > MAX_BODY_BYTES) throw RuleExecutionException("响应解压后超过 2 MiB 限制")
        }
    }

    private fun readLimited(input: InputStream): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) return output.toByteArray()
            require(output.size() + count <= MAX_BODY_BYTES) { "上游响应超过 2 MiB 限制" }
            output.write(buffer, 0, count)
        }
    }

    private fun validateTarget(uri: URI) {
        try {
            NetworkSecurity.resolveAndValidateSafeHttpTarget(uri, "站点")
        } catch (e: IllegalArgumentException) {
            logNetwork("拒绝访问不安全地址", networkContext(uri.toString(), null) + mapOf("原因" to (e.message ?: "内网或本机地址")))
            throw RuleExecutionException(e.message ?: "拒绝访问内网或本机地址")
        }
    }

    /**
     * 把书源地址里的占位写法换成真实值。`page` **只在调用方真给了页码时才传**：
     * `<页1,页2,…>` 这种翻页段要"有页码"才该被展开（上游 `AnalyzeUrl` 也是 `page?.let { … }`），
     * 详情/目录那几条没有页码，留着原样才是它的语义。
     */
    private fun renderUrl(template: String, keyword: String, sourceUrl: String, page: Int? = null): String {
        val literals = template
            .replace("{{key}}", URLEncoder.encode(keyword, Charsets.UTF_8))
            .replace("{{keyword}}", URLEncoder.encode(keyword, Charsets.UTF_8))
            .replace("{{page}}", (page ?: 1).toString())
            .replace("<key>", URLEncoder.encode(keyword, Charsets.UTF_8))
            .replace("{{source.key}}", URLEncoder.encode(keyword, Charsets.UTF_8))
            .replace("{{source.bookSourceUrl}}", sourceUrl)
            .replace("{{cookie.removeCookie(source.key)}}", "")
        // Legado 把地址里剩下的 `{{…}}` 当 JS 表达式求值（`{{(page-1)*20}}`、`{{java.getDict(…)}}`、
        // `{{url=source.getKey();cookie.removeCookie(url)}}`）。只认固定字面量的话整串会被当成网址，
        // 这类书源就永远搜不到东西。求值失败的占位符原样保留，免得把网址悄悄改坏。
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

    /**
     * Legado 的 `<页1,页2,…>` 翻页段：段内按逗号切，第 N 页取第 N−1 条、**超出条数取最后一条**，
     * 两端按"≤ 空格"裁掉，整段（含尖括号）替换。必须放在 `{{…}}` 求值**之后** ——
     * 社区最常见的写法 `<,index_{{page}}.html>` 是把页码同时写进两处的。
     *
     * 为什么值得做：本机 25,290 条静态栏目地址里有 **2,644 条**用这个写法，以前尖括号原样留在网址里，
     * 过不了 URI 解析 —— 那一栏**第 1 页就 502**（实测饭饭小说 `都市言情::/dsyq/<,index_{{page}}.html>`）。
     */
    private fun selectPageSegments(url: String, page: Int): String =
        PAGE_SEGMENT_PATTERN.replace(url) { match ->
            val options = match.groupValues[1].split(",")
            (options.getOrNull(page - 1) ?: options.last()).trim { it <= ' ' }
        }

    /** Rhino 里所有数字都是 double，`{{(page-1)*20}}` 会求值成 `0.0`；网址里必须是 `0`。 */
    private fun trimJsNumberFraction(text: String): String =
        if (JS_NUMBER_FRACTION.matches(text)) text.substringBefore('.') else text

    /**
     * `%%` 组合（上游 `AnalyzeByJSoup.getElements` 的 `elementsType == "%%"` 分支）：
     * 以**第一支**的条数为准，逐条把各支同一位置取出来拼在一起。
     * 目录规则里典型写法是两卷目录交替排回阅读顺序，少一支就整卷错位。
     */
    private fun interleaveNodes(branches: List<List<NodeValue>>): List<NodeValue> {
        if (branches.isEmpty()) return emptyList()
        if (branches.size == 1) return branches[0]
        val rows = branches[0].size
        val out = ArrayList<NodeValue>(rows * branches.size)
        for (index in 0 until rows) {
            for (nodes in branches) nodes.getOrNull(index)?.let { out += it }
        }
        return out
    }

    private fun nodes(body: String, rule: String): List<NodeValue> {
        // @xpath 方言优先：xpath 里的 `|` 并集不能被当成 Legado 的 `||` 备选来切分
        if (isXpathRule(rule)) return xpathNodes(Jsoup.parse(body), stripXpathPrefix(rule))
        // @json: 前缀（对齐原版 ruleStr.startsWith("@Json:")）：去前缀后按 JSONPath 读列表
        if (isJsonPrefixedRule(rule)) {
            val path = stripJsonPrefix(rule)
            return runCatching { (JsonPath.read<Any>(body, path) as? List<*>)?.map { NodeValue.json(it) } ?: emptyList() }.getOrDefault(emptyList())
        }
        val (branchSeparator, branches) = splitLegadoBranches(rule)
        if (branches.size > 1) {
            // 上游 AnalyzeByJSoup.getElements 的三种组合：`||` 取首个非空、`&&` 并集、`%%` 逐位交错。
            // 以前只认 `||`，`class.a&&class.b@tag.li` 整串被当 CSS 选择器 → SelectorParseException，
            // 该源搜索/目录 0 条（本机 79 条非 JS 列表规则这么写，极速漫画是实测样本）。
            return when (branchSeparator) {
                "&&" -> branches.flatMap { nodes(body, it) }.distinct()
                "%%" -> interleaveNodes(branches.map { nodes(body, it) })
                else -> branches.firstNotNullOfOrNull { branch -> nodes(body, branch).ifEmpty { null } } ?: emptyList()
            }
        }
        return when {
            rule.startsWith("$") -> (JsonPath.read<Any>(body, rule) as? List<*>)?.map { NodeValue.json(it) } ?: emptyList()
            else -> {
                // JSON 响应上的「裸键」列表规则（`bookList: list`）：字段规则早就会把裸键补成 `$.list`
                // （见 RuleValue.valueJson），列表这一路却没补 —— 于是 `list` 被当成 CSS 标签名，
                // 整源搜索 0 条。实测样本是音频源 5sing：接口回 `{"list":[…]}`、规则写 `list`，
                // 站点本身 200 正常，界面上只有一句"一条都没有"。
                bareJsonListPath(body, rule)?.let { path ->
                    val viaJson = runCatching {
                        (JsonPath.read<Any>(body, path) as? List<*>)?.map { NodeValue.json(it) } ?: emptyList()
                    }.getOrDefault(emptyList())
                    if (viaJson.isNotEmpty()) return viaJson
                }
                // 列表规则与字段规则走同一套选择器方言（`class.a@tag.li` / `id.list@tag.dd` / `@children`）：
                // 原来这里只把各段用空格拼成一条 CSS，`tag.` / `id.` 段被当成标签名，整条规则一条都选不出来。
                val document = Jsoup.parse(body)
                val (base, ops) = splitIndexSuffix(rule)
                val selected = selectLegadoSegments(document, base).map(NodeValue::html)
                if (ops.isEmpty()) selected else applyIndexTokens(selected, ops)
            }
        }
    }

    /**
     * `cleanContent()` 会把所有标签抹掉，正文配图因此整张消失（上游是用 ImageGetter 渲染的）。
     * 先把 `<img>` 换成 `![图片](绝对地址)` 占位行，前端按行还原成 `<img>` —— 这样在线读、
     * 离线缓存、净化管道、TTS 走的仍然是同一条字符串链路，不用为图片另开一套数据结构。
     * 懒加载源普遍写 `data-src`/`data-original`，一并认。`data:` 内联图会撑爆缓存，丢掉。
     *
     * 匹配**整个标签**再单独取 src：漫画源的 src 是 Legado 的 `地址,{"headers":"…"}` 形态，
     * 里面带着**没转义的引号**（`<img src="地址,{"headers":"{\"Referer\":…}"}">`）。
     * 老正则从 `src="` 往后取到第一个引号为止，结果是 `地址,{` —— 地址被截断，标签后半截
     * 还留在正文里当文字（实测爱看漫画：整章漫画变成一行行乱码）。
     */
    private fun String.preserveContentImages(pageUrl: String): String =
        CONTENT_IMG_TAG.replace(this) { match ->
            val src = IMG_SRC.find(match.value)?.groupValues?.get(1)?.imageSrcUrl() ?: return@replace ""
            if (src.startsWith("data:", ignoreCase = true)) "" else "\n![图片](${src.absolute(pageUrl)})\n"
        }

    /** Legado 的 `<img src="地址,{"headers":"…"}">`：逗号后是这张图的请求选项，不是地址的一部分。 */
    private fun String.imageSrcUrl(): String {
        val raw = trim()
        val comma = raw.indexOf(',')
        if (comma > 0 && raw.substring(comma + 1).trimStart().startsWith("{")) return raw.substring(0, comma).trim()
        return raw
    }

    private fun String.cleanContent(): String {
        // 漫画正文的图是 `![图片](…)` 占位行，而占位行由 `preserveContentImages` 生成在
        // **`<div>` 内部**（漫画页几乎普遍是"每页图包在一个 div 单元里"）。
        // 下面的 DIV_BLOCK 会把整个 div 连同内容一起删掉 —— 于是占位行被连图带壳吃掉，
        // 整章正文变空，最后报「正文规则未提取到内容」（用户：「漫画源当前还不能使用」）。
        //
        // 不能简单把 DIV_BLOCK 改成"只剥标签保内容"：`ANY_TAG`（下面几行）本来就已经
        // 剥掉所有标签，DIV_BLOCK 的**净效果正是"丢弃 div 里的文字"**，那是文本站屏蔽
        // 广告/推荐位的既有语义，动它会让笔趣阁那类站把侧栏文字灌进正文。
        //
        // 所以这里只救图：先把占位行摘成哨兵（不含 `<` `>`，任何标签清洗都碰不到它），
        // 走完整条清洗，再还原成独占一行的占位。DIV_BLOCK 删块时把块内哨兵留在原地，
        // 于是"div 里的图保住、div 里的广告文字照旧丢掉"。嵌套 div 的非贪婪半截匹配
        // 也一并成立：被切成两段的 div，前一段返回哨兵，残壳交给 ANY_TAG。
        val saved = mutableListOf<String>()
        val withSentinels = CONTENT_IMG_PLACEHOLDER.replace(this) { match ->
            val url = match.groupValues[1]
            val token = "\u0001${saved.size}\u0001"
            saved += url
            "\n$token\n"
        }
        return withSentinels
            .replace(SCRIPT_BLOCK, "")
            .replace(STYLE_BLOCK, "")
            .replace(DIV_BLOCK) { match ->
                val kept = SENTINEL.findAll(match.value).map { it.value }.toList()
                if (kept.isEmpty()) "" else "\n" + kept.joinToString("\n") + "\n"
            }
            .replace(BR_TAG, "\n")
            .replace(P_TAG, "\n")
            .replace(ANY_TAG, "")
            .let { org.jsoup.parser.Parser.unescapeEntities(it, false) }
            .lines()
            .map { line -> SENTINEL.replace(line.trim()) { m ->
                // 越界守卫：正文里本来就带 \u0001 数字 \u0001 这种形状（罕见但非零概率）时，
                // 索引会指向没存过的槽位；取不到就原样丢掉，不能让整章炸掉。
                val url = m.groupValues[1].toIntOrNull()?.let { saved.getOrNull(it) }
                if (url == null) "" else "![图片]($url)"
            } }
            .filter { it.isNotBlank() }
            .joinToString("\n\n")
    }
    private fun String.absolute(base: String): String = try {
        val cleanBase = base.substringBefore("##").substringBefore("#").trim()
        // 规则里常见这种写法：`a.0@href##book\/(.*)\/##https://站点/img/$1.jpg` ——
        // 正则从 `book` 开始匹配，**吃不掉 href 前面那个 `/`**，于是值成了 `/https://站点/img/x.jpg`。
        // 再拿它当"根相对路径"去 resolve，就拼成 `https://站点/https://站点/img/x.jpg`（实测 00小说网
        // 30/30 封面全废）。所以：去掉前导斜杠后若已经是绝对地址，就原样用它。
        // 注意别误伤另外两种：`/img/x.jpg`（根相对，仍要按 base 解析）与 `//cdn/x.jpg`（协议相对）。
        val withoutSlash = trim().removePrefix("/")
        if (withoutSlash.startsWith("http://", ignoreCase = true) || withoutSlash.startsWith("https://", ignoreCase = true)) {
            return withoutSlash
        }
        if (cleanBase.startsWith("http://", ignoreCase = true) || cleanBase.startsWith("https://", ignoreCase = true)) {
            URI(cleanBase).resolve(this).toString()
        } else {
            this
        }
    } catch (_: Exception) { this }
    private fun String.objectValue(): JsonObject = json.parseToJsonElement(this).jsonObject
    private fun JsonObject.objectValue(key: String): JsonObject? = get(key)?.jsonObject
    private fun JsonObject.string(key: String): String? = (get(key) as? JsonPrimitive)?.contentOrNull
    /** 书源 `bookSourceType`：0 文本 / 1 音频 / 2 图片(漫画) / 3 文件 / 4 视频；缺省或非数字给 0。 */
    private fun JsonObject.sourceType(): Int = (get("bookSourceType") as? JsonPrimitive)?.intOrNull ?: 0
    private companion object {
        const val MAX_BODY_BYTES = 2 * 1024 * 1024
        private const val MAX_TRACE_CHARS = 240
        /** ruleData（跨调用复用的 @put 变量）的键上限：超了整表清空 —— 丢了顶多重搜一次。 */
        const val MAX_RULE_DATA_KEYS = 4096
        /** Java HttpClient 的受限请求头（设了会抛 IllegalArgumentException，见 request()）。 */
        val RESTRICTED_HEADERS = setOf("connection", "content-length", "expect", "host", "upgrade")
        /** 正文整段是直链时按这些后缀认媒体（音频 / 视频 / 播流）。`.m3u8` 与 `.ts` 是 HLS，`.m4a` 是音频站最常见的形态。 */
        val MEDIA_URL_SUFFIXES = setOf(".mp3", ".m4a", ".aac", ".ogg", ".wav", ".flac", ".mp4", ".m3u8", ".ts", ".webm", ".mkv", ".mov", ".flv", ".avi")
        val URL_VARIABLE_PATTERN = Regex("\\{\\{(.+?)}}")
        /** `<…>` 翻页段（非贪婪，一段一段来）：见 `selectPageSegments`。 */
        val PAGE_SEGMENT_PATTERN = Regex("<(.*?)>")

        // 下方几个正则原来在每次调用处现编译：cleanContent 走每章正文（离线缓存整本 = 上万次），
        // 其余的走每个字段取值。语义不变，只是提到类级只编译一次。
        val JS_NUMBER_FRACTION = Regex("""-?\d+\.0+""")
        val CONTENT_IMG_TAG = Regex("(?i)<img\\b[^>]*>")
        /** 在一个 `<img …>` 标签里找 src / data-src / data-original 的值（到引号或空白为止）。 */
        val IMG_SRC = Regex("(?i)(?:data-original|data-src|src)\\s*=\\s*[\"']?([^\"'\\s>]+)")
        val SCRIPT_BLOCK = Regex("(?i)<script[\\s\\S]*?</script>")
        val STYLE_BLOCK = Regex("(?i)<style[\\s\\S]*?</style>")
        val DIV_BLOCK = Regex("(?i)<div[\\s\\S]*?</div>")
        /**
         * `cleanContent` 用来把 `![图片](地址)` 占位行临时换成哨兵的两种正则。
         * 哨兵形如 `\u0001<序号>\u0001`：不含 `<` `>`，所以 ANY_TAG 剥标签时碰不到它；
         * 也不含 div/script/style 的任何语法，所以 DIV_BLOCK 删块时它只是块里的一段文本。
         * 见 [cleanContent] 的注释 —— 这是"漫画图被 div 整块吞掉"的修法。
         */
        val CONTENT_IMG_PLACEHOLDER = Regex("!\\[图片]\\(([^)]*)\\)")
        val SENTINEL = Regex("\u0001(\\d+)\u0001")
        val BR_TAG = Regex("(?i)<br\\s*/?>")
        val P_TAG = Regex("(?i)</?p[^>]*>")
        val ANY_TAG = Regex("<[^>]+>")

        /**
         * 续取页数上限。上游只靠 visited 集合防回环，服务端替用户发请求，
         * 需要一层硬上限，否则一条坏规则能把开书变成一次爬站。
         */
        val MAX_TOC_PAGES = AppConfig.maxTocPages
        val MAX_CONTENT_PAGES = AppConfig.maxContentPages
    }
}

private class JsSourceRunner(private val runner: RuleRunner, private val source: JsonObject) {
    private val script = source.string("mainJs") ?: error("mainJs 缺失")

    fun search(keyword: String): List<SearchResult> = call("search", arrayOf(keyword, 1)).jsonArray().mapNotNull { value ->
        val book = Json.parseToJsonElement(value).jsonObject
        val url = book.string("bookUrl") ?: return@mapNotNull null
        SearchResult(source.string("bookSourceUrl")!!, book.string("name") ?: return@mapNotNull null, book.string("author"), url, book.string("coverUrl"), book.string("intro"), sourceType = source.sourceType())
    }
    fun details(bookUrl: String): BookDetails {
        val value = callOptional("getBookInfo", arrayOf(bookObject(bookUrl)))?.jsonObjectOrEmpty() ?: JsonObject(emptyMap())
        val name = value.string("name")?.trim().orEmpty()
        return BookDetails(source.string("bookSourceUrl")!!, name.ifBlank { "未命名书籍" }, value.string("author"), value.string("intro"), value.string("coverUrl"), value.string("tocUrl") ?: bookUrl, sourceType = source.sourceType())
    }
    fun chapters(tocUrl: String): List<Chapter> = call("getChapters", arrayOf(bookObject(tocUrl))).jsonArray().mapIndexedNotNull { index, value ->
        val chapter = Json.parseToJsonElement(value).jsonObject; val url = chapter.string("url") ?: return@mapIndexedNotNull null; Chapter(index, chapter.string("title") ?: "第 ${index + 1} 章", url)
    }
    fun content(chapterUrl: String): ChapterContent = ChapterContent(content = call("getContent", arrayOf(chapterObject(chapterUrl), bookObject(""), null)).trim().also { if (it.isBlank()) throw RuleExecutionException("JS书源正文为空") })

    private fun call(name: String, args: Array<Any?>): String = callOptional(name, args) ?: throw RuleExecutionException("JS书源缺少函数 $name")
    private fun callOptional(name: String, args: Array<Any?>): String? {
        val context = BoundedJs.enter()
        try {
            context.optimizationLevel = -1; context.setClassShutter(ClassShutter { false })
            val scope = context.initSafeStandardObjects()
            ScriptableObject.putProperty(scope, "java", ajaxFunction(scope))
            context.evaluateString(scope, script, "source.js", 1, null)
            val function = ScriptableObject.getProperty(scope, name) as? Function ?: return null
            val raw = function.call(context, scope, scope, args.map { toJsValue(it, scope) }.toTypedArray())
            if (raw == null || raw == Context.getUndefinedValue()) return null
            if (raw is CharSequence) return raw.toString()
            return NativeJSON.stringify(context, scope, raw, null, null).toString()
        } catch (error: RuleExecutionException) { 
            logRuleExecution("JS 书源规则执行异常", mapOf("function" to name, "sourceId" to (source.string("bookSourceUrl") ?: ""), "errorType" to "RuleExecutionException"))
            throw error 
        }
        catch (error: Exception) { 
            logRuleExecution("JS 书源函数调用失败", mapOf("function" to name, "sourceId" to (source.string("bookSourceUrl") ?: ""), "errorMessage" to (error.message ?: "")), error)
            throw RuleExecutionException("JS书源 $name 执行失败: ${error.message}") 
        }
        finally { BoundedJs.exit() }
    }
    private fun ajaxFunction(scope: Scriptable): NativeObject = NativeObject().also { api ->
        api.parentScope = scope
        ScriptableObject.putProperty(api, "ajax", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any = runner.fetch(args.firstOrNull()?.toString() ?: throw RuleExecutionException("ajax 缺少 URL"))
        })
    }
    private fun toJsValue(value: Any?, scope: Scriptable): Any? = when (value) {
        is Map<*, *> -> NativeObject().also { objectValue ->
            objectValue.parentScope = scope
            value.forEach { (key, item) -> if (key is String) ScriptableObject.putProperty(objectValue, key, toJsValue(item, scope)) }
        }
        is List<*> -> Context.getCurrentContext().newArray(scope, value.map { toJsValue(it, scope) }.toTypedArray())
        else -> Context.javaToJS(value, scope)
    }
    private fun bookObject(url: String) = mapOf("bookUrl" to url, "tocUrl" to url)
    private fun chapterObject(url: String) = mapOf("url" to url)
    private fun String.jsonArray(): List<String> = (Json.parseToJsonElement(this) as? JsonArray)?.map { it.toString() } ?: throw RuleExecutionException("JS书源返回值必须是数组")
    private fun String.jsonObjectOrEmpty(): JsonObject = runCatching { Json.parseToJsonElement(this).jsonObject }.getOrDefault(JsonObject(emptyMap()))
    private fun JsonObject.string(key: String): String? = (get(key) as? JsonPrimitive)?.contentOrNull
    /** 书源 `bookSourceType`：0 文本 / 1 音频 / 2 图片(漫画) / 3 文件 / 4 视频；缺省或非数字给 0。 */
    private fun JsonObject.sourceType(): Int = (get("bookSourceType") as? JsonPrimitive)?.intOrNull ?: 0
}

class RuleExecutionException(message: String) : RuntimeException(message)

/** 调试链路里的一条规则追溯：字段、规则原文、取到的值，以及取不到时的原因。 */
@Serializable
data class DebugTrace(
    val field: String,
    val rule: String,
    val value: String,
    val failure: String = "",
)

// ---------------------------------------------------------------- 裸键列表规则（JSON 响应）

/**
 * JSON 响应上的「裸键」列表规则要不要补 `$.` 前缀，返回可直接交给 JsonPath 的路径。
 *
 * 字段规则早就支持裸键（`RuleValue.valueJson` 会把 `songName` 补成 `$.songName`），
 * 列表规则却没补：`bookList: list` 被当成 CSS 标签名，在 `{"list":[…]}` 上一个都选不中，
 * 整源搜索 0 条 —— 而界面上只有一句"一条都没有"，看不出是规则方言的问题。
 *
 * 只认「整条就是键路径」的形态（`list` / `data.list`）：带 `@`、`<js>`、`$`、空格或
 * 选择器语法的规则一律不碰，避免把 CSS 规则误判成 JSONPath。
 */
internal fun bareJsonListPath(body: String, rule: String): String? {
    val head = body.trimStart()
    if (!head.startsWith("{") && !head.startsWith("[")) return null
    if (rule.startsWith("$") || rule.startsWith("@") || rule.startsWith("<")) return null
    if (!BARE_JSON_LIST_KEY.matches(rule)) return null
    return "\$.$rule"
}

private val BARE_JSON_LIST_KEY = Regex("[A-Za-z_][\\w-]*(\\.[A-Za-z_][\\w-]*)*")

// ---------------------------------------------------------------- @xpath 方言（JsoupXpath）
