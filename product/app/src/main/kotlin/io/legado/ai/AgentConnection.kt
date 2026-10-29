package io.legado.ai

import kotlinx.coroutines.runBlocking

/**
 * 程序内部的「AI 连接 API」句柄。
 *
 * 把它当成一个指向本服务的连接来用：调用方（进程内的自动化脚本 / 智能体 / 调试器）
 * 通过 [call] 执行某个已注册工具，通过 [manifest] 查看当前能力面。
 * 所有写操作都走与 HTTP 端点同一批服务、同一道护栏，不会绕开 1234 既有约束。
 *
 * 这个连接**不额外开端口、不注册任何 HTTP 路由**，纯进程内。它同时也是 `/api/agent/`
 * HTTP 收口背后真正的执行体：Application 启动时会**无条件**构造一个实例交给路由层，
 * 从而让「自定义接入」的每一条能力（含外部模型阅读理解）都落到本网关里，而不是在 HTTP 层另写一份。
 * `-Dai.debug` 只决定 [io.legado.ai.AgentModule] 是否额外跑一次自检演示，与连接本身的存在无关。
 */
class AgentConnection internal constructor(private val agent: Agent) {

    /**
     * 当前全部可用工具（id / 分组 / 是否会写库 / 描述）。
     * 让调用方先看清能做什么，再决定调哪一个——等价于一份「内部 API 契约」。
     */
    fun manifest(): List<ToolMeta> = agent.toolManifest()

    /**
     * 是否登记了外部连接——决定 `manifest` 的 `enabled` 字段。
     * 注意：这只是「连接已注册」的信号；真正外呼是否成功要看 [comprehend]/[callLlm] 的运行结果。
     */
    fun hasConnection(): Boolean = agent.hasConnection()

    /**
     * 工具注册表 —— 让调用方**在运行时**增删工具，而不是只能调内置那 54 个。
     *
     * ```kotlin
     * conn.registry.register(Tool { ctx, _ -> ctx.error("ok", "hi") }.also {
     *     it.meta = ToolMeta("demo.hi", "demo", "示例", writes = false)
     * })
     * conn.call("demo.hi")   // 立刻就能调到
     * ```
     *
     * 约束由注册表本身守：id 唯一、内置工具默认删不掉、线程安全。
     * 这里注册的工具**不产生 HTTP 路由**，`/api/catalog` 的端点计数不变。
     */
    val registry: ToolRegistry get() = agent.registry

    /**
     * 生命周期钩子 —— 让调用方挂审计 / 限流 / 结果改写，而不必改框架源码。
     *
     * ```kotlin
     * val handle = conn.hooks.install(
     *     before = { meta, _ -> if (meta.writes) AgentResult(status = "error", code = "forbidden") else null },
     *     after  = { _, _, r -> r },
     * )
     * ```
     */
    val hooks: ToolHooks get() = agent.hooks

    /**
     * LLM 协议注册表 —— 让"怎么跟模型说话"可插拔，而不是硬编码 OpenAI 协议。
     *
     * ```kotlin
     * conn.providerRegistry.register(OllamaProvider())   // 加一家
     * conn.providerRegistry.unregister("openai-compatible") // 不要默认那家
     * ```
     *
     * 框架只认 `LlmProvider` 这个形状；`openai-compatible` 只是内置的默认实现。
     */
    val providerRegistry: LlmProviderRegistry get() = agent.providerRegistry

    /**
     * 连接选择策略注册表 —— 让"连哪个外部连接"可插拔，而不是硬编码取第一个。
     *
     * ```kotlin
     * conn.selectorRegistry.register(FailoverSelector())   // 加一个按健康度顺延的策略
     * conn.selectorRegistry.setDefault("FailoverSelector") // 设为默认
     * ```
     *
     * 默认 [io.legado.ai.FirstProfileSelector] 取第一个连接，与原行为完全一致；
     * 框架只立 [io.legado.ai.ConnectionSelector] 这个钩子，决定权交给外部。
     */
    val selectorRegistry: ConnectionSelectorRegistry get() = agent.selectorRegistry

    /**
     * 文章阅读理解（同步）。必须有外部模型连接；没有或外呼失败返回 error，不做本地兜底。
     * HTTP 层的 `POST /api/agent/comprehend` 就是直接委派到这里。
     */
    fun comprehend(
        text: String,
        question: String? = null,
        summarySentences: Int = 3,
        topKeywords: Int = 8,
    ): Agent.ComprehendOutcome = runBlocking {
        agent.comprehend(text, question, summarySentences, topKeywords)
    }

