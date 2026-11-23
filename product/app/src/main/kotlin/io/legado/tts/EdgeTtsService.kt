package io.legado.tts

import java.io.ByteArrayOutputStream
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.net.http.WebSocket
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import io.legado.AppConfig
import io.legado.ops.CustomTtsClient
import io.legado.ops.NetworkSecurity
import io.legado.model.TtsSessionChunkRequest
import io.legado.model.TtsSpeakRequest
import io.legado.model.TtsVoice

class EdgeTtsService(
    /**
     * Edge 官方 WSS：目标固定为 `speech.platform.bing.com`，走唯一出站原语。
     * `GuardedHttpClient` 的 WebSocket 包装只放 wss，经 PinnedProxy 的 CONNECT 盲隧道。
     */
    private val wssClient: HttpClient = NetworkSecurity.newHttpClient(
        connectTimeout = Duration.ofSeconds(10),
        followRedirects = HttpClient.Redirect.NEVER,
    ),
    /**
     * 自定义 TTS：地址由用户填，按方案 A 放行本机/局域网，但封掉链路本地与云元数据段。
     * 不自动跟随重定向：`followCustomTtsRedirects` 手动逐跳跟随并重新过策略。
     */
    private val customClient: HttpClient = CustomTtsClient.newClient(
        connectTimeout = Duration.ofSeconds(10),
        followRedirects = HttpClient.Redirect.NEVER,
    ),
) {
    private val cache = ConcurrentHashMap<String, ByteArray>()
    private val maxCacheSize = AppConfig.edgeTtsCacheMax

    companion object {
        private const val MAX_CUSTOM_TTS_BYTES = 8 * 1024 * 1024
        /** 自定义 TTS 最多跟几跳重定向；超过按失败处理，避免 A→B→A 把线程挂住。 */
        private const val MAX_CUSTOM_TTS_REDIRECTS = 3
        /** 由 HttpClient 自行管理的请求头：用户填了也只会被丢掉，硬塞会抛 IllegalArgumentException。 */
        private val RESTRICTED_CUSTOM_HEADERS = setOf(
            "host", "content-length", "connection", "upgrade", "expect", "transfer-encoding", "te", "keep-alive",
        )
        private val TRUSTED_CLIENT_TOKEN = EdgeTtsToken.TRUSTED_CLIENT_TOKEN
        private const val WSS_BASE_URL = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1"
        // Chromium 版本可经 env(LEGADO_EDGE_TTS_CHROMIUM_VERSION) 覆盖；UA 与 Sec-MS-GEC-Version 据此派生。
        // 微软改协议时改这一个 env 即可，不必重编译（旧值会让合成静默返回 0 字节）。
        private val CHROMIUM_FULL_VERSION = AppConfig.edgeTtsChromiumVersion
        private val CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.substringBefore('.')
        private val USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$CHROMIUM_MAJOR_VERSION.0.0.0 Safari/537.36 Edg/$CHROMIUM_MAJOR_VERSION.0.0.0"
        private val SEC_MS_GEC_VERSION = "2-$CHROMIUM_FULL_VERSION"
        private const val ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold"

        val DEFAULT_VOICES = listOf(
            TtsVoice("zh-CN-XiaoxiaoNeural", "晓晓 (女声·温暖自然·推荐)", "zh-CN", "Female", "中文普通话", "edge", "适合小说叙述与日常对话"),
            TtsVoice("zh-CN-YunxiNeural", "云希 (男声·沉稳磁性·推荐)", "zh-CN", "Male", "中文普通话", "edge", "适合玄幻、都市小说旁白与对话"),
            TtsVoice("zh-CN-YunjianNeural", "云健 (男声·激情影视解说)", "zh-CN", "Male", "中文普通话", "edge", "影视解说、热血玄幻音色"),
            TtsVoice("zh-CN-XiaoyiNeural", "晓伊 (女声·柔和抒情)", "zh-CN", "Female", "中文普通话", "edge", "抒情、言情、文艺小说"),
            TtsVoice("zh-CN-YunyangNeural", "云扬 (男声·专业新闻播报)", "zh-CN", "Male", "中文普通话", "edge", "专业稳重播音员音色"),
            TtsVoice("zh-CN-liaoning-XiaobeiNeural", "晓北 (东北话·风趣女声)", "zh-CN-liaoning", "Female", "东北话", "edge", "风趣幽默的东北口音"),
            TtsVoice("zh-CN-shaanxi-XiaoniNeural", "晓妮 (陕西话·特色女声)", "zh-CN-shaanxi", "Female", "陕西话", "edge", "地道西北陕西口音"),
            TtsVoice("zh-TW-HsiaoChenNeural", "晓臻 (台湾腔·温柔女声)", "zh-TW", "Female", "台湾国语", "edge", "台湾国语自然女声"),
            TtsVoice("zh-TW-YunJheNeural", "云哲 (台湾腔·清澈男声)", "zh-TW", "Male", "台湾国语", "edge", "台湾国语阳光男声"),
            TtsVoice("zh-HK-HiuMaanNeural", "晓曼 (粤语·自然女声)", "zh-HK", "Female", "粤语", "edge", "标准粤语自然女声"),
            TtsVoice("zh-HK-WanLungNeural", "云龙 (粤语·磁性男声)", "zh-HK", "Male", "粤语", "edge", "标准粤语磁性男声"),
            TtsVoice("en-US-JennyNeural", "Jenny (英文·自然女声)", "en-US", "Female", "English (US)", "edge", "Natural American English Female"),
            TtsVoice("en-US-GuyNeural", "Guy (英文·自然男声)", "en-US", "Male", "English (US)", "edge", "Natural American English Male"),
        )

        /** v2 令牌（`<CS64>-<SHA256>`）；算法与固定样本见 [EdgeTtsToken]。 */
        fun generateSecMsGec(): String = EdgeTtsToken.generateSecMsGec()

        fun generateMuid(): String {
            val bytes = ByteArray(16)
            java.util.concurrent.ThreadLocalRandom.current().nextBytes(bytes)
            return bytes.joinToString("") { b -> "%02X".format(b) }
        }
    }

    fun listVoices(): List<TtsVoice> = DEFAULT_VOICES

    fun synthesize(
        text: String,
        voice: String = "zh-CN-XiaoxiaoNeural",
        rate: Int = 0,
        pitch: Int = 0,
        timeoutSeconds: Long = 15,
    ): ByteArray {
        val cleanText = text.trim()
        if (cleanText.isEmpty()) return ByteArray(0)

        // Guard: skip synthesis for punctuation-only or trivially short text (e.g. a bare `"` quote)
        // which would cause Edge-TTS to return 0 bytes, leading to ERR_REQUEST_RANGE_NOT_SATISFIABLE.
        val strippedForCheck = cleanText.replace(Regex("[\\s\\p{Punct}\\u2000-\\u206F\\u2018\\u2019\\u201C\\u201D\\u3000-\\u303F\\uFF00-\\uFFEF]"), "")
        if (strippedForCheck.length < 2) return ByteArray(0)

        val cacheKey = "$voice:$rate:$pitch:$cleanText"
        cache[cacheKey]?.let { return it }

        val rateStr = if (rate >= 0) "+$rate%" else "$rate%"
        val pitchStr = if (pitch >= 0) "+${pitch}Hz" else "${pitch}Hz"
        val requestId = UUID.randomUUID().toString().replace("-", "")

        val escapedText = xmlEscape(cleanText)
        val ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>" +
                "<voice name='$voice'>" +
                "<prosody pitch='$pitchStr' rate='$rateStr' volume='+0%'>$escapedText</prosody>" +
                "</voice></speak>"

        val audioBuffer = ByteArrayOutputStream()
        val future = CompletableFuture<ByteArray>()

        val listener = object : WebSocket.Listener {
            override fun onText(webSocket: WebSocket, data: CharSequence, last: Boolean): CompletionStage<*>? {
                val str = data.toString()
                if (str.contains("Path:turn.end")) {
                    future.complete(audioBuffer.toByteArray())
                    webSocket.sendClose(WebSocket.NORMAL_CLOSURE, "Done")
                }
                return super.onText(webSocket, data, last)
            }

            override fun onBinary(webSocket: WebSocket, data: ByteBuffer, last: Boolean): CompletionStage<*>? {
                if (data.remaining() > 2) {
                    val headerLen = data.short.toInt() and 0xFFFF
                    if (data.remaining() >= headerLen) {
                        val headerBytes = ByteArray(headerLen)
                        data.get(headerBytes)
                        val audioBytes = ByteArray(data.remaining())
                        data.get(audioBytes)
                        if (audioBytes.isNotEmpty()) {
                            synchronized(audioBuffer) {
                                audioBuffer.write(audioBytes)
                            }
                        }
                    }
                }
                return super.onBinary(webSocket, data, last)
            }

            override fun onError(webSocket: WebSocket, error: Throwable) {
                if (!future.isDone) {
                    future.completeExceptionally(error)
                }
            }

            override fun onClose(webSocket: WebSocket, statusCode: Int, reason: String): CompletionStage<*>? {
                if (!future.isDone) {
                    future.complete(audioBuffer.toByteArray())
                }
                return super.onClose(webSocket, statusCode, reason)
            }
        }

        val connectionId = UUID.randomUUID().toString().replace("-", "")
        val secMsGec = generateSecMsGec()
        val muid = generateMuid()
        val wssUrl = "$WSS_BASE_URL?TrustedClientToken=$TRUSTED_CLIENT_TOKEN&Sec-MS-GEC=$secMsGec&Sec-MS-GEC-Version=$SEC_MS_GEC_VERSION&ConnectionId=$connectionId"

        val ws = wssClient.newWebSocketBuilder()
            .header("User-Agent", USER_AGENT)
            .header("Origin", ORIGIN)
            .header("Pragma", "no-cache")
            .header("Cache-Control", "no-cache")
            .header("Accept-Encoding", "gzip, deflate, br, zstd")
            .header("Accept-Language", "en-US,en;q=0.9")
            .header("Cookie", "muid=$muid;")
            .buildAsync(URI.create(wssUrl), listener)
            .get(timeoutSeconds, TimeUnit.SECONDS)

        try {
            val configMsg = "Content-Type:application/json; charset=utf-8\r\n" +
                    "Path:speech.config\r\n\r\n" +
                    "{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\"},\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}"

            ws.sendText(configMsg, true)

            val ssmlMsg = "X-RequestId:$requestId\r\n" +
                    "Content-Type:application/ssml+xml\r\n" +
                    "Path:ssml\r\n\r\n" +
                    ssml

            ws.sendText(ssmlMsg, true)

            val result = future.get(timeoutSeconds, TimeUnit.SECONDS)
            if (result.isNotEmpty()) {
                if (cache.size > maxCacheSize) {
                    cache.clear()
                }
                cache[cacheKey] = result
            }
            return result
        } catch (e: Exception) {
            ws.abort()
            throw e
        }
    }

    /**
     * Sends MP3 frames to the callback as they arrive from Edge-TTS while also
     * retaining the existing bounded in-memory cache for completed chunks.
     */
    fun synthesizeStream(
        text: String,
        voice: String = "zh-CN-XiaoxiaoNeural",
        rate: Int = 0,
        pitch: Int = 0,
        timeoutSeconds: Long = 15,
        onAudio: (ByteArray) -> Unit,
    ) {
        val cleanText = text.trim()
        if (cleanText.isEmpty()) return

        val strippedForCheck = cleanText.replace(Regex("[\\s\\p{Punct}\\u2000-\\u206F\\u2018\\u2019\\u201C\\u201D\\u3000-\\u303F\\uFF00-\\uFFEF]"), "")
        if (strippedForCheck.length < 2) return

        val cacheKey = "$voice:$rate:$pitch:$cleanText"
        cache[cacheKey]?.let { cached ->
            onAudio(cached)
            return
        }

        val rateStr = if (rate >= 0) "+$rate%" else "$rate%"
        val pitchStr = if (pitch >= 0) "+${pitch}Hz" else "${pitch}Hz"
        val requestId = UUID.randomUUID().toString().replace("-", "")
        val escapedText = xmlEscape(cleanText)
        val ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>" +
                "<voice name='$voice'>" +
                "<prosody pitch='$pitchStr' rate='$rateStr' volume='+0%'>$escapedText</prosody>" +
                "</voice></speak>"
        var attempt = 0
        while (attempt < 2) {
            attempt++
            val audioBuffer = ByteArrayOutputStream()
            val future = CompletableFuture<Unit>()

            val listener = object : WebSocket.Listener {
                override fun onText(webSocket: WebSocket, data: CharSequence, last: Boolean): CompletionStage<*>? {
                    if (data.toString().contains("Path:turn.end")) {
                        future.complete(Unit)
                        webSocket.sendClose(WebSocket.NORMAL_CLOSURE, "Done")
                    }
                    return super.onText(webSocket, data, last)
                }

                override fun onBinary(webSocket: WebSocket, data: ByteBuffer, last: Boolean): CompletionStage<*>? {
                    if (data.remaining() > 2) {
                        val headerLen = data.short.toInt() and 0xFFFF
                        if (data.remaining() >= headerLen) {
                            val headerBytes = ByteArray(headerLen)
                            data.get(headerBytes)
                            val audioBytes = ByteArray(data.remaining())
                            data.get(audioBytes)
                            if (audioBytes.isNotEmpty()) {
                                synchronized(audioBuffer) { audioBuffer.write(audioBytes) }
                                onAudio(audioBytes)
                            }
                        }
                    }
                    return super.onBinary(webSocket, data, last)
                }

                override fun onError(webSocket: WebSocket, error: Throwable) {
                    future.completeExceptionally(error)
                }

                override fun onClose(webSocket: WebSocket, statusCode: Int, reason: String): CompletionStage<*>? {
                    if (!future.isDone) future.complete(Unit)
                    return super.onClose(webSocket, statusCode, reason)
                }
            }

            val connectionId = UUID.randomUUID().toString().replace("-", "")
            val secMsGec = generateSecMsGec()
            val muid = generateMuid()
            val wssUrl = "$WSS_BASE_URL?TrustedClientToken=$TRUSTED_CLIENT_TOKEN&Sec-MS-GEC=$secMsGec&Sec-MS-GEC-Version=$SEC_MS_GEC_VERSION&ConnectionId=$connectionId"
            var ws: WebSocket? = null

            try {
                ws = wssClient.newWebSocketBuilder()
                    .header("User-Agent", USER_AGENT)
                    .header("Origin", ORIGIN)
                    .header("Pragma", "no-cache")
                    .header("Cache-Control", "no-cache")
                    .header("Accept-Encoding", "gzip, deflate, br, zstd")
                    .header("Accept-Language", "en-US,en;q=0.9")
                    .header("Cookie", "muid=$muid;")
                    .buildAsync(URI.create(wssUrl), listener)
                    .get(timeoutSeconds, TimeUnit.SECONDS)

                val configMsg = "Content-Type:application/json; charset=utf-8\r\n" +
                        "Path:speech.config\r\n\r\n" +
                        "{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\"},\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}"
                ws.sendText(configMsg, true)
                val ssmlMsg = "X-RequestId:$requestId\r\n" +
                        "Content-Type:application/ssml+xml\r\n" +
                        "Path:ssml\r\n\r\n" +
                        ssml
                ws.sendText(ssmlMsg, true)
                future.get(timeoutSeconds, TimeUnit.SECONDS)
                val result = audioBuffer.toByteArray()
                if (result.isNotEmpty()) {
                    if (cache.size > maxCacheSize) cache.clear()
                    cache[cacheKey] = result
                }
                return
            } catch (e: Exception) {
                ws?.abort()
                if (attempt < 2 && audioBuffer.size() == 0) {
                    Thread.sleep(150)
                    continue
                }
                throw e
            }
        }
    }

    /**
     * 自定义 TTS 的地址由用户在朗读设置里填，最常见的用法就是指向本机的自建合成服务，
     * 所以**不能**套用封面/书源抓取那套内网拦截；但也不能什么都不拦 —— 策略在
     * [CustomTtsClient]：放行本机与 RFC1918/ULA，封掉链路本地、云元数据、CGNAT、组播/保留段。
     *
     * 注意：**重定向必须逐跳复查** —— 客户端配的是 `Redirect.NEVER`，3xx 原样返回，
     * `followCustomTtsRedirects` 手动跟跳，每跳都回到这里过一遍策略。
     */
    private fun assertSafeTtsTarget(uri: URI) {
        CustomTtsClient.requireAllowed(uri)
    }

    /**
     * 手动跟随重定向，每跳都重新过 [assertSafeTtsTarget]。
     *
     * 客户端已改 `Redirect.NEVER`，所以 3xx 会原样返回；这里最多跟 [MAX_CUSTOM_TTS_REDIRECTS] 跳，
     * 超过就报错（防止 A→B→A 的死循环把线程挂住）。`rebuild` 负责用新的 URI 重建请求，
     * 因为 POST 的 body publisher 不能复用。
     */
    private fun <T> followCustomTtsRedirects(
        initial: HttpRequest,
        rebuild: (from: URI, to: URI, status: Int) -> HttpRequest,
        handler: HttpResponse.BodyHandler<T>,
    ): HttpResponse<T> {
        var current = initial
        var response = customClient.send(current, handler)
        var hops = 0
        while (response.statusCode() in 300..399) {
            val location = response.headers().firstValue("location").orElse(null) ?: break
            val next = runCatching { current.uri().resolve(location) }.getOrNull() ?: break
            if (hops >= MAX_CUSTOM_TTS_REDIRECTS) {
                // 判据是「最多跟 N 跳」：第 N 跳本身合法，再下一跳才拒绝。
                // 报错前也要关掉手里这一跳的响应体，否则流式响应漏文件描述符。
                runCatching { response.body()?.let { (it as? java.io.Closeable)?.close() } }
                throw IllegalArgumentException("自定义 TTS 重定向超过 $MAX_CUSTOM_TTS_REDIRECTS 次")
            }
            assertSafeTtsTarget(next)
            // 被丢弃的那一跳响应体必须关掉，否则流式响应会漏文件描述符。
            runCatching { response.body()?.let { (it as? java.io.Closeable)?.close() } }
            current = rebuild(current.uri(), next, response.statusCode())
            response = customClient.send(current, handler)
            hops++
        }
        return response
    }

    /**
     * 跳转后的请求方法（RFC 9110 §15.4）：`303` 一律改 `GET`；`301`/`302` 按浏览器与 curl 的
     * 历史约定把 `POST` 降为 `GET`；`307`/`308` 必须原样保留方法与 body。
     *
     * 原实现每跳都重发 `POST`：上游把合成请求 302/303 到静态文件或 CDN 时，常见结果是 405
     * 或同一段文本被合成两次。
     */
    private fun redirectMethod(method: String, status: Int): String = when {
        status == 303 -> "GET"
        (status == 301 || status == 302) && method == "POST" -> "GET"
        else -> method
    }

    /**
     * 跳转前后是否同源（scheme / host / 端口任一不同都算跨源，默认端口归一化）。
     *
     * 跨源时 [followCustomTtsRedirects] 的调用方**不再重放用户自定义请求头**：
     * 那些头里通常放的是第三方服务的 key，而跳转目标是上游自己选的，
     * 不能把用户的凭据发给用户没配置过的主机。
     */
    private fun isSameOrigin(from: URI, to: URI): Boolean =
        from.scheme.equals(to.scheme, ignoreCase = true) &&
            from.host.equals(to.host, ignoreCase = true) &&
            effectivePort(from) == effectivePort(to)

    private fun effectivePort(uri: URI): Int = when {
        uri.port != -1 -> uri.port
        uri.scheme.equals("http", ignoreCase = true) -> 80
        uri.scheme.equals("https", ignoreCase = true) -> 443
        else -> -1
    }

    private fun customTtsUri(raw: String): URI {
        val uri = runCatching { URI.create(raw) }.getOrNull() ?: throw IllegalArgumentException("自定义 TTS 地址无效")
        assertSafeTtsTarget(uri)
        return uri
    }

    /**
     * 自定义 TTS 的附加请求头。界面上以前没有这一栏，"第三方 TTS 基本都要一个 key"这条路是断的；
     * 补上入口的同时把口子收住：值或名字里带 CR/LF 的丢掉（那是请求走私与头注入的原料），
     * `Host` / `Content-Length` 这类由 HttpClient 自己管理的字段丢掉（硬塞上去 JDK 客户端会直接抛
     * IllegalArgumentException，整条请求就废了）。
     */
    private fun customHeaders(raw: String?): List<Pair<String, String>> {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return emptyList()
        return runCatching {
            Json.parseToJsonElement(text).jsonObject.mapNotNull { (key, value) ->
                runCatching {
                    val name = key.trim()
                    val content = value.jsonPrimitive.content.trim()
                    if (name.isEmpty() || content.isEmpty()) return@runCatching null
                    if (name.lowercase() in RESTRICTED_CUSTOM_HEADERS) return@runCatching null
                    if (name.any { it == '\r' || it == '\n' } || content.any { it == '\r' || it == '\n' }) return@runCatching null
                    name to content
                }.getOrNull()
            }
        }.getOrDefault(emptyList())
    }

    fun synthesizeCustom(request: TtsSpeakRequest, timeoutSeconds: Long = 15): Pair<String, ByteArray> {
        val targetUrl = request.customUrl ?: throw IllegalArgumentException("customUrl is required for custom TTS")
        val cleanText = request.text.trim()
        val voice = request.voice
        val speedMultiplier = (1.0 + request.rate / 100.0).coerceIn(0.2, 4.0)

        var resolvedUrl = targetUrl
            .replace("{{speakText}}", URLEncoder.encode(cleanText, StandardCharsets.UTF_8))
            .replace("{{speakVoice}}", URLEncoder.encode(voice, StandardCharsets.UTF_8))
            .replace("{{speakSpeed}}", speedMultiplier.toString())
            .replace("{{speakPitch}}", request.pitch.toString())

        val method = request.customMethod?.uppercase() ?: "GET"
        // POST 的 body 在跟重定向时要重建，所以先算好放在外面（body publisher 不能复用）。
        val resolvedBody = (request.customBody ?: "")
            .replace("{{speakText}}", cleanText)
            .replace("{{speakVoice}}", voice)
            .replace("{{speakSpeed}}", speedMultiplier.toString())
            .replace("{{speakPitch}}", request.pitch.toString())
        val reqBuilder = HttpRequest.newBuilder().timeout(Duration.ofSeconds(timeoutSeconds))

        val headers = customHeaders(request.customHeader)
        headers.forEach { (name, value) -> reqBuilder.header(name, value) }

        if (method == "POST") {
            reqBuilder.uri(customTtsUri(resolvedUrl))
            reqBuilder.POST(HttpRequest.BodyPublishers.ofString(resolvedBody, StandardCharsets.UTF_8))
        } else {
            reqBuilder.uri(customTtsUri(resolvedUrl))
            reqBuilder.GET()
        }

        val response = followCustomTtsRedirects(reqBuilder.build(), { from, to, status ->
            val rebuilt = HttpRequest.newBuilder(to).timeout(Duration.ofSeconds(timeoutSeconds))
            if (isSameOrigin(from, to)) {
                headers.forEach { (name, value) -> rebuilt.header(name, value) }
            }
            if (redirectMethod(method, status) == "POST") {
                rebuilt.POST(HttpRequest.BodyPublishers.ofString(resolvedBody, StandardCharsets.UTF_8))
            } else {
                rebuilt.GET()
            }
            rebuilt.build()
        }, HttpResponse.BodyHandlers.ofInputStream())
        assertSafeTtsTarget(response.uri())
        val contentType = response.headers().firstValue("Content-Type").orElse("audio/mpeg")
        response.body().use { input ->
            // 上游失败必须报错。之前直接把 401/500 的响应体当音频回 200，
            // 用户看到的是"合成成功但没声音"，比明确报错难查得多。
            if (response.statusCode() !in 200..299) {
                throw IllegalStateException("自定义 TTS 返回 HTTP ${response.statusCode()}")
            }
            // 边读边卡上限：先 ofByteArray() 读完再判，超大响应会先把内存吃满。
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(16 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                if (output.size() + read > MAX_CUSTOM_TTS_BYTES) {
                    throw IllegalArgumentException("自定义 TTS 响应超过 ${MAX_CUSTOM_TTS_BYTES / 1024 / 1024}MB 上限")
                }
                output.write(buffer, 0, read)
            }
            return Pair(contentType, output.toByteArray())
        }
    }

    fun synthesizeCustomStream(
        request: TtsSessionChunkRequest,
        timeoutSeconds: Long = 15,
        onAudio: (ByteArray) -> Unit,
    ): String {
        val targetUrl = request.customUrl ?: throw IllegalArgumentException("customUrl is required for custom TTS")
        val cleanText = request.text.trim()
        val speedMultiplier = (1.0 + request.rate / 100.0).coerceIn(0.2, 4.0)
        val resolvedUrl = targetUrl
            .replace("{{speakText}}", URLEncoder.encode(cleanText, StandardCharsets.UTF_8))
            .replace("{{speakVoice}}", URLEncoder.encode(request.voice, StandardCharsets.UTF_8))
            .replace("{{speakSpeed}}", speedMultiplier.toString())
            .replace("{{speakPitch}}", request.pitch.toString())
        val method = request.customMethod?.uppercase() ?: "GET"
        // POST 的 body 在跟重定向时要重建，所以先算好放在外面（body publisher 不能复用）。
        val resolvedBody = (request.customBody ?: "")
            .replace("{{speakText}}", cleanText)
            .replace("{{speakVoice}}", request.voice)
            .replace("{{speakSpeed}}", speedMultiplier.toString())
            .replace("{{speakPitch}}", request.pitch.toString())
        val reqBuilder = HttpRequest.newBuilder().timeout(Duration.ofSeconds(timeoutSeconds))
        val headers = customHeaders(request.customHeader)
        headers.forEach { (name, value) -> reqBuilder.header(name, value) }
        if (method == "POST") {
            reqBuilder.uri(customTtsUri(resolvedUrl))
            reqBuilder.POST(HttpRequest.BodyPublishers.ofString(resolvedBody, StandardCharsets.UTF_8))
        } else {
            reqBuilder.uri(customTtsUri(resolvedUrl))
            reqBuilder.GET()
        }

        val response = followCustomTtsRedirects(reqBuilder.build(), { from, to, status ->
            val rebuilt = HttpRequest.newBuilder(to).timeout(Duration.ofSeconds(timeoutSeconds))
            if (isSameOrigin(from, to)) {
                headers.forEach { (name, value) -> rebuilt.header(name, value) }
            }
            if (redirectMethod(method, status) == "POST") {
                rebuilt.POST(HttpRequest.BodyPublishers.ofString(resolvedBody, StandardCharsets.UTF_8))
            } else {
                rebuilt.GET()
            }
            rebuilt.build()
        }, HttpResponse.BodyHandlers.ofInputStream())
        assertSafeTtsTarget(response.uri())
        response.body().use { input ->
            if (response.statusCode() !in 200..299) {
                throw IllegalStateException("自定义 TTS 返回 HTTP ${response.statusCode()}")
            }
            val contentType = response.headers().firstValue("Content-Type")
                .orElse("audio/mpeg")
                .substringBefore(';')
                .trim()
                .lowercase()
            if (contentType !in setOf("audio/mpeg", "audio/mp3")) {
                throw IllegalArgumentException("自定义 TTS 必须返回 audio/mpeg，实际为 $contentType")
            }
            val buffer = ByteArray(8192)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (count > 0) onAudio(buffer.copyOf(count))
            }
            return contentType
        }
    }

    private fun xmlEscape(str: String): String {
        return buildString(str.length + 16) {
            for (ch in str) {
                when (ch) {
                    '&' -> append("&amp;")
                    '<' -> append("&lt;")
                    '>' -> append("&gt;")
                    '"' -> append("&quot;")
                    '\'' -> append("&apos;")
                    else -> append(ch)
                }
            }
        }
    }
}
