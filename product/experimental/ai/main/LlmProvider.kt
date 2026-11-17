package io.legado.ai

/**
 * LLM 提供方契约：框架只认 [LlmProvider] 这个形状，"某一家协议"不是框架本身。
 * OpenAI 兼容只是内置默认实现（[OpenAiCompatibleProvider]），换协议注册自己的 provider 即可。
 *
 * 三条约束：① 按 [id] 注册，重复默认拒绝（覆盖要显式）；② 失败不抛 —— 返回 null 表示"这次没拿到"，
 * 由调用方翻成 409/502，一个连不上的模型不能把整条链路带走；③ provider 只做外呼，不注册 HTTP 路由。
 */
interface LlmProvider {

    /** 稳定 id，如 `openai-compatible`、`ollama`、`anthropic`。档案里的 `kind` 与它对应。 */
    val id: String

    /** 给人看的名字。 */
    val displayName: String

    /** 一句话说明这个 provider 期望什么形状的地址/模型。 */
    val description: String

    /**
     * 发一次对话请求。
     *
     * @param profile 连接档案（含 baseUrl / model / apiKey 等，由用户配置）
     * @param messages 多轮消息，role 为 system/user/assistant
     * @return 模型回复的文本；拿不到就返回 null（调用方报错），**不要抛异常**
     */
    fun chat(profile: AgentProfileStore.Profile, messages: List<LlmMessage>): String?

    /**
     * 带工具能力的一次对话。**默认实现退化为纯文本**，保证既有 provider 不用改。
     *
     * 想支持工具调用（让模型能执行插件注册的能力）的 provider 覆盖这个方法。
     * 框架拿到 [LlmReply.toolCalls] 后会执行对应工具、把结果回灌，再问一轮。
     *
     * @param tools 当前可用的工具清单（来自 ToolRegistry，含插件注册的）
     * @return 文本 + 工具调用；拿不到返回 null（调用方报错）
     */
    fun chatWithTools(
        profile: AgentProfileStore.Profile,
        messages: List<LlmMessage>,
        tools: List<ToolMeta>,
    ): LlmReply? {
        // 默认：忽略工具，退化成普通对话 —— 老 provider 零改动。
        val text = chat(profile, messages) ?: return null
        return LlmReply(content = text)
    }

    /**
     * 带工具的**流式**对话。默认实现退回 [chatWithTools]，拿到完整回复后一次性回调。
     *
     * 这样没有实现流式的 provider（Anthropic/Responses 的第一版）也能被同一条 SSE 通路
     * 服务：界面不会逐字出现，但事件序列、工具调用、用量统计完全一致。
     * 想真正逐字输出的 provider 覆盖它。
     *
     * 约束与 [chatWithTools] 相同：拿不到返回 null，**不要抛异常之外的"半个结果"**。
     */
    fun chatWithToolsStream(
        profile: AgentProfileStore.Profile,
        messages: List<LlmMessage>,
        tools: List<ToolMeta>,
        callbacks: LlmStreamCallbacks,
    ): LlmReply? {
        val reply = chatWithTools(profile, messages, tools) ?: return null
        if (reply.content.isNotBlank()) callbacks.onDelta(reply.content)
        reply.usage?.let(callbacks.onUsage)
        return reply
    }

    /**
     * 拉这个连接可用的模型清单。默认 null = 这个协议不提供/不实现。
     * 界面的「拉取模型」按钮据此决定显示模型下拉还是自由输入。
     */
    fun listModels(profile: AgentProfileStore.Profile): List<String>? = null
}

/**
 * 流式回调。**在 IO 线程上调用**，实现里只做"塞进队列/累加"，不要在这里做重活或切线程。
 *
 * 三个回调都可缺省：`onReasoning` 给带思考过程的模型（DeepSeek-R1 / o 系列）用，
 * 收到的内容与正文分开显示，不混进最终回答。
 */
data class LlmStreamCallbacks(
    val onDelta: (String) -> Unit = {},
    val onReasoning: (String) -> Unit = {},
    val onUsage: (LlmUsage) -> Unit = {},
)

/** 上游报告的 token 用量。字段都可空 —— 不少中转站不返回 usage。 */
data class LlmUsage(
    val promptTokens: Int? = null,
    val completionTokens: Int? = null,
    val totalTokens: Int? = null,
) {
    fun plus(other: LlmUsage?): LlmUsage {
        if (other == null) return this
        return LlmUsage(
            promptTokens = sum(promptTokens, other.promptTokens),
            completionTokens = sum(completionTokens, other.completionTokens),
            totalTokens = sum(totalTokens, other.totalTokens),
        )
    }

    private fun sum(a: Int?, b: Int?): Int? = when {
        a == null -> b
        b == null -> a
        else -> a + b
    }

    val isEmpty: Boolean get() = promptTokens == null && completionTokens == null && totalTokens == null
}

