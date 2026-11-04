package io.legado.rules

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * 规则解析器处理器接口。
 *
 * 设计原则：
 * - `rule-core`（`io.legado.rules`）只定义接口与调度，不 import 任何具体处理器实现；
 * - 具体解析器（CSS/XPath/JSONPath/Rhino/用户自定义）按同一接口注册进 `RuleDispatcher`；
 * - `RuleContext` 只暴露抽象能力（fetch、getVariable、log），不出现 OkHttp、Jsoup、数据库等具体类型，
 *   因此同一套接口可在不同宿主里复用。
 *
 * 新增一种解析方式时，只需新建一个类实现本接口，在 `RuleDispatcher` 中注册，
 * `RuleRunner` 作为调度器零修改。
 */
interface RuleProcessor {

    /** 处理器类型标识，如 "css" / "jsonpath" / "xpath" / "rhino" / 用户自定义字符串。 */
    val type: String

    /** 是否能处理给定的规则字符串（如以 `@css:` 开头、或书源声明 `ruleType = "xpath"`）。 */
    fun canHandle(rule: String): Boolean

    /**
     * 执行规则求值。
     *
     * @param rule 规则原文（可能带 `<js>`、`@js:`、`||` 备选等前缀，由具体实现自行解析）；
     * @param input 待解析的原始文本（HTML / JSON / 等）；
     * @param context 规则执行上下文，提供抽象的 fetch / 变量 / 日志能力；
     * @return 解析结果，具体形状由实现决定（列表节点 / 单值 / 正文文本等）。
     */
    suspend fun execute(
        rule: String,
        input: String,
        context: RuleContext,
    ): RuleResult
}

/**
 * 规则解析结果。由具体处理器构造，上层调用方（RuleRunner）根据结果类型做后续处理。
 */
@Serializable
data class RuleResult(
    /** 文本结果（正文、单值、标题等）。 */
    val text: String = "",
    /** 节点列表（书源列表、目录章节等），每项为节点的文本/属性映射。 */
    val nodes: List<Map<String, String?>> = emptyList(),
    /** 是否解析成功。 */
    val ok: Boolean = true,
    /** 失败原因（ok = false 时填充，供调试面板与错误回显）。 */
    val error: String? = null,
)

/**
 * 规则执行上下文：只暴露抽象能力，不依赖具体宿主实现。
 */
interface RuleContext {

    /** 抓取指定 URL 并返回文本；由宿主实现（默认走出站闸门）。 */
    suspend fun fetch(url: String, headers: Map<String, String> = emptyMap()): String?

    /** 读取书源变量表（`@put` / `@get` 跨调用复用）。 */
    fun getVariable(key: String): String?

    /** 写入书源变量表。 */
    fun putVariable(key: String, value: String)

    /** 记录一条规则执行日志。 */
    fun log(message: String)

    /** 当前书源 id（bookSourceUrl）。 */
    val sourceUrl: String?

    /** 当前书籍 URL（可为 null）。 */
    val bookUrl: String?
}

/**
 * 规则处理器调度器：按 ruleType 分派给已注册的 RuleProcessor。
 *
 * **当前状态（0.2.14）：契约先行，尚未接入 `RuleRunner`。**
 * `RuleRunner`（2413 行）仍走原有的内联解析链路（Jsoup / Rhino / JS 上下文混在一起），
 * 把它替换成「声明式处理器 + 调度器」是一次独立重构，必须带等价性测试另开一单。
 * 因此本类目前是**扩展点契约**：新增一种解析方式可以独立实现并单测，
 * 但真正生效还需要 `RuleRunner` 改造完成。
 *
 * 具体处理器类在 `io.legado.rules.processor` 包下（现均为占位，`execute` 返回未实现）。
 * 示例见 `io.legado.rules.processor.demo`。
 */
class RuleDispatcher(private val processors: Map<String, RuleProcessor>) {

    fun dispatch(ruleType: String): RuleProcessor? = processors[ruleType]

    /** 所有已注册处理器的类型。 */
    fun types(): List<String> = processors.keys.toList()
}
