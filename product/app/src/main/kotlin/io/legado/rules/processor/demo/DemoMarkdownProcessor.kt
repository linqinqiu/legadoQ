package io.legado.rules.processor.demo

import io.legado.rules.RuleContext
import io.legado.rules.RuleInput
import io.legado.rules.RuleProcessor
import io.legado.rules.RuleResult

/**
 * 示例处理器：把 markdown 标题解析成**列表条目**。
 *
 * 用途：演示 `producesNodes = true` 的那一类 —— 列表规则（书源列表 / 目录）也能交给处理器。
 * 条目的字段规则按 **JSONPath** 取（`$.title` / `$.level`），因为处理器产出的是字段映射，
 * 不是 DOM 节点。
 *
 * 只认 `demo-markdown:` 前缀，**不要**认 `#` 开头的裸规则：`#bookIntro@text` 是 CSS 的 id 选择器，
 * 认宽了会把整个书源的字段规则吃掉（认领即拥有，不会再退回内建链路）。
 *
 * 处理器类型：`demo-markdown`
 */
class DemoMarkdownProcessor : RuleProcessor {

    override val type: String = "demo-markdown"

    override val producesNodes: Boolean = true

    override fun canHandle(rule: String): Boolean =
        rule.trim().startsWith("demo-markdown:", ignoreCase = true)

    override fun execute(rule: String, input: RuleInput, context: RuleContext): RuleResult {
        val nodes = input.raw.lines().mapNotNull { line ->
            val trimmed = line.trim()
            when {
                trimmed.startsWith("## ") -> mapOf(
                    "title" to trimmed.substring(3).trim(),
                    "level" to "2",
                    "text" to trimmed.substring(3).trim(),
                )
                trimmed.startsWith("# ") -> mapOf(
                    "title" to trimmed.substring(2).trim(),
                    "level" to "1",
                    "text" to trimmed.substring(2).trim(),
                )
                else -> null
            }
        }
        if (nodes.isEmpty()) context.log("demo-markdown：输入里没有标题行")
        return RuleResult(nodes = nodes)
    }
}
