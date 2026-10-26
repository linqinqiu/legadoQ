package io.legado.rules

import cn.wanghaomiao.xpath.model.JXDocument
import com.jayway.jsonpath.JsonPath
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element
import org.jsoup.nodes.Node
import org.jsoup.nodes.TextNode
import org.jsoup.select.Elements

/**
 * 取值后端层：对应上游 AnalyzeByJSoup / AnalyzeByJSonPath / AnalyzeByXPath —— 一个节点对象把三种后端的分派收在一起。
 */

internal class NodeValue private constructor(private val html: Element?, private val json: Any?) {
    private val ruleVariables = mutableMapOf<String, String>()

    fun value(rule: String?, jsSandbox: JsSandbox? = null, rawBody: String? = null, baseUrl: String? = null): String? {
        if (rule.isNullOrBlank()) return null
        var trimmedRule = rule.trim()

        // `@put:{key:规则}` 求值后存进变量表并从规则串里剔除，`@get:{key}` 再取回。
        // 上游把这张表挂在 ruleData 上，所以同一个 `name` 里 put、`tocUrl` 里 get 是合法的，
        // 变量表必须跟着「本次解析的节点」走，而不是单次 value() 调用。
        trimmedRule = storePutVariables(trimmedRule, jsSandbox, rawBody, baseUrl)
        trimmedRule = substituteGetVariables(trimmedRule)
        if (trimmedRule.isBlank()) return null

        // Legado 的 `##正则##替换` 是整条规则的**最后一步**：先求值主规则，再拿结果做替换。
        // 必须在 `{{}}` 展开之前就把「花括号外」的替换段摘出来 —— 否则模板展开后整条
        // （连同指令原文）一起过替换，模式会把指令自身也改写一遍，`##…##$1<br>` 反而留在
        // 简介里（用户 2026-10-09：00小说网的简介规则正是「模板 + 尾部 ##…##$1<br>」）。
        // 花括号里的 `##` 属于占位符自己的替换（`{{$.create_time##T|\+.*## }}`），不在这一层摘。
        val hashCut = if (trimmedRule.contains("##")) firstTopLevelHashIndex(trimmedRule) else -1
        val replaceSuffix = if (hashCut >= 0) trimmedRule.substring(hashCut) else ""
        if (replaceSuffix.isNotEmpty()) trimmedRule = trimmedRule.substring(0, hashCut)

        val result = evaluateRule(trimmedRule, jsSandbox, rawBody, baseUrl)
        return if (replaceSuffix.isEmpty() || result == null) result else applyRegexReplace(result, replaceSuffix)
    }

