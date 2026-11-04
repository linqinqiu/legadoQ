package io.legado.rules.processor

import io.legado.rules.RuleContext
import io.legado.rules.RuleProcessor
import io.legado.rules.RuleResult

/**
 * JSONPath 规则处理器（`@Json:` / `$.data.list[*]`）。
 *
 * 占位实现：先建立 `RuleProcessor` 接口契约，后续将 `RuleRunner` 中
 * JSONPath 相关的列表/目录/正文解析逻辑迁入本类的 `execute`。
 *
 * 处理器类型：`jsonpath`
 */
class JsonPathProcessor : RuleProcessor {
    override val type: String = "jsonpath"

    override fun canHandle(rule: String): Boolean =
        rule.startsWith("@Json:") || rule.startsWith("$.")

    override suspend fun execute(
        rule: String,
        input: String,
        context: RuleContext,
    ): RuleResult {
        // TODO: 迁移 JSONPath 列表/目录/正文解析逻辑到此处
        return RuleResult(ok = false, error = "JsonPathProcessor.execute 尚未实现（阶段 2 占位）")
    }
}
