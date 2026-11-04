package io.legado.rules.processor.demo

import io.legado.rules.RuleContext
import io.legado.rules.RuleProcessor
import io.legado.rules.RuleResult

/**
 * 示例处理器：把 markdown 风格的 `# 标题` 规则转为节点列表。
 *
 * 用途：演示如何在不修改 `RuleRunner` 的前提下，新增一种书源解析方式。
 * 用户或第三方只需：
 *   1. 新建一个类实现 `RuleProcessor`；
   *   2. 在 `RuleDispatcher`（由宿主/Application 注册）里把它加进去；
   *   3. 书源里声明 `"ruleType": "demo-markdown"` 即可。
 *
 * 处理器类型：`demo-markdown`
 */
class DemoMarkdownProcessor : RuleProcessor {
    override val type: String = "demo-markdown"

    override fun canHandle(rule: String): Boolean =
        rule.trim().startsWith("#") || rule.trimStart().startsWith("demo-markdown:")

    override suspend fun execute(
        rule: String,
        input: String,
        context: RuleContext,
    ): RuleResult {
        try {
            val lines = input.lines()
            val nodes = mutableListOf<Map<String, String?>>()
            for (line in lines) {
                val trimmed = line.trim()
                if (trimmed.startsWith("# ")) {
                    nodes.add(mapOf(
                        "title" to trimmed.substring(2).trim(),
                        "level" to "1",
                        "text" to trimmed.substring(2).trim(),
                    ))
                } else if (trimmed.startsWith("## ")) {
                    nodes.add(mapOf(
                        "title" to trimmed.substring(3).trim(),
                        "level" to "2",
                        "text" to trimmed.substring(3).trim(),
                    ))
                }
            }
            return RuleResult(
                text = "",
                nodes = nodes,
                ok = true,
            )
        } catch (e: Throwable) {
            return RuleResult(ok = false, error = "DemoMarkdownProcessor 执行失败：${e.message ?: e::class.simpleName}")
        }
    }
}