    /** [value] 的主干：摘掉「花括号外的 `##` 替换段」之后真正求值的那部分。 */
    private fun evaluateRule(rule: String, jsSandbox: JsSandbox?, rawBody: String?, baseUrl: String?): String? {
        var trimmedRule = rule

        // Legado 的 `规则1||规则2||…` 备选语法：返回第一个取到值的分支。聚合源的字段规则几乎人人都写，
        // 不支持就等于整条记录被 mapNotNull 丢掉，表现为「搜索完成：0 项」而不是报错。
        // 只在花括号外层切，`{{$.book_id||$.BookID}}` 里的 `||` 属于内层路径的备选。
        // 有内联 `@js:` 时更要跳过：JS 里的 `a || b` 是代码，不是分支，切开会破坏整段脚本。
        val inlineJs = findInlineJsMarker(trimmedRule)
        val (branchSeparator, branches) = splitLegadoBranches(trimmedRule)
        if (branches.size > 1 && inlineJs == null &&
            !trimmedRule.contains("<js>") && !trimmedRule.startsWith("@js:") && !trimmedRule.startsWith("js:")
        ) {
            val evaluated = branches.mapNotNull { branch ->
                value(branch, jsSandbox, rawBody, baseUrl)?.takeIf { it.isNotBlank() }
            }
            // `&&` 是「并且」：每个分支都要取值再拼接；`||` 只要第一个非空；
            // `%%` 与上游 getStringList 一致，按**第一支的行数**逐行交错。
            return when (branchSeparator) {
                "&&" -> evaluated.joinToString("\n").takeIf { it.isNotBlank() }
                "%%" -> interleaveLines(evaluated).takeIf { it.isNotBlank() }
                else -> evaluated.firstOrNull()
            }
        }

        if (trimmedRule.contains("{{") && trimmedRule.contains("}}")) {
            val templated = BRACE_TEMPLATE.replace(trimmedRule) { match ->
                // 只去前导空白：`{{$.t##T|\+.*## }}` 的替换串就是那个空格，整串 trim 会把时间粘成 `2023-09-0100:00:33`。
                // `@@` 前缀（上游常见写法，如 `{{@@#bookIntro@text}}`、`{{@@td.0@text}}`）只是标记，
                // 不是选择器的一部分 —— 不剥掉的话整条规则会去选一个叫 `@@#bookIntro` 的东西，取值必空。
                val raw = match.groupValues[1].trimStart()
                val inner = if (raw.startsWith("@@")) raw.substring(2).trimStart() else raw
                if (inner.isBlank()) return@replace ""
                // 先查 `@put:` 存下的变量（上游 `{{}}` 与 `@get:{}` 是同一条正则匹配的）
                ruleVariables[inner.trim()]?.let { return@replace it }
                // 花括号里既可能写取值路径，也可能写一整段 JS（`{{java.timeFormat(...)}}`）。
                // 只认 `$` 开头的话，实测语料里 1800 余行规则会被渲染成空白。
                if (isJsExpression(inner)) evaluateJs(jsSandbox, inner.trim(), rawBody, baseUrl) ?: ""
                else if (!inner.contains("||")) runCatching { valuePlain(inner) }.getOrNull() ?: ""
                else splitLegadoAlternatives(inner).firstNotNullOfOrNull { branch ->
                    runCatching { valuePlain(branch) }.getOrNull()?.takeIf { it.isNotBlank() }
                } ?: ""
            }
            // 上游语义：规则里只要出现 {{}}，整条就是文本模板 —— 展开的结果就是最终值。
            // 不早退的话 "都市" 这种纯文本会掉到函数末尾被再当一次 CSS 选择器求值，必空
            // （实测 65 个源的 intro/kind 全这么丢的；带 @js: / <js> 尾段的仍走后面的合成路径）。
            if (templated != trimmedRule && findInlineJsMarker(templated) == null && !templated.contains("<js>")) {
                return templated
            }
            trimmedRule = templated
        }

        if (trimmedRule.startsWith("@js:") || trimmedRule.startsWith("js:")) {
            val jsCode = trimmedRule.removePrefix("@js:").removePrefix("js:").trim()
            return evaluateJs(jsSandbox, jsCode, rawBody, baseUrl) ?: documentText().ifBlank { rawBody ?: "" }
        }

        // Legado 允许「文字模板 + @js: 代码」：前段先求值成字符串，作为 result 交给后段 JS 收尾。
        // 番茄一类聚合源用它把 `__status__` 这类占位词替换成「连载/完结」，不认的话源码会直接漏进简介。
        val marker = if (trimmedRule.contains("<js>")) null else findInlineJsMarker(trimmedRule)
        if (marker != null) {
            val preRule = trimmedRule.substring(0, marker.first).trim()
            val jsCode = trimmedRule.substring(marker.first + marker.second).trim()
            val base = value(preRule, jsSandbox, rawBody, baseUrl) ?: ""
            if (jsCode.isBlank()) return base
            val src = rawBody ?: base
            return jsSandbox?.eval(jsCode, mapOf("result" to base, "src" to src, "baseUrl" to (baseUrl ?: ""))) ?: base
        }

        if (trimmedRule.contains("<js>") && trimmedRule.contains("</js>")) {
            val preRule = trimmedRule.substringBefore("<js>").trim()
            val jsCode = trimmedRule.substringAfter("<js>").substringBefore("</js>").trim()
            val postRule = trimmedRule.substringAfter("</js>").trim()
            // 无前缀时 result 就是当前条目本身。JSON 条目必须按**对象**传入（沙箱会把 Map 转成 JS 对象），
            // 若按 toString 传，书源里的 result.book_id 之类属性访问全部取不到值，条目会被整条丢弃。
            val intermediate: Any? = if (preRule.isNotBlank()) valuePlain(preRule) ?: ""
            else html?.html() ?: json ?: rawBody ?: ""
            val evaluated = jsSandbox?.eval(
                jsCode,
                mapOf("result" to intermediate, "src" to (rawBody ?: intermediate), "baseUrl" to (baseUrl ?: "")),
            ) ?: (intermediate as? String ?: intermediate?.toString() ?: "")
            if (postRule.isBlank()) return evaluated
            // Legado 规则链：`<js>…</js>` 之后可以再接取值路径（如 `$.data` 或 CSS 选择器），
            // 把 JS 的返回值当作新文档继续取值。聚合源大量使用这种写法。
            return NodeValue.document(evaluated).value(postRule, jsSandbox, evaluated, baseUrl)
        }

        return valuePlain(trimmedRule)
    }

