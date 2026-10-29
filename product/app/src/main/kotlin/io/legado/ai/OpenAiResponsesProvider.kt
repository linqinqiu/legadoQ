package io.legado.ai

import io.legado.AppConfig
import io.legado.http.NetworkSecurity
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.util.LinkedHashMap

/**
 * OpenAI **Responses API** 协议的实现（`POST /v1/responses`）。
 *
 * 它和 `/v1/chat/completions` 是同一家的两套协议，差别不在"换个 URL"，而在**数据形状**：
 * - 输入是 `input[]` 条目：消息（role+content）、`function_call`、`function_call_output`；
 * - 输出是 `output[]` 条目：`message`（内含 `output_text` 块）与 `function_call`；
 * - 流式事件是 `response.output_text.delta` / `response.function_call_arguments.delta`。
 *
 * 所以单独一个 provider，而不是把 OpenAI 兼容那份复制一遍改几个字段 ——
 * 两套协议以后各自演进，混在一起改一处必崩另一处。
 *
 * 地址：`<baseUrl>/v1/responses`（baseUrl 已带 `/v1` 不重复拼）。
 */
class OpenAiResponsesProvider(
    private val loopbackAllowed: () -> Boolean = { AppConfig.aiAllowLoopbackBaseUrl },
) : LlmProvider {

    override val id: String = "openai-responses"
    override val displayName: String = "OpenAI Responses"
    override val description: String =
        "OpenAI 新的 /v1/responses 协议（gpt-5 / o 系列推荐）。鉴权用 Bearer；" +
            "地址填到根即可（…/v1 有没有都行）。"

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
            headers = ProfileOptions.headers(profile.options),
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
            headers = ProfileOptions.headers(profile.options),
            authHeaders = { key -> auth(key) },
        )
        if (resp.statusCode() !in 200..299) {
            val text = runCatching { resp.body().bufferedReader().use { it.readText() } }.getOrNull()
            ProviderHttp.failForStatus(resp.statusCode(), text)
        }

        val text = StringBuilder()
        val calls = LinkedHashMap<String, CallAccumulator>()
        var usage: LlmUsage? = null

        fun handle(payload: String) {
            val obj = runCatching { json.parseToJsonElement(payload) }.getOrNull() as? JsonObject ?: return
            when ((obj["type"] as? JsonPrimitive)?.contentOrNull) {
                "response.output_item.added" -> {
                    val item = obj["item"] as? JsonObject ?: return
                    if ((item["type"] as? JsonPrimitive)?.contentOrNull == "function_call") {
                        val acc = accumulatorFor(obj, item, calls)
                        acc.callId = (item["call_id"] as? JsonPrimitive)?.contentOrNull
                        acc.name = (item["name"] as? JsonPrimitive)?.contentOrNull
                        (item["arguments"] as? JsonPrimitive)?.contentOrNull?.let { acc.json.append(it) }
                    }
                }
                "response.output_text.delta" -> {
                    val piece = (obj["delta"] as? JsonPrimitive)?.contentOrNull
                    if (!piece.isNullOrEmpty()) {
                        text.append(piece)
                        callbacks.onDelta(piece)
                    }
                }
                "response.reasoning_summary_text.delta", "response.reasoning_text.delta" -> {
                    (obj["delta"] as? JsonPrimitive)?.contentOrNull
                        ?.takeIf { it.isNotEmpty() }?.let(callbacks.onReasoning)
                }
                "response.function_call_arguments.delta" -> {
                    val acc = accumulatorFor(obj, item = null, calls)
                    (obj["delta"] as? JsonPrimitive)?.contentOrNull?.let { acc.json.append(it) }
                }
                "response.output_item.done" -> {
                    val item = obj["item"] as? JsonObject ?: return
                    if ((item["type"] as? JsonPrimitive)?.contentOrNull == "function_call") {
                        val acc = accumulatorFor(obj, item, calls)
                        (item["call_id"] as? JsonPrimitive)?.contentOrNull?.let { acc.callId = it }
                        (item["name"] as? JsonPrimitive)?.contentOrNull?.let { acc.name = it }
                        (item["arguments"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }?.let {
                            // done 里的 arguments 是完整值：用它覆盖分片拼接值，避免重复拼接。
                            acc.json.setLength(0)
                            acc.json.append(it)
                        }
                    }
                }
                "response.completed" -> {
                    val response = obj["response"] as? JsonObject
                    ProviderHttp.parseUsage(response?.get("usage") as? JsonObject)?.let { usage = it }
                }
                "response.failed" -> {
                    val response = obj["response"] as? JsonObject
                    val message = ((response?.get("error") as? JsonObject)?.get("message") as? JsonPrimitive)
                        ?.contentOrNull
                    throw NetworkSecurity.UnreachableTargetException("上游报错：${message ?: "响应失败"}")
                }
                "error" -> {
                    val message = ((obj["error"] as? JsonObject)?.get("message") as? JsonPrimitive)?.contentOrNull
                        ?: (obj["message"] as? JsonPrimitive)?.contentOrNull
                    throw NetworkSecurity.UnreachableTargetException("上游报错：${message ?: "未知错误"}")
                }
            }
        }

        ProviderHttp.forEachSseData(resp.body()) { handle(it) }
        usage?.let(callbacks.onUsage)
        val parsed = calls.values.mapNotNull { acc ->
            val name = acc.name ?: return@mapNotNull null
            LlmToolCall(
                id = acc.callId ?: name,
                args = if (acc.json.isBlank()) emptyMap() else ProviderHttp.parseArgs(acc.json.toString()),
                name = name,
            )
        }
        val content = text.toString()
        if (content.isEmpty() && parsed.isEmpty()) return null
        return LlmReply(content = content, toolCalls = parsed, usage = usage)
    }

    /** Responses 与 OpenAI 同源，模型清单可以直接走 `/v1/models`。 */
    override fun listModels(profile: AgentProfileStore.Profile): List<String>? {
        val url = ProviderHttp.endpoint(profile, "/models", listOf("/responses")) ?: return null
        ProviderHttp.assertPublicBaseUrl(url, loopbackAllowed())
        val resp = ProviderHttp.sendGetText(
            profile = profile,
            url = url,
            timeoutMs = ProviderHttp.timeoutMs(profile, 20_000L),
            headers = ProfileOptions.headers(profile.options),
            authHeaders = { key -> auth(key) },
        )
        if (resp.statusCode() !in 200..299) {
            ProviderHttp.failForStatus(resp.statusCode(), resp.body())
        }
        val root = runCatching { json.parseToJsonElement(resp.body()) }.getOrNull() as? JsonObject ?: return null
        val models = root["data"]?.jsonArray
            ?.mapNotNull { it.jsonObject["id"]?.jsonPrimitive?.contentOrNull }
            .orEmpty()
            .filter { it.isNotBlank() }
        return models.distinct().sorted().takeIf { it.isNotEmpty() }
    }

    /** 拼 `…/v1/responses`；有人把整条端点粘进来也能纠正。 */
    internal fun endpointUrl(profile: AgentProfileStore.Profile): String? =
        ProviderHttp.endpoint(profile, "/responses", listOf("/responses", "/v1/responses"))

    /** 解析非流式响应：`output[]` 里的 message / function_call。 */
    internal fun parseReply(body: String): LlmReply {
        val root = runCatching { json.parseToJsonElement(body) }.getOrNull() as? JsonObject
            ?: return LlmReply(content = body)
        val text = StringBuilder()
        val calls = mutableListOf<LlmToolCall>()
        (root["output"] as? JsonArray)?.forEach { element ->
            val item = element as? JsonObject ?: return@forEach
            when ((item["type"] as? JsonPrimitive)?.contentOrNull) {
                "message" -> (item["content"] as? JsonArray)?.forEach { block ->
                    val obj = block as? JsonObject ?: return@forEach
                    if ((obj["type"] as? JsonPrimitive)?.contentOrNull == "output_text") {
                        text.append((obj["text"] as? JsonPrimitive)?.contentOrNull.orEmpty())
                    }
                }
                "function_call" -> {
                    val name = (item["name"] as? JsonPrimitive)?.contentOrNull ?: return@forEach
                    val id = (item["call_id"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
                        ?: name
                    val args = (item["arguments"] as? JsonPrimitive)?.contentOrNull ?: "{}"
                    calls += LlmToolCall(id = id, args = ProviderHttp.parseArgs(args), name = name)
                }
            }
        }
        val usage = ProviderHttp.parseUsage(root["usage"] as? JsonObject)
        if (text.isEmpty() && calls.isEmpty()) return LlmReply(content = body, usage = usage)
        return LlmReply(content = text.toString(), toolCalls = calls, usage = usage)
    }

    internal fun parseArgs(raw: String): Map<String, Any?> = ProviderHttp.parseArgs(raw)

    // ===== 请求编码 =====

    /** 编码请求体（internal 以便单测钉住 instructions / input 条目形状）。 */
    internal fun encodeRequest(
        profile: AgentProfileStore.Profile,
        messages: List<LlmMessage>,
        tools: List<ToolMeta>,
        stream: Boolean,
    ): String {
        val instructions = messages.filter { it.role == "system" }
            .map { it.content.trim() }
            .filter { it.isNotEmpty() }
            .joinToString("\n\n")
        val input = buildJsonArray {
            messages.filter { it.role != "system" }.forEach { message ->
                when (message.role) {
                    "tool" -> add(
                        buildJsonObject {
                            put("type", "function_call_output")
                            put("call_id", message.toolCallId ?: "")
                            put("output", message.content)
                        },
                    )
                    "assistant" -> {
                        if (message.content.isNotBlank()) {
                            add(
                                buildJsonObject {
                                    put("role", "assistant")
                                    put("content", message.content)
                                },
                            )
                        }
                        message.toolCalls.forEach { call ->
                            add(
                                buildJsonObject {
                                    put("type", "function_call")
                                    put("call_id", call.id)
                                    put("name", call.name)
                                    put("arguments", json.encodeToString(
                                        JsonObject.serializer(),
                                        ProviderHttp.argsToJsonObject(call.args),
                                    ))
                                },
                            )
                        }
                    }
                    else -> add(
                        buildJsonObject {
                            put("role", "user")
                            put("content", message.content)
                        },
                    )
                }
            }
        }
        val root = buildJsonObject {
            put("model", profile.model ?: DEFAULT_MODEL)
            if (instructions.isNotBlank()) put("instructions", instructions)
            put("input", input)
            if (tools.isNotEmpty()) {
                put(
                    "tools",
                    buildJsonArray {
                        tools.forEach { meta ->
                            add(
                                buildJsonObject {
                                    put("type", "function")
                                    put("name", meta.id)
                                    put("description", meta.description)
                                    put("parameters", ToolSchemas.jsonSchema(meta.params))
                                },
                            )
                        }
                    },
                )
            }
            if (stream) put("stream", true)
            // max_output_tokens 只在用户显式配了才发：不配时让服务端用它的默认值。
            ProfileOptions.maxTokens(profile.options, 0).takeIf { it > 0 }?.let { put("max_output_tokens", it) }
            ProfileOptions.thinking(profile.options)?.let { level ->
                put(
                    "reasoning",
                    buildJsonObject { put("effort", level.wire) },
                )
            }
        }
        return json.encodeToString(JsonObject.serializer(), root)
    }

    private fun auth(key: String): Map<String, String> =
        if (key.isEmpty()) emptyMap() else mapOf("Authorization" to "Bearer $key")

    /**
     * 流式事件里定位同一个 function_call 的累加器。
     *
     * `output_item.added` 带 `item.id`；`function_call_arguments.delta` 只带 `item_id`。
     * 两者用同一个键（item id），否则分片会落到另一个累加器里、参数拼不出来。
     */
    private fun accumulatorFor(
        event: JsonObject,
        item: JsonObject?,
        calls: LinkedHashMap<String, CallAccumulator>,
    ): CallAccumulator {
        val itemId = (item?.get("id") as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
            ?: (event["item_id"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
            ?: (event["output_index"] as? JsonPrimitive)?.contentOrNull
            ?: "call"
        return calls.getOrPut(itemId) { CallAccumulator() }
    }

    private class CallAccumulator {
        var callId: String? = null
        var name: String? = null
        val json: StringBuilder = StringBuilder()
    }

    private companion object {
        const val DEFAULT_MODEL = "gpt-5"
    }
}
