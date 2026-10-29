package io.legado.ai

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import io.legado.AppConfig
import io.legado.http.NetworkSecurity
import java.util.TreeMap

/**
 * OpenAI 兼容协议的实现 —— **这是内置的默认 provider，不是框架本身**。
 *
 * 它从 [Agent] 里搬出来的：那段代码原来写死在编排层，等于框架把"某一家协议"
 * 当成了"框架本身"。现在它是 [LlmProviderRegistry] 里的一个可替换实现 ——
 * 想接别家协议，注册自己的 provider，不用动这个文件、也不用动 [Agent]。
 *
 * 协议细节：
 * - URL：`<baseUrl>/v1/chat/completions`（baseUrl 已以 `/v1` 结尾时不重复拼）
 * - 请求：`{model, messages:[{role,content}], temperature:0.7}`
 * - 鉴权：`Authorization: Bearer <apiKey>`（apiKey 非空时；多个 key 用逗号分隔轮换）
 * - 超时：请求 30s（流式 60s）、连接 10s；429/5xx/传输失败按 `retries`（默认 2）退避重试
 * - 解析：`choices[0].message.content`，解析失败退回响应原文
 * - 流式：`stream:true`，逐帧 `delta.content` / `delta.reasoning*` / `delta.tool_calls`
 */
