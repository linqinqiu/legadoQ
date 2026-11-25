package io.legado.feedback

import io.legado.ops.NetworkSecurity
import java.net.URI
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

/**
 * 意见收集的出站结果：只带上游状态码与响应原文，不解释、不记日志、不回显给前端太多。
 * [status] 是 Supabase/PostgREST 的 HTTP 状态码；[body] 仅在需要时给前端看一条摘要。
 */
data class FeedbackOutcome(val status: Int, val body: String = "")

/**
 * 出站 HTTP 的可注入缝。生产实现走 [supabaseHttp]（过 SSRF 闸门），测试直接塞假实现，
 * 于是路由测试不需要真的 Supabase 项目、也不需要开回环口子。
 */
fun interface FeedbackHttp {
    fun send(
        url: String,
        method: String,
        headers: Map<String, String>,
        body: String?,
    ): FeedbackOutcome
}

/**
 * 生产出站：用 [NetworkSecurity] 造的受控 client（公网 HTTPS 放行、私网/回环/169.254 等拒绝），
 * 不自己 new builder。anon key 只放在这里发出的请求头里，绝不进日志（见 ops/LogRedaction）。
 */
internal fun supabaseHttp(): FeedbackHttp {
    // client 建一次复用（HttpClient 内部有连接池）；每个请求只 new builder。
    val client by lazy { NetworkSecurity.newHttpClient(Duration.ofSeconds(10)) }
    return FeedbackHttp { url, method, headers, body ->
        val builder = HttpRequest.newBuilder(URI.create(url))
            .timeout(Duration.ofSeconds(10))
        headers.forEach { (k, v) -> builder.header(k, v) }
        when (method) {
            "POST" -> builder.POST(HttpRequest.BodyPublishers.ofString(body ?: "", Charsets.UTF_8))
            "GET" -> builder.GET()
            else -> error("feedback 出站只支持 POST/GET，收到 $method")
        }
        try {
            val response = client.send(builder.build(), HttpResponse.BodyHandlers.ofString(Charsets.UTF_8))
            FeedbackOutcome(response.statusCode(), response.body() ?: "")
        } catch (error: java.io.IOException) {
            // 只回状态与固定文案；不把 URL / key / body 写进任何日志。
            FeedbackOutcome(0, "upstream_unreachable: ${error::class.simpleName}")
        }
    }
}
