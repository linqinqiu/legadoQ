package io.legado.ai

import io.legado.http.NetworkSecurity
import io.legado.http.ServerIdentity
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import java.io.BufferedReader
import java.io.InputStream
import java.io.InputStreamReader
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

/**
 * provider 共用的出站件 —— **三家协议只差"怎么说话"，不差"怎么出门"**。
 *
 * 收在这一个文件里的都是跨协议同一条：地址拼接、出站闸门、鉴权头、超时、
 * 重试退避、多 key 轮换、SSE 逐行读。
 *
 * 为什么必须共用：出站闸门是**安全边界**（AI 连接不许打内网/本机，尤其不许打这台服务自己）。
 * 每多一份复制就多一次漂移机会，而漂移的那天就是侧门重开的那天。协议实现可以各写各的，
 * 这道门只有一套。
 */
internal object ProviderHttp {

    val json = Json { ignoreUnknownKeys = true; isLenient = true; encodeDefaults = true }

    /** 这些状态码值得等一会儿再试：限流与上游临时故障。 */
    private val RETRYABLE_STATUS = setOf(408, 425, 429, 500, 502, 503, 504)

    /** 配了多个 key 时，鉴权失败也换下一个试试。 */
    private val ROTATE_KEY_STATUS = setOf(401, 403)

    /** 上游给的 `Retry-After` 最多听这么多，别让一次重试把请求拖到超时。 */
    private const val MAX_RETRY_AFTER_MS = 10_000L

    private val client: HttpClient by lazy {
        HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()
    }

    // ===== 地址 =====

    /**
     * 把 `baseUrl` 和协议路径拼成完整地址。
     *
     * @param path 以 `/` 开头，如 `/chat/completions`
     * @param stripSuffixes 有人会把整条端点地址粘进来（`…/v1/chat/completions`），
     *        先去掉这些尾巴再拼，避免拼出 `…/chat/completions/v1/chat/completions`
     */
    fun endpoint(
        profile: AgentProfileStore.Profile,
        path: String,
        stripSuffixes: List<String> = emptyList(),
    ): String? {
        var base = profile.baseUrl?.trim()?.removeSuffix("/") ?: return null
        stripSuffixes.forEach { suffix ->
            if (base.endsWith(suffix)) base = base.removeSuffix(suffix).removeSuffix("/")
        }
        if (base.isEmpty()) return null
        return if (base.endsWith("/v1")) base + path else base + "/v1" + path
    }

    /** 报错给人看时不要把整条带 key 的 URL 抄全：取到 host+path 就够定位了。 */
    fun hostSummary(url: String): String = runCatching {
        val u = URI.create(url)
        if (u.host.isNullOrBlank()) url else u.host + (if (u.port > 0) ":${u.port}" else "") + u.path
    }.getOrDefault(url)

    /**
     * 出站闸门：AI 连接的 `baseUrl` 默认不许指向内网 / 本机。
     *
     * 复用 [NetworkSecurity.resolveAndValidateSafeHttpTarget]（IPv4/IPv6/组播/保留段/CGNAT，
     * 带 DNS 缓存），**不另写一份判定**。
     *
     * 唯一例外是 [loopbackAllowed]（环境变量 `LEGADO_AI_ALLOW_LOOPBACK_BASEURL=1`）：
     * 本机跑 Ollama / LM Studio 的人只有回环地址可填。放开时也**只放回环**，
     * 私网段照旧拒；并且硬拒"打到这台服务自己"——见 [refusePointingAtSelf]。
     */
    fun assertPublicBaseUrl(url: String, loopbackAllowed: Boolean) {
        val uri = URI.create(url)
        if (uri.scheme !in setOf("http", "https") || uri.host.isNullOrBlank()) {
            throw NetworkSecurity.BlockedAddressException("仅允许 HTTP(S) AI 连接地址")
        }
        if (loopbackAllowed && isLoopbackLiteral(uri.host.lowercase())) {
            refusePointingAtSelf(uri)
            return
        }
        NetworkSecurity.resolveAndValidateSafeHttpTarget(uri, "AI 连接")
    }

    /** 只认字面回环：不走 DNS，免得"合法域名解析到 127.0.0.1"这种重绑定从这条口子进来。 */
    fun isLoopbackLiteral(host: String): Boolean =
        host == "localhost" || host == "::1" || host.startsWith("127.")

