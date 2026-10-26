package io.legado.ai

import java.util.concurrent.ConcurrentHashMap

/**
 * 连接选择策略 —— 决定「多个外部连接里到底用哪一个」。
 *
 * 设计红线（用户原话："只做框架，不要有任何自己的内容"）：
 * 框架**不替用户决定连哪个**。把这份"选哪个"的决定权从写死的 `firstProfile()`
 * 里抽出来，做成可插拔的钩子——框架只立这个钩子（[ConnectionSelector] 这个形状），
 * 真正"连第一个 / 按健康度 failover / 按地域挑"这种业务策略，完全交给默认实现或插件。
 *
 * 默认实现 [FirstProfileSelector] 取 `agent-profiles.json` 里**第一个**连接，
 * 保持青阅既有的「已确认的正确行为」：只走第一个，它不可达就不自动顺延（见 AGENTS.md §4）。
 * 想要 failover / 加权 / 按负载分流？写个自定义 [ConnectionSelector] 注册进
 * [ConnectionSelectorRegistry] 即可，**不必改框架源码**——这是"基础框架只立钩子"的落点。
 *
 * 与 [LlmProviderRegistry] 完全对称：内置一个默认实现，插件可增删替换。
 */
interface ConnectionSelector {
    /**
     * 从当前已登记的全部外部连接里挑一个来用。
     *
     * @param profiles 当前 `agent-profiles.json` 里的全部连接（顺序即文件顺序）
     * @return 选中的连接；一个都没有时返回 null（调用方据此返回 409 no_connection）
     */
    fun select(profiles: List<AgentProfileStore.Profile>): AgentProfileStore.Profile?
}

/**
 * 默认策略：取第一个连接。
 *
 * 这是青阅长期以来的行为，[Agent.hasConnection] / [Agent.callLlm] / [Agent.comprehend] /
 * [Agent.chat] 历史上都是这么做的。抽到接口后默认仍是它，**行为零变化**——
 * AGENTS.md §4 关于「第一个连接、不自动顺延」的描述继续成立。
 */
class FirstProfileSelector : ConnectionSelector {
    override fun select(profiles: List<AgentProfileStore.Profile>): AgentProfileStore.Profile? =
        profiles.firstOrNull()
}

/**
 * 连接选择策略注册表 —— 让"连哪个"可插拔，与 [LlmProviderRegistry] 同一套路。
 *
 * 内置 [FirstProfileSelector]；插件可通过 [register] 注册自己的策略（如 failover），
 * 用 [setDefault] 换成默认。框架只认 [ConnectionSelector] 这个形状。
 */
class ConnectionSelectorRegistry(
    builtin: List<ConnectionSelector> = listOf(FirstProfileSelector()),
) {
    private val selectors = ConcurrentHashMap<String, ConnectionSelector>()
    private val order = ConcurrentHashMap.newKeySet<String>()
    private var defaultId: String = FirstProfileSelector::class.simpleName!!

    init {
        builtin.forEach { register(it) }
        defaultId = selectors.keys.firstOrNull() ?: defaultId
    }

    /** 注册一个策略；[replace]=false 且 id 已存在时返回 false（不覆盖）。 */
    fun register(selector: ConnectionSelector, replace: Boolean = false): Boolean {
        val id = selector::class.simpleName ?: return false
        if (!replace && selectors.containsKey(id)) return false
        selectors[id] = selector
        order.add(id)
        return true
    }

    /** 撤掉一个策略（默认实现也能撤，撤了就用剩下的第一个；撤光就退回 firstOrNull 行为）。 */
    fun unregister(id: String): Boolean = selectors.remove(id) != null

    /** 把某个已注册策略设为默认（返回值即 [selected] 实际用的那个）。 */
    fun setDefault(id: String): Boolean = if (selectors.containsKey(id)) {
        defaultId = id
        true
    } else false

    /** 当前默认策略的 id。 */
    fun defaultId(): String = defaultId

    /** 查某个策略。 */
    fun find(id: String): ConnectionSelector? = selectors[id]

    /** 全部已注册策略。 */
    fun all(): List<ConnectionSelector> = order.mapNotNull { selectors[it] }

    fun size(): Int = selectors.size

    /**
     * 按当前默认策略从全部连接里挑一个。
     * 所有策略都返回 null（或没有连接）时退化为 firstOrNull，保证永远不凭空造连接。
     */
    fun selected(profiles: List<AgentProfileStore.Profile>): AgentProfileStore.Profile? {
        val chosen = selectors[defaultId]?.select(profiles)
        if (chosen != null) return chosen
        // 默认策略没挑中（理论上不该发生，除非有人注册了空策略），退化保护：
        return profiles.firstOrNull()
    }
}
