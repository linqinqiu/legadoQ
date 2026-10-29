package io.legado.ai

import io.legado.data.VersionConflict
import io.legado.AppConfig
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Path
import java.time.Duration

/**
 * 程序内部 AI 的编排骨架，也是「自定义接入」所有能力的真正执行体。
 *
 * 设计定位（用户原话："我们要做的是提供大体框架支持"）：
 * 这一层**不绑定任何外部大模型**，只把"工具选择 + 执行 + 结果反馈"的管道立起来；
 * 真正接外部模型时，唯一入口是 [callLlm] 钩子——它经 [selectorRegistry] 从
 * [AgentProfileStore] 里选出要用哪一个外部连接，再真正发出 HTTP 请求；找不到或调用失败就返回 null，
 * 调用方据此返回明确的不可用错误。"连哪个"由可插拔的 [ConnectionSelector] 决定，
 * 默认取第一个连接（[FirstProfileSelector]），行为与原先一致且可被插件替换。
 * **没有本地兜底**：本地关键词抽取不是模型结果，
 * 拿它冒充对话或摘要会让调用方分不清真假。HTTP 层 `/api/agent/` 只是这个网关的收口。
 *
 * 关键约束（沿用现有服务的语义）：
 * - AI 能调用的只有 [BuiltinTools] 注册过的工具，工具背后是和 HTTP 端点同一批服务。
 * - 写工具受 [Guardrails] 约束（批量确认、乐观锁冲突转 version_conflict、禁改绑定地址）。
 * - 不在进程内另开一条数据写入路径。
 * - 所有外部 HTTP 调用走 JDK `java.net.http.HttpClient`（Ktor 客户端不在依赖里）。
 */