    /**
     * 开了回环口子后唯一必须守住的一条：**不许让 AI 连接打到这台服务自己**。
     *
     * 本服务对**不带 Origin 的请求直接放行写操作**，而 JDK `HttpClient` 发请求不带 Origin。
     * 于是 `baseUrl=http://127.0.0.1:1234/…` 等于让模型拿到整库写权限。端口对上就拒。
     */
    fun refusePointingAtSelf(uri: URI) {
        val identityHost = ServerIdentity.host.lowercase()
        val boundEverywhere = identityHost == "0.0.0.0" || identityHost == "::" || identityHost.isBlank()
        val sameHost = boundEverywhere ||
            isLoopbackLiteral(identityHost) ||
            uri.host.lowercase() == identityHost
        val port = if (uri.port > 0) uri.port else if (uri.scheme == "https") 443 else 80
        if (sameHost && port == ServerIdentity.port) {
            throw NetworkSecurity.BlockedAddressException(
                "AI 连接的地址不能指向 legadoQ 服务自己（端口 ${ServerIdentity.port}）：那会绕过这台服务唯一的写保护。",
            )
        }
    }

    // ===== 连接配置 =====

    /**
     * 这个连接可用的 key 列表。
     *
     * `apiKey` 字段可以写多个（逗号 / 分号 / 空白分隔），另外支持
     * `options["key.2"]`、`options["key.3"]` 追加。重试时按顺序轮换 ——
     * 中转站常按 key 做限流，一个 key 撞 429 换下一个往往立刻就好。
     */
    fun keys(profile: AgentProfileStore.Profile): List<String> {
        val fromField = profile.apiKey.orEmpty()
            .split(Regex("[,;\\s]+"))
            .map { it.trim() }
            .filter { it.isNotEmpty() }
        val fromOptions = profile.options.entries
            .filter { it.key.startsWith(ProfileOptions.KEY_PREFIX) }
            .sortedBy { it.key }
            .map { it.value.trim() }
            .filter { it.isNotEmpty() }
        return (fromField + fromOptions).distinct()
    }

    fun timeoutMs(profile: AgentProfileStore.Profile, default: Long): Long =
        ProfileOptions.timeoutMs(profile.options) ?: default

    fun retries(profile: AgentProfileStore.Profile): Int =
        ProfileOptions.retries(profile.options) ?: 2

    fun backoffMs(profile: AgentProfileStore.Profile): Long =
        ProfileOptions.retryBackoffMs(profile.options) ?: 800L

    // ===== HTTP =====

    /**
     * 一次非流式往返，带重试。
     *
     * 重试判据只有两类：**传输失败**（连不上 / 超时）与**上游明确说"稍再试"**（429/5xx）。
     * 4xx（除 408/425/429）不重试 —— 参数或鉴权错了，再试一百次也一样，
     * 还会把"key 不对"拖成"等了半分钟才报错"。
     *
     * 配了多个 key 时，401/403 也重试：换下一个 key 常常直接能过。
     *
     * @param authHeaders 按当前 key 生成鉴权头。空 key 时也会调用，实现方可返回空表。
     */
    fun sendText(
        profile: AgentProfileStore.Profile,
        url: String,
        body: String,
        timeoutMs: Long,
        headers: Map<String, String> = emptyMap(),
        authHeaders: (String) -> Map<String, String> = { emptyMap() },
        allowRetry: Boolean = true,
    ): HttpResponse<String> = sendWithRetry(
        profile = profile,
        url = url,
        timeoutMs = timeoutMs,
        allowRetry = allowRetry,
        handler = HttpResponse.BodyHandlers.ofString(),
        build = { key ->
            baseBuilder(url, key, timeoutMs)
                .apply { headers.forEach { (name, value) -> header(name, value) } }
                .apply { authHeaders(key).forEach { (name, value) -> header(name, value) } }
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build()
        },
    )

    /** GET 版本（模型清单探针用）。 */
    fun sendGetText(
        profile: AgentProfileStore.Profile,
        url: String,
        timeoutMs: Long,
        headers: Map<String, String> = emptyMap(),
        authHeaders: (String) -> Map<String, String> = { emptyMap() },
        allowRetry: Boolean = true,
    ): HttpResponse<String> = sendWithRetry(
        profile = profile,
        url = url,
        timeoutMs = timeoutMs,
        allowRetry = allowRetry,
        handler = HttpResponse.BodyHandlers.ofString(),
        build = { key ->
            baseBuilder(url, key, timeoutMs)
                .apply { headers.forEach { (name, value) -> header(name, value) } }
                .apply { authHeaders(key).forEach { (name, value) -> header(name, value) } }
                .GET()
                .build()
        },
    )

