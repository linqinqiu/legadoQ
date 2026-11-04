package io.legado.rules.processor

import io.legado.rules.RuleContext
import io.legado.rules.RuleProcessor
import io.legado.rules.RuleResult

/**
 * CSS 选择器规则处理器（Jsoup）。
 *
 * 占位实现：先建立 `RuleProcessor` 接口契约，后续将 `RuleRunner` 中
 * Jsoup 相关的列表/目录/正文解析逻辑迁入本类的 `execute`。
 *
 * 处理器类型：`css`
 */
class JsoupProcessor : RuleProcessor {
    override val type: String = "css"

    override fun canHandle(rule: String): Boolean =
        rule.startsWith("@css:") || rule.startsWith("<js>") == false && rule.contains("::")

    override suspend fun execute(
        rule: String,
        input: String,
        context: RuleContext,
    ): RuleResult {
        // TODO: 迁移 Jsoup 列表/目录/正文解析逻辑到此处
        return RuleResult(ok = false, error = "JsoupProcessor.execute 尚未实现（阶段 2 占位）")
    }
}
