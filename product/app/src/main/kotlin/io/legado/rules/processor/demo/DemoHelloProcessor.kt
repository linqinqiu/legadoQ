package io.legado.rules.processor.demo

import io.legado.rules.RuleContext
import io.legado.rules.RuleInput
import io.legado.rules.RuleProcessor
import io.legado.rules.RuleResult

/**
 * 示例处理器：最小可用的自定义规则类型 —— 返回一句固定文本。
 *
 * 用途：看清"加一种规则类型"要写多少东西。规则写 `demo-hello:任意后缀`，求值时返回固定问候，
 * 不碰网络、不碰文档。
 *
 * 怎么让它生效（三行）：
 * ```kotlin
 * val runner = RuleRunner(fetcher)
 * runner.dispatcher.register(DemoHelloProcessor())
 * ```
 *
 * 处理器类型：`demo-hello`
 */
class DemoHelloProcessor : RuleProcessor {

    override val type: String = "demo-hello"

    override fun canHandle(rule: String): Boolean =
        rule.trimStart().startsWith("demo-hello:", ignoreCase = true)

    override fun execute(rule: String, input: RuleInput, context: RuleContext): RuleResult =
        RuleResult(text = "Hello, legadoQ! 来自 demo-hello 处理器。")
}