    private fun documentText(): String = html?.html() ?: json?.toString() ?: ""

    /**
     * `%%` 组合（上游 `AnalyzeByJSoup.getStringList` 的 `elementsType == "%%"` 分支）：
     * 以**第一支**的行数为准，逐行把各支同一位置的行拼在一起。
     * 目录规则里典型的写法是 `class.chapters@tag.ul.0@tag.a%%class.chapters@tag.ul.1@tag.li@tag.a`
     * —— 两卷目录交错排回它们原本的阅读顺序，少一支就会整卷错位。
     */
    private fun interleaveLines(branches: List<String>): String {
        if (branches.isEmpty()) return ""
        if (branches.size == 1) return branches[0]
        val split = branches.map { it.lines() }
        val rows = split[0].size
        val out = ArrayList<String>(rows * split.size)
        for (index in 0 until rows) {
            for (lines in split) lines.getOrNull(index)?.let { out += it }
        }
        return out.joinToString("\n")
    }

    /** `@put:{k:rule,...}`：每个键都求值存表并吃掉这段（多键解析见 `putPairs`）。 */
    private fun storePutVariables(rule: String, jsSandbox: JsSandbox?, rawBody: String?, baseUrl: String?): String =
        PUT_VARIABLE.replace(rule) { match ->
            putPairs(match.groupValues[1]).forEach { (key, subRule) ->
                ruleVariables[key] = value(subRule, jsSandbox, rawBody, baseUrl) ?: ""
            }
            ""
        }

    /** `@get:{k}` 与 `{{k}}` 共用一张表（上游 `evalPattern` 就是把这两种写法合并匹配的）。 */
    private fun substituteGetVariables(rule: String): String = GET_VARIABLE.replace(rule) { match ->
        ruleVariables[match.groupValues[1].trim().removeSurrounding("\"")] ?: ""
    }

    private fun evaluateJs(jsSandbox: JsSandbox?, code: String, rawBody: String?, baseUrl: String?): String? {
        val doc = documentText()
        return jsSandbox?.eval(
            code,
            mapOf("result" to doc, "src" to (rawBody ?: doc), "baseUrl" to (baseUrl ?: "")),
        )
    }

    /** `{{…}}` 里的内容是取值路径还是一段 JS：带调用括号、或从 `java.`/`cookie.`/`result` 等起手即为 JS。 */
    private fun isJsExpression(inner: String): Boolean {
        val text = inner.trim()
        return !text.startsWith("$") && !text.startsWith("..") && !BARE_JSON_KEY.matches(text) &&
            (text.contains('(') || JS_IDENT_PREFIX.matches(text))
    }

