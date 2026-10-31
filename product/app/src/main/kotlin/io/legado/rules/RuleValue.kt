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

internal class NodeValue private constructor(
    private val html: Element?,
    private val json: Any?,
    /**
     * 这个节点代表「整份响应文档」时，这里是它来自的原文（上游 AnalyzeRule 的 `content`）。
     * 文档级 `@js:` 的 `result` 要绑它：JSON 源靠 `JSON.parse(String(result))` 自己解析。
     * 注意 init 规则会把输出再包成文档节点，此时原文是 init 的输出而不是 HTTP 正文。
     */
    private val rootText: String? = null,
    /**
     * AllInOne 正则条目（上游 `AnalyzeByRegex.getElements` 的一次匹配）：下标就是字段规则里
     * `$N` 的 N，`groups[0]` 是整个匹配。非 null 时这个节点**不代表文档片段**，字段规则改走
     * [regexItemValue] —— 分组替换出来的字面量就是值，不再当选择器 / JSONPath 求值。
     */
    private val groups: List<String>? = null,
) {
    private val ruleVariables = mutableMapOf<String, String>()

    fun value(rule: String?, jsSandbox: JsSandbox? = null, rawBody: String? = null, baseUrl: String? = null): String? {
        if (rule.isNullOrBlank()) return null
        // `:` 起头的列表规则产出的条目：字段规则是 `$1`/`$2` 这种分组引用，另有一条链（见 regexItemValue）
        groups?.let { return regexItemValue(rule.trim(), it, jsSandbox, rawBody, baseUrl) }
        var trimmedRule = rule.trim()

        // `@put:{key:规则}` 求值后存进变量表并从规则串里剔除，`@get:{key}` 再取回。
        // 上游把这张表挂在 ruleData 上，所以同一个 `name` 里 put、`tocUrl` 里 get 是合法的，
        // 变量表必须跟着「本次解析的节点」走，而不是单次 value() 调用。
        trimmedRule = storePutVariables(trimmedRule, jsSandbox, rawBody, baseUrl)
        trimmedRule = substituteGetVariables(trimmedRule)
        if (trimmedRule.isBlank()) return null

        // `规则前段 + @js:` 要在切 `##` **之前**分开：`##"url":"(.*)"##$1###@js:…` 里
        // `@js:` 之前的部分（连同它的正则替换段）先求值成字符串，作为 `result` 交给脚本收尾。
        // 以前先按 ## 切替换段，`@js:` 被一起吞进替换串、主干变成空串，整条规则取不到值 ——
        // 番茄短剧一类视频源（本机库 293 条字段规则是这种形状）的直链全丢。
        if (!trimmedRule.contains("<js>")) {
            val inlineMarker = findInlineJsMarker(trimmedRule)
            if (inlineMarker != null && inlineMarker.first > 0) {
                val preRule = trimmedRule.substring(0, inlineMarker.first).trim()
                val jsCode = trimmedRule.substring(inlineMarker.first + inlineMarker.second).trim()
                val base = value(preRule, jsSandbox, rawBody, baseUrl).orEmpty()
                if (jsCode.isBlank()) return base
                val src = rawBody ?: base
                return jsSandbox?.eval(
                    jsCode,
                    mapOf("result" to base, "src" to src, "baseUrl" to (baseUrl ?: "")),
                ) ?: base
            }
        }

        // Legado 的 `##正则##替换` 是整条规则的**最后一步**：先求值主规则，再拿结果做替换。
        // 必须在 `{{}}` 展开之前就把「花括号外」的替换段摘出来 —— 否则模板展开后整条
        // （连同指令原文）一起过替换，模式会把指令自身也改写一遍，`##…##$1<br>` 反而留在
        // 简介里（用户 2026-10-09：00小说网的简介规则正是「模板 + 尾部 ##…##$1<br>」）。
        // 花括号里的 `##` 属于占位符自己的替换（`{{$.create_time##T|\+.*## }}`），不在这一层摘。
        val hashCut = if (trimmedRule.contains("##")) firstTopLevelHashIndex(trimmedRule) else -1
        val replaceSuffix = if (hashCut >= 0) trimmedRule.substring(hashCut) else ""
        if (replaceSuffix.isNotEmpty()) trimmedRule = trimmedRule.substring(0, hashCut)

        // 整条规则从 `##` 起头（本机库 458 条字段规则这么写，如起点 `##data-bid="([^"]+)"##…$1###`）：
        // 上游此时 `rule` 为空、跳过取值，直接拿**当前内容原文**做替换。以前返回空值，
        // 这些源的 bookUrl / coverUrl / 字段全取不到。
        val result =
            if (trimmedRule.isBlank() && replaceSuffix.isNotEmpty()) ruleContentText(rawBody)
            else evaluateRule(trimmedRule, jsSandbox, rawBody, baseUrl)
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
            val templated = expandBraces(trimmedRule, jsSandbox, rawBody, baseUrl)
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
            // 脚本失败不再拿整页正文冒充字段值：JSON 文档的兜底是 Java Map 的 toString
            // （`{msg=0, ret=0, …}`），调用方会把它当**非空结果**继续用 —— 喜马拉雅（音频源）
            // 的 nextTocUrl 脚本一失败，整段目录 JSON 就被当成「下一页地址」，
            // 报「URL 格式无效或包含未解析变量」。留空让上层如实报「取到空值」。
            return evaluateJs(jsSandbox, jsCode, rawBody, baseUrl)
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
            // **没有前缀段**时，`<js>` 与 `@js:` 在上游是同一件事（都是 Mode.Js，result 绑当前内容），
            // 所以走同一条 evaluateJs：脚本没跑出结果就**如实为空**。以前这里回退成整页原文，
            // 食在广州的 `name` 因此变成《<!doctype html> <html lang="zh-CN">…》，
            // 书名、书架、搜索记录一起被这串脏掉，调试面板还显示成「取到值了」。
            if (preRule.isBlank() && jsCode.isNotBlank()) {
                val evaluated = evaluateJs(jsSandbox, jsCode, rawBody, baseUrl) ?: return null
                return if (postRule.isBlank()) evaluated
                else NodeValue.document(evaluated).value(postRule, jsSandbox, evaluated, baseUrl)
            }
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

    /**
     * `{{…}}` 占位符展开（上游 `evalPattern` 里的 jsRuleType 分支）：花括号里既可以写取值路径，
     * 也可以写一整段 JS（`{{java.timeFormat(…)}}`），还可能是 `@put:` 存下的变量名。
     * 普通规则链与 AllInOne 正则条目共用这一份。
     */
    private fun expandBraces(rule: String, jsSandbox: JsSandbox?, rawBody: String?, baseUrl: String?): String =
        BRACE_TEMPLATE.replace(rule) { match ->
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

    /**
     * AllInOne 正则条目的字段取值（上游 `Mode.Regex`）。
     *
     * `bookList` / `chapterList` 以 `:` 起头时，上游把**整页原文**交给 `AnalyzeByRegex.getElements`，
     * 一个条目就是「一次匹配的全部分组」；字段规则于是写成 `$1`/`$2`，`makeUpRule` 把它们替换成
     * 分组文本之后，`getString` 的 `when(mode)` **没有 Regex 分支** —— 落到 `else -> rule`，
     * 也就是「替换出来的字面量就是值」，不再当 CSS 选择器 / JSONPath 求值。
     * `@put:`/`@get:{}`、`{{}}`、`##正则##替换`、`@js:`、`<js>…</js>` 照旧生效
     * （上游同样先做这些、再拼字面量；连 JS 代码里的 `$N` 都会被替换，
     * 起点中文的 `<js>java.timeFormat($3)</js>` 正是靠这一步拿到时间戳）。
     *
     * 为什么要做：本机 23 个启用源是这种形状（天涯知识 `:a href="(.*?)"\s+target="_blank">(.*?)<`、
     * 起点中文 `:\{"C":(\d+),…`、黑岩 `:(?s)(\d+)" class="…`），以前一律报
     * `SelectorParseException：Could not parse query ':a href="(.*?)"…'`，整源搜索/目录 0 条。
     */
    private fun regexItemValue(
        rule: String,
        items: List<String>,
        jsSandbox: JsSandbox?,
        rawBody: String?,
        baseUrl: String?,
    ): String? {
        // `<js>…</js>` 段（上游 JS_PATTERN 先切分）：主段的值作为 result 交给脚本，`</js>` 之后还能再接规则
        if (rule.contains("<js>") && rule.contains("</js>")) {
            val preRule = rule.substringBefore("<js>").trim()
            val jsCode = substituteGroups(rule.substringAfter("<js>").substringBefore("</js>"), items)
            val postRule = rule.substringAfter("</js>").trim()
            val base = if (preRule.isEmpty()) "" else regexLiteral(preRule, items, jsSandbox, rawBody, baseUrl).orEmpty()
            // 无前缀段时上游交给脚本的 `result` 是**这个条目本身**（一次匹配的全部分组），
            // 不是空串 —— 脚本里 `result[1]` 取的就是 1 号分组。有前缀段时才用前缀替出来的字面量。
            val binding: Any = if (preRule.isEmpty()) items else base
            val evaluated = jsSandbox?.eval(
                jsCode,
                mapOf("result" to binding, "src" to (rawBody ?: base), "baseUrl" to (baseUrl ?: "")),
            ) ?: base
            if (postRule.isBlank()) return evaluated
            return NodeValue.document(evaluated).value(postRule, jsSandbox, evaluated, baseUrl)
        }
        val marker = findInlineJsMarker(rule)
        if (marker != null && marker.first > 0) {
            val preRule = rule.substring(0, marker.first).trim()
            val jsCode = rule.substring(marker.first + marker.second).trim()
            val base = regexLiteral(preRule, items, jsSandbox, rawBody, baseUrl).orEmpty()
            if (jsCode.isBlank()) return base
            return jsSandbox?.eval(
                jsCode,
                mapOf("result" to base, "src" to (rawBody ?: base), "baseUrl" to (baseUrl ?: "")),
            ) ?: base
        }
        if (rule.startsWith("@js:") || rule.startsWith("js:")) {
            val jsCode = substituteGroups(rule.removePrefix("@js:").removePrefix("js:").trim(), items)
            return jsSandbox?.eval(
                jsCode,
                // 同上：`@js:` 段的 result 也是条目本身（全部分组），脚本可用 `result[1]`
                mapOf("result" to items, "src" to (rawBody ?: ""), "baseUrl" to (baseUrl ?: "")),
            )
        }
        return regexLiteral(rule, items, jsSandbox, rawBody, baseUrl)
    }

    /**
     * 正则条目的「主段」：`@put:` → `@get:{}` → `##` 替换段摘出 → `{{}}` 展开 → `$N` 替换 → 正则替换。
     * 分组替换刻意排在 `{{}}` 之后：分组文本是站点原文，不能让它再被当成模板 / 脚本展开一次。
     */
    private fun regexLiteral(
        rule: String,
        items: List<String>,
        jsSandbox: JsSandbox?,
        rawBody: String?,
        baseUrl: String?,
    ): String? {
        var text = substituteGetVariables(storePutVariables(rule, jsSandbox, rawBody, baseUrl))
        // 替换段要在 `{{}}` 展开**之前**摘出来（与 value() 同一口径，见那里的注释）
        val hashCut = if (text.contains("##")) firstTopLevelHashIndex(text) else -1
        val replaceSuffix = if (hashCut >= 0) text.substring(hashCut) else ""
        if (hashCut >= 0) text = text.substring(0, hashCut)
        if (text.contains("{{") && text.contains("}}")) text = expandBraces(text, jsSandbox, rawBody, baseUrl)
        val literal = substituteGroups(text, items)
        // 整条从 `##` 起头（上游此时拿 `content.toString()` 做替换）：正则条目就用整个匹配（`$0`）
        val base = if (text.isBlank() && replaceSuffix.isNotEmpty()) items.firstOrNull().orEmpty() else literal
        val result = if (replaceSuffix.isEmpty()) base else applyRegexReplace(base, replaceSuffix)
        return result.ifBlank { null }
    }

    /**
     * `$N` → 第 N 个分组（上游 `regexPattern = \$\d{1,2}`，所以 `$0`…`$99` 都认，`$0` 是整个匹配）。
     * 越界按空串：上游 `makeUpRule` 是 `if (this.size > regType)` 才插入，否则什么都不插。
     */
    private fun substituteGroups(rule: String, items: List<String>): String =
        GROUP_REF.replace(rule) { match -> items.getOrNull(match.value.substring(1).toInt()) ?: "" }

    private fun documentText(): String = html?.html() ?: json?.toString() ?: ""

    /**
     * `java.getElements` / `java.getElement` 交给脚本的**条目文本**，按上游给对象的形状来：
     * - HTML 条目 → `outerHtml`（上游给的是 Jsoup `Elements`，`toString` 就是 outerHtml，
     *   脚本常拿它再 `java.setContent(...)` 或直接正则取属性，少了开闭标签就取不到）；
     * - JSON 条目 → 合法 JSON 文本（脚本普遍 `JSON.parse` 再读字段）；
     * - AllInOne 正则条目 → 整个匹配（`$0`）；
     * - 文档节点 → 建节点时的原文。
     */
    internal fun bridgeText(): String = when {
        html != null -> html.outerHtml()
        json != null -> toJsonText(json)
        groups != null -> groups.firstOrNull().orEmpty()
        else -> rootText.orEmpty()
    }

    /**
     * 规则主干为空（`##正则##替换` 起头）时，正则作用的对象 —— 上游 `AnalyzeRule` 里的 `content`。
     * 文档节点优先用建节点时收到的**原文**（`rootText`）：`html.html()` 会把属性引号等重新序列化，
     * `##data-bid="([^"]+)"##` 这种按源码写的正则就对不上了。
     */
    private fun ruleContentText(rawBody: String?): String = when {
        rootText != null -> rootText
        json != null -> json.toString()
        // 条目节点用 outerHtml：上游 `replaceRegex(result.toString(), …)`，Element.toString 就是 outerHtml。
        // 用 innerHtml 会漏掉条目自身的属性（`##data-bid="…"##` 正是从条目标签上取的）。
        html != null -> html.outerHtml()
        else -> rawBody.orEmpty()
    }

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
        // 上游 AnalyzeRule 把 `result` 绑成「当前被解析的内容」：**文档级**规则拿到响应正文原文
        // （JSON 源正是靠 `JSON.parse(String(result))` 自己解析），条目级规则才拿到条目对象。
        //
        // 以前一律传 documentText()：JSON 文档得到的是 Java Map 的 toString（`{msg=0, ret=0, …}`），
        // 既不是合法 JSON 也不是原文 —— 喜马拉雅（音频源）的 nextTocUrl 里
        // `JSON.parse(String(result)).tracks.maxPageId` 必抛 SyntaxError，脚本失败后
        // 整段目录 JSON 又被当成「下一页地址」，目录直接取不到。
        val docText = documentText()
        val result: Any? = when {
            rootText != null -> rootText
            json != null -> json
            html != null -> html.html()
            else -> rawBody ?: docText
        }
        return jsSandbox?.eval(
            code,
            mapOf("result" to result, "src" to (rawBody ?: docText), "baseUrl" to (baseUrl ?: "")),
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
            val texts = when (rawMode) {
                // 上游 `AnalyzeByJSoup.getResultLast`：html 是**整组元素的 outerHtml**
                // （克隆后去掉 script/style），不是逐个元素的 innerHtml。
                // `<img src=…>` 的 innerHtml 恒为空，以前漫画源 `#cp_img@img@html`
                // 取回空串，整章图一张都出不来；文本源的外壳标签也会丢。
                "html" -> {
                    val clean = Elements(elements.map { it.clone() })
                    clean.select("script").remove()
                    clean.select("style").remove()
                    listOf(clean.outerHtml()).filter { it.isNotBlank() }
                }
                "all" -> listOf(Elements(elements).outerHtml()).filter { it.isNotBlank() }
                "text" -> elements.mapNotNull { it.text().takeIf(String::isNotBlank) }
                // 上游按文本节点取，再逐元素用换行拼（`<div>a<br>b</div>` 是两行）。
                "textNodes", "textNode" -> elements.mapNotNull { el ->
                    el.textNodes().map { it.text().trim() }.filter { it.isNotEmpty() }
                        .joinToString("\n").takeIf { it.isNotBlank() }
                }
                // 属性值按上游去重（同一张封面被选到两次时只留一条）。
                else -> elements.mapNotNull { el -> el.attr(rawMode).takeIf { it.isNotBlank() } }.distinct()
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
        // 上游 `makeUpRule` 只认前两段：parts[1] 是正则、parts[2] 是替换串；
        // **parts.size > 3（写成 `###` 收尾）是「只取第一个匹配段再做替换」的标记**，
        // 第四段本身不是第二条替换。以前把 `###` 尾巴又当正则跑一遍：617 个源的这类规则
        // 得到的是「全部匹配替换后的整段文字」（如 bookUrl 取到 `addToShelf(123,456)`），不是那个 id。
        val parts = rule.split("##")
        val pattern = parts.getOrNull(1).orEmpty()
        if (pattern.isBlank()) return value
        val replacement = parts.getOrNull(2).orEmpty()
        val regex = runCatching { Regex(pattern) }.getOrNull() ?: return value
        return if (parts.size > 3) {
            val match = regex.find(value) ?: return ""
            runCatching { match.value.replace(regex, replacement) }.getOrDefault("")
        } else {
            runCatching { value.replace(regex, replacement) }.getOrDefault(value)
        }
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
        /** 上游 `AnalyzeRule.regexPattern`：字段规则里的分组引用 `$0`…`$99`。 */
        private val GROUP_REF = Regex("\\$\\d{1,2}")

        fun html(element: Element) = NodeValue(element, null)
        fun document(body: String) = if (body.trimStart().startsWith("{") || body.trimStart().startsWith("[")) {
            NodeValue(null, JsonPath.parse(body).json<Any>(), rootText = body)
        } else {
            NodeValue(Jsoup.parse(body), null, rootText = body)
        }
        fun json(value: Any?) = NodeValue(null, value)

        /** AllInOne 正则条目：[groups] 是一次匹配的全部分组，下标对应字段规则里的 `$N`。 */
        fun regexItem(groups: List<String>) = NodeValue(null, null, groups = groups)
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
