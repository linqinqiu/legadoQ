package io.legado.rules

import com.jayway.jsonpath.JsonPath
import org.jsoup.Jsoup

/**
 * 规则 → 节点列表：把 `RuleRunner` 里「列表规则怎么取出一串条目」这一段整体搬出来。
 *
 * 为什么先拆这一段：它几乎不碰网络与 JS 沙箱（唯一的出口是构造时注入的 [jsList]），
 * 而 `GoldenRuleTest` 的 6 组 fixture 能逐字节比对，是 `RuleRunner`（2,549 行）里
 * 最容易证明「搬完行为没变」的一块。
 *
 * 调用方只需要给两样东西：求值运行时（日志 + 扩展点调度）和 JS 列表求值函数。
 */
internal class RuleNodeSelection(
    private val runtime: RuleRuntime,
    private val jsList: (base: NodeValue, listRule: String, body: String, baseUrl: String) -> List<NodeValue>,
) {

    /**
     * 给 JS 桥用的「再入」入口：对**任意内容**跑一次列表规则，把每条变成文本。
     *
     * 条目文本的口径见 [NodeValue.bridgeText]：HTML 给 outerHtml、JSON 给 JSON 文本。
     */
    fun listItemsByRule(content: String, rule: String, baseUrl: String?): List<String> {
        val listRule = stripListPrefixMarkers(rule)
        if (listRule.isEmpty()) return emptyList()
        val base = NodeValue.document(content, runtime)
        val nodes = if (isJsRule(listRule)) jsList(base, listRule, content, baseUrl ?: "") else nodes(content, listRule)
        return nodes.map { it.bridgeText() }
    }

    fun nodes(body: String, rule: String): List<NodeValue> {
        // `-` / `+` 是目录规则的「倒序 / 顺序」标记，可真实书源把它也写进了搜索规则
        // （🌸快眼看书™ `bookList: "+@css:.librarylist li"`）：这个前缀既不是 CSS 也不是方言，
        // 还会把开头的 `@css:` 挡在第二位（selectLegadoSegments 只认开头的标记），
        // 于是整条规则喂给 Jsoup 报回一句看不懂的「SelectorParseException：String must not be empty」，
        // 整个源搜索 0 条。前缀在非目录路径没有语义，剥掉再走正常分发即可
        // （chapters() / rssArticles() 自己会先剥好再进来，反转语义不受影响）。
        if (rule.startsWith("-") || rule.startsWith("+")) return nodes(body, stripListPrefixMarkers(rule))
        // `@css:` 是显式前缀（值规则那一侧早就认它，见 RuleValue.valuePlain）：列表这一侧以前不认，
        // 于是 `@css:.librarylist li` 被整串喂给选择器方言，报一句看不懂的解析异常、整源 0 条。
        if (rule.startsWith("@css:", ignoreCase = true)) return nodes(body, rule.substringAfter(':').trim())
        // 扩展点：列表规则只问声明了 producesNodes 的处理器；没人认领就落回内建链路。
        runtime.dispatcher.claimNodeRule(rule)?.let { processor ->
            val document = NodeValue.document(body, runtime)
            val result = runCatching { processor.execute(rule, document.inputFor(body), runtime) }
                .getOrElse { error ->
                    runtime.log("规则处理器 ${processor.type} 执行列表失败：${error.message ?: error::class.simpleName}")
                    return emptyList()
                }
            if (!result.ok) {
                runtime.log("规则处理器 ${processor.type} 报告列表失败：${result.error ?: "未给原因"}")
                return emptyList()
            }
            // 认领即拥有：条目为空就是「这个源确实没有条目」，不再退回内建链路。
            return result.nodes.map { NodeValue.json(it, runtime) }
        }
        // AllInOne 正则列表（上游 `splitSourceRule(ruleStr, allInOne = true)` 的「首字符是 `:`」分支）：
        // 整条规则是正则，一个条目 = 一次匹配的**全部分组**，字段规则用 `$1`/`$2` 取分组。
        // 必须排在 `&&` 分支切分**之前** —— 正则模式里 `&&` 是「多级正则」的分隔符
        // （快眼小说 `:正文卷[\s\S]*?/dl&&href ="([^"]+)">([^<]+)`），当成并集切整个语义就错了。
        if (rule.startsWith(":")) return regexNodes(body, rule.substring(1))
        // @xpath 方言优先：xpath 里的 `|` 并集不能被当成 Legado 的 `||` 备选来切分
        if (isXpathRule(rule)) return xpathNodes(Jsoup.parse(body), stripXpathPrefix(rule))
        // @json: 前缀（对齐原版 ruleStr.startsWith("@Json:")）：去前缀后按 JSONPath 读列表
        if (isJsonPrefixedRule(rule)) {
            val path = stripJsonPrefix(rule)
            return runCatching { (JsonPath.read<Any>(body, path) as? List<*>)?.map { NodeValue.json(it, runtime) } ?: emptyList() }.getOrDefault(emptyList())
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
            rule.startsWith("$") -> (JsonPath.read<Any>(body, rule) as? List<*>)?.map { NodeValue.json(it, runtime) } ?: emptyList()
            else -> {
                // JSON 响应上的「裸键」列表规则（`bookList: list`）：字段规则早就会把裸键补成 `$.list`
                // （见 RuleValue.valueJson），列表这一路却没补 —— 于是 `list` 被当成 CSS 标签名，
                // 整源搜索 0 条。实测样本是音频源 5sing：接口回 `{"list":[…]}`、规则写 `list`，
                // 站点本身 200 正常，界面上只有一句"一条都没有"。
                bareJsonListPath(body, rule)?.let { path ->
                    val viaJson = runCatching {
                        (JsonPath.read<Any>(body, path) as? List<*>)?.map { NodeValue.json(it, runtime) } ?: emptyList()
                    }.getOrDefault(emptyList())
                    if (viaJson.isNotEmpty()) return viaJson
                }
                // 列表规则与字段规则走同一套选择器方言（`class.a@tag.li` / `id.list@tag.dd` / `@children`）：
                // 原来这里只把各段用空格拼成一条 CSS，`tag.` / `id.` 段被当成标签名，整条规则一条都选不出来。
                val document = Jsoup.parse(body)
                val (base, ops) = splitIndexSuffix(rule)
                val selected = selectLegadoSegments(document, base).map({ element -> NodeValue.html(element, runtime) })
                if (ops.isEmpty()) selected else applyIndexTokens(selected, ops)
            }
        }
    }

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

    /**
     * AllInOne 正则列表（上游 `AnalyzeByRegex.getElements`）：`&&` 分隔的多级正则，
     * 前一级把**所有匹配的整段文本串起来**交给下一级，只有最后一级产出条目
     * （每条 = 分组 `0..groupCount`，未参与的可选分组按空串）。
     *
     * 写坏的正则如实抛出去（与选择器同一口径）：静默返回空列表的话，
     * 「规则写坏了」和「站点真没内容」在体检与调试面板里就再也分不开。
     */
    private fun regexNodes(body: String, rule: String): List<NodeValue> {
        val levels = rule.split("&&").map { it.trim() }.filter { it.isNotEmpty() }
        if (levels.isEmpty()) return emptyList()
        return regexMatches(body, levels, 0).map { NodeValue.regexItem(it, runtime) }
    }

    private fun regexMatches(text: String, levels: List<String>, index: Int): List<List<String>> {
        val pattern = levels[index]
        val regex = runCatching { Regex(pattern) }.getOrElse { error ->
            throw RuleExecutionException(
                "正则列表规则无法编译：${pattern.take(160)}（${(error.message ?: error.javaClass.simpleName).take(160)}）"
            )
        }
        val found = regex.findAll(text).toList()
        if (found.isEmpty()) return emptyList()
        if (index + 1 == levels.size) return found.map { it.groupValues }
        return regexMatches(found.joinToString("") { it.value }, levels, index + 1)
    }
}

internal fun isJsRule(rule: String): Boolean {
    val trimmed = rule.trimStart()
    return trimmed.startsWith("@js:") || trimmed.startsWith("js:") || (rule.contains("<js>") && rule.contains("</js>"))
}

/**
 * 剥掉列表规则开头的 `-` / `+` 排序标记。
 *
 * 这两个标记只有目录（chapters）与订阅（rssArticles）认，而且**都是先自己读走 `-` 的
 * 反转语义再调到这里**。留着它们有两个坏处：`isJsRule` 认不出 `+@js:…` 是 JS 列表规则，
 * `@css:` 这类模式标记也被挤到第二位而失效（selectLegadoSegments 只认开头的标记）。
 */
internal fun stripListPrefixMarkers(rule: String): String {
    var text = rule.trim()
    while (text.startsWith("-") || text.startsWith("+")) text = text.substring(1).trim()
    return text
}