    private fun valuePlain(rule: String): String? {
        if (rule.isBlank()) return null
        // 字面量地址：`tocUrl` / `chapterUrl` 常直接写成 `https://…/api?bid=@get:{bid}`。
        // 这不是选择器 —— 拿去当 CSS 选择器（属性名）取必然为空，`tocUrl` 就退回书页地址、
        // 目录取不到（漫画源实测如此）。上游也是原样当 URL 用。
        if (rule.startsWith("http://", ignoreCase = true) || rule.startsWith("https://", ignoreCase = true)) {
            return rule
        }
        return if (json != null) valueJson(if (isJsonPrefixedRule(rule)) stripJsonPrefix(rule) else rule)
        else html?.let { element ->
            if (isXpathRule(rule)) {
                val path = stripXpathPrefix(rule)
                val texts = xpathTexts(element, path.substringBefore("##"))
                if (texts.isEmpty()) return null
                return applyRegexReplace(texts.joinToString("\n"), path).takeIf { it.isNotBlank() }
            }
            val selector = rule.removePrefix("@css:")
            val segments = selector.split('@')
            val lastSegment = segments.last()
            val rawMode = lastSegment.substringBefore("##").ifBlank { "text" }
            val selectorChain = segments.subList(0, segments.size - 1).filter { it.isNotBlank() }
            
            val elements = if (selectorChain.isEmpty()) listOf(element) else {
                var currentList = listOf(element)
                for (segment in selectorChain) {
                    val nextList = mutableListOf<Element>()
                    for (curr in currentList) {
                        // 字段取值**吞掉**写坏的选择器（上游 getResultLast 也不抛）：一条 kind/coverUrl
                        // 写坏了只该让那个字段为空，不能把整条搜索结果连坐。列表规则那一层则不吞 ——
                        // 那里写坏就是整源 0 条，必须让体检报出来。
                        nextList.addAll(runCatching { selectLegadoSegment(curr, segment) }.getOrDefault(emptyList()))
                    }
                    currentList = nextList
                    if (currentList.isEmpty()) break
                }
                currentList
            }
            if (elements.isEmpty()) return null
            val texts = elements.mapNotNull { el ->
                when (rawMode) {
                    "html" -> el.html().takeIf { it.isNotBlank() }
                    "text" -> el.text().takeIf { it.isNotBlank() }
                    "textNodes", "textNode" -> el.ownText().takeIf { it.isNotBlank() }
                    else -> el.attr(rawMode).takeIf { it.isNotBlank() }
                }
            }
            if (texts.isEmpty()) return null
            val resultText = applyRegexReplace(texts.joinToString("\n"), lastSegment)
            resultText.takeIf { it.isNotBlank() }
        }
    }

    fun at(rule: String?): NodeValue {
        if (json == null || rule.isNullOrBlank() || !rule.trimStart().startsWith("$")) return this
        return runCatching { NodeValue.json(readJson(rule)) }.getOrDefault(this)
    }

    /**
     * `@put:{k:…}` 存下的变量表：读出来 / 灌进去。
     *
     * 上游把这张表挂在**书的 ruleData** 上，所以「搜索时 put、目录/正文时 get」是合法的
     * （漫画源典型：搜索里 `@put:{bid:$.comic_id}`，`tocUrl`/`chapterUrl` 再 `@get:{bid}`）。
     * 我们的表只活在单个 NodeValue 上，跨调用就丢 —— RuleRunner 用这两个方法把表存起来再灌回去。
     */
    internal fun snapshotVariables(): Map<String, String> = ruleVariables.toMap()

    internal fun seedVariables(initial: Map<String, String>) {
        if (initial.isNotEmpty()) ruleVariables.putAll(initial)
    }

