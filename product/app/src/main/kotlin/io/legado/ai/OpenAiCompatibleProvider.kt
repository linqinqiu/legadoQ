package io.legado.ai

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.net.URI
import io.legado.AppConfig
import io.legado.http.NetworkSecurity
import io.legado.http.ServerIdentity
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

/**
 * OpenAI 兼容协议的实现 —— **这是内置的默认 provider，不是框架本身**。
 *
 * 它从 [Agent] 里搬出来的：那段代码原来写死在编排层，等于框架把"某一家协议"
 * 当成了"框架本身"。现在它是 [LlmProviderRegistry] 里的一个可替换实现 ——
 * 想接别家协议，注册自己的 provider，不用动这个文件、也不用动 [Agent]。
 *
 * 协议细节（保持与改造前完全一致，不改变既有行为）：
 * - URL：`<baseUrl>/v1/chat/completions`（baseUrl 已以 `/v1` 结尾时不重复拼）
 * - 请求：`{model, messages:[{role,content}], temperature:0.7}`
 * - 鉴权：`Authorization: Bearer <apiKey>`（apiKey 非空时）
 * - 超时：请求 30s、连接 10s
 * - 解析：`choices[0].message.content`，解析失败退回响应原文
 * - 非 2xx / 网络失败 → 返回 null（由调用方报错）
 */
