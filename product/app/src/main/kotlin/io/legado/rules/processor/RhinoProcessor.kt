package io.legado.rules.processor

import io.legado.rules.RuleContext
import io.legado.rules.RuleProcessor
import io.legado.rules.RuleResult

/**
 * Rhino JS 沙箱规则处理器（`<js>…</js>`、`@js:`）。
 *
 * 占位实现：先建立 `RuleProcessor` 接口契约，后续将 `RuleRunner` 中
 * Rhino JS 相关的列表/目录/正文解析逻辑迁入本类的 `execute`。
 *
 * 处理器类型：`rhino`
 */
class RhinoProcessor : RuleProcessor {
    override val type: String = "rhino"

    override fun canHandle(rule: String): Boolean =
        rule.contains("<js>") || rule.startsWith("@js:") || rule.startsWith("js:")

    override suspend fun execute(
        rule: String,
        input: String,
        context: RuleContext,
    ): RuleResult {
        // TODO: 迁移 Rhino JS 沙箱列表/目录/正文解析逻辑到此处
        return RuleResult(ok = false, error = "RhinoProcessor.execute 尚未实现（阶段 2 占位）")
    }
}