    /**
     * 流式往返：返回**尚未读取**的响应流。
     *
     * 与非流式共用重试规则，但只在拿到响应头之前重试；一旦 2xx 开始吐数据，
     * 中途断开就不再重发 —— 重新发一次会让界面看到两段重复回答。
     *
     * 超时只约束"响应头多久内到"：逐字输出可能持续几分钟，不能套用整体超时。
     * 调用方读完流负责关闭（[InputStream.close]）。
     */
    fun sendStream(
        profile: AgentProfileStore.Profile,
        url: String,
        body: String,
        timeoutMs: Long,
        headers: Map<String, String> = emptyMap(),
        authHeaders: (String) -> Map<String, String> = { emptyMap() },
        allowRetry: Boolean = true,
    ): HttpResponse<InputStream> = sendWithRetry(
        profile = profile,
        url = url,
        timeoutMs = timeoutMs,
        allowRetry = allowRetry,
        handler = HttpResponse.BodyHandlers.ofInputStream(),
        build = { key ->
            baseBuilder(url, key, timeoutMs)
                .header("Accept", "text/event-stream")
                .apply { headers.forEach { (name, value) -> header(name, value) } }
                .apply { authHeaders(key).forEach { (name, value) -> header(name, value) } }
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build()
        },
        release = { resp -> runCatching { resp.body().close() } },
    )

    private fun baseBuilder(url: String, @Suppress("UNUSED_PARAMETER") key: String, timeoutMs: Long): HttpRequest.Builder =
        HttpRequest.newBuilder()
            .uri(URI.create(url))
            .timeout(Duration.ofMillis(timeoutMs))
            .header("Content-Type", "application/json")

    private fun <T> sendWithRetry(
        profile: AgentProfileStore.Profile,
        url: String,
        timeoutMs: Long,
        allowRetry: Boolean,
        handler: HttpResponse.BodyHandler<T>,
        build: (String) -> HttpRequest,
        release: (HttpResponse<T>) -> Unit = {},
    ): HttpResponse<T> {
        val keys = keys(profile)
        val maxAttempts = 1 + (if (allowRetry) retries(profile) else 0)
        var lastError: Throwable? = null
        for (attempt in 0 until maxAttempts) {
            val key = if (keys.isEmpty()) "" else keys[attempt % keys.size]
            val request = build(key)
            try {
                val resp = client.send(request, handler)
                val retryable = resp.statusCode() in RETRYABLE_STATUS ||
                    (resp.statusCode() in ROTATE_KEY_STATUS && keys.size > 1)
                if (retryable && attempt < maxAttempts - 1) {
                    release(resp)
                    sleepBeforeRetry(profile, attempt, resp)
                    continue
                }
                return resp
            } catch (error: Throwable) {
                lastError = error
                // InterruptedException / ClosedByInterrupt 表示调用方取消了：不再重试。
                if (isCancellation(error) || attempt >= maxAttempts - 1) break
                sleepBeforeRetry(profile, attempt, null)
            }
        }
        throw NetworkSecurity.UnreachableTargetException(
            "连不上 ${hostSummary(url)}：${lastError?.message ?: lastError?.let { it::class.simpleName } ?: "未知错误"}",
            lastError,
        )
    }

    /** 非 2xx 的上游错误翻成可读异常；body 里常有服务端的原话，截一段带上。 */
    fun failForStatus(status: Int, body: String?): Nothing {
        val detail = body?.trim()?.takeIf { it.isNotEmpty() }?.let { excerpt(it) }
        val suffix = if (detail.isNullOrBlank()) "" else "：$detail"
        throw NetworkSecurity.UnreachableTargetException("上游返回 $status（不是有效的模型应答）$suffix")
    }

    /** 从错误响应体里尽量捞出服务端的一句话（OpenAI 风格 `error.message`）。 */
    fun errorMessage(body: String?): String = excerpt(body.orEmpty())

    // ===== SSE =====

    /**
     * 逐条读 SSE 的 `data:` 负载。
     *
     * 只关心 `data:` 行：`event:` / `id:` / 注释行（`:` 开头）都跳过，
     * 空行是事件分隔符。三家实测都发单行 data，这里按单行处理。
     */
    inline fun forEachSseData(stream: InputStream, onData: (String) -> Unit) {
        BufferedReader(InputStreamReader(stream, Charsets.UTF_8)).use { reader ->
            readSseData(reader, onData)
        }
    }