    private fun unwrapJsonValue(value: Any?): String? {
        return when (value) {
            null -> null
            // JSON 对象必须序列化成合法 JSON：直接用 Java 的 {k=v} 形式会让后续规则链解析失败
            is Map<*, *> -> toJsonText(value)
            is List<*> -> {
                val nonNull = value.filterNotNull()
                // 元素是对象/嵌套结构时必须保留 JSON 数组形态，否则章节列表之类的规则链会被压成文本而无法再解析；
                // 纯标量列表仍按行拼接，保持原有取值语义。
                if (nonNull.any { it is Map<*, *> || it is List<*> }) toJsonText(nonNull)
                else if (nonNull.size == 1) unwrapJsonValue(nonNull[0])
                else nonNull.joinToString(separator = "\n") { unwrapJsonValue(it) ?: "" }.ifBlank { null }
            }
            else -> value.toString().takeIf { it.isNotBlank() }
        }
    }

    /** 把 JsonPath 取出的 Java Map/List 递归序列化为合法 JSON 文本。 */
    private fun toJsonText(value: Any?): String = runCatching {
        Json.encodeToString(JsonElement.serializer(), toJsonElement(value))
    }.getOrElse { value?.toString() ?: "" }

    private fun toJsonElement(value: Any?): JsonElement = when (value) {
        null -> JsonNull
        is JsonElement -> value
        is String -> JsonPrimitive(value)
        is Number -> JsonPrimitive(value)
        is Boolean -> JsonPrimitive(value)
        is Map<*, *> -> JsonObject(value.entries.associate { (key, item) -> key.toString() to toJsonElement(item) })
        is Iterable<*> -> JsonArray(value.map { toJsonElement(it) })
        else -> JsonPrimitive(value.toString())
    }

    private fun valueJson(rule: String): String? {
        // Legado 规则语法 `路径##正则##替换`：必须先剥离 ## 部分再交给 JsonPath，
        // 否则整串会当成 JSON 路径解析失败，条目会被 mapNotNull 全部丢弃（表现为搜索 0 结果）。
        val pathPart = rule.substringBefore("##").trim()
        val template = BRACE_TEMPLATE.replace(pathPart) { match ->
            val inner = match.groupValues[1].trim()
            unwrapJsonValue(readJson(inner)) ?: ""
        }
        // Legado 的裸键简写：JSON 规则里写 `book_name` 等价于 `$.book_name`（番茄等官方接口源大量使用）。
        // 不展开的话这里会把规则文本本身当成值返回，详情书名变成「book_name」、章节标题变成「title」。
        val path = when {
            template.startsWith("$") || template.startsWith("@") -> template
            BARE_JSON_KEY.matches(template) -> "\$.$template"
            else -> return applyRegexReplace(template, rule).takeIf { it.isNotBlank() }
        }
        val raw = unwrapJsonValue(readJson(path)) ?: return null
        return applyRegexReplace(raw, rule).takeIf { it.isNotBlank() }
    }

    /** Legado 的 `##正则##替换` 语法：成对出现，替换串缺省为空串。 */
    private fun applyRegexReplace(value: String, rule: String): String {
        if (!rule.contains("##")) return value
        val parts = rule.split("##")
        var result = value
        var index = 1
        while (index < parts.size) {
            val pattern = parts[index]
            val replacement = if (index + 1 < parts.size) parts[index + 1] else ""
            if (pattern.isNotBlank()) {
                result = runCatching { result.replace(Regex(pattern), replacement) }.getOrDefault(result)
            }
            index += 2
        }
        return result
    }

