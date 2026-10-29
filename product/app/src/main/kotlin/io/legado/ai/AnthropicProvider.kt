package io.legado.ai

import io.legado.AppConfig
import io.legado.http.NetworkSecurity
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import java.util.TreeMap

/**
 * Anthropic Messages 协议的实现（Claude）。
 *
 * 与 OpenAI 兼容协议的三处硬差别 —— 这也是为什么它必须是一个独立 provider，
 * 而不是在 OpenAI 那份里加几个 if：
 *
 * 1. **鉴权头不同**：`x-api-key` + 必带 `anthropic-version`，不是 `Authorization: Bearer`。
 * 2. **system 不在 messages 里**：必须单独一个顶层 `system` 字段。
 * 3. **工具结果是 user 消息里的 `tool_result` 块**，不是 `role:"tool"`；
 *    且角色必须交替（连续同角色会被 400），所以这里要把相邻 user 合并成一条。
 *
 * 流式是 Anthropic 自己的事件形态（`content_block_start/delta/stop`），
 * 工具参数以 `input_json_delta.partial_json` 分片到达。
 *
 * 地址：`<baseUrl>/v1/messages`（baseUrl 已带 `/v1` 不重复拼）。
 */
class AnthropicProvider(
    private val loopbackAllowed: () -> Boolean = { AppConfig.aiAllowLoopbackBaseUrl },
) : LlmProvider {

    override val id: String = "anthropic"
    override val displayName: String = "Anthropic Messages"
    override val description: String =
        "Anthropic 官方 /v1/messages 协议（Claude），也适用于实现了同一协议的中转站。" +
            "鉴权用 x-api-key；地址填到根即可（…/v1 有没有都行）。"

    private val json = ProviderHttp.json

    override fun chat(profile: AgentProfileStore.Profile, messages: List<LlmMessage>): String? =
        chatWithTools(profile, messages, emptyList())?.content?.ifBlank { null }

    override fun chatWithTools(
        profile: AgentProfileStore.Profile,
        messages: List<LlmMessage>,
        tools: List<ToolMeta>,
    ): LlmReply? {
        val url = endpointUrl(profile) ?: return null
        ProviderHttp.assertPublicBaseUrl(url, loopbackAllowed())
        val resp = ProviderHttp.sendText(
            profile = profile,
            url = url,
            body = encodeRequest(profile, messages, tools, stream = false),
            timeoutMs = ProviderHttp.timeoutMs(profile, 60_000L),
            headers = baseHeaders(profile),
            authHeaders = { key -> auth(key) },
        )
        if (resp.statusCode() !in 200..299) {
            ProviderHttp.failForStatus(resp.statusCode(), resp.body())
        }
        return runCatching { parseReply(resp.body()) }.getOrNull()
    }

    override fun chatWithToolsStream(
        profile: AgentProfileStore.Profile,
        messages: List<LlmMessage>,
        tools: List<ToolMeta>,
        callbacks: LlmStreamCallbacks,
    ): LlmReply? {
        val url = endpointUrl(profile) ?: return null
        ProviderHttp.assertPublicBaseUrl(url, loopbackAllowed())
        val resp = ProviderHttp.sendStream(
            profile = profile,
            url = url,
            body = encodeRequest(profile, messages, tools, stream = true),
            timeoutMs = ProviderHttp.timeoutMs(profile, 60_000L),
            headers = baseHeaders(profile),
            authHeaders = { key -> auth(key) },
        )
        if (resp.statusCode() !in 200..299) {
            val text = runCatching { resp.body().bufferedReader().use { it.readText() } }.getOrNull()
            ProviderHttp.failForStatus(resp.statusCode(), text)
        }

        val text = StringBuilder()
        val blocks = TreeMap<Int, BlockAccumulator>()
        var usage: LlmUsage? = null

        fun handle(payload: String) {
            val obj = runCatching { json.parseToJsonElement(payload) }.getOrNull() as? JsonObject ?: return
            when ((obj["type"] as? JsonPrimitive)?.contentOrNull) {
                "message_start" -> {
                    val message = obj["message"] as? JsonObject ?: return
                    ProviderHttp.parseUsage(message["usage"] as? JsonObject)?.let { usage = it }
                }
                "content_block_start" -> {
                    val index = indexOf(obj) ?: return
                    val block = obj["content_block"] as? JsonObject ?: return
                    val acc = blocks.getOrPut(index) { BlockAccumulator() }
                    acc.type = (block["type"] as? JsonPrimitive)?.contentOrNull ?: "text"
                    acc.id = (block["id"] as? JsonPrimitive)?.contentOrNull
                    acc.name = (block["name"] as? JsonPrimitive)?.contentOrNull
                }
                "content_block_delta" -> {
                    val index = indexOf(obj) ?: return
                    val delta = obj["delta"] as? JsonObject ?: return
                    when ((delta["type"] as? JsonPrimitive)?.contentOrNull) {
                        "text_delta" -> (delta["text"] as? JsonPrimitive)?.contentOrNull
                            ?.takeIf { it.isNotEmpty() }?.let {
                                text.append(it)
                                callbacks.onDelta(it)
                            }
                        "thinking_delta" -> (delta["thinking"] as? JsonPrimitive)?.contentOrNull
                            ?.takeIf { it.isNotEmpty() }?.let(callbacks.onReasoning)
                        "input_json_delta" -> {
                            val acc = blocks.getOrPut(index) { BlockAccumulator().apply { type = "tool_use" } }
                            (delta["partial_json"] as? JsonPrimitive)?.contentOrNull?.let { acc.json.append(it) }
                        }
                    }
                }
                "message_delta" -> {
                    ProviderHttp.parseUsage(obj["usage"] as? JsonObject)?.let {
                        usage = (usage ?: LlmUsage()).plus(it)
                    }
                }
                "error" -> {
                    val message = ((obj["error"] as? JsonObject)?.get("message") as? JsonPrimitive)?.contentOrNull
                    throw NetworkSecurity.UnreachableTargetException("上游报错：${message ?: "未知错误"}")
                }
            }
        }

        ProviderHttp.forEachSseData(resp.body()) { handle(it) }
        usage?.let(callbacks.onUsage)
        val calls = blocks.values
            .filter { it.type == "tool_use" }
            .mapNotNull { acc ->
                val name = acc.name ?: return@mapNotNull null
                LlmToolCall(
                    id = acc.id ?: name,
                    args = if (acc.json.isBlank()) emptyMap() else ProviderHttp.parseArgs(acc.json.toString()),
                    name = name,
                )
            }
        val content = text.toString()
        if (content.isEmpty() && calls.isEmpty()) return null
        return LlmReply(content = content, toolCalls = calls, usage = usage)
    }

    /** Anthropic 没有模型清单端点（官方要求写死/查文档），返回 null 让界面走自由输入。 */
    override fun listModels(profile: AgentProfileStore.Profile): List<String>? = null

    /** 拼 `…/v1/messages`；有人把整条端点粘进来也能纠正。 */
    internal fun endpointUrl(profile: AgentProfileStore.Profile): String? =
        ProviderHttp.endpoint(profile, "/messages", listOf("/messages", "/v1/messages"))

    /** 解析非流式响应：`content[]` 里的 text / tool_use 块 + usage。 */
    internal fun parseReply(body: String): LlmReply {
        val root = runCatching { json.parseToJsonElement(body) }.getOrNull() as? JsonObject
            ?: return LlmReply(content = body)
        val text = StringBuilder()
        val calls = mutableListOf<LlmToolCall>()
        (root["content"] as? JsonArray)?.forEach { element ->
            val block = element as? JsonObject ?: return@forEach
            when ((block["type"] as? JsonPrimitive)?.contentOrNull) {
                "text" -> text.append((block["text"] as? JsonPrimitive)?.contentOrNull.orEmpty())
                "tool_use" -> {
                    val name = (block["name"] as? JsonPrimitive)?.contentOrNull ?: return@forEach
                    val id = (block["id"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() } ?: name
                    calls += LlmToolCall(
                        id = id,
                        args = ProviderHttp.jsonObjectToArgs(block["input"] as? JsonObject),
                        name = name,
                    )
                }
            }
        }
        val usage = ProviderHttp.parseUsage(root["usage"] as? JsonObject)
        if (text.isEmpty() && calls.isEmpty()) return LlmReply(content = body, usage = usage)
        return LlmReply(content = text.toString(), toolCalls = calls, usage = usage)
    }

    internal fun parseArgs(raw: String): Map<String, Any?> = ProviderHttp.parseArgs(raw)

    // ===== 请求编码 =====

    /** 编码请求体（internal 以便单测钉住 system 提取、tool_result 合并、max_tokens 规则）。 */
    internal fun encodeRequest(
        profile: AgentProfileStore.Profile,
        messages: List<LlmMessage>,
        tools: List<ToolMeta>,
        stream: Boolean,
    ): String {
        val (system, wireMessages) = toWire(messages)
        val budget = thinkingBudget(profile)
        val configured = ProfileOptions.maxTokens(profile.options, DEFAULT_MAX_TOKENS)
        // 开了 extended thinking 时 max_tokens 必须大于预算，否则上游直接 400。
        val maxTokens = if (budget != null) maxOf(configured, budget + 1024) else configured
        val root = buildJsonObject {
            put("model", profile.model ?: DEFAULT_MODEL)
            put("max_tokens", maxTokens)
            if (system.isNotBlank()) put("system", system)
            put("messages", buildJsonArray { wireMessages.forEach { add(it) } })
            if (tools.isNotEmpty()) {
                put(
                    "tools",
                    buildJsonArray {
                        tools.forEach { meta ->
                            add(
                                buildJsonObject {
                                    put("name", meta.id)
                                    put("description", meta.description)
                                    put("input_schema", ToolSchemas.jsonSchema(meta.params))
                                },
                            )
                        }
                    },
                )
            }
            if (stream) put("stream", true)
            if (budget != null) {
                put(
                    "thinking",
                    buildJsonObject {
                        put("type", "enabled")
                        put("budget_tokens", budget)
                    },
                )
            }
        }
        return json.encodeToString(JsonObject.serializer(), root)
    }

    /**
     * 转成 Anthropic 的 `(system, messages[])`。
     *
     * 两条硬约束：system 单独提出来；相邻同角色合并（角色必须交替）。
     */
    private fun toWire(messages: List<LlmMessage>): Pair<String, List<JsonObject>> {
        val system = messages.filter { it.role == "system" }
            .map { it.content.trim() }
            .filter { it.isNotEmpty() }
            .joinToString("\n\n")
        val result = mutableListOf<JsonObject>()

        fun mergeOrAppend(role: String, blocks: List<JsonObject>) {
            if (blocks.isEmpty()) return
            val last = result.lastOrNull()
            val lastRole = (last?.get("role") as? JsonPrimitive)?.contentOrNull
            if (lastRole == role && role == "user") {
                val existing = (last?.get("content") as? JsonArray)?.toMutableList() ?: mutableListOf()
                existing.addAll(blocks)
                result[result.lastIndex] = buildJsonObject {
                    put("role", role)
                    put("content", JsonArray(existing))
                }
            } else if (lastRole == role && role == "assistant") {
                val existing = (last?.get("content") as? JsonArray)?.toMutableList() ?: mutableListOf()
                existing.addAll(blocks)
                result[result.lastIndex] = buildJsonObject {
                    put("role", role)
                    put("content", JsonArray(existing))
                }
            } else {
                result += buildJsonObject {
                    put("role", role)
                    put("content", JsonArray(blocks))
                }
            }
        }

        for (message in messages) {
            when (message.role) {
                "system" -> {}
                "assistant" -> {
                    val blocks = mutableListOf<JsonObject>()
                    if (message.content.isNotBlank()) {
                        blocks += buildJsonObject {
                            put("type", "text")
                            put("text", message.content)
                        }
                    }
                    message.toolCalls.forEach { call ->
                        blocks += buildJsonObject {
                            put("type", "tool_use")
                            put("id", call.id)
                            put("name", call.name)
                            put("input", ProviderHttp.argsToJsonObject(call.args))
                        }
                    }
                    mergeOrAppend("assistant", blocks)
                }
                "tool" -> mergeOrAppend(
                    "user",
                    listOf(
                        buildJsonObject {
                            put("type", "tool_result")
                            put("tool_use_id", message.toolCallId ?: "")
                            put("content", message.content)
                        },
                    ),
                )
                else -> mergeOrAppend(
                    "user",
                    listOf(
                        buildJsonObject {
                            put("type", "text")
                            put("text", message.content)
                        },
                    ),
                )
            }
        }
        return system to result
    }

    private fun baseHeaders(profile: AgentProfileStore.Profile): Map<String, String> =
        mapOf("anthropic-version" to ANTHROPIC_VERSION) + ProfileOptions.headers(profile.options)

    private fun auth(key: String): Map<String, String> =
        if (key.isEmpty()) emptyMap() else mapOf("x-api-key" to key)

    private fun thinkingBudget(profile: AgentProfileStore.Profile): Int? =
        when (ProfileOptions.thinking(profile.options)) {
            null -> null
            ProfileOptions.Thinking.LOW -> 1024
            ProfileOptions.Thinking.MEDIUM -> 2048
            ProfileOptions.Thinking.HIGH -> 4096
            ProfileOptions.Thinking.XHIGH -> 8192
            ProfileOptions.Thinking.MAX -> 16_000
        }

    private fun indexOf(obj: JsonObject): Int? =
        (obj["index"] as? JsonPrimitive)?.contentOrNull?.toIntOrNull()

    private class BlockAccumulator {
        var type: String = "text"
        var id: String? = null
        var name: String? = null
        val json: StringBuilder = StringBuilder()
    }

    private companion object {
        const val ANTHROPIC_VERSION = "2023-06-01"
        const val DEFAULT_MODEL = "claude-sonnet-4-20250514"
        const val DEFAULT_MAX_TOKENS = 4096
    }
}
