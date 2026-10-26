package io.legado.rules

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * 规则切分层：对应上游 model/analyzeRule/RuleAnalyzer —— 先把整条规则切成分支、内联 JS 段、索引段，再交给取值层。
 */

/**
 * 切分 Legado 的 `a||b||c` 备选规则，只在 `{{…}}` 之外切：
 * `{{$.book_id||$.BookID}}` 里的 `||` 属于占位符内部的路径备选，不能当外层分支。
 */
internal fun splitLegadoAlternatives(rule: String): List<String> {
    val (separator, parts) = splitLegadoBranches(rule)
    return if (separator == "||") parts else listOf(rule.trim()).filter { it.isNotEmpty() }
}

/**
 * `@put:{…}` 里可以有**多个**键值对。上游 `AnalyzeRule.splitPutRule` 把整段当 map 解析
 * （先严格 JSON，失败再走宽松 GSON 并提示「≡@put 规则 JSON 格式不规范」），
 * 我们以前只 `substringBefore(':')` 取第一个键，其余全丢 —— 实测库里 `@put` 出现 492 次、
 * 其中 **278 次是多键**（普查见 tools/verify/context-dialect-census.mjs），
 * 于是引用 `@get:{第二个键}` / `{{第二个键}}` 的位置恒为空，整源取不到值还不报错。
 *
 * 现网三种形状都得吃：裸键 `{sid:$.sandboxId,smg:$.magic}`（最多）、带换行的准 JSON、
 * 严格 JSON。值里可能含 `:` `,` `[]` `{}`（如 `@js:[{a:1,b:2}]`），
 * 所以按**顶层**逗号切，跳过引号与嵌套括号。
 */
internal fun putPairs(body: String): List<Pair<String, String>> {
    parseStrictPutJson(body)?.let { return it }
    val pairs = mutableListOf<Pair<String, String>>()
    var start = 0
    while (start < body.length) {
        val colon = indexOfOutsideQuotes(body, start, ':') ?: break
        val key = body.substring(start, colon).trim().removeSurrounding("\"").removeSurrounding("'")
        val comma = indexOfTopLevelChar(body, colon + 1, ',') ?: body.length
        val value = body.substring(colon + 1, comma).trim().removeSurrounding("\"")
        if (key.isNotEmpty() && value.isNotEmpty()) pairs += key to value
        start = comma + 1
    }
    return pairs
}

/** 严格 JSON 形状（`{"n":"$.name"}`）优先，成对顺序与书写一致。 */
private fun parseStrictPutJson(body: String): List<Pair<String, String>>? = runCatching {
    val root = Json.parseToJsonElement("{$body}") as? JsonObject ?: return null
    root.map { (key, value) ->
        key to when (value) {
            is JsonPrimitive -> value.content
            else -> value.toString()
        }
    }.takeIf { it.isNotEmpty() && it.all { pair -> pair.first.isNotBlank() && pair.second.isNotBlank() } }
}.getOrNull()

/** 只在引号之外找第一个 ch（键名里不会有引号，所以键的搜索不必看括号深度）。 */
private fun indexOfOutsideQuotes(text: String, from: Int, ch: Char): Int? {
    var quote: Char? = null
    for (index in from until text.length) {
        val current = text[index]
        if (quote != null) {
            if (current == quote) quote = null
        } else if (current == '\'' || current == '"') {
            quote = current
        } else if (current == ch) {
            return index
        }
    }
    return null
}

/** 在引号与嵌套括号之外找第一个 ch —— 值里的 `[{a:1,b:2}]` 不能被从中间劈开。 */
private fun indexOfTopLevelChar(text: String, from: Int, ch: Char): Int? {
    var quote: Char? = null
    var depth = 0
    for (index in from until text.length) {
        val current = text[index]
        when {
            quote != null -> if (current == quote) quote = null
            current == '\'' || current == '"' -> quote = current
            current == '{' || current == '[' -> depth++
            current == '}' || current == ']' -> depth = (depth - 1).coerceAtLeast(0)
            depth == 0 && current == ch -> return index
        }
    }
    return null
}

/**
 * Legado 的分支规则（上游 `RuleAnalyzer.splitRule("&&","||","%%")` 的三种组合类型）：
 *
 * - `||` 取第一个有结果的分支；
 * - `&&` 把**每个**分支的结果并集起来（`AnalyzeByJSoup.getElements` 里 `elements.addAll(es)`）；
 * - `%%` 把各分支结果**按位交错**（`for (i in results[0].indices) for (temp in results)`）。
 *
 * **无优先级、最左边的分隔符说了算**，并且切分要跳过 `{{…}}`、`[…]`（JSONPath 过滤谓词里本来就带
 * `&&`/`||`）、引号与 `##正则##` 段，否则 `$.book[?(@.price<10 && @.cat=="x")]` 会被从中间劈开。
 *
 * 为什么必须认 `&&`：本机 5,574 个源里 79 条非 JS 列表规则写的是 `&&`
 * （极速漫画 `class.banner_detail_form&&class.mh-list@tag.li`、小说天堂 `class.chapters@…%%…`）。
 * 只切 `||` 时整串被当成一个 CSS 选择器交给 Jsoup，报
 * `SelectorParseException: unexpected token at '&&class.mh-list tag.li'` —— 表现为该源搜索 0 条。
 */
