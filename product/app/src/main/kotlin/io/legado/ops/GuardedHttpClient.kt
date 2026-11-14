package io.legado.ops

import java.net.Authenticator
import java.net.CookieHandler
import java.net.InetAddress
import java.net.ProxySelector
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.Optional
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executor
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLParameters

/**
 * 出站 HTTP 只能由 [NetworkSecurity.newHttpClient] 签发：模块拿不到裸的 `HttpClient.newBuilder()`，
 * 想发请求就走受控实例，每个请求在真正发包前都要过 SSRF 闸门
 * （[NetworkSecurity.resolveAndValidateSafeHttpTarget]），并在发送时重新检查 DNS 应答。
 *
 * 连接级 TOCTOU 由 [PinnedProxy] 关闭：所有请求经本进程回环代理，由它解析一次、校验、连同一个
 * `InetAddress`；JDK 只跟 127.0.0.1 建连，不再自己解析目标域名。这里的复查是纵深防御。
 *
 * 这是把"出站必过闸"从"每个调用点记得手调一次"变成"拿不到不过闸的 client"的机制化收口。
 */
internal class GuardedHttpClient(
    private val delegate: HttpClient,
    /**
     * 允许打到**回环**地址（本机模型：Ollama / LM Studio）。
     *
     * 只有 AI 外呼这一条在显式开关（`LEGADO_AI_ALLOW_LOOPBACK_BASEURL=1`）下会打开它，
     * 且打开后仍拒私网/链路本地/保留段，并由调用方另行硬拒「打到这台服务自己」。
     * 其余出站（书源、订阅、封面、媒体代理）永远拿不到放开回环的实例。
     */
    private val allowLoopback: Boolean = false,
) : HttpClient() {

    override fun <T> send(req: HttpRequest, responseBodyHandler: HttpResponse.BodyHandler<T>): HttpResponse<T> {
        guard(req.uri())
        val response = delegate.send(req, responseBodyHandler)
        failIfProxyCouldNotConnect(req.uri(), response)
        return response
    }

    override fun <T> sendAsync(req: HttpRequest, responseBodyHandler: HttpResponse.BodyHandler<T>): CompletableFuture<HttpResponse<T>> {
        guard(req.uri())
        return delegate.sendAsync(req, responseBodyHandler).thenApply { response ->
            failIfProxyCouldNotConnect(req.uri(), response)
            response
        }
    }

    override fun <T> sendAsync(
        req: HttpRequest,
        responseBodyHandler: HttpResponse.BodyHandler<T>,
        pushPromiseHandler: HttpResponse.PushPromiseHandler<T>,
    ): CompletableFuture<HttpResponse<T>> {
        guard(req.uri())
        return delegate.sendAsync(req, responseBodyHandler, pushPromiseHandler).thenApply { response ->
            failIfProxyCouldNotConnect(req.uri(), response)
            response
        }
    }

    override fun cookieHandler(): Optional<CookieHandler> = delegate.cookieHandler()
    override fun connectTimeout(): Optional<Duration> = delegate.connectTimeout()
    override fun followRedirects(): HttpClient.Redirect = delegate.followRedirects()
    override fun proxy(): Optional<ProxySelector> = delegate.proxy()
    override fun sslContext(): SSLContext? = delegate.sslContext()
    override fun sslParameters(): SSLParameters? = delegate.sslParameters()
    override fun authenticator(): Optional<Authenticator> = delegate.authenticator()
    override fun version(): HttpClient.Version = delegate.version()
    override fun executor(): Optional<Executor> = delegate.executor()

    private fun guard(uri: URI) {
        // 1) 既有判定：scheme/host + 解析后 IP 的私网/回环/保留段。
        NetworkSecurity.resolveAndValidateSafeHttpTarget(uri, uri.host ?: "目标", allowLoopback)
        // 2) 发送前复查全部应答。真正堵住 TOCTOU 的是 [PinnedProxy]：它解析一次并连同一个地址，
        //    客户端不再自己解析目标域名。这里的复查保留为纵深防御（缓存命中时几乎零成本）。
        val resolved = try {
            InetAddress.getAllByName(uri.host)
        } catch (e: Exception) {
            throw NetworkSecurity.UnreachableTargetException("无法解析目标域名: ${uri.host}（${e.message}）", e)
        }
        NetworkSecurity.validateResolvedAddresses(resolved, allowLoopback)
    }

    /**
     * 代理建连失败时回的是 502 + [PinnedProxy.ERROR_HEADER]，不能让调用方把它当成"上游返回 502"。
     * 还原成 [NetworkSecurity.UnreachableTargetException]：错误分类（被拒 vs 到不了）比状态码更重要，
     * 上层按它决定回 4xx 还是 502，并给出"连不上哪个地址"的可排查文案。
     */
    private fun failIfProxyCouldNotConnect(uri: URI, response: HttpResponse<*>) {
        if (!response.headers().firstValue(PinnedProxy.ERROR_HEADER).isPresent) return
        (response.body() as? java.io.Closeable)?.let { runCatching { it.close() } }
        val port = if (uri.port > 0) uri.port else if (uri.scheme == "https") 443 else 80
        throw NetworkSecurity.UnreachableTargetException("连不上 ${uri.host}:$port（出站代理建连失败）")
    }
}