    /**
     * 找整条规则里**花括号外**的第一个 `##`（`##正则##替换` 段的起点），没有则 -1。
     *
     * 深度口径与 [splitLegadoBranches] 的 `topLevelSeparators` 一致：`{}`/`[]` 里的 `##`
     * 属于占位符或 JSONPath 谓词自己的内容（如 `{{$.create_time##T|\+.*## }}`），
     * 不能当成整条规则的替换段 —— 直接 `split("##")` 会把两段错位配对，替换结果整个跑偏。
     */
    private fun firstTopLevelHashIndex(rule: String): Int {
        var depth = 0
        var quote: Char? = null
        var index = 0
        while (index < rule.length - 1) {
            val ch = rule[index]
            when {
                quote != null -> if (ch == quote) quote = null
                ch == '\'' || ch == '"' -> quote = ch
                ch == '{' || ch == '[' -> depth++
                ch == '}' || ch == ']' -> depth = (depth - 1).coerceAtLeast(0)
                ch == '#' && depth == 0 && rule[index + 1] == '#' -> return index
            }
            index++
        }
        return -1
    }

    private fun readJson(path: String): Any? = runCatching {
        val clean = path.trim()
        val normalized = if (clean.startsWith("$")) clean else if (clean.startsWith("..")) "$.$clean" else "$.$clean"
        JsonPath.read<Any>(json, normalized)
    }.getOrNull()

    companion object {
        /** Legado JSON 规则里的裸键简写（`book_name` == `$.book_name`）。 */
        private val BARE_JSON_KEY = Regex("[A-Za-z_][\\w-]*(\\.[A-Za-z_][\\w-]*)*")
        /** `{{}}` 文本模板：value() 与 valueJson() 都要走，提到类级只编译一次（每字段取值都路过）。 */
        private val BRACE_TEMPLATE = Regex("\\{\\{(.*?)}}")
        private val JS_IDENT_PREFIX = Regex("^(?:java|cookie|source|book|chapter|result|baseUrl|key|page)\\b")
        private val PUT_VARIABLE = Regex("@put:\\{([^{}]*?)\\}", RegexOption.IGNORE_CASE)
        private val GET_VARIABLE = Regex("@get:\\{([^{}]*?)\\}", RegexOption.IGNORE_CASE)

        fun html(element: Element) = NodeValue(element, null)
        fun document(body: String) = if (body.trimStart().startsWith("{") || body.trimStart().startsWith("[")) {
            NodeValue(null, JsonPath.parse(body).json<Any>())
        } else {
            NodeValue(Jsoup.parse(body), null)
        }
        fun json(value: Any?) = NodeValue(null, value)
    }
}

internal val XPATH_PREFIX = Regex("""^@(?:xpath|xp)\s*:\s*""", RegexOption.IGNORE_CASE)

// 选择器方言的六种段形态（`selectLegadoSegment` 用）：最热的取值路径，只编译一次
private val ID_ONLY = Regex("^id\\.([a-zA-Z0-9_-]+)$")
private val TAG_ONLY = Regex("^tag\\.([a-zA-Z0-9_-]+)$")
private val CLASS_ONLY = Regex("^class\\.([a-zA-Z][a-zA-Z0-9_-]*)$")
private val TAG_INDEXED = Regex("^([a-zA-Z][a-zA-Z0-9-]*)\\.(\\d+)$")
private val CLASS_INDEXED = Regex("^class\\.([a-zA-Z][a-zA-Z0-9_-]*)\\.(\\d+)$")
private val CLASS_DOT_INDEXED = Regex("^\\.([a-zA-Z][a-zA-Z0-9_-]*)\\.(\\d+)$")
// 段内索引写法 `class.foo.0:1:2` / `tag.div.-1:10:2`（上游 findIndexSet 的另一种写法）
private val CLASS_INDEX_SPEC = Regex("^class\\.([a-zA-Z][a-zA-Z0-9_-]*)\\.([-\\d][\\d,:\\-]*)$")
private val TAG_INDEX_SPEC = Regex("^tag\\.([a-zA-Z][a-zA-Z0-9-]*)\\.([-\\d][\\d,:\\-]*)$")

internal fun isXpathRule(rule: String): Boolean {
    val r = rule.trim()
    // 对齐原版 AnalyzeRule：显式 @xpath:/@xp: 前缀，或以 "/" 开头的裸 XPath（真实书源常不带前缀）都判为 XPath。
    // CSS 选择器不会以 "/" 开头、JSONPath 以 "$" 开头，故无副作用。
    return XPATH_PREFIX.containsMatchIn(r) || r.startsWith("/")
}