class OpenAiCompatibleProvider(
    /**
     * 回环口子。默认读环境变量（[AppConfig.aiAllowLoopbackBaseUrl]），
     * 但**做成可注入**：环境变量在测试进程里改不动，而这条闸门两个方向都要钉住 ——
     * 关着时必须拒、开着时必须放行且仍守住"不许打到自己"。
     */
    private val loopbackAllowed: () -> Boolean = { AppConfig.aiAllowLoopbackBaseUrl },
) : LlmProvider {

    override val id: String = "openai-compatible"
    override val displayName: String = "OpenAI 兼容"
    /**
     * 这句描述会进 `/api/agent/manifest` 与界面，所以必须与闸门一致。
     * 从前它写着"LM Studio、Ollama 的兼容端点等"都行，而那些默认只有回环地址可填，
     * 闸门又一刀切拒回环 —— 照这句话填地址的人只会收到一个"连不上"。
     */
    override val description: String =
        "任何实现了 /v1/chat/completions 的服务：OpenAI、各类中转、vLLM、LM Studio / Ollama 的兼容端点。" +
            "填内网或本机地址需先设 LEGADO_AI_ALLOW_LOOPBACK_BASEURL=1（本机模型常用）。"

    private val json = ProviderHttp.json

    override fun chat(profile: AgentProfileStore.Profile, messages: List<LlmMessage>): String? {
        val reply = post(profile, messages, tools = null) ?: return null
        return reply.content.ifBlank { null }
    }

    /**
     * 带工具调用。用 OpenAI 的 `tools` / `tool_calls` 协议：
     * 请求给 `tools:[{type:"function",function:{name,description,parameters}}]`，
     * 响应可能带 `tool_calls:[{id,function:{name,arguments}}]`。
     *
     * 模型不认工具（或服务端不支持）时自然退化 —— 只返回普通文本，toolCalls 为空。
     */
    override fun chatWithTools(
        profile: AgentProfileStore.Profile,
        messages: List<LlmMessage>,
        tools: List<ToolMeta>,
    ): LlmReply? {
        if (tools.isEmpty()) return chat(profile, messages)?.let { LlmReply(content = it) }
        return post(profile, messages, tools)
    }

    /**
     * 真流式：`stream:true`，把 `delta.content` 逐帧回调。
     *
     * 工具调用跨帧拼装（首个 delta 带 `id`/`name`，`arguments` 分多帧拼接），
     * 全部收完后再交给编排层执行 —— 与「先拿完整回复再执行」语义一致，
     * 只是正文能提前显示。
     *
     * 有两处必须兜住的现实：
     * - 有的网关无视 `stream:true`，直接回整段 JSON → 嗅探首行后退回 [parseReply]；
     * - 有的网关只在最后一帧给 usage，`stream_options.include_usage` 可关（`streamUsage=0`）。
     */
    override fun chatWithToolsStream(
        profile: AgentProfileStore.Profile,
        messages: List<LlmMessage>,
        tools: List<ToolMeta>,
        callbacks: LlmStreamCallbacks,
    ): LlmReply? {
        val url = endpointUrl(profile) ?: return null
        assertPublicBaseUrl(url)
        val body = json.encodeToString(
            ChatRequest(
                model = profile.model ?: "gpt-3.5-turbo",
                messages = messages.map { it.toWire() },
                temperature = 0.7,
                reasoningEffort = ProfileOptions.thinking(profile.options)?.wire,
                tools = tools.takeIf { it.isNotEmpty() }?.map { it.toSpec() },
                stream = true,
                streamOptions = if (ProfileOptions.streamUsage(profile.options)) StreamOptions() else null,
            ),
        )
        val resp = ProviderHttp.sendStream(
            profile = profile,
            url = url,
            body = body,
            timeoutMs = ProviderHttp.timeoutMs(profile, 60_000L),
            headers = ProfileOptions.headers(profile.options),
            authHeaders = { key -> bearer(key) },
        )
        if (resp.statusCode() !in 200..299) {
            val text = runCatching { resp.body().bufferedReader().use { it.readText() } }.getOrNull()
            ProviderHttp.failForStatus(resp.statusCode(), text)
        }

        val reader = resp.body().bufferedReader(Charsets.UTF_8)
        val content = StringBuilder()
        val calls = TreeMap<Int, CallAccumulator>()
        var usage: LlmUsage? = null

        fun handle(payload: String) {
            if (payload == "[DONE]") return
            val obj = runCatching { json.parseToJsonElement(payload) }.getOrNull() as? JsonObject ?: return
            (obj["usage"] as? JsonObject)?.let { block ->
                ProviderHttp.parseUsage(block)?.let { usage = (usage ?: LlmUsage()).plus(it) }
            }
            val choice = (obj["choices"] as? JsonArray)?.firstOrNull() as? JsonObject ?: return
            val delta = choice["delta"] as? JsonObject ?: return
            (delta["content"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() }?.let {
                content.append(it)
                callbacks.onDelta(it)
            }
            val reasoning = (delta["reasoning_content"] as? JsonPrimitive)?.contentOrNull
                ?: (delta["reasoning"] as? JsonPrimitive)?.contentOrNull
            reasoning?.takeIf { it.isNotEmpty() }?.let(callbacks.onReasoning)
            (delta["tool_calls"] as? JsonArray)?.forEachIndexed { position, element ->
                val item = element as? JsonObject ?: return@forEachIndexed
                val index = (item["index"] as? JsonPrimitive)?.contentOrNull?.toIntOrNull() ?: position
                val acc = calls.getOrPut(index) { CallAccumulator() }
                (item["id"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }?.let { acc.id = it }
                val fn = item["function"] as? JsonObject
                (fn?.get("name") as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }?.let { acc.name = it }
                (fn?.get("arguments") as? JsonPrimitive)?.contentOrNull?.let { acc.arguments.append(it) }
            }
        }

        // 嗅探第一个有效行：是 data: 就按 SSE 走；是 { 就说明网关无视了 stream，退回整段解析。
        val firstLine = firstMeaningfulLine(reader) ?: return null
        val isSse = firstLine.startsWith("data:") || firstLine.startsWith("event:")
            || firstLine.startsWith("id:") || firstLine.startsWith("retry:")
        if (!isSse) {
            val raw = buildString {
                append(firstLine).append('\n')
                reader.forEachLine { append(it).append('\n') }
            }
            val reply = runCatching { parseReply(raw) }.getOrNull() ?: return null
            if (reply.content.isNotBlank()) callbacks.onDelta(reply.content)
            reply.usage?.let(callbacks.onUsage)
            return reply.takeIf { it.content.isNotBlank() || it.toolCalls.isNotEmpty() }
        }
        if (firstLine.startsWith("data:")) {
            firstLine.removePrefix("data:").trim().takeIf { it.isNotEmpty() }?.let { handle(it) }
        }
        ProviderHttp.readSseData(reader) { handle(it) }

        val parsedCalls = calls.values.mapNotNull { acc ->
            val name = acc.name ?: return@mapNotNull null
            LlmToolCall(
                id = acc.id ?: name,
                args = parseArgs(acc.arguments.toString().ifBlank { "{}" }),
                name = name,
            )
        }
        usage?.let(callbacks.onUsage)
        val text = content.toString()
        if (text.isEmpty() && parsedCalls.isEmpty()) return null
        return LlmReply(content = text, toolCalls = parsedCalls, usage = usage)
    }

    /**
     * 出站闸门：AI 连接的 `baseUrl` 默认不许指向内网 / 本机。
     *
     * 真正的判定在 [ProviderHttp.assertPublicBaseUrl]，三家 provider 共用同一份 ——
     * 安全边界不许各写一份。这里保留同名方法，是因为既有判据按它验闸门。
     *
     * @throws NetworkSecurity.BlockedAddressException 目标地址不是可用的 HTTP(S) 地址
     */
    internal fun assertPublicBaseUrl(url: String) {
        ProviderHttp.assertPublicBaseUrl(url, loopbackAllowed())
    }

    /**
     * 一次 HTTP 往返。tools 为 null 时不带工具（纯对话）。
     *
     * 内网地址在这里**明确抛** [IllegalArgumentException]，不被吞掉：
     * 吞了会变成"返回 null → 上层报 upstream_unreachable"，把"被拒绝"说成"连不上"，
     * 用户会去查网络而不是去看自己填的地址。[Agent] 有专门的分支把它翻成
     * `invalid_request`，那才是该说的话。
     */
    private fun post(
        profile: AgentProfileStore.Profile,
        messages: List<LlmMessage>,
        tools: List<ToolMeta>?,
    ): LlmReply? {
        val url = endpointUrl(profile) ?: return null
        assertPublicBaseUrl(url)
        val body = json.encodeToString(
            ChatRequest(
                model = profile.model ?: "gpt-3.5-turbo",
                messages = messages.map { it.toWire() },
                temperature = 0.7,
                reasoningEffort = ProfileOptions.thinking(profile.options)?.wire,
                tools = tools?.takeIf { it.isNotEmpty() }?.map { it.toSpec() },
            ),
        )
        val resp = ProviderHttp.sendText(
            profile = profile,
            url = url,
            body = body,
            timeoutMs = ProviderHttp.timeoutMs(profile, 30_000L),
            headers = ProfileOptions.headers(profile.options),
            authHeaders = { key -> bearer(key) },
        )
        if (resp.statusCode() !in 200..299) {
            ProviderHttp.failForStatus(resp.statusCode(), resp.body())
        }
        // 答了 2xx 但不是模型应答体（网关常回一个 HTML 错误页），仍算"没拿到"：
        // 返回 null，由上层报 upstream_unreachable。
        return runCatching { parseReply(resp.body()) }.getOrNull()
    }

    private fun bearer(key: String): Map<String, String> =
        if (key.isEmpty()) emptyMap() else mapOf("Authorization" to "Bearer $key")

    private fun LlmMessage.toWire(): ChatMessage = ChatMessage(
        role = role,
        content = content,
        toolCallId = toolCallId,
        toolCalls = toolCalls.takeIf { it.isNotEmpty() }?.map { call ->
            WireToolCall(
                id = call.id,
                function = WireToolCallFunction(
                    name = call.name,
                    // 协议要求字符串形式的 JSON。
                    arguments = json.encodeToString(
                        JsonObject.serializer(),
                        JsonObject(call.args.mapValues { (_, v) -> ProviderHttp.anyToJson(v) }),
                    ),
                ),
            )
        },
    )

    private fun ToolMeta.toSpec(): ToolSpec = ToolSpec(
        function = ToolSpecFunction(
            name = id,
            description = description,
            // 参数 schema 来自 ToolMeta.params（ToolSchemas 集中声明）。
            // 从前这里恒为空对象，模型只能从描述里猜键名 —— 实测大量
            // `invalid_request: 缺少 sourceId` 都是这么来的。
            parameters = ToolSchemas.jsonSchema(params),
        ),
    )

    /**
     * 拼出 `chat/completions` 的完整地址 —— **纯字符串逻辑，不发任何网络请求**。
     *
     * 抽成独立函数是为了可测：这段的边界（baseUrl 带不带 `/v1`、带不带尾斜杠、
     * 为 null）是最容易错的地方，埋在 `post()` 里时没法单独验。
     *
     * 这里**故意不做内网校验**：那需要 DNS 解析，会把"拼地址"这个纯逻辑拖成网络操作，
     * 于是拿一个假域名测拼接就用不了（既有判据正是这么测的，`OpenAiCompatibleProviderTest`）。
     * 校验放在 [post] 里 —— 真正要发请求的地方。两件事分开，各自都能单测。
     *
     * @return null 表示 baseUrl 缺失**或为空**（调用方据此返回 null，上层报 upstream_unreachable）
     */
    internal fun endpointUrl(profile: AgentProfileStore.Profile): String? {
        // 注意 `removeSuffix("/")` 之后还要判空：空串会一路拼成 "/v1/chat/completions"，
        // 那是个没有 host 的地址 —— URI.create 能过、HttpClient.send 才炸，
        // 表现为"AI 连不上"而不是"baseUrl 没配"，排查会绕远路。
        val base = profile.baseUrl?.trim()?.removeSuffix("/")?.takeIf { it.isNotEmpty() } ?: return null
        return if (base.endsWith("/v1")) base + "/chat/completions" else base + "/v1/chat/completions"
    }

    /**
     * 拉取这个连接可用的模型清单：`GET {baseUrl}/models`。
     *
     * 与 [post] 共用同一道出站闸门与鉴权：地址先过 [assertPublicBaseUrl]，
     * key 走 `Authorization: Bearer`，连接自己的额外请求头也带上（中转站常靠自定义头分渠道）。
     *
     * 解析 OpenAI 的 `data[].id`；顺带兼容 Ollama 风格的 `models[].name`。
     * 失败一律抛 [NetworkSecurity.UnreachableTargetException]，不返回空列表 ——
     * 空列表会被界面读成"这家没有模型"，而真相多半是地址错了、被网关拦了、或 key 没权限。
     *
     * @return 去重并按字母排序的模型 id
     * @throws NetworkSecurity.BlockedAddressException 地址被出站闸门拒绝
     * @throws NetworkSecurity.UnreachableTargetException 连不上 / 非 2xx / 返回体不是模型清单
     */
    override fun listModels(profile: AgentProfileStore.Profile): List<String> {
        // 有人会把整条对话地址粘进来（…/v1/chat/completions）：先把尾巴去掉再拼 /models，
        // 否则会拼出 …/chat/completions/v1/models 这种必然 404 的地址。
        val url = ProviderHttp.endpoint(profile, "/models", listOf("/chat/completions"))
            ?: throw IllegalArgumentException("接口地址不能为空")
        assertPublicBaseUrl(url)
        val resp = ProviderHttp.sendGetText(
            profile = profile,
            url = url,
            timeoutMs = ProviderHttp.timeoutMs(profile, 20_000L),
            headers = ProfileOptions.headers(profile.options),
            authHeaders = { key -> bearer(key) },
        )
        if (resp.statusCode() !in 200..299) {
            ProviderHttp.failForStatus(resp.statusCode(), resp.body())
        }
        val root = runCatching { json.parseToJsonElement(resp.body()) }.getOrNull() as? JsonObject
            ?: throw NetworkSecurity.UnreachableTargetException("模型清单不是 JSON（可能被网关或登录页拦了）")
        val fromData = root["data"]?.jsonArray
            ?.mapNotNull { it.jsonObject["id"]?.jsonPrimitive?.contentOrNull }
        val fromModels = root["models"]?.jsonArray
            ?.mapNotNull { item ->
                item.jsonObject["name"]?.jsonPrimitive?.contentOrNull
                    ?: item.jsonObject["id"]?.jsonPrimitive?.contentOrNull
            }
        val models = (fromData ?: fromModels).orEmpty().filter { it.isNotBlank() }
        if (models.isEmpty()) {
            throw NetworkSecurity.UnreachableTargetException("模型清单是空的（服务在，但没有可用模型）")
        }
        return models.distinct().sorted()
    }

    /** 解析 OpenAI 响应：取 content、tool_calls 与 usage。 */
    internal fun parseReply(body: String): LlmReply {
        // `parseToJsonElement` 遇到非 JSON 会**抛异常**（JsonDecodingException），
        // 不是返回 null —— 包一层 runCatching，让"退回原文"那条兜底真正生效。
        val root = runCatching { json.parseToJsonElement(body) }.getOrNull() as? JsonObject
        // 上游无视 `stream:false` 仍回 SSE 时的兜底（实测 pipio.io 在字段缺省时就是流式）：
        // 把 `data: {...}` 分块里的 delta.content 拼起来，等同于非流式的 message.content。
        if (root == null) {
            val streamed = concatSseDeltas(body)
            if (streamed != null) return LlmReply(content = streamed)
            return LlmReply(content = body)
        }
        val choices = root["choices"] as? JsonArray
        val first = choices?.firstOrNull() as? JsonObject
        val message = first?.get("message") as? JsonObject
        val content = (message?.get("content") as? JsonPrimitive)?.content ?: ""

        val calls = mutableListOf<LlmToolCall>()
        val rawCalls = message?.get("tool_calls") as? JsonArray
        rawCalls?.forEach { item ->
            val obj = item as? JsonObject ?: return@forEach
            val fn = obj["function"] as? JsonObject ?: return@forEach
            val name = (fn["name"] as? JsonPrimitive)?.content ?: return@forEach
            val protocolId = (obj["id"] as? JsonPrimitive)?.content?.takeIf { it.isNotBlank() } ?: name
            val argsRaw = (fn["arguments"] as? JsonPrimitive)?.content ?: "{}"
            calls += LlmToolCall(id = protocolId, args = parseArgs(argsRaw), name = name)
        }
        val usage = ProviderHttp.parseUsage(root["usage"] as? JsonObject)
        // 既没 content 也没工具调用 → 退回原文（与改造前一致，别把响应吃成空）。
        if (content.isBlank() && calls.isEmpty()) return LlmReply(content = body, usage = usage)
        return LlmReply(content = content, toolCalls = calls, usage = usage)
    }

    /**
     * 把 SSE 流式响应里的 `delta.content` 拼成一段完整文本。
     *
     * 只在 [parseReply] 拿到**非 JSON** 时才试：逐行找 `data: {...}`，取
     * `choices[0].delta.content`，遇到 `[DONE]` 或非 data 行就跳过。
     * 一段 delta 都没有时返回 null，让调用方继续走「退回原文」。
     */
    internal fun concatSseDeltas(body: String): String? {
        val sb = StringBuilder()
        for (line in body.lineSequence()) {
            val trimmed = line.trim()
            if (!trimmed.startsWith("data:")) continue
            val payload = trimmed.removePrefix("data:").trim()
            if (payload == "[DONE]" || payload.isEmpty()) continue
            val obj = runCatching { json.parseToJsonElement(payload) }.getOrNull() as? JsonObject ?: continue
            val choice = (obj["choices"] as? JsonArray)?.firstOrNull() as? JsonObject ?: continue
            val delta = choice["delta"] as? JsonObject ?: continue
            val piece = (delta["content"] as? JsonPrimitive)?.content ?: continue
            sb.append(piece)
        }
        return sb.toString().takeIf { it.isNotEmpty() }
    }

    /** 把模型给的 arguments 字符串解析成扁平键值。解析不了就当空参，不抛。 */
    internal fun parseArgs(raw: String): Map<String, Any?> = runCatching {
        val el = json.parseToJsonElement(raw)
        ProviderHttp.jsonObjectToArgs(el as? JsonObject)
    }.getOrDefault(emptyMap())

    /** 读第一行"有内容"的行（跳过空行与 `:` 注释），用于判断这是 SSE 还是整段 JSON。 */
    private fun firstMeaningfulLine(reader: java.io.BufferedReader): String? {
        while (true) {
            val line = reader.readLine() ?: return null
            val trimmed = line.trim()
            if (trimmed.isEmpty() || trimmed.startsWith(":")) continue
            return trimmed
        }
    }

    private class CallAccumulator {
        var id: String? = null
        var name: String? = null
        val arguments: StringBuilder = StringBuilder()
    }

    /**
     * 发给上游的一条消息。
     *
     * `role == "tool"` 时必须带 `tool_call_id`（指回是哪个调用的结果），
     * `role == "assistant"` 且模型要调工具时必须带 `tool_calls`。
     */
    @Serializable
    private data class ChatMessage(
        val role: String,
        /** 工具结果/带工具调用的 assistant 轮次，content 可以是 null（协议允许）。 */
        val content: String? = null,
        @SerialName("tool_call_id")
        val toolCallId: String? = null,
        @SerialName("tool_calls")
        val toolCalls: List<WireToolCall>? = null,
    )

    /** 回传模型上一轮要求的工具调用（OpenAI 协议要求原样带回）。 */
    @Serializable
    private data class WireToolCall(
        val id: String,
        val type: String = "function",
        val function: WireToolCallFunction,
    )

    @Serializable
    private data class WireToolCallFunction(
        val name: String,
        /** 协议要求是**字符串**形式的 JSON，不是对象。 */
        val arguments: String,
    )

    @Serializable
    private data class ToolSpecFunction(
        val name: String,
        val description: String,
        /**
         * 参数 schema。用 JsonObject 而不是 `Map<String, Any?>` —— 后者没有序列化器
         * （kotlinx 需要具体类型），而这里本来就是要发一段 JSON。
         */
        val parameters: JsonObject,
    )

    @Serializable
    private data class ToolSpec(val type: String = "function", val function: ToolSpecFunction)

    @Serializable
    private data class StreamOptions(
        @SerialName("include_usage") val includeUsage: Boolean = true,
    )

    @Serializable
    private data class ChatRequest(
        val model: String,
        val messages: List<ChatMessage>,
        val temperature: Double,
        /**
         * **必须显式发 `stream:false`。**
         *
         * OpenAI 自己的默认值就是 false，但不少中转站/自建网关（实测 pipio.io）
         * 在**字段缺省**时按 SSE 流式回 `data: {...}` 分块。显式写出来，不依赖上游的缺省行为。
         */
        val stream: Boolean = false,
        val tools: List<ToolSpec>? = null,
        /**
         * 思考强度。OpenAI 的 `reasoning_effort` 字段；不设就不发（老服务不认会报错）。
         */
        @SerialName("reasoning_effort")
        val reasoningEffort: String? = null,
        /** 流式时要求最后一帧带 usage（`streamUsage=0` 可关）。 */
        @SerialName("stream_options")
        val streamOptions: StreamOptions? = null,
    )
}
