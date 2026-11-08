package io.legado.rules

import kotlinx.serialization.Serializable
import java.util.concurrent.CopyOnWriteArrayList

/**
 * 规则处理器：给规则引擎加一种**新的取值方式**，而不必改 `RuleRunner` / `RuleValue`。
 *
 * 这是「扩展点」真正生效的那一层。此前这三个类型只是契约（`RuleRunner` 里有个从未被读取的
 * `ruleDispatcher` 参数，`processor` 包下四个实现全是「尚未实现」），新增一种解析方式可以写出来、
 * 可以单测，但**规则求值时不会走到它** —— 那等于没有扩展点。
 *
 * 现在的链路：`NodeValue.value(rule)` 与 `RuleRunner.nodes(body, rule)` 在走内建解析**之前**，
 * 先问一句「有处理器认领这条规则吗」，认领了就由它给结果。没人认领才落回内建链路，
 * 所以**内建四种类型（CSS / XPath / JSONPath / JS）的行为一个字节都没动**。
 *
 * 三条边界，写处理器的人必须知道：
 * ① [execute] 是**同步**的：取值发生在解析热路径上，一次搜索要对几千条记录求值。需要联网或
 *    长耗时的能力请放在宿主层，不要塞进取值规则。
 * ② 认领即拥有：处理器返回空结果就是「这条规则没值」，**不会**再退回内建链路
 *    （否则自定义类型会被内建当成 CSS 选择器，报一句看不懂的 SelectorParseException）。
 * ③ [RuleInput.evaluateBuiltin] 走的是内建链路，**不经过**扩展点 —— 处理器可以放心用它做
 *    「先按老规则取个值、再加工」而不会自己调自己。
 */
interface RuleProcessor {

    /** 处理器类型标识，如 `css` / `jsonpath` / `xpath` / `rhino` / 自定义字符串。 */
    val type: String

    /** 是否能处理给定的规则串（只看规则本身，不看文档）。 */
    fun canHandle(rule: String): Boolean

    /**
     * 是否能产出**列表条目**（书源列表 / 目录）。
     *
     * 默认 `false`：只参与单值规则（书名、作者、封面、正文…）。列表规则与单值规则的返回形状
     * 完全不同，混在一起会让"一个值型处理器认领了列表规则、结果整源 0 条"变成沉默故障。
     */
    val producesNodes: Boolean get() = false

    /**
     * 执行规则求值。
     *
     * @param rule 规则原文（已做过 `@put`/`@get` 变量替换，前缀仍是原样，由实现自行剥）
     * @param input 输入文档（原始文本 + 内建求值入口）
     * @param context 只读上下文（当前只有日志）
     */
    fun execute(rule: String, input: RuleInput, context: RuleContext): RuleResult
}

/** 规则求值时的输入。 */
interface RuleInput {

    /** 原始响应文本（HTML / JSON / 正文）。 */
    val raw: String

    /** 文档里的全部文本（HTML 给 innerHtml，JSON 给 JSON 文本）。 */
    fun documentText(): String

    /**
     * 用**内建引擎**求值这条规则（不经过扩展点，不会自递归）。
     * 处理器最常见的用法就是「先取到原值，再按自己的类型加工」。
     */
    fun evaluateBuiltin(rule: String): String?
}

/** 处理器执行上下文：只读。 */
interface RuleContext {
    /** 记一条规则执行日志（处理器自己报错/降级时用，不要静默吞掉）。 */
    fun log(message: String)
}

/**
 * 规则求值结果。
 *
 * 单值处理器只填 [text]；列表处理器填 [nodes]（每项是一个字段映射，字段规则按 **JSONPath** 取，
 * 例如 `$.name`）。两边都空且 [ok] 为真表示「这条规则确实没有值」。
 */
@Serializable
data class RuleResult(
    val text: String = "",
    val nodes: List<Map<String, String?>> = emptyList(),
    val ok: Boolean = true,
    val error: String? = null,
)

/**
 * 规则处理器调度器：按注册顺序问「谁认领这条规则」。
 *
 * 线程安全（`CopyOnWriteArrayList`）：注册通常发生在启动期，求值发生在请求线程上，两边不互斥。
 * 同 [type] 再注册一次会覆盖旧的 —— 与工具注册表同一条口径。
 */
class RuleDispatcher(processors: List<RuleProcessor> = emptyList()) {

    private val registered = CopyOnWriteArrayList<RuleProcessor>()

    init {
        processors.forEach { register(it) }
    }

    /** 注册（或按 [RuleProcessor.type] 覆盖）一个处理器。 */
    fun register(processor: RuleProcessor) {
        require(processor.type.isNotBlank()) { "规则处理器必须带 type" }
        registered.removeIf { it.type == processor.type }
        registered += processor
    }

    /** 按类型摘掉；返回是否真的摘掉了。 */
    fun unregister(type: String): Boolean = registered.removeIf { it.type == type }

    fun dispatch(type: String): RuleProcessor? = registered.firstOrNull { it.type == type }

    fun types(): List<String> = registered.map { it.type }

    val size: Int get() = registered.size

    /** 找出第一个认领这条规则的处理器；`canHandle` 抛异常视作不认领（一个坏处理器不许拖垮整源）。 */
    internal fun claim(rule: String): RuleProcessor? =
        registered.firstOrNull { processor ->
            runCatching { processor.canHandle(rule) }.getOrDefault(false)
        }

    /** 列表规则只问声明了 [RuleProcessor.producesNodes] 的处理器。 */
    internal fun claimNodeRule(rule: String): RuleProcessor? =
        registered.firstOrNull { processor ->
            processor.producesNodes && runCatching { processor.canHandle(rule) }.getOrDefault(false)
        }
}

/**
 * 一次求值期间的运行时：把调度器与日志出口绑在一起，随 [NodeValue] 往下传。
 *
 * 为什么跟着节点走而不是放在线程变量里：解析会在同一线程里层层嵌套（列表规则里再求字段规则），
 * 用线程变量就得层层保存/恢复，漏一层就是"某条路径上扩展点静默失效"。节点本来就随规则链传递，
 * 挂在它上面最不容易漏。
 */
internal class RuleRuntime(
    val dispatcher: RuleDispatcher,
    private val logger: (String) -> Unit = {},
) : RuleContext {

    override fun log(message: String) = logger(message)
}
