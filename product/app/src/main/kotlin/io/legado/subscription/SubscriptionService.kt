package io.legado.subscription

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.net.InetAddress
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.security.MessageDigest
import java.time.Duration
import io.legado.AppConfig
import io.legado.charsetOf
import io.legado.data.Database
import io.legado.data.getSubscription
import io.legado.data.importSources
import io.legado.data.listSubscriptions
import io.legado.data.recordSubscriptionFailure
import io.legado.data.recordSubscriptionSuccess
import io.legado.decodeTextAuto
import io.legado.http.NetworkSecurity
import io.legado.model.ImportResponse
import io.legado.model.SourceSubscription

class SubscriptionService(private val database: Database, private val log: (String) -> Unit) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val updateMutex = Mutex()
    private val client = io.legado.http.NetworkSecurity.newHttpClient(connectTimeout = Duration.ofSeconds(10), followRedirects = HttpClient.Redirect.NEVER)
    private var scheduler: Job? = null

    fun start() {
        if (scheduler != null) return
        scheduler = scope.launch {
            while (true) {
                delay(UPDATE_INTERVAL_MS)
                updateAll()
            }
        }
    }

    fun stop() { scope.cancel() }

    suspend fun updateAll(): List<Pair<Long, Result<ImportResponse>>> = updateMutex.withLock {
        database.listSubscriptions(enabledOnly = true).map { subscription ->
            subscription.id to runCatching { update(subscription) }
        }
    }

    suspend fun updateOne(id: Long): ImportResponse = updateMutex.withLock {
        val subscription = database.getSubscription(id) ?: throw NoSuchElementException("订阅不存在")
        update(subscription)
    }

    private fun update(subscription: SourceSubscription): ImportResponse {
        return try {
            val body = download(subscription.url)
            val sources = parseSources(body)
            val result = database.importSources(sources)
            database.recordSubscriptionSuccess(subscription.id, result, sha256(body))
            log("source subscription updated: id=${subscription.id}, imported=${result.imported}, updated=${result.updated}")
            result
        } catch (error: Throwable) {
            database.recordSubscriptionFailure(subscription.id, error.message ?: "订阅更新失败")
            throw error
        }
    }

    private fun download(url: String): String {
        var uri = URI(url)
        validate(uri)
        repeat(MAX_REDIRECTS + 1) {
            val response = client.send(
                HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(30)).header("User-Agent", "legadoQ/0.1").GET().build(),
                HttpResponse.BodyHandlers.ofInputStream(),
            )
            response.body().use { body ->
                if (response.statusCode() in 300..399) {
                    uri = uri.resolve(response.headers().firstValue("location").orElseThrow { IllegalArgumentException("订阅重定向缺少地址") })
                    validate(uri)
                    return@repeat
                }
                require(response.statusCode() in 200..299) { "订阅上游返回 HTTP ${response.statusCode()}" }
                // 体积封顶：坏/超大订阅源不该整包读进内存。读满「上限+1」字节即判定超限并拒绝。
                val bytes = body.readNBytes(MAX_BODY_BYTES + 1)
                require(bytes.size <= MAX_BODY_BYTES) { "订阅内容超过 ${MAX_BODY_BYTES / (1024 * 1024)}MB 上限，已拒绝" }
                // 订阅源不一定按 UTF-8 存：老站点/老工具导出的 GBK 清单直接按 UTF-8 读会整份乱码，
                // 然后 json 解析失败被记成「订阅内容不是有效 JSON」—— 用户看到的是一句莫名其妙的报错。
                // 按 `Content-Type` 声明 + 自动探测解（与备份导入、TXT 同一套口径）。
                val declared = charsetOf(response.headers().firstValue("Content-Type").orElse(null))
                return decodeTextAuto(bytes, declared)
            }
        }
        throw IllegalArgumentException("订阅重定向次数超过限制")
    }

    /**
     * 解析订阅源内容。
     *
     * 订阅地址吐出来的形状很不统一：裸数组、`{data:[…]}`、`{sources:[…]}`、
     * `{bookSources:[…]}`、`{list:[…]}` 都见过。这里全认，并把每个元素**原样序列化**
     * 成字符串（下游按字符串存库，不在这里重新建模 —— 认不出的字段才不会丢）。
     *
     * 抽成 internal 是为了可测：这五种形状的判定是最容易漏的地方。
     */
    internal fun parseSources(body: String): List<String> {
        val cleanBody = body.trim().removePrefix("\uFEFF")
        val element = try { Json.parseToJsonElement(cleanBody) } catch (_: Exception) { throw IllegalArgumentException("订阅内容不是有效 JSON") }
        val values = when (element) {
            is JsonArray -> element
            is JsonObject -> when {
                element["data"] is JsonArray -> element["data"] as JsonArray
                element["sources"] is JsonArray -> element["sources"] as JsonArray
                element["bookSources"] is JsonArray -> element["bookSources"] as JsonArray
                element["list"] is JsonArray -> element["list"] as JsonArray
                else -> listOf(element)
            }
            else -> listOf(element)
        }
        return values.map { Json.encodeToString(JsonElement.serializer(), it) }
    }

    private fun validate(uri: URI) {
        NetworkSecurity.resolveAndValidateSafeHttpTarget(uri, "订阅")
    }

    private fun sha256(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }

    private companion object {
        val UPDATE_INTERVAL_MS = AppConfig.subscriptionUpdateMs
        const val MAX_REDIRECTS = 3
        const val MAX_BODY_BYTES = 8 * 1024 * 1024 // 8MB：订阅源是 JSON 清单，超过即视为异常
    }
}
