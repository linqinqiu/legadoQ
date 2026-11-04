package io.legado.rules.processor

import io.legado.rules.RuleContext
import io.legado.rules.RuleProcessor
import io.legado.rules.RuleResult

/**
 * XPath 规则处理器（`@xpath:` / JsoupXpath）。
 *
 * 占位实现：先建立 `RuleProcessor` 接口契约，后续将 `RuleRunner` 中
 * XPath 相关的列表/目录/正文解析逻辑迁入本类的 `execute`。
 *
 * 处理器类型：`xpath`
 */
class XPathProcessor : RuleProcessor {
    override val type: String = "xpath"

    override fun canHandle(rule: String): Boolean =
        rule.startsWith("@xpath:")

    override suspend fun execute(
        rule: String,
        input: String,
        context: RuleContext,
    ): RuleResult {
        // TODO: 迁移 XPath 列表/目录/正文解析逻辑到此处
        return RuleResult(ok = false, error = "XPathProcessor.execute 尚未实现（阶段 2 占位）")
    }
}