    /** 同 [comprehend]，但保留挂起语义，供已经是协程的调用方使用。 */
    suspend fun comprehendSuspend(
        text: String,
        question: String? = null,
        summarySentences: Int = 3,
        topKeywords: Int = 8,
    ): Agent.ComprehendOutcome = agent.comprehend(text, question, summarySentences, topKeywords)

    /**
     * 自由对话（多轮）。直接把 `messages` 交给外部 openai-compatible 模型；
     * 缺连接 / 调用失败返回 error。HTTP 层 `POST /api/agent/chat` 直接委派到这里。
     * `messages` 是 (role, content) 对，role 取 system/user/assistant 之一（其它值按 user 处理）。
     */
    fun chat(
        messages: List<Pair<String, String>>,
        allowedToolGroups: Set<String>? = null,
        skillIds: List<String> = emptyList(),
        disabledToolIds: List<String> = emptyList(),
    ): Agent.ChatOutcome = runBlocking {
        agent.chat(messages, allowedToolGroups, skillIds, disabledToolIds)
    }

    /** 同 [chat]，但保留挂起语义。 */
    suspend fun chatSuspend(
        messages: List<Pair<String, String>>,
        allowedToolGroups: Set<String>? = null,
        skillIds: List<String> = emptyList(),
        disabledToolIds: List<String> = emptyList(),
    ): Agent.ChatOutcome = agent.chat(messages, allowedToolGroups, skillIds, disabledToolIds)

    /**
     * 流式对话：工具循环与 [chat] 完全一致，只是把过程作为 [AgentStreamEvent] 逐步回调。
     *
     * 这里不做 HTTP 相关的事 —— 写 SSE 是 `http/` 层的事；这里是进程内 API，
     * 调用方拿到事件后自己决定怎么呈现。客户端断开时调用方应取消所在协程，
     * 生产者会随之停止（不会继续烧模型额度）。
     */
    suspend fun chatStream(
        messages: List<Pair<String, String>>,
        allowedToolGroups: Set<String>? = null,
        skillIds: List<String> = emptyList(),
        disabledToolIds: List<String> = emptyList(),
        onEvent: suspend (AgentStreamEvent) -> Unit,
    ): Agent.ChatOutcome = agent.chatStream(messages, allowedToolGroups, skillIds, disabledToolIds, onEvent)

    /** 当前技能库（内置 + 用户）。 */
    fun listSkills(): List<AgentSkillStore.Skill> = agent.listSkills()

    /** 新建/覆盖一个技能。 */
    fun saveSkill(
        id: String?,
        name: String,
        description: String,
        keywords: List<String>,
        content: String,
        enabled: Boolean,
    ): AgentSkillStore.Skill = agent.saveSkill(id, name, description, keywords, content, enabled)

    /** 删除一个用户技能（移入 .trash）。 */
    fun deleteSkill(id: String): Boolean = agent.deleteSkill(id)

    /** 当前提示词预设（按 order 排好序）。 */
    fun listPrompts(): List<AgentPromptStore.Preset> = agent.listPrompts()

    /** 新建/覆盖一条提示词预设。 */
    fun savePrompt(
        id: String?,
        name: String,
        instruction: String,
        enabled: Boolean,
        order: Int?,
    ): AgentPromptStore.Preset = agent.savePrompt(id, name, instruction, enabled, order)

    /** 删除一条提示词预设（删前整份文件备份进 .trash）。 */
    fun deletePrompt(id: String): Boolean = agent.deletePrompt(id)

    /**
     * 执行一个工具（同步）。内部以 `runBlocking` 把挂起调用摊平，方便非协程的进程内
     * 调用方（普通 Java/Kotlin 代码、调试脚本）直接使用。
     *
     * 若调用方本身已在协程里（例如未来的 Ktor 扩展），请用 [callSuspend] 以避免
     * 在调度器线程上再起一个事件循环。
     *
     * @param toolId 工具 id（见 [manifest]）
     * @param args   扁平键值参数（基础类型：字符串 / 数字 / 布尔 / 列表 / null）
     * @return 结构化结果 [AgentResult]，失败也有 `status="error"` + `code`，不会抛裸异常
     */
    fun call(toolId: String, args: Map<String, Any?> = emptyMap()): AgentResult =
        runBlocking { agent.runTool(toolId, args) }

    /** 同 [call]，但保留挂起语义，供已经是协程的调用方使用。 */
    suspend fun callSuspend(toolId: String, args: Map<String, Any?> = emptyMap()): AgentResult =
        agent.runTool(toolId, args)
}
