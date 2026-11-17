package io.legado.ai

import io.legado.BuildInfo
import io.legado.ops.NetworkSecurity
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.atomic.AtomicInteger

/** MCP 协议层失败：`code` 是 JSON-RPC 错误码（传输层失败时为 null）。 */
class McpException(val code: Int?, override val message: String) : RuntimeException(message)

/** 远端工具的一条声明，来自 `tools/list`。 */
data class McpTool(
    val name: String,
    val description: String,
    /** 原样的 `inputSchema`，用来还原参数名/类型/必填。 */
    val inputSchema: JsonObject?,
    /** `annotations.readOnlyHint == true` 时视为只读；缺省按"会写"处理，宁可多提醒。 */
    val readOnly: Boolean,
)

/** 一次 `tools/call` 的结果：正文拼成一段文本，`isError` 是协议里明说的工具级失败。 */
data class McpCallResult(val text: String, val isError: Boolean)

/**
 * MCP（Model Context Protocol）客户端：JSON-RPC 2.0 over HTTP（streamable HTTP 传输）。
 *
 * 只实现客户端真正要用的四步：`initialize` → `notifications/initialized` → `tools/list`（带
 * `nextCursor` 翻页）→ `tools/call`。**不做** resources / prompts / sampling —— 那几样
 * 在我们的界面里没有落点，先做能立刻变成"AI 多一组能力"的部分。
 *
 * 三条协议细节都是踩过才知道的：
 * ① 响应可能是普通 JSON，也可能是 SSE（`text/event-stream` 里若干 `data: {...}`）。
 *    只认 JSON 的客户端在真服务上会看到"回了空 body"，所以这里两种都解。
 * ② `Mcp-Session-Id` 由服务端在 `initialize` 的响应头里给，之后每个请求都要带回去。
 *    会话过期时服务端回 404，客户端必须**重新握手一次再重试**，否则用户看到的是
 *    "用着用着就 404 了"，重启服务才好。
 * ③ 工具调用是同步阻塞的（[callTool]），因为它最终由工具处理体直接调用 ——
 *    那一层本来就是挂起函数，多套一层协程只会多一个线程切换。
 */