class OpenAiCompatibleProvider(
    /**
     * 回环口子。默认读环境变量（[AppConfig.aiAllowLoopbackBaseUrl]），
     * 但**做成可注入**：环境变量在测试进程里改不动，而这条闸门两个方向都要钉住 ——
     * 关着时必须拒、开着时必须放行且仍守住"不许打到自己"。
     * 从前这类判据只能单向测（只测默认关的那一半），于是"口子开了会绕过什么"没人验过。
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

    private val json = Json { ignoreUnknownKeys = true; isLenient = true; encodeDefaults = true }

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
     * 出站闸门：AI 连接的 `baseUrl` 默认不许指向内网 / 本机。
     *
     * 单独抽出来（而不是塞进 [post]）是为了可测 —— 内网拒绝这条安全判据必须能单独验，
     * 不能只能靠"真的发一次请求看它失败"。
     *
     * 复用既有的 [NetworkSecurity.resolveAndValidateSafeHttpTarget]：IPv4/IPv6/组播/
     * 保留段 / CGNAT 都已覆盖，还带 DNS 缓存。**不另写一份判定** ——
     * 两份判定迟早漂移，而漂移的那天就是侧门重开的那天。
     *
     * 唯一的例外是 [AppConfig.aiAllowLoopbackBaseUrl]：本机跑 Ollama / LM Studio 的人
     * 只有回环地址可填，一刀切等于把这批用户整个挡在 AI 功能外面。放开时也**只放回环**，
     * 私网段照旧拒；并且硬拒"打到这台服务自己"——见 [refusePointingAtSelf]。
     *
     * @throws NetworkSecurity.BlockedAddressException 目标地址不是可用的 HTTP(S) 地址
     */
    internal fun assertPublicBaseUrl(url: String) {
        val uri = URI.create(url)
        if (uri.scheme !in setOf("http", "https") || uri.host.isNullOrBlank()) {
            throw NetworkSecurity.BlockedAddressException("仅允许 HTTP(S) AI 连接地址")
        }
        if (loopbackAllowed() && isLoopbackLiteral(uri.host.lowercase())) {
            refusePointingAtSelf(uri)
            return
        }
        NetworkSecurity.resolveAndValidateSafeHttpTarget(uri, "AI 连接")
    }

    /** 只认字面回环：不走 DNS，免得"合法域名解析到 127.0.0.1"这种重绑定从这条口子进来。 */
    private fun isLoopbackLiteral(host: String): Boolean =
        host == "localhost" || host == "::1" || host.startsWith("127.")

    /**
     * 开了回环口子后唯一必须守住的一条：**不许让 AI 连接打到这台服务自己**。
     *
     * 理由不是"防内网"，而是这道服务唯一的写保护会被它绕过：本服务对**不带 Origin 的请求
     * 直接放行写操作**（AGENTS 的安全模型），而 JDK `HttpClient` 发请求不带 Origin。
     * 于是 `baseUrl=http://127.0.0.1:1234/…` 等于让模型拿到整库写权限 ——
     * 同源门就只剩"外部网页驱动不了它"这一层意思了。端口对上就拒，与地址写法无关。
     */
    private fun refusePointingAtSelf(uri: URI) {
        val identityHost = ServerIdentity.host.lowercase()
        val boundEverywhere = identityHost == "0.0.0.0" || identityHost == "::" || identityHost.isBlank()
        val sameHost = boundEverywhere ||
            isLoopbackLiteral(identityHost) ||            // 绑回环时，任何回环写法都算自己
            uri.host.lowercase() == identityHost
        val port = if (uri.port > 0) uri.port else if (uri.scheme == "https") 443 else 80
        if (sameHost && port == ServerIdentity.port) {
            throw NetworkSecurity.BlockedAddressException(
                "AI 连接的地址不能指向 legadoQ 服务自己（端口 ${ServerIdentity.port}）：那会绕过这台服务唯一的写保护。",
            )
        }
    }

    /**
     * 一次 HTTP 往返。tools 为 null 时不带工具（纯对话）。
     *
     * 内网地址在这里**明确抛** [IllegalArgumentException]，不被下面的 runCatching 吞掉：
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
        // 出站闸门：与书源 / 订阅 / TTS 同一条（NetworkSecurity，含 IPv4/IPv6/组播/
        // 保留段 / CGNAT，还带 DNS 缓存）。放在这里而不是 endpointUrl 里，是为了让
        // "拼地址"保持纯字符串逻辑 —— 那一段要能拿假域名单测。
        //
        // 为什么必须加：baseUrl 是用户自己填的，而 AI 这一层以前**没过这道闸门**
        // （书源、订阅、TTS 都过）。填一个内网地址，这台机器上的其它本机服务
        // （路由器管理页、数据库、另一个本地端口）就会被这个 AI 连接打通 ——
        // 服务本身只绑 127.0.0.1、靠同源门挡跨站写，等于侧门开着。
        //
        // 校验不过**抛**而不是返回 null：返回 null 会变成上层报 upstream_unreachable，
        // 把"被拒绝"说成"连不上"，用户会去查网络而不是去看自己填的地址。
        assertPublicBaseUrl(url)
        val body = json.encodeToString(
            ChatRequest(
                model = profile.model ?: "gpt-3.5-turbo",
                messages = messages.map { m ->
                    ChatMessage(
                        role = m.role,
                        content = m.content,
                        toolCallId = m.toolCallId,
                        toolCalls = m.toolCalls.takeIf { it.isNotEmpty() }?.map { call ->
                            WireToolCall(
                                // 框架里 LlmToolCall.id 存的就是工具 id（解析时取的 function.name），
                                // 而协议要求 id 与 tool_call_id 成对 —— 两者同用一个值即可闭环。
                                id = call.id,
                                function = WireToolCallFunction(
                                    name = call.id,
                                    // 协议要求字符串形式的 JSON。
                                    arguments = json.encodeToString(
                                        JsonObject.serializer(),
                                        JsonObject(call.args.mapValues { (_, v) -> JsonPrimitive(v?.toString() ?: "") }),
                                    ),
                                ),
                            )
                        },
                    )
                },
                temperature = 0.7,
                // 思考强度：只有连接自己配了才发（老服务不认这个字段会直接 400）。
                reasoningEffort = ProfileOptions.thinking(profile.options)?.wire,
                tools = tools?.takeIf { it.isNotEmpty() }?.map { meta ->
                    ToolSpec(
                        function = ToolSpecFunction(
                            name = meta.id,
                            description = meta.description,
                            // 工具参数是扁平键值（见 ToolArgs），不强制 schema ——
                            // 模型按描述自己填，框架侧对未知键宽容。
                            parameters = buildJsonObject {
                                put("type", "object")
                                put("properties", buildJsonObject { })
                                put("additionalProperties", true)
                            },
                        ),
                    )
                },
            ),
        )
        val builder = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .timeout(Duration.ofMillis(ProfileOptions.timeoutMs(profile.options) ?: 30_000L))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body))
        if (!profile.apiKey.isNullOrBlank()) builder.header("Authorization", "Bearer " + profile.apiKey)
        // 连接自己的额外请求头（中转站/自建服务常要）。危险头已在 ProfileOptions 里挡掉。
        ProfileOptions.headers(profile.options).forEach { (name, value) -> builder.header(name, value) }
        val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()
        // 网络失败**抛出去**而不是吞成 null：从前这里是 `runCatching{…}.getOrNull()`，
        // 于是"域名打错一个字母"（DNS 失败）、"连不上"、"上游回了 500 页面"全被压成同一个 null，
        // 上层只能一律报"连不上"，而用户其实需要知道是**自己填错了地址**。
        // 抛的必须是 IOException 那一支（UnreachableTargetException）：它不是
        // IllegalArgumentException，才不会被上层误分类成"你的请求非法"。
        val resp = try {
            client.send(builder.build(), HttpResponse.BodyHandlers.ofString())
        } catch (error: Throwable) {
            throw NetworkSecurity.UnreachableTargetException(
                "连不上 ${hostSummary(url)}：${error.message ?: error::class.simpleName}", error,
            )
        }
        if (resp.statusCode() !in 200..299) {
            // 上游答了但答的是错误页：这也是"到不了有效服务"，不是"你的地址非法"。
            throw NetworkSecurity.UnreachableTargetException("上游返回 ${resp.statusCode()}（不是有效的模型应答）")
        }
        // 答了 2xx 但不是模型应答体（网关常回一个 HTML 错误页），仍算"没拿到"：
        // 这条保留返回 null 的既有语义 —— 判据里有"provider 拿不到内容时报 upstream_unreachable"。
        return runCatching { parseReply(resp.body()) }.getOrNull()
    }

    /** 报错给人看时不要把整条带 key 的 URL 抄全：取到 host+path 就够定位了。 */
    private fun hostSummary(url: String): String = runCatching {
        val u = URI.create(url)
        if (u.host.isNullOrBlank()) url else u.host + (if (u.port > 0) ":${u.port}" else "") + u.path
    }.getOrDefault(url)

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
    fun listModels(profile: AgentProfileStore.Profile): List<String> {
        // 有人会把整条对话地址粘进来（…/v1/chat/completions）：先把尾巴去掉再拼 /models，
        // 否则会拼出 …/chat/completions/v1/models 这种必然 404 的地址。
        val base = profile.baseUrl?.trim()?.removeSuffix("/")
            ?.removeSuffix("/chat/completions")
            ?.takeIf { it.isNotEmpty() }
            ?: throw IllegalArgumentException("接口地址不能为空")
        val url = if (base.endsWith("/v1")) "$base/models" else "$base/v1/models"
        assertPublicBaseUrl(url)
        val builder = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .timeout(Duration.ofMillis(ProfileOptions.timeoutMs(profile.options) ?: 20_000L))
            .GET()
        if (!profile.apiKey.isNullOrBlank()) builder.header("Authorization", "Bearer " + profile.apiKey)
        ProfileOptions.headers(profile.options).forEach { (name, value) -> builder.header(name, value) }
        val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()
        val resp = try {
            client.send(builder.build(), HttpResponse.BodyHandlers.ofString())
        } catch (error: Throwable) {
            throw NetworkSecurity.UnreachableTargetException(
                "连不上 ${hostSummary(url)}：${error.message ?: error::class.simpleName}", error,
            )
        }
        if (resp.statusCode() !in 200..299) {
            throw NetworkSecurity.UnreachableTargetException("上游返回 ${resp.statusCode()}（拿不到模型清单）")
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

    /** 解析 OpenAI 响应：取 content，以及 tool_calls（如果有）。 */
    internal fun parseReply(body: String): LlmReply {
        // `parseToJsonElement` 遇到非 JSON 会**抛异常**（JsonDecodingException），
        // 不是返回 null —— 原来这里直接调它，于是"非 JSON 响应退回原文"这条兜底
        // 实际上走不到：异常会一路冒到 `post()` 的 runCatching 变成 null，
        // 表现为"模型没回答"，而真相是"上游返回了非 JSON（可能是 502 页面/HTML 错误页）"。
        // 包一层 runCatching，让兜底真正生效。
        val root = runCatching { json.parseToJsonElement(body) }.getOrNull() as? JsonObject
        // 上游无视 `stream:false` 仍回 SSE 时的兜底（实测 pipio.io 在字段缺省时就是流式）：
        // 把 `data: {...}` 分块里的 delta.content 拼起来，等同于非流式的 message.content。
        // 不做这层的话，用户看到的是整段 `data: {"choices":[...]}` 原文。
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
            val argsRaw = (fn["arguments"] as? JsonPrimitive)?.content ?: "{}"
            calls += LlmToolCall(id = name, args = parseArgs(argsRaw))
        }
        // 既没 content 也没工具调用 → 退回原文（与改造前一致，别把响应吃成空）。
        if (content.isBlank() && calls.isEmpty()) return LlmReply(content = body)
        return LlmReply(content = content, toolCalls = calls)
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
        (el as? JsonObject)?.entries?.associate { (k, v) ->
            k to when (v) {
                is JsonPrimitive -> v.content
                else -> v.toString()
            }
        } ?: emptyMap()
    }.getOrDefault(emptyMap())

    /**
     * 发给上游的一条消息。
     *
     * `role == "tool"` 时必须带 `tool_call_id`（指回是哪个调用的结果），
     * `role == "assistant"` 且模型要调工具时必须带 `tool_calls`。
     * 这两个字段以前没有，于是工具轮次永远在第二跳被上游 400 掉。
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
    private data class ChatRequest(
        val model: String,
        val messages: List<ChatMessage>,
        val temperature: Double,
        /**
         * **必须显式发 `stream:false`。**
         *
         * OpenAI 自己的默认值就是 false，但不少中转站/自建网关（实测 pipio.io）
         * 在**字段缺省**时按 SSE 流式回 `data: {...}` 分块。而本客户端用的是
         * `BodyHandlers.ofString()` + `parseReply` 按**普通 JSON** 解析，
         * 拿到 SSE 会解析失败、走「退回响应原文」那条兜底，用户看到的是
         * 一大串 `data: {"choices":[...]}` —— 表现为「AI 答非所问」。
         * 显式写出来，不依赖上游的缺省行为。
         */
        val stream: Boolean = false,
        val tools: List<ToolSpec>? = null,
        /**
         * 思考强度。OpenAI 的 `reasoning_effort` 字段；不设就不发（老服务不认会报错）。
         * 档位见 [ProfileOptions.Thinking]。
         */
        @SerialName("reasoning_effort")
        val reasoningEffort: String? = null,
    )
}
