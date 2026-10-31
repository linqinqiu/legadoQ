package io.legado.rules

import org.mozilla.javascript.CompilerEnvirons
import org.mozilla.javascript.Context
import org.mozilla.javascript.Node
import org.mozilla.javascript.Parser
import org.mozilla.javascript.ast.AstNode
import org.mozilla.javascript.ast.AstRoot
import org.mozilla.javascript.ast.FunctionNode
import org.mozilla.javascript.ast.NodeVisitor
import org.mozilla.javascript.ast.ReturnStatement
import java.io.StringReader

/**
 * 书源脚本"要不要包一层 IIFE"的判断。
 *
 * 书源规则里的 JS 允许直接写 `return 'xxx'`（上游是整段包在函数里跑的），
 * 所以我们原来在文本里搜到 `return` 就把整段包成 `(function(){ … })()`。
 *
 * 这个文本判断会**吞掉结果**：`var f = function (x) { return x * 2; }; [1,2].map(f).join(',')`
 * 这种"只在嵌套函数里 return、末尾是个表达式"的脚本，被包进一个没有 return 的外层函数后，
 * 整段的完成值变成 undefined —— 表现是"这条规则取到空值"，脚本本身一声不响。
 * 启用库里有 **210 份**源的脚本片段同时含 `function` 与 `return`，每一段都可能踩。
 *
 * 现在改成问 AST：**顶层**有 return 才包。解析失败退回旧的文本判断
 *（那种脚本本来就语法坏了，包不包都失败，不改它现有行为）。
 */
internal object JsScriptShape {

    /**
     * 顶层（不在任何函数体内）是否出现 return。
     *
     * `@Suppress("DEPRECATION")`：这版 Rhino 只留了 `parse(Reader, name, line)` 这一个
     * 入口能拿到整段脚本的 AST（`parseReader`/`parseString` 在 1.8.0 里没有），
     * 它标了 deprecated 但没有替代签名可用。
     */
    @Suppress("DEPRECATION")
    fun hasTopLevelReturn(script: String): Boolean = runCatching {
        val env = CompilerEnvirons().apply {
            languageVersion = Context.VERSION_ES6
            isIdeMode = true
        }
        val root: AstRoot = Parser(env).parse(StringReader(script), "legado-js-shape", 1)
        var found = false
        root.visit(object : NodeVisitor {
            override fun visit(node: AstNode): Boolean {
                if (node is ReturnStatement && !insideFunction(node)) found = true
                return true
            }
        })
        found
    }.getOrElse { script.contains("return") }

    /** 顺着 parent 往上走：途中遇到函数节点（含箭头函数）就不算顶层 return。 */
    private fun insideFunction(node: AstNode): Boolean {
        var parent: AstNode? = node.parent
        while (parent != null) {
            if (parent is FunctionNode) return true
            parent = parent.parent
        }
        return false
    }
}