class McpClient(
    private val server: McpServerStore.Server,
    /** 仅供测试注入；生产走受控出站 client（回环放行、私网照拒）。 */
    httpClient: HttpClient? = null,
) {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    private val client: HttpClient by lazy {
        httpClient ?: NetworkSecurity.newHttpClient(
            connectTimeout = Duration.ofSeconds(5),
            followRedirects = HttpClient.Redirect.NEVER,
            // MCP 服务几乎都跑在本机（或 docker 发布的回环端口）。私网段仍然拒 ——
            // 与 AI 连接同一条口径，避免"配一个地址就把内网扫一遍"。
            allowLoopback = true,
        )
    }

    private val idSeq = AtomicInteger(1)
    private var sessionId: String? = null
    private var initialized = false

    /** 握手 + 拉清单用的上限：这两步是"能不能用"的判断，不该被一次慢响应拖到 20 秒。 */
    private val handshakeTimeoutMs: Long = minOf(server.timeoutMs.toLong(), 8_000L)

    /** 完成握手。可重复调用（会话过期后由 [rpc] 自动再来一次）。 */
    fun initialize() {
        sessionId = null
        initialized = false
        val id = idSeq.getAndIncrement()
        val body = buildJsonObject {
            put("jsonrpc", "2.0")
            put("id", id)
            put("method", "initialize")
            put("params", buildJsonObject {
                put("protocolVersion", PROTOCOL_VERSION)
                put("capabilities", buildJsonObject { })
                put("clientInfo", buildJsonObject {
                    put("name", CLIENT_NAME)
                    put("version", BuildInfo.version)
                })
            })
        }
        val response = post(body, handshakeTimeoutMs)
        if (response.statusCode() !in 200..299) {
            throw McpException(response.statusCode(), "MCP 服务握手失败：HTTP ${response.statusCode()}")
        }
        response.headers().firstValue("Mcp-Session-Id").ifPresent { sessionId = it }
        val payload = extractJsonRpc(response.body())
            ?: throw McpException(response.statusCode(), "MCP 服务握手没有返回 JSON-RPC 响应")
        raiseIfError(payload)
        initialized = true
        // 通知类消息没有 id，服务端通常回 202 + 空 body；失败不影响后续调用，不当成握手失败。
        runCatching {
            post(buildJsonObject {
                put("jsonrpc", "2.0")
                put("method", "notifications/initialized")
            }, handshakeTimeoutMs)
        }
    }

    /** 拉全部工具（`nextCursor` 翻页）。 */
    fun listTools(): List<McpTool> {
        ensureInitialized()
        val out = mutableListOf<McpTool>()
        var cursor: String? = null
        var pages = 0
        while (true) {
            val params = cursor?.let { buildJsonObject { put("cursor", it) } }
            val result = rpc("tools/list", params, handshakeTimeoutMs).jsonObject
            (result["tools"] as? JsonArray)?.forEach { element ->
                val obj = element as? JsonObject ?: return@forEach
                val name = obj["name"]?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
                if (name.isEmpty()) return@forEach
                out += McpTool(
                    name = name,
                    description = obj["description"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                    inputSchema = obj["inputSchema"] as? JsonObject,
                    readOnly = obj["annotations"]?.jsonObject?.get("readOnlyHint")?.jsonPrimitive?.booleanOrNull == true,
                )
            }
            cursor = result["nextCursor"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }
            // 服务端给不出终止游标时最多翻 20 页，防止一个坏游标把进程拖死。
            if (cursor == null || ++pages >= 20) break
        }
        return out
    }

    /** 调用一个远端工具。工具级失败由 `isError` 表达，不抛异常。 */
    fun callTool(name: String, args: Map<String, Any?>): McpCallResult {
        ensureInitialized()
        val result = rpc("tools/call", buildJsonObject {
            put("name", name)
            put("arguments", ProviderHttp.argsToJsonObject(args))
        }, server.timeoutMs.toLong()).jsonObject
        return McpCallResult(
            text = contentText(result["content"]),
            isError = result["isError"]?.jsonPrimitive?.booleanOrNull == true,
        )
    }

    // ===== 内部 =====

    private fun ensureInitialized() {
        if (!initialized) initialize()
    }

    private fun rpc(method: String, params: JsonObject?, timeoutMs: Long): JsonElement {
        var retried = false
        while (true) {
            val body = buildJsonObject {
                put("jsonrpc", "2.0")
                put("id", idSeq.getAndIncrement())
                put("method", method)
                params?.let { put("params", it) }
            }
            val response = post(body, timeoutMs)
            // 会话过期：服务端用 404 表示"这个 Mcp-Session-Id 我不认识了"。重握手一次再重试，
            // 但只重试一次 —— 一直 404 说明地址或实现有问题，再试也是白试。
            if (response.statusCode() == 404 && sessionId != null && !retried) {
                retried = true
                initialize()
                continue
            }
            if (response.statusCode() !in 200..299) {
                throw McpException(response.statusCode(), "MCP 服务返回 HTTP ${response.statusCode()}（$method）")
            }
            val payload = extractJsonRpc(response.body())
                ?: throw McpException(response.statusCode(), "MCP 服务对 $method 没有返回 JSON-RPC 响应")
            raiseIfError(payload)
            return payload["result"] ?: JsonNull
        }
    }

    private fun raiseIfError(payload: JsonObject) {
        val error = payload["error"] as? JsonObject ?: return
        val message = error["message"]?.jsonPrimitive?.contentOrNull ?: "MCP 返回错误"
        throw McpException(error["code"]?.jsonPrimitive?.intOrNull, message)
    }

    private fun post(payload: JsonObject, timeoutMs: Long): HttpResponse<String> {
        assertTargetAllowed(server.url)
        val builder = HttpRequest.newBuilder(URI.create(server.url))
            .timeout(Duration.ofMillis(timeoutMs))
            .header("Content-Type", "application/json")
            // 两种都要：服务端可以回普通 JSON，也可以回 SSE 流。只声明 json 会被一部分实现判为不兼容。
            .header("Accept", "application/json, text/event-stream")
            .POST(HttpRequest.BodyPublishers.ofString(payload.toString(), Charsets.UTF_8))
        sessionId?.let { builder.header("Mcp-Session-Id", it) }
        if (initialized) builder.header("MCP-Protocol-Version", PROTOCOL_VERSION)
        // 用户配的头用 setHeader：header() 是追加，配一个同名头（比如 Content-Type）
        // 会变成两个值一起发出去，有些服务端直接判 400。
        server.headers.forEach { (key, value) -> builder.setHeader(key, value) }
        return try {
            client.send(builder.build(), HttpResponse.BodyHandlers.ofString(Charsets.UTF_8))
        } catch (error: java.io.IOException) {
            throw McpException(null, "连不上 MCP 服务 ${server.url}：${error.message ?: error::class.simpleName}")
        } catch (error: InterruptedException) {
            Thread.currentThread().interrupt()
            throw McpException(null, "调用 MCP 服务被中断")
        }
    }

    /**
     * 出站闸门：MCP 服务天然在本机，所以**放行回环**；私网/保留段照旧拒绝
     * （与 AI 连接同一条口径，不因为多了一个配置文件就多开一道门）。
     * 唯一必须硬守的是"不许指向这台服务自己"—— 那等于让外部工具绕过唯一的写保护。
     */
    private fun assertTargetAllowed(url: String) {
        val uri = URI.create(url)
        if (uri.scheme !in setOf("http", "https") || uri.host.isNullOrBlank()) {
            throw IllegalArgumentException("MCP 服务地址必须是 http(s)://主机:端口/路径 的形式：$url")
        }
        ProviderHttp.refusePointingAtSelf(uri)
        NetworkSecurity.resolveAndValidateSafeHttpTarget(uri, "MCP 服务", allowLoopback = true)
    }

    /**
     * 从响应体里取出 JSON-RPC 对象：普通 JSON 直接解；SSE 取最后一条带 `result`/`error` 的
     * `data:`。中间可能夹着进度通知（`notifications/progress`），所以不能简单取第一条。
     */
    private fun extractJsonRpc(body: String): JsonObject? {
        val text = body.trim()
        if (text.isEmpty()) return null
        if (text.startsWith("{")) {
            return runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull()
        }
        var last: JsonObject? = null
        text.lineSequence().forEach { line ->
            val trimmed = line.trim()
            if (!trimmed.startsWith("data:")) return@forEach
            val payload = trimmed.removePrefix("data:").trim()
            if (!payload.startsWith("{")) return@forEach
            val obj = runCatching { json.parseToJsonElement(payload).jsonObject }.getOrNull() ?: return@forEach
            if (obj.containsKey("result") || obj.containsKey("error")) last = obj
        }
        return last
    }

    /** 把 `content` 数组拼成一段文本：文本直取，图片/资源给一句占位，不静默丢内容。 */
    private fun contentText(content: JsonElement?): String {
        val items = content as? JsonArray ?: return ""
        return items.joinToString("\n") { element ->
            val obj = element as? JsonObject ?: return@joinToString element.toString()
            when (obj["type"]?.jsonPrimitive?.contentOrNull) {
                "text" -> obj["text"]?.jsonPrimitive?.contentOrNull.orEmpty()
                "image" -> "[图片 ${obj["mimeType"]?.jsonPrimitive?.contentOrNull ?: "未知类型"}]"
                "resource" -> obj["resource"]?.jsonObject?.get("text")?.jsonPrimitive?.contentOrNull ?: "[资源]"
                else -> element.toString()
            }
        }.trim()
    }

    private companion object {
        const val PROTOCOL_VERSION = "2025-06-18"
        const val CLIENT_NAME = "legadoQ"
    }
}