internal fun splitLegadoBranches(rule: String): Pair<String?, List<String>> {
    val separators = topLevelSeparators(rule)
    val separator = separators.firstOrNull()?.second ?: return null to listOf(rule.trim()).filter { it.isNotEmpty() }
    val parts = mutableListOf<String>()
    var start = 0
    for ((index, token) in separators.filter { it.second == separator }) {
        parts += rule.substring(start, index)
        start = index + token.length
    }
    parts += rule.substring(start)
    return separator to parts.map { it.trim() }.filter { it.isNotEmpty() }
}

private fun topLevelSeparators(rule: String): List<Pair<Int, String>> {
    val found = mutableListOf<Pair<Int, String>>()
    var depth = 0
    var quote: Char? = null
    var index = 0
    while (index < rule.length) {
        val ch = rule[index]
        when {
            quote != null -> if (ch == quote) quote = null
            ch == '\'' || ch == '"' -> quote = ch
            ch == '{' || ch == '[' -> depth++
            ch == '}' || ch == ']' -> depth = (depth - 1).coerceAtLeast(0)
            ch == '#' && rule.startsWith("##", index) -> {
                val end = rule.indexOf("##", index + 2)
                index = if (end < 0) rule.length else end + 1
            }
            depth == 0 && rule.startsWith("||", index) -> { found += index to "||"; index++ }
            depth == 0 && rule.startsWith("&&", index) -> { found += index to "&&"; index++ }
            depth == 0 && rule.startsWith("%%", index) -> { found += index to "%%"; index++ }
        }
        index++
    }
    return found
}

/**
 * 在 `{{…}}` 之外找内联 JS 分隔符，返回「位置 + 分隔符长度」。
 * 行首的 `@js:` 由调用方先行处理，所以只认下标 > 0 的情况。
 */
internal fun findInlineJsMarker(rule: String): Pair<Int, Int>? {
    var depth = 0
    var index = 0
    while (index < rule.length) {
        when (val ch = rule[index]) {
            '{' -> depth++
            '}' -> depth = (depth - 1).coerceAtLeast(0)
            '@' -> if (depth == 0 && rule.startsWith("@js:", index)) return index to 4
            'j' -> if (depth == 0 && rule.startsWith("js:", index) &&
                (index == 0 || rule[index - 1] == ' ' || rule[index - 1] == '\n')
            ) return index to 3
        }
        index++
    }
    return null
}

/**
 * Legado 选择器尾部的**索引段**（上游 `AnalyzeByJSoup` 的「索引列表处理器」）：
 * `tag!0,2` 从结果列表里排除第 0、2 个，`tag[1]`/`tag[-1]` 取第 2 个/最后一个，
 * `tag[1:4]`、`tag[0:6:2]` 是区间与步长。负数一律从尾部数。
 *
 * 注意 `[attr=val]` 这种 CSS 属性选择器**不是**索引，内容必须是数字/冒号/逗号/负号才算。
 * 以前 `!N` 被映射成 `:not(:nth-child(N+1))`：nth-child 数的是同一父元素下的兄弟，
 * 而 Legado 数的是**这条规则匹配到的列表**，两者在真实 DOM 里通常不等，取错元素还不报错。
 */
internal fun splitIndexSuffix(rule: String): Pair<String, List<String>> {
    val tokens = mutableListOf<String>()
    var text = rule.trimEnd()
    while (text.isNotEmpty()) {
        if (text.endsWith("]")) {
            val open = text.lastIndexOf('[')
            val inner = if (open >= 0) text.substring(open + 1, text.length - 1) else ""
            if (open < 0 || !Regex("[\\d\\s,:\\-]+").matches(inner) || !inner.any { it.isDigit() }) break
            tokens.add(0, inner)
            text = text.substring(0, open).trimEnd()
        } else {
            val match = Regex("!([\\d\\s,:\\-]*)$").find(text) ?: break
            val inner = match.groupValues[1]
            if (!inner.any { it.isDigit() }) break
            tokens.add(0, "!$inner")
            text = text.substring(0, match.range.first).trimEnd()
        }
    }
    return text to tokens
}

/** 把索引段作用到已匹配列表上（保持文档顺序）。 */
internal fun <T> applyIndexTokens(input: List<T>, tokens: List<String>): List<T> {
    var current = input
    for (token in tokens) {
        if (current.isEmpty()) return emptyList()
        current = if (token.startsWith("!")) {
            val drop = parseIndexSpec(token.removePrefix("!"), current.size).toSet()
            current.filterIndexed { index, _ -> index !in drop }
        } else {
            parseIndexSpec(token, current.size).mapNotNull { current.getOrNull(it) }
        }
    }
    return current
}

/** `3` 单个、`0,2` 多选、`1:4` 区间、`0:6:2` 带步长；负数从尾部数。 */
internal fun parseIndexSpec(spec: String, size: Int): List<Int> {
    val out = mutableListOf<Int>()
    for (raw in spec.split(',')) {
        val part = raw.trim()
        if (part.isEmpty()) continue
        if (':' in part) {
            val bits = part.split(':').map { it.trim() }
            val start = bits.getOrNull(0)?.toIntOrNull() ?: 0
            val end = bits.getOrNull(1)?.toIntOrNull() ?: size
            val step = bits.getOrNull(2)?.toIntOrNull()?.takeIf { it > 0 } ?: 1
            var index = if (start < 0) start + size else start
            val stop = if (end < 0) end + size else end
            while (index < stop && index < size) {
                if (index >= 0) out += index
                index += step
            }
        } else {
            val value = part.toIntOrNull() ?: continue
            out += if (value < 0) value + size else value
        }
    }
    return out
}