    /** 同上，但复用调用方给的 reader（需要先探一行判断"到底是不是 SSE"时用）。 */
    inline fun readSseData(reader: BufferedReader, onData: (String) -> Unit) {
        while (true) {
            val line = reader.readLine() ?: break
            val trimmed = line.trim()
            if (trimmed.isEmpty() || trimmed.startsWith(":") || trimmed.startsWith("event:")
                || trimmed.startsWith("id:") || trimmed.startsWith("retry:")
            ) continue
            if (!trimmed.startsWith("data:")) continue
            val payload = trimmed.removePrefix("data:").trim()
            if (payload.isEmpty()) continue
            onData(payload)
        }
    }

    // ===== JSON 小工具 =====

    /** `Any?` 转 JsonElement。参数都是扁平的（字符串/数字/布尔/列表），充足。 */
    fun anyToJson(value: Any?): JsonElement = when (value) {
        null -> JsonNull
        is Boolean -> JsonPrimitive(value)
        is Number -> JsonPrimitive(value)
        is String -> JsonPrimitive(value)
        is Collection<*> -> JsonArray(value.map { anyToJson(it) })
        else -> JsonPrimitive(value.toString())
    }

    fun argsToJsonObject(args: Map<String, Any?>): JsonObject = buildJsonObject {
        args.forEach { (key, value) -> put(key, anyToJson(value)) }
    }

    /** JsonObject 的顶层键值摊平成 [Map<String, Any?>]（数字按原文，框架侧对未知键宽容）。 */
    fun jsonObjectToArgs(obj: JsonObject?): Map<String, Any?> =
        obj?.entries?.associate { (key, element) ->
            key to when (element) {
                is JsonPrimitive -> element.content
                else -> element.toString()
            }
        } ?: emptyMap()

    /** 把模型给的 arguments 字符串解析成扁平键值。解析不了就当空参，不抛。 */
    fun parseArgs(raw: String): Map<String, Any?> = runCatching {
        jsonObjectToArgs(json.parseToJsonElement(raw) as? JsonObject)
    }.getOrDefault(emptyMap())

    /**
     * 解析 usage 块。三家字段名不同：
     * - OpenAI：`prompt_tokens` / `completion_tokens` / `total_tokens`
     * - Anthropic：`input_tokens` / `output_tokens`（无 total，自己加）
     * - Responses：`input_tokens` / `output_tokens` / `total_tokens`
     */
    fun parseUsage(obj: JsonObject?): LlmUsage? {
        if (obj == null) return null
        fun int(vararg names: String): Int? = names.firstNotNullOfOrNull { name ->
            (obj[name] as? JsonPrimitive)?.contentOrNull?.toIntOrNull()
        }
        val prompt = int("prompt_tokens", "input_tokens")
        val completion = int("completion_tokens", "output_tokens")
        val total = int("total_tokens") ?: if (prompt != null || completion != null) {
            (prompt ?: 0) + (completion ?: 0)
        } else null
        val usage = LlmUsage(prompt, completion, total)
        return usage.takeIf { !it.isEmpty }
    }

    // ===== 内部 =====

    private fun isCancellation(error: Throwable): Boolean =
        error is InterruptedException ||
            error is java.nio.channels.ClosedByInterruptException ||
            (error is java.io.InterruptedIOException && error !is java.net.SocketTimeoutException)

    /**
     * 退避：基础间隔按次翻倍（封顶 8 倍），并尊重上游的 `Retry-After`（上限 10 秒）。
     * 线程被中断（客户端断开导致协程取消）时立刻放弃等待。
     */
    private fun sleepBeforeRetry(
        profile: AgentProfileStore.Profile,
        attempt: Int,
        resp: HttpResponse<*>?,
    ) {
        val base = backoffMs(profile)
        if (base <= 0) return
        val retryAfter = resp?.headers()?.firstValue("Retry-After")?.orElse(null)?.toLongOrNull()
            ?.let { if (it > 0) it * 1000 else null }
        val wait = minOf(MAX_RETRY_AFTER_MS, retryAfter ?: (base shl attempt.coerceAtMost(3)))
        if (wait <= 0) return
        try {
            Thread.sleep(wait)
        } catch (interrupted: InterruptedException) {
            Thread.currentThread().interrupt()
            throw NetworkSecurity.UnreachableTargetException("请求已取消", interrupted)
        }
    }

    private fun excerpt(body: String): String {
        val text = body.trim()
        val fromJson = runCatching {
            val root = json.parseToJsonElement(text) as? JsonObject ?: return@runCatching null
            val err = root["error"]
            when (err) {
                is JsonObject -> (err["message"] as? JsonPrimitive)?.content
                is JsonPrimitive -> err.content
                else -> null
            }
        }.getOrNull()
        val chosen = fromJson?.takeIf { it.isNotBlank() } ?: text
        return chosen.replace(Regex("\\s+"), " ").take(300)
    }
}