// @json: 显式前缀（原版 ruleStr.startsWith("@Json:")）：去掉后按 JSONPath 求值。
internal val JSON_PREFIX = Regex("""^@json\s*:\s*""", RegexOption.IGNORE_CASE)

internal fun isJsonPrefixedRule(rule: String): Boolean = JSON_PREFIX.containsMatchIn(rule.trim())

internal fun stripJsonPrefix(rule: String): String = JSON_PREFIX.replace(rule.trim(), "").trim()

internal fun stripXpathPrefix(rule: String): String = XPATH_PREFIX.replace(rule.trim(), "").trim()

/**
 * Legado 的选择器链（上游 `AnalyzeByJSoup.ElementsSingle.getElementsSingle`）：
 * `class.a@tag.li@text`、`id.list@tag.dd`、`class.BOX@tag.tr!0`、`class.cover@children`。
 *
 * 列表规则与字段规则**必须走同一套**：列表规则原来只把各段用空格拼成一条 CSS，
 * 于是 `@tag.` / `@id.` / `@children` 这些方言段被当成标签名去查，整条规则一条都选不出来
 * （本机 11,280 条非 JS 列表规则里 2,164 条带 `tag.`、1,063 条带 `id.`、30 条带 `children`）。
 *
 * 尾段是取值模式（`text` / `href` / `html` / `attr(x)` …）时不参与选元素 —— 那是字段取值层的事。
 */
internal fun selectLegadoSegments(element: Element, selector: String): List<Element> {
    // 显式 `@css:` 前缀（上游 SourceRule.isCss）只是「这是原生 CSS」的标记，不是选择器的一部分；
    // 不剥掉的话首段变成 `css:ul.chapter-list > li`，Jsoup 报 unexpected token at '.chapter-list'。
    val cleaned = selector.trim().let { if (it.startsWith("@css:", ignoreCase = true)) it.substring(5).trim() else it }
    val segments = cleaned.split('@').map { it.trim() }.filter { it.isNotEmpty() }
    if (segments.isEmpty()) return listOf(element)
    var current = listOf(element)
    for ((index, segment) in segments.withIndex()) {
        if (index == segments.lastIndex && isValueModeSegment(segment)) break
        current = current.flatMap { selectLegadoSegment(it, segment) }
        if (current.isEmpty()) return emptyList()
    }
    return current
}

/** 上游 `getResultLast` 认的取值模式段；出现在链尾时说明前面都是选元素。 */
private fun isValueModeSegment(segment: String): Boolean {
    val s = segment.trim()
    // 注意 `children` **不是**取值模式：上游 ElementsSingle 把它当选择器（取子元素）。
    return s in setOf("text", "href", "src", "content", "html", "textNodes", "textNode", "ownText", "all") ||
        s.startsWith("attr(") || s.startsWith("text(")
}

/**
 * 单段选择器：`tag.li` / `id.list` / `class.a` / `children` / `.a` / `li.0` / `li!0` / `[1]` / 原生 CSS。
 *
 * **不吞异常**：写坏的 CSS（`class.x@tag.li[[`）必须抛出去 —— 调用方会把它接成
 * 「RuleExecutionException: SelectorParseException…」摆到体检与界面上。静默返回空列表的话，
 * 「规则写坏了」与「站点真的没内容」就再也分不开（极速漫画那条缺陷正是靠这句报错定位的）。
 *
 * 注意：**字段取值**那一层会自己吞掉异常（上游 `getResultLast` 同样不抛），见 [valuePlain]。
 */
