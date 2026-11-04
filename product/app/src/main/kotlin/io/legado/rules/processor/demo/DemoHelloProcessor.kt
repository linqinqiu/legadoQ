package io.legado.rules.processor.demo

import io.legado.rules.RuleContext
import io.legado.rules.RuleProcessor
import io.legado.rules.RuleResult

/**
 * 示例处理器：简单问候处理器，返回固定问候文本。
 *
 * 用途：演示最小化的自定义 ruleType。书源可声明 `"ruleType": "demo-hello"`，
 * 该处理器会直接返回 `"Hello, legadoQ!"` 作为正文，不需要任何网络请求。
 *
 * 处理器类型：`demo-hello`
 */
class DemoHelloProcessor : RuleProcessor {
    override val type: String = "demo-hello"

    override fun canHandle(rule: String): Boolean =
        rule.trimStart().startsWith("demo-hello:")

    override suspend fun execute(
        rule: String,
        input: String,
        context: RuleContext,
    ): RuleResult {
        return RuleResult(text = "Hello, legadoQ! 来自 demo-hello 处理器。", ok = true)
    }
}
