package io.legado.rules

import org.mozilla.javascript.CompilerEnvirons
import org.mozilla.javascript.Context
import org.mozilla.javascript.Parser
import org.mozilla.javascript.ast.Name
import org.mozilla.javascript.ast.ObjectProperty
import org.mozilla.javascript.ast.PropertyGet

/**
 * 「这一栏到底能不能翻页」——只看规则怎么写，**绝不执行它**。
 *
 * 为什么要单独判：发现页原来永远挂一颗「下一页」，靠"发第二页、按 bookUrl 去重、空或全重就算到底"
 * 事后发现 —— 本机 25,290 条静态栏目地址里有 **4,368 条（17%）压根不含任何翻页写法**，
 * 每一击都是一次白发的请求，而且界面上没有任何地方告诉用户"这一栏没有下一页"。
 *
 * 认它支持翻页的三种写法（语义照上游 `AnalyzeUrl.supportsPageSelection` 读，实现自写）：
 * ① `{{…}}` 表达式里出现**自由变量** `page`；② `<js>…</js>` / `@js:` 脚本里出现自由变量 `page`；
 * ③ 剩下的 `<…>` 翻页段里带逗号（`<,index_2.html>` 这一类，见 `RuleRunner.selectPageSegments`）。
 *
 * 关键是"自由"两个字：`{{book.page}}`（属性）、`{{(function(page){…})(1)}}`（形参遮蔽）、
 * `@js: var page = 1; …`（局部声明）、`{{'page'}}`（字符串）都**不算** —— 那些源自己不吃页码参数，
 * 给它们挂按钮就是白发请求。用 AST 而不是正则就是为了让这四种都能被正确排除。
 */
private val PAGE_SCRIPT_BLOCK = Regex("<js>([\\s\\S]*?)</js>")
private val PAGE_SCRIPT_PREFIX = Regex("^\\s*@?js:")
private val PAGE_EXPRESSION = Regex("\\{\\{(.+?)}}", RegexOption.DOT_MATCHES_ALL)
private val PAGE_SEGMENT = Regex("<(.*?)>")
/** 便宜的预筛：连 "page" 这个词都没出现，就不必起一个 Rhino 解析器。 */
private val PAGE_WORD = Regex("(^|[^.\\w$])page\\b")

internal fun supportsPaging(rule: String?): Boolean {
    if (rule.isNullOrBlank()) return false
    if (PAGE_SCRIPT_PREFIX.containsMatchIn(rule) && referencesPage(rule.substringAfter(':'))) return true
    var found = false
    val withoutBlocks = PAGE_SCRIPT_BLOCK.replace(rule) { match ->
        if (referencesPage(match.groupValues[1])) found = true
        ""
    }
    if (found) return true
    val withoutExpressions = PAGE_EXPRESSION.replace(withoutBlocks) { match ->
        if (referencesPage(match.groupValues[1])) found = true
        ""
    }
    if (found) return true
    return PAGE_SEGMENT.findAll(withoutExpressions).any { it.groupValues[1].contains(',') }
}

/** 脚本里是否引用了自由变量 `page`（解析失败一律当作"没有"，宁可不给按钮也不许执行别人的代码）。 */
internal fun referencesPage(script: String): Boolean {
    if (!PAGE_WORD.containsMatchIn(script)) return false
    val environment = CompilerEnvirons().apply { languageVersion = Context.VERSION_ES6 }
    val root = try {
        Parser(environment).parse(script, "paging-check", 1)
    } catch (error: Exception) {
        return false
    }
    var found = false
    root.visit { node ->
        if (node is Name && node.identifier == "page" && node.definingScope == null) {
            val parent = node.parent
            val isPropertyAccess = (parent is PropertyGet && parent.property === node) ||
                (parent is ObjectProperty && parent.left === node)
            if (!isPropertyAccess) found = true
        }
        !found
    }
    return found
}