class Agent(
    private val ctx: AgentContext,
    private val homeDirectory: Path,
    private val profileStore: AgentProfileStore = AgentProfileStore,
    /**
     * 确认策略：默认 [DefaultGuardrailsPolicy]（等价于历史 `requireConfirm` 行为）。
     * 仅用于放宽"批量写需显式确认"这一业务默认；地址外绑 / 乐观锁冲突两道硬护栏不可经此放开。
     */
    val guardrailsPolicy: GuardrailsPolicy = DefaultGuardrailsPolicy,
    tools: List<Tool> = BuiltinTools.all(guardrailsPolicy),
    /** 工具注册表：默认用传入的 tools 建一份；外部想运行时增删工具就自己构造一个传进来。 */
    val registry: ToolRegistry = ToolRegistry(tools),
    /** 生命周期钩子：默认没有钩子（零开销），外部挂审计/限流/改写用。 */
    val hooks: ToolHooks = ToolHooks(),
    /** LLM 协议注册表：默认含 openai-compatible；想接别家协议注册自己的 provider。 */
    val providerRegistry: LlmProviderRegistry = LlmProviderRegistry(),
    /** 连接选择策略注册表：默认取第一个连接（[FirstProfileSelector]），策略可插拔。 */
    val selectorRegistry: ConnectionSelectorRegistry = ConnectionSelectorRegistry(),
) {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true; encodeDefaults = true }

    /** 暴露给外部（含 `/api/agent`）的能力清单，与 `/api/catalog` 的"可改范围"对齐。 */
    fun toolManifest(): List<ToolMeta> = registry.manifest()

    /** 是否注册了外部（openai-compatible）连接；供 manifest 的 `enabled` 字段使用。 */
    fun hasConnection(): Boolean = selectedProfile() != null

    /** 直接按工具 id 执行（已解析出该调哪个工具时用）。 */
    suspend fun runTool(id: String, args: ToolArgs): AgentResult {
        val tool = registry.find(id) ?: return ctx.error("unknown_tool", "未注册的工具：$id")
        val meta = tool.meta

        // 1) before 链：任一钩子返回非 null 即拦截，工具不执行。
        val blocked = try {
            hooks.runBefore(meta, args)
        } catch (e: Throwable) {
            // 钩子自己炸了不能把整条链路带走：转成 error 结果，工具照常不执行。
            ctx.error("hook_failed", "工具前置钩子异常：${e.message ?: e::class.simpleName}")
        }
        if (blocked != null) return hooks.runAfter(meta, args, blocked)

        // 2) 执行工具本体（异常统一兜底成 error 结果）。
        val raw: AgentResult = try {
            tool.invoke(ctx, args)
        } catch (e: Guardrails.AgentVersionConflict) {
            ctx.error("version_conflict", e.message ?: "书源版本冲突，请先读取最新版本再保存")
        } catch (e: VersionConflict) {
            ctx.error("version_conflict", e.message ?: "书源版本冲突，请先读取最新版本再保存")
        } catch (e: IllegalArgumentException) {
            ctx.error("invalid_request", e.message ?: "参数非法")
        } catch (e: Throwable) {
            // 先造出结果再回调：钩子看到的必须就是最终返回的那一个，不能各造一份。
            val converted = ctx.error("internal_error", e.message ?: "工具执行异常")
            hooks.runOnError(meta, args, e, converted)
            converted
        }

        // 3) after 链：可改写结果。
        return hooks.runAfter(meta, args, raw)
    }

    /**
     * 接收一个自然语言目标，产出"下一步该调哪个工具、带什么参数"。
     *
     * 占位实现：按关键字做极简路由，仅用于把整条链路跑通与演示。
     * 接真实 LLM 时，把这里的实现换成对 [callLlm] 的调用即可，其余管道不动。
     */
    suspend fun plan(goal: String): Plan {
        val g = goal.lowercase()
        val picked = when {
            "体检" in goal || "health" in g -> "source.health"
            "调试" in goal || "debug" in g -> "source.debug"
            "校验" in goal || "验证" in goal || "validate" in g -> "source.validate"
            "删除书源" in goal || "删源" in goal -> "source.batch"
            "列书源" in goal || "看看书源" in goal || "source.list" in g -> "source.list"
            "导入" in goal || "import" in g -> "source.import"
            "净化" in goal || "replace" in g -> "replace.list"
            "书架" in goal || "shelf" in g -> "shelf.list"
            "订阅" in goal || "subscription" in g -> "subscription.list"
            "搜索" in goal || "search" in g -> "search.run"
            else -> null
        }
        return Plan(goal = goal, toolId = picked, note = if (picked == null) "未在已注册工具中找到匹配项（骨架路由仅做关键字匹配）。" else null)
    }

    /**
     * LLM 钩子：有外部连接时真正调用该 openai-compatible 模型；
     * 缺连接或调用失败都返回 null，调用方据此返回明确的不可用错误。
     * 接真实 LLM 的唯一入口就在这里——不在 HTTP 层另写一份外呼。
     */
    suspend fun callLlm(prompt: String): String? {
        val ext = selectedProfile() ?: return null
        return (callLlmOutcome(ext, listOf(LlmMessage("user", prompt))) as? LlmOutcome.Ok)?.text
    }

    /**
     * 一次外呼的结果。**必须分成三类**，因为它们的修法完全不同，而从前只有两类可用：
     * - [Ok] 拿到文本；
     * - [Blocked] 地址被出站闸门拒了（填了内网/本机、语法不对）→ 4xx，并把闸门那句中文原样带回；
     * - [Unreachable] 到不了 / 解析不了 / 上游没给内容 → 502。
     *
     * 从前这里只把结果压成 `String?`：`runCatching { … }.getOrNull()` 一把抓，
     * 于是"你填的地址是内网"和"这台机器连不上它"都变成同一个 null，
     * 上层只能报 `upstream_unreachable`；而 chat 那条路径反过来又把闸门异常当非法参数
     * 一路抛成 500。实测三种形态都对不上用户看到的那句话。
     */
    private sealed class LlmOutcome {
        data class Ok(val text: String) : LlmOutcome()
        data class Blocked(val why: String) : LlmOutcome()
        data class Unreachable(val why: String) : LlmOutcome()
    }

    /** 带工具外呼的同一套分类（chat 的循环里用），把异常收成三态而不是 null。 */
    private fun classifyProviderError(error: Throwable): LlmOutcome = when (error) {
        // 闸门拒绝与"参数不对"都是"你的地址/输入有问题"→ 4xx，且要把真因带回去
        is IllegalArgumentException -> LlmOutcome.Blocked(error.message ?: "地址不合法或被出站闸门拒绝")
        // 解析不了、连不上、协议本身失败 → 502
        else -> LlmOutcome.Unreachable(error.message ?: "外呼失败（${error::class.simpleName}）")
    }

    /**
     * 通过注册的 [LlmProvider] 外呼一次，并把结果收成三态（见 [LlmOutcome]）。
     * 具体协议由 provider 决定 —— 框架不认识任何一家（从前这里写死 OpenAI 的
     * URL 拼接与 `choices[0]` 解析，想接别家只能改框架）。
     */
    private fun callLlmOutcome(profile: AgentProfileStore.Profile, messages: List<LlmMessage>): LlmOutcome {
        val provider = providerRegistry.forProfile(profile)
            ?: return LlmOutcome.Unreachable("没有能处理「${profile.kind.name}」这种连接的 provider")
        return try {
            val text = provider.chat(profile, messages)
            if (text.isNullOrBlank()) LlmOutcome.Unreachable("上游没有返回可用内容") else LlmOutcome.Ok(text)
        } catch (error: Throwable) {
            classifyProviderError(error)
        }
    }

    /**
     * 文章阅读理解：必须有外部模型连接。没有连接或外呼失败都返回 `error`，
     * 由 HTTP 层映射成 409/400/502 —— 不再用本地关键词抽取冒充模型结果。
     * 这是 `/api/agent/comprehend` 的真正执行体（经由 [AgentConnection] 收口到 HTTP）。
     */
    suspend fun comprehend(
        text: String,
        question: String? = null,
        summarySentences: Int = 3,
        topKeywords: Int = 8,
    ): ComprehendOutcome {
        val ext = selectedProfile()
            ?: return ComprehendOutcome(
                engine = "unavailable",
                summary = "",
                keywords = emptyList(),
                answer = null,
                sentencesCount = 0,
                error = "no_connection",
            )
        val prompt = buildComprehensionPrompt(text, question, summarySentences, topKeywords)
        when (val llm = callLlmOutcome(ext, listOf(LlmMessage("user", prompt)))) {
            is LlmOutcome.Ok -> return ComprehendOutcome(
                engine = "external:" + ext.id,
                summary = llm.text.trim(),
                keywords = emptyList(),
                answer = question,
                sentencesCount = -1,
            )
            // 从前这里不分青红皂白报 `upstream_unreachable`：用户填了内网地址被告知"连不上"，
            // 于是去查网络，而真相是他自己填的地址被闸门拒了 —— 这条分支现在如实说 400 + 原因。
            is LlmOutcome.Blocked -> return ComprehendOutcome(
                engine = "unavailable",
                summary = "",
                keywords = emptyList(),
                answer = null,
                sentencesCount = 0,
                error = "invalid_request",
                errorDetail = llm.why,
            )
            is LlmOutcome.Unreachable -> return ComprehendOutcome(
                engine = "unavailable",
                summary = "",
                keywords = emptyList(),
                answer = null,
                sentencesCount = 0,
                error = "upstream_unreachable",
                errorDetail = llm.why,
            )
        }
    }

    /**
     * 自由对话（多轮）—— **带工具能力**：模型可以要求执行已注册工具，框架执行后回灌结果，
     * 它再继续推理，直到给出最终文本。
     *
     * 这是"内置 AI 接入后可以完成插件级功能"的核心：工具清单来自 [registry]，
     * 所以**插件注册的工具自动对模型可见**。模型想查书源、改规则、搜书，都能真的做到，
     * 而不是只能聊天。
     *
     * 三条约束：
     * - 最多 [MAX_TOOL_ROUNDS] 轮，防止模型无限调工具
     * - 工具执行走 [runTool]，护栏、钩子、权限全部照常生效
     * - 没有连接或外呼失败都返回 error，不编一段"本地说明"冒充回答
     */
    suspend fun chat(
        messages: List<Pair<String, String>>,
        allowedToolGroups: Set<String>? = null,
        /** 本轮显式指定的技能 id；空表示按关键词自动挑。 */
        skillIds: List<String> = emptyList(),
        /** 用户逐项停用的工具 id（组开着也不下发）；`program` 组豁免，见 [ToolSelection.select]。 */
        disabledToolIds: List<String> = emptyList(),
    ): ChatOutcome {
        val norm = messages
            .filter { it.second.isNotBlank() }
            .map { LlmMessage(role = it.first.takeIf { r -> r in setOf("system", "user", "assistant") } ?: "user", content = it.second) }
        if (norm.isEmpty()) {
            return ChatOutcome(engine = "error", content = "", error = "empty_messages")
        }
        val ext = selectedProfile()
            ?: return ChatOutcome(engine = "unavailable", content = "", error = "no_connection")

        val provider = providerRegistry.forProfile(ext) ?: return ChatOutcome(
            engine = "unavailable", content = "", error = "upstream_unreachable",
            // 没有 provider 是配置状态，不是网络问题 —— 一句"连不上"会让人去查网络。
            errorDetail = "没有能处理「${ext.kind.name}」这种连接的 provider",
        )
        // 只下发与这一轮相关的工具组：55 个全量塞进每次请求会白烧 token、也让模型更容易挑错工具。
        val lastUserText = messages.lastOrNull { it.first == "user" }?.second.orEmpty()
        val tools = ToolSelection.select(registry.manifest(), lastUserText, allowedToolGroups, disabledToolIds.toSet())
        val toolRounds = mutableListOf<String>()
        val injected = injectContext(
            norm,
            AgentPromptStore.select(homeDirectory),
            AgentSkillStore.select(homeDirectory, skillIds, lastUserText),
        )
        // 这两个是**实际注入**的那两份：预设可能因为注入预算被挡掉几条，
        // 回报给界面的 ids 必须与模型真正看到的一致。
        val prompts = injected.prompts
        val skills = injected.skills
        val convo = injected.messages.toMutableList()
        val trimmed = trimToBudget(convo)
        var usage = LlmUsage()

        // 多轮：模型要调工具 → 框架执行 → 结果回灌 → 再问。
        //
        // 回灌有两种协议形态，按能力自动降级：
        //  A. **原生 tool 协议**（标准 OpenAI）：带 tool_calls 的 assistant 轮次 + 每条
        //     role="tool" 且带 tool_call_id 的消息。这是最正确的形态。
        //  B. **纯文本回灌**：把工具结果写成一段 user 消息、并且**不再带 tools**。
        //     有些网关（实测 pipio.io）把工具调用实现成服务端有状态的「原生工具运行」，
        //     客户端把结果回灌第二轮时那次运行已经过期，上游直接报
        //     `invalid_tool_contract: native tool run expired … start a new turn with the
        //     original request instead of resending tool results`。
        //     对这类上游，只有 B 能通。所以 A 失败一次就整体切到 B，不再回头试 A。
        var useNativeToolProtocol = true
        // 最后一跳"到不了"的真因（DNS 失败 / 连不上 / 上游返回非 2xx）。
        // 只用来把 HTTP 层那句套话换成能照着做事的话，不参与控制流。
        var providerFailure: String? = null
        for (round in 0 until MAX_TOOL_ROUNDS) {
            // 内网地址被闸门拒了要**说清是拒绝**，不能混进 runCatching 变成
            // "返回 null → 上层报 upstream_unreachable" —— 那会让用户去查网络，
            // 而真相是他填的 baseUrl 指向本机/内网。这两件事的修法完全不同。
            val reply: LlmReply? = try {
                if (useNativeToolProtocol) provider.chatWithTools(ext, convo, tools)
                else provider.chatWithTools(ext, convo, emptyList())
            } catch (error: IllegalArgumentException) {
                // 地址被闸门拒了 / 参数非法：明确报 invalid_request，并把那句中文原样带回去。
                // 上层（HTTP 层）据此回 400 + 这句消息，用户看到的是"你填的地址是内网"，
                // 而不是"模型不可达"。
                val blocked = classifyProviderError(error) as LlmOutcome.Blocked
                return ChatOutcome(engine = "unavailable", content = "", error = "invalid_request", errorDetail = blocked.why)
            } catch (error: Throwable) {
                // 「到不了」这一支从前把异常整个丢掉（`{ null }`），于是域名打错一个字母
                // 与上游超时在用户眼里都是同一句"外部模型连不上"。
                // 留着 null 继续走既有的协议降级逻辑（A→B），但把原因记下来，
                // 最后真要报错时把它带回 HTTP 层。
                providerFailure = error.message ?: "外呼失败（${error::class.simpleName}）"
                null
            }
            // 原生协议这一跳失败：可能是上游不认「回灌」形态。切到文本回灌重试一次本轮。
            if (reply == null && useNativeToolProtocol && convo.any { it.role == "tool" }) {
                useNativeToolProtocol = false
                // 把历史里已有的 tool 结果改写成 user 消息 —— 文本回灌形态不认 tool 角色。
                val transcript = convo.filter { it.role == "tool" }.joinToString("\n") { it.content }
                val stripped = convo.filter { it.role != "tool" && it.role != "assistant" }
                convo.clear()
                convo.addAll(stripped)
                convo += LlmMessage(
                    role = "user",
                    content = "已执行以下工具，结果如下：\n$transcript\n请基于这些结果直接回答，不要再次请求工具。",
                )
                val retry = runCatching { provider.chatWithTools(ext, convo, emptyList()) }
                    .onFailure { providerFailure = it.message ?: "外呼失败（${it::class.simpleName}）" }
                    .getOrNull()
                if (retry != null && retry.toolCalls.isEmpty()) {
                    return ChatOutcome(
                        engine = "external:" + ext.id,
                        content = retry.content.trim(),
                        toolRounds = toolRounds.ifEmpty { null },
                        usage = usage.plus(retry.usage).takeIf { !it.isEmpty },
                        skillsUsed = skills.map { it.id }.ifEmpty { null },
                        promptsUsed = prompts.map { it.id }.ifEmpty { null },
                        trimmed = trimmed,
                    )
                }
            }
            if (reply == null) {
                // 外呼失败：明确报错；已经执行过的工具照实带回去，不伪造回答。
                return ChatOutcome(
                    engine = "unavailable",
                    content = "",
                    error = "upstream_unreachable",
                    toolRounds = toolRounds.ifEmpty { null },
                    errorDetail = providerFailure,
                )
            }
            usage = usage.plus(reply.usage)
            if (reply.toolCalls.isEmpty()) {
                // 没有工具调用 = 模型给出了最终答复，收工。
                return ChatOutcome(
                    engine = "external:" + ext.id,
                    content = reply.content.trim(),
                    toolRounds = toolRounds.ifEmpty { null },
                    usage = usage.takeIf { !it.isEmpty },
                    skillsUsed = skills.map { it.id }.ifEmpty { null },
                    promptsUsed = prompts.map { it.id }.ifEmpty { null },
                    trimmed = trimmed,
                )
            }
            // 有工具调用：先把它的话留下，再逐个执行并回灌。
            if (useNativeToolProtocol) {
                // 标准 OpenAI 形态：assistant 轮次原样带回 tool_calls，
                // 每条 tool 消息用 tool_call_id 指回是哪一个调用。
                convo += LlmMessage(
                    role = "assistant",
                    content = reply.content,
                    toolCalls = reply.toolCalls,
                )
                for (call in reply.toolCalls) {
                    val result = runTool(call.name, call.args)
                    toolRounds += "${call.name}:${result.code}"
                    convo += LlmMessage(
                        role = "tool",
                        content = renderToolResult(call.name, result),
                        toolCallId = call.id,
                    )
                }
            } else {
                // 文本回灌形态：结果写成 user 消息，历史里不留 tool 角色。
                val executed = reply.toolCalls.map { call ->
                    val result = runTool(call.name, call.args)
                    toolRounds += "${call.name}:${result.code}"
                    renderToolResult(call.name, result)
                }
                convo += LlmMessage(
                    role = "user",
                    content = "已执行以下工具，结果如下：\n" + executed.joinToString("\n") +
                        "\n请基于这些结果直接回答，不要再次请求工具。",
                )
            }
        }

        // 轮数用完：逼它收敛（不带工具再问一次）。
        val finalText = runCatching {
            provider.chat(ext, convo + LlmMessage("user", "请基于以上工具结果直接回答，不要再调用工具。"))
        }.getOrNull()
        if (!finalText.isNullOrBlank()) {
            return ChatOutcome(
                engine = "external:" + ext.id,
                content = finalText.trim(),
                toolRounds = toolRounds.ifEmpty { null },
                usage = usage.takeIf { !it.isEmpty },
                skillsUsed = skills.map { it.id }.ifEmpty { null },
                promptsUsed = prompts.map { it.id }.ifEmpty { null },
                trimmed = trimmed,
            )
        }
        return ChatOutcome(
            engine = "unavailable",
            content = "",
            error = "tool_rounds_exhausted",
            toolRounds = toolRounds.ifEmpty { null },
        )
    }

    /**
     * 流式对话：与 [chat] 同一套工具循环，但把过程作为 [AgentStreamEvent] 逐步吐出来。
     *
     * 实现上把"跑模型 + 执行工具"放在 IO 协程里，事件经无界 Channel 交给调用方；
     * 调用方（HTTP 层）只负责把事件写成 SSE。这样：
     * - provider 的回调在阻塞线程里也能安全发事件（trySend 不阻塞）；
     * - 客户端断开 → 调用方取消 → 生产者协程一起取消，不会继续烧模型额度；
     * - 前缀 `delta` 与最终 `end.content` 分开：工具轮次前的"我先查一下"不会被当成最终答案。
     *
     * 没有连接、provider 缺失等"开流前就能确定"的错误仍以 `error` 事件发出；
     * HTTP 层在开流前会先检查连接，避免 200 之后才发现 409。
     */
    suspend fun chatStream(
        messages: List<Pair<String, String>>,
        allowedToolGroups: Set<String>? = null,
        skillIds: List<String> = emptyList(),
        /** 与 [chat] 同一份逐项停用清单 —— 两条路径的过滤必须一致。 */
        disabledToolIds: List<String> = emptyList(),
        onEvent: suspend (AgentStreamEvent) -> Unit,
    ): ChatOutcome = coroutineScope {
        val events = Channel<AgentStreamEvent>(Channel.UNLIMITED)
        val result = CompletableDeferred<ChatOutcome>()
        val producer = launch(Dispatchers.IO) {
            try {
                result.complete(
                    runStream(messages, allowedToolGroups, skillIds, disabledToolIds) { event -> events.trySend(event) },
                )
            } catch (cancelled: CancellationException) {
                result.complete(ChatOutcome(engine = "unavailable", content = "", error = "cancelled"))
                throw cancelled
            } catch (error: Throwable) {
                val why = error.message ?: error::class.simpleName ?: "未知错误"
                events.trySend(AgentStreamEvent("error", code = "internal_error", message = why))
                result.complete(ChatOutcome(engine = "unavailable", content = "", error = "upstream_unreachable", errorDetail = why))
            } finally {
                events.close()
            }
        }
        try {
            for (event in events) onEvent(event)
        } catch (error: Throwable) {
            // 客户端断开/写失败：停掉生产者，别让模型继续算。
            producer.cancel()
            throw error
        }
        producer.join()
        result.await()
    }

    private suspend fun runStream(
        messages: List<Pair<String, String>>,
        allowedToolGroups: Set<String>?,
        skillIds: List<String>,
        disabledToolIds: List<String>,
        emit: (AgentStreamEvent) -> Unit,
    ): Agent.ChatOutcome {
        val norm = messages
            .filter { it.second.isNotBlank() }
            .map { LlmMessage(role = it.first.takeIf { r -> r in setOf("system", "user", "assistant") } ?: "user", content = it.second) }
        if (norm.isEmpty()) {
            emit(AgentStreamEvent("error", code = "empty_messages", message = "messages 不能为空"))
            return ChatOutcome(engine = "error", content = "", error = "empty_messages")
        }
        val ext = selectedProfile()
            ?: return ChatOutcome(engine = "unavailable", content = "", error = "no_connection").also {
                emit(AgentStreamEvent("error", code = "no_connection", message = "尚未登记外部模型连接"))
            }
        val provider = providerRegistry.forProfile(ext)
            ?: return ChatOutcome(
                engine = "unavailable", content = "", error = "upstream_unreachable",
                errorDetail = "没有能处理「${ext.kind.name}」这种连接的 provider",
            ).also {
                emit(AgentStreamEvent("error", code = "upstream_unreachable", message = "没有能处理「${ext.kind.name}」这种连接的 provider"))
            }

        val lastUserText = messages.lastOrNull { it.first == "user" }?.second.orEmpty()
        val tools = ToolSelection.select(registry.manifest(), lastUserText, allowedToolGroups, disabledToolIds.toSet())
        val injected = injectContext(
            norm,
            AgentPromptStore.select(homeDirectory),
            AgentSkillStore.select(homeDirectory, skillIds, lastUserText),
        )
        val prompts = injected.prompts
        val skills = injected.skills
        val convo = injected.messages.toMutableList()
        val trimmed = trimToBudget(convo)
        val toolRounds = mutableListOf<String>()
        var usage = LlmUsage()
        var providerFailure: String? = null
        var useNativeToolProtocol = true

        emit(
            AgentStreamEvent(
                type = "start",
                engine = "external:" + ext.id,
                model = ext.model,
                skills = skills.map { it.id }.ifEmpty { null },
                prompts = prompts.map { it.id }.ifEmpty { null },
                trimmed = trimmed.takeIf { it > 0 },
            ),
        )

        for (round in 0 until MAX_TOOL_ROUNDS) {
            val roundText = StringBuilder()
            val callbacks = LlmStreamCallbacks(
                onDelta = { piece ->
                    if (piece.isNotEmpty()) {
                        roundText.append(piece)
                        emit(AgentStreamEvent("delta", text = piece))
                    }
                },
                onReasoning = { piece ->
                    if (piece.isNotEmpty()) emit(AgentStreamEvent("reasoning", text = piece))
                },
                onUsage = { reported ->
                    usage = usage.plus(reported)
                    emit(usageEvent(usage))
                },
            )
            val reply: LlmReply? = try {
                // runInterruptible：provider 走的是阻塞 HttpClient，客户端断开时靠线程中断
                // 把那次 send/readLine 打断，否则协程取消了它还在继续读，模型额度照烧。
                runInterruptible {
                    provider.chatWithToolsStream(ext, convo, if (useNativeToolProtocol) tools else emptyList(), callbacks)
                }
            } catch (blocked: IllegalArgumentException) {
                val why = blocked.message ?: "地址不合法或被出站安全闸门拒绝"
                emit(AgentStreamEvent("error", code = "invalid_request", message = why))
                return ChatOutcome(engine = "unavailable", content = "", error = "invalid_request", errorDetail = why)
            } catch (cancelled: CancellationException) {
                // 客户端断开：一路向上抛，别把它翻译成"上游不可达"。
                throw cancelled
            } catch (error: Throwable) {
                providerFailure = error.message ?: "外呼失败（${error::class.simpleName}）"
                null
            }

            if (reply == null && useNativeToolProtocol && convo.any { it.role == "tool" }) {
                // 上游不认原生回灌：切到文本回灌，重试一次（与 [chat] 同一条降级路径）。
                useNativeToolProtocol = false
                val transcript = convo.filter { it.role == "tool" }.joinToString("\n") { it.content }
                val stripped = convo.filter { it.role != "tool" && it.role != "assistant" }
                convo.clear()
                convo.addAll(stripped)
                convo += LlmMessage(
                    role = "user",
                    content = "已执行以下工具，结果如下：\n$transcript\n请基于这些结果直接回答，不要再次请求工具。",
                )
                val retry = runCatching { provider.chat(ext, convo) }
                    .onFailure { providerFailure = it.message ?: "外呼失败（${it::class.simpleName}）" }
                    .getOrNull()
                if (!retry.isNullOrBlank()) {
                    emit(AgentStreamEvent("delta", text = retry))
                    if (!usage.isEmpty) emit(usageEvent(usage))
                    emit(
                        AgentStreamEvent(
                            "end",
                            engine = "external:" + ext.id,
                            content = retry.trim(),
                            toolRounds = toolRounds.ifEmpty { null },
                            skills = skills.map { it.id }.ifEmpty { null },
                            prompts = prompts.map { it.id }.ifEmpty { null },
                            trimmed = trimmed.takeIf { it > 0 },
                        ),
                    )
                    return ChatOutcome(
                        engine = "external:" + ext.id,
                        content = retry.trim(),
                        toolRounds = toolRounds.ifEmpty { null },
                        usage = usage.takeIf { !it.isEmpty },
                        skillsUsed = skills.map { it.id }.ifEmpty { null },
                        promptsUsed = prompts.map { it.id }.ifEmpty { null },
                        trimmed = trimmed,
                    )
                }
            }

            if (reply == null) {
                val why = providerFailure ?: "外部模型没有返回内容"
                emit(AgentStreamEvent("error", code = "upstream_unreachable", message = why))
                return ChatOutcome(
                    engine = "unavailable", content = "", error = "upstream_unreachable",
                    toolRounds = toolRounds.ifEmpty { null }, errorDetail = why,
                )
            }
            usage = usage.plus(reply.usage)

            if (reply.toolCalls.isEmpty()) {
                val content = reply.content.ifBlank { roundText.toString() }.trim()
                if (!usage.isEmpty) emit(usageEvent(usage))
                emit(
                    AgentStreamEvent(
                        "end",
                        engine = "external:" + ext.id,
                        content = content,
                        toolRounds = toolRounds.ifEmpty { null },
                        skills = skills.map { it.id }.ifEmpty { null },
                        prompts = prompts.map { it.id }.ifEmpty { null },
                        trimmed = trimmed.takeIf { it > 0 },
                    ),
                )
                return ChatOutcome(
                    engine = "external:" + ext.id,
                    content = content,
                    toolRounds = toolRounds.ifEmpty { null },
                    usage = usage.takeIf { !it.isEmpty },
                    skillsUsed = skills.map { it.id }.ifEmpty { null },
                    promptsUsed = prompts.map { it.id }.ifEmpty { null },
                    trimmed = trimmed,
                )
            }

            reply.toolCalls.forEach { call ->
                emit(
                    AgentStreamEvent(
                        "tool_start",
                        toolId = call.name,
                        callId = call.id,
                        args = call.args.mapValues { (_, v) -> (v?.toString() ?: "").take(200) },
                    ),
                )
            }

            if (useNativeToolProtocol) {
                convo += LlmMessage(role = "assistant", content = reply.content, toolCalls = reply.toolCalls)
                for (call in reply.toolCalls) {
                    val startedAt = System.currentTimeMillis()
                    val result = runTool(call.name, call.args)
                    toolRounds += "${call.name}:${result.code}"
                    emit(toolEndEvent(call.name, call.id, result, System.currentTimeMillis() - startedAt))
                    convo += LlmMessage(
                        role = "tool",
                        content = renderToolResult(call.name, result),
                        toolCallId = call.id,
                    )
                }
            } else {
                val executed = reply.toolCalls.map { call ->
                    val startedAt = System.currentTimeMillis()
                    val result = runTool(call.name, call.args)
                    toolRounds += "${call.name}:${result.code}"
                    emit(toolEndEvent(call.name, call.id, result, System.currentTimeMillis() - startedAt))
                    renderToolResult(call.name, result)
                }
                convo += LlmMessage(
                    role = "user",
                    content = "已执行以下工具，结果如下：\n" + executed.joinToString("\n") +
                        "\n请基于这些结果直接回答，不要再次请求工具。",
                )
            }
        }

        val finalText = runCatching {
            provider.chat(ext, convo + LlmMessage("user", "请基于以上工具结果直接回答，不要再调用工具。"))
        }.getOrNull()
        if (!finalText.isNullOrBlank()) {
            emit(AgentStreamEvent("delta", text = finalText))
            if (!usage.isEmpty) emit(usageEvent(usage))
            emit(
                AgentStreamEvent(
                    "end",
                    engine = "external:" + ext.id,
                    content = finalText.trim(),
                    toolRounds = toolRounds.ifEmpty { null },
                    skills = skills.map { it.id }.ifEmpty { null },
                    prompts = prompts.map { it.id }.ifEmpty { null },
                    trimmed = trimmed.takeIf { it > 0 },
                ),
            )
            return ChatOutcome(
                engine = "external:" + ext.id,
                content = finalText.trim(),
                toolRounds = toolRounds.ifEmpty { null },
                usage = usage.takeIf { !it.isEmpty },
                skillsUsed = skills.map { it.id }.ifEmpty { null },
                promptsUsed = prompts.map { it.id }.ifEmpty { null },
                trimmed = trimmed,
            )
        }
        emit(AgentStreamEvent("error", code = "tool_rounds_exhausted", message = "工具调用轮数已达上限，模型仍未给出结论"))
        return ChatOutcome(
            engine = "unavailable",
            content = "",
            error = "tool_rounds_exhausted",
            toolRounds = toolRounds.ifEmpty { null },
        )
    }

    private fun usageEvent(usage: LlmUsage) = AgentStreamEvent(
        type = "usage",
        promptTokens = usage.promptTokens,
        completionTokens = usage.completionTokens,
        totalTokens = usage.totalTokens,
    )

    private fun toolEndEvent(toolId: String, callId: String, result: AgentResult, ms: Long) = AgentStreamEvent(
        type = "tool_end",
        toolId = toolId,
        callId = callId,
        status = result.status,
        code = result.code,
        message = (result.message ?: result.code).take(200),
        ms = ms,
    )

    /** 当前可用的技能（含内置）。 */
    fun listSkills(): List<AgentSkillStore.Skill> = AgentSkillStore.list(homeDirectory)

    /** 新建/覆盖一个用户技能。 */
    fun saveSkill(
        id: String?,
        name: String,
        description: String,
        keywords: List<String>,
        content: String,
        enabled: Boolean,
    ): AgentSkillStore.Skill = AgentSkillStore.save(homeDirectory, id, name, description, keywords, content, enabled)

    /** 删除一个用户技能（移入 agent-skills/.trash，不直接删文件）。 */
    fun deleteSkill(id: String): Boolean = AgentSkillStore.delete(homeDirectory, id)

    /** 当前提示词预设（按 order 排好序）。 */
    fun listPrompts(): List<AgentPromptStore.Preset> = AgentPromptStore.list(homeDirectory)

    /** 新建/覆盖一条提示词预设。 */
    fun savePrompt(
        id: String?,
        name: String,
        instruction: String,
        enabled: Boolean,
        order: Int?,
    ): AgentPromptStore.Preset = AgentPromptStore.save(homeDirectory, id, name, instruction, enabled, order)

    /** 删除一条提示词预设（删前整份文件备份进 agent-prompts 的 .trash）。 */
    fun deletePrompt(id: String): Boolean = AgentPromptStore.delete(homeDirectory, id)

    /** 注入结果：拼好的消息序列 + **真的进了 system** 的预设与技能（回报用的就是这两份）。 */
    private data class Injected(
        val messages: List<LlmMessage>,
        val prompts: List<AgentPromptStore.Preset>,
        val skills: List<AgentSkillStore.Skill>,
    )

    /**
     * 组装本轮 system 段：**宿主基础人设 → 提示词预设 → 技能**。
     *
     * 顺序有意如此：预设说的是"怎么说话"（全局生效），技能说的是"这类任务怎么做"
     * （按关键词命中），越具体越靠后，模型更容易把它当成本轮的补充而不是全局人设。
     * 调用方自己传的 system 永远排最前 —— 那是宿主的地基，不能被用户预设顶掉。
     *
     * 为什么不拼成一个巨大的 system：每条预设/技能各自有边界，分开注入后模型更容易
     * 把"这次命中的是哪几条"对上；也方便在响应里回报 `promptsUsed` / `skillsUsed`。
     *
     * 预设总长受 [MAX_PROMPT_CHARS] 约束：放不下的一条**整条不注入**（不截半句），
     * 后面的也不再试 —— 预设有顺序，前面缺一条后面接上去只会得到半套规则。
     * 被这样挡掉的预设**不进 [Injected.prompts]**：回报"用了哪些"必须与实际发给模型的一致，
     * 否则界面说"已注入 4 条"而模型只看到 3 条，用户排查半天找不到原因。
     */
    private fun injectContext(
        base: List<LlmMessage>,
        prompts: List<AgentPromptStore.Preset>,
        skills: List<AgentSkillStore.Skill>,
    ): Injected {
        if (prompts.isEmpty() && skills.isEmpty()) return Injected(base, emptyList(), emptyList())
        val insertAt = base.indexOfFirst { it.role != "system" }.let { if (it < 0) base.size else it }
        val injected = mutableListOf<LlmMessage>()
        val usedPrompts = mutableListOf<AgentPromptStore.Preset>()
        var promptBudget = MAX_PROMPT_CHARS
        for (preset in prompts) {
            val body = preset.instruction.take(AgentPromptStore.MAX_INSTRUCTION_CHARS)
            if (body.length > promptBudget) break
            promptBudget -= body.length
            usedPrompts += preset
            injected += LlmMessage(role = "system", content = "【提示词：${preset.name}】\n$body")
        }
        for (skill in skills) {
            injected += LlmMessage(
                role = "system",
                content = "【技能：${skill.name}】\n${skill.content.take(AgentSkillStore.MAX_CONTENT_CHARS)}",
            )
        }
        return Injected(base.take(insertAt) + injected + base.drop(insertAt), usedPrompts, skills)
    }

    /**
     * 按字符预算裁剪历史：从**最旧的整轮**开始丢，绝不切开任何一轮。
     *
     * 为什么按轮（user → assistant → tool…）而不是逐条丢：原生 tool 协议里
     * assistant 的 `tool_calls` 与后面每条 `role=tool` 的结果必须成对出现，
     * 单独丢掉一半，上游会直接报 invalid tool contract。以 user 消息为段边界
     * 天然满足这条 —— 一轮之内的消息要么全留、要么全丢。
     *
     * 两条保底：system 段（人设 + 预设 + 技能）与**最后一条 user 消息**永远保留。
     * 前者丢了整轮就变味；后者丢了等于没问。单条用户消息自己就超预算时不截断：
     * 那是用户的原话，宁可让它超一点，也不能悄悄改写他问的内容。
     *
     * 直接改 [convo]，返回实际丢掉的条数（0 = 没到预算，没裁）。
     */
    private fun trimToBudget(convo: MutableList<LlmMessage>): Int {
        if (convo.isEmpty()) return 0
        var remaining = convo.sumOf { it.content.length }
        if (remaining <= MAX_CONTEXT_CHARS) return 0

        val lastUser = convo.indexOfLast { it.role == "user" }
        if (lastUser < 0) return 0
        val headEnd = convo.indexOfFirst { it.role != "system" }.let { if (it < 0) convo.size else it }
        // 只有一轮：没有可丢的旧消息，宁可超预算也不动用户这次问的内容。
        if (lastUser <= headEnd) return 0

        // 段边界：headEnd 起每遇到一条 user 就是新的一段（headEnd→首条 user 之间的
        // 零散消息并进第一段，它们本来就属于上一轮的尾巴）。
        val cuts = mutableListOf(headEnd)
        for (i in headEnd + 1 until lastUser) {
            if (convo[i].role == "user") cuts += i
        }

        var dropUntil = headEnd
        for (k in cuts.indices) {
            if (remaining <= MAX_CONTEXT_CHARS) break
            val from = cuts[k]
            val to = if (k + 1 < cuts.size) cuts[k + 1] else lastUser
            if (to <= from) continue
            for (i in from until to) remaining -= convo[i].content.length
            dropUntil = to
        }
        if (dropUntil <= headEnd) return 0
        val count = dropUntil - headEnd
        repeat(count) { convo.removeAt(headEnd) }
        return count
    }

    /** 把一次工具结果压成给模型看的短文本（太长会挤爆上下文）。 */
    private fun renderToolResult(toolId: String, result: AgentResult): String {
        val body = buildString {
            append("工具 ").append(toolId).append(" 返回（").append(result.status).append("/").append(result.code).append("）")
            if (!result.message.isNullOrBlank()) append("：").append(result.message)
            if (result.data != null) {
                // 工具结果本来就是给人/模型看的（List/Map/String），toString 足够；
                // 不走 kotlinx 序列化 —— Any? 没有序列化器，硬塞会编译不过。
                val raw = result.data.toString()
                if (raw.length <= MAX_TOOL_DATA) {
                    append("｜数据：").append(raw)
                } else {
                    // **截断必须说清"这是截断"**。原来只写「…（已截断）」，模型会把
                    // 截断后能看到的条数当成总数 —— 实测问「库里多少书源」，5596 条的
                    // 列表被截到 4000 字符（约 21 条），模型就答了「21」。
                    // 现在明确给出总长度与元素个数，让模型知道该说"数据太长，只看到前一部分"。
                    val total = (result.data as? Collection<*>)?.size
                    append("｜数据（**已截断**，")
                    append("完整内容共 ").append(raw.length).append(" 字符")
                    if (total != null) append("、").append(total).append(" 条")
                    append("，下面只给出前 ").append(MAX_TOOL_DATA).append(" 字符，**不是全部**）：")
                    append(raw.take(MAX_TOOL_DATA)).append("…")
                }
            }
        }
        return body
    }

    /**
     * 当前选中的外部连接——统一走 [selectorRegistry]，把"连哪个"的决定权交给可插拔策略。
     * 默认策略 [FirstProfileSelector] 取第一个，行为与改动前完全一致（见 AGENTS.md §4）。
     */
    private fun selectedProfile(): AgentProfileStore.Profile? =
        selectorRegistry.selected(profileStore.list(homeDirectory))

    // 把摘要/关键词/问答需求拼成一个给外部模型的 prompt（通用模板，不绑定某家）。
    private fun buildComprehensionPrompt(text: String, question: String?, summarySentences: Int, topKeywords: Int): String =
        buildString {
            append("你是一个文章阅读理解助手。请基于下面的文章完成三件事：\n")
            append("1. 用不超过 " + summarySentences + " 句话给出摘要；\n")
            append("2. 列出 " + topKeywords + " 个关键词；\n")
            if (!question.isNullOrBlank()) append("3. 回答问题：" + question + "\n")
            append("\n文章：\n" + text + "\n")
        }

    /** 文章阅读理解的结构化结果，与 HTTP 层 ComprehendResponse 对齐。 */
    data class ComprehendOutcome(
        val engine: String,
        val summary: String,
        val keywords: List<String>,
        val answer: String?,
        val sentencesCount: Int,
        val error: String? = null,
        /**
         * 出错的真因（一句中文）。从前只有 `error` 那个码，HTTP 层只能回一句写死的
         * 套话（"外部模型连不上"），于是"地址是内网"被说成"连不上"。
         */
        val errorDetail: String? = null,
    )

    /** 一个目标经"规划 → 执行"的极简闭环结果。 */
    data class Plan(
        val goal: String,
        val toolId: String?,
        val note: String? = null,
    )

    /** 自由对话的结构化结果，与 HTTP 层 ChatResponse 对齐。 */
    data class ChatOutcome(
        val engine: String,
        val content: String,
        val error: String? = null,
        /** 本轮对话实际执行过的工具（`工具id:结果码`）。没调工具就是 null。 */
        val toolRounds: List<String>? = null,
        /** 出错的真因（一句中文），同 ComprehendOutcome.errorDetail。 */
        val errorDetail: String? = null,
        /** 上游报告的 token 用量（多轮累加）；没报就是 null。 */
        val usage: LlmUsage? = null,
        /** 本轮实际注入的技能 id。没命中就是 null。 */
        val skillsUsed: List<String>? = null,
        /** 本轮实际注入的提示词预设 id（按注入顺序）。一条都没启用就是 null。 */
        val promptsUsed: List<String>? = null,
        /** 为塞进上下文预算丢掉的旧消息条数。0 = 没裁。 */
        val trimmed: Int = 0,
    )

    companion object {
        /** 一次对话里最多让模型调几轮工具 —— 防止它无限"我要再查一个"把请求拖死。 */
        val MAX_TOOL_ROUNDS: Int = AppConfig.aiMaxToolRounds

        /** 单次工具结果塞回上下文的字符上限。 */
        val MAX_TOOL_DATA: Int = AppConfig.aiMaxToolData

        /** 整轮对话的字符预算，超过就从最旧的整轮开始丢（见 [trimToBudget]）。 */
        val MAX_CONTEXT_CHARS: Int = AppConfig.aiMaxContextChars

        /** 每轮注入提示词预设的总字符上限，放不下的整条不注入（见 [injectContext]）。 */
        val MAX_PROMPT_CHARS: Int = AppConfig.aiMaxPromptChars
    }
}