private fun selectLegadoSegment(element: Element, selector: String): List<Element> {
    val trimmed = selector.trim()
    if (trimmed.isEmpty()) return emptyList()
    if (trimmed == "children") return element.children().toList()
    val (base, ops) = splitIndexSuffix(trimmed)
    if (ops.isNotEmpty()) {
        if (base.isBlank()) return applyIndexTokens(element.children().toList(), ops)
        return applyIndexTokens(selectLegadoSegment(element, base), ops)
    }
    val idOnly = ID_ONLY.find(trimmed)
    if (idOnly != null) {
        val el = element.getElementById(idOnly.groupValues[1])
        return if (el != null) listOf(el) else emptyList()
    }
    val tagOnly = TAG_ONLY.find(trimmed)
    if (tagOnly != null) {
        return element.getElementsByTag(tagOnly.groupValues[1]).toList()
    }
    // `class.foo.0:1:2` / `tag.div.-1:10:2`：索引写在段里而不是 `[]`/`!` 后缀
    // （上游 `findIndexSet` 的另一种写法，真实语料里 `.book_tag.0:1:2` 就是它）。
    val classSpec = CLASS_INDEX_SPEC.find(trimmed)
    if (classSpec != null) {
        val matches = element.select(".${classSpec.groupValues[1]}")
        return applyIndexTokens(matches.toList(), listOf(classSpec.groupValues[2]))
    }
    val tagSpec = TAG_INDEX_SPEC.find(trimmed)
    if (tagSpec != null) {
        val matches = element.getElementsByTag(tagSpec.groupValues[1])
        return applyIndexTokens(matches.toList(), listOf(tagSpec.groupValues[2]))
    }
    val classOnly = CLASS_ONLY.find(trimmed)
    if (classOnly != null) {
        return element.select(".${classOnly.groupValues[1]}")
    }
    val indexed = TAG_INDEXED.find(trimmed)
    if (indexed != null) {
        val tag = indexed.groupValues[1]
        val ordinal = indexed.groupValues[2].toInt().coerceAtLeast(0)
        val matches = element.getElementsByTag(tag)
        return matches.getOrNull(ordinal)?.let { listOf(it) } ?: emptyList()
    }
    val classIndexed = CLASS_INDEXED.find(trimmed)
        ?: CLASS_DOT_INDEXED.find(trimmed)
    if (classIndexed != null) {
        val className = classIndexed.groupValues[1]
        val ordinal = classIndexed.groupValues[2].toInt().coerceAtLeast(0)
        val matches = element.select(".$className")
        return matches.getOrNull(ordinal)?.let { listOf(it) } ?: emptyList()
    }
    return element.select(trimmed)
}

/** JXDocument 2.5.1 只吃 Document / Elements / String / List，不接受裸 Node，这里按类型适配。 */
internal fun jx(node: Node): JXDocument = when (node) {
    is Document -> JXDocument(node)
    is Element -> JXDocument(Elements(listOf(node)))
    else -> JXDocument(node.toString())
}

/** 列表选择：从文档/元素出发按 xpath 选出节点。元素结果包成可继续取值的 html 节点，文本/属性结果当作文本节点。 */
internal fun xpathNodes(node: Node, path: String): List<NodeValue> =
    runCatching {
        jx(node).sel(path).mapNotNull { item ->
            when (item) {
                is Element -> NodeValue.html(item)
                is TextNode -> NodeValue.document(item.getWholeText())
                null -> null
                else -> NodeValue.document(item.toString())
            }
        }
    }.getOrDefault(emptyList())

/** 字段取值：按 xpath 求值后把结果统一成文本（Element 取可见文本，TextNode/属性取文本）。 */
internal fun xpathTexts(node: Node, path: String): List<String> =
    runCatching {
        jx(node).sel(path).mapNotNull { item ->
            when (item) {
                is Element -> item.text().ifBlank { item.wholeText().ifBlank { null } }
                is TextNode -> item.getWholeText().ifBlank { null }
                null -> null
                else -> item.toString().ifBlank { null }
            }
        }
    }.getOrDefault(emptyList())