/**
 * 一条对话消息。
 *
 * [toolCallId] 只在 `role == "tool"` 时有意义：OpenAI 协议要求工具结果必须用
 * `tool_call_id` 指回**是哪一个** `tool_calls` 条目的结果，缺了它上游直接 400
 * （实测 pipio.io 报 `invalid_tool_contract: tool result requires call_id`）。
 * 之前这里只有 role/content，所以「模型要调工具」这一半能跑、「结果回灌」那一半
 * 必然失败 —— 表现为 AI 一碰工具就 `upstream_unreachable`。
 *
 * [toolCalls] 只在 `role == "assistant"` 时有意义：模型上一轮要求调的那些工具，
 * 按 OpenAI 协议必须原样带回对话历史，否则上游会认为 tool 消息没有对应的调用。
 */
data class LlmMessage(
    val role: String,
    val content: String,
    val toolCallId: String? = null,
    val toolCalls: List<LlmToolCall> = emptyList(),
)

/**
 * 一次工具调用请求 —— 模型说"我要调这个工具、带这些参数"。
 *
 * 这是"AI 能完成插件级功能"的关键：模型不再只能聊天，它能要求执行某个已注册工具，
 * 由框架执行后把结果回灌给它，它再继续推理。工具清单来自 [ToolRegistry]，
 * 所以**插件注册的工具自动对模型可见**，不必额外登记。
 */
data class LlmToolCall(
    /**
     * 本次调用的协议 id（`call_id`）。OpenAI 兼容协议里模型可以不回 id，此时退化成工具名；
     * Anthropic / Responses 一定会回，且同一轮里**同一个工具可以被调多次** ——
     * 这也是它必须与 [name] 分开的原因：旧实现把两者合成一个字段，
     * 同一轮调两次 `source.get` 时两条 `tool_call_id` 会撞在一起。
     */
    val id: String,
    /** 参数（扁平键值，与 [ToolArgs] 同形）。 */
    val args: Map<String, Any?> = emptyMap(),
    /** 真正的工具 id（对应 [ToolMeta.id]）。默认等于 [id]，兼容老 provider/测试。 */
    val name: String = id,
)

/**
 * 模型的一次回复：文本 + 可能要调的工具。
 *
 * 两者可以同时存在（模型先说一句再调工具），所以不是二选一的结构。
 */
data class LlmReply(
    /** 文本部分，可能为空。 */
    val content: String = "",
    /** 要调的工具，可能为空。 */
    val toolCalls: List<LlmToolCall> = emptyList(),
    /** 上游报告的 token 用量；没报就是 null。 */
    val usage: LlmUsage? = null,
)

/**
 * Provider 注册表 —— 让协议可插拔。
 *
 * 用法与 [ToolRegistry] 一致：内置一个默认实现，外部可注册自己的。
 *
 * ```kotlin
 * val registry = LlmProviderRegistry()              // 默认含 openai-compatible
 * registry.register(OllamaProvider())               // 加一家
 * val agent = Agent(ctx, home, registry = registry) // 交给框架
 * ```
 */
class LlmProviderRegistry(
    builtin: List<LlmProvider> = listOf(
        OpenAiCompatibleProvider(),
        AnthropicProvider(),
        OpenAiResponsesProvider(),
    ),
) {

    private val providers = java.util.concurrent.ConcurrentHashMap<String, LlmProvider>()

    init {
        builtin.forEach { p ->
            require(p.id.isNotBlank()) { "内置 provider 必须带 id" }
            require(providers.putIfAbsent(p.id, p) == null) { "内置 provider id 重复：${p.id}" }
        }
    }

    /** 注册一个 provider。id 已存在时返回 false（不覆盖），除非 [replace] 为 true。 */
    fun register(provider: LlmProvider, replace: Boolean = false): Boolean {
        require(provider.id.isNotBlank()) { "provider 必须带 id" }
        if (!replace) return providers.putIfAbsent(provider.id, provider) == null
        providers[provider.id] = provider
        return true
    }

    /** 注销（内置的也可以注销 —— provider 不是安全边界，只是协议实现）。 */
    fun unregister(id: String): Boolean = providers.remove(id) != null

    /** 按 id 找；没有返回 null。 */
    fun find(id: String): LlmProvider? = providers[id]

    /** 全部 provider，按 id 排序（稳定，便于展示）。 */
    fun all(): List<LlmProvider> = providers.values.sortedBy { it.id }

    /**
     * 为某个档案挑 provider。
     *
     * 匹配规则：档案 `kind` 的 wire 值与 provider id 相等就用它；没有就回退 `openai-compatible`。
     * 这样老档案（kind 写的是 `openai-compatible`）照常工作，新协议只要 kind 对上即可；
     * kind 写错也不会让连接彻底不可用（回退默认档，行为与从前一致）。
     */
    fun forProfile(profile: AgentProfileStore.Profile): LlmProvider? {
        val kind = profile.kind.wire
        return providers[kind] ?: providers["openai-compatible"]
    }

    /** 当前注册数量。 */
    fun size(): Int = providers.size
}
