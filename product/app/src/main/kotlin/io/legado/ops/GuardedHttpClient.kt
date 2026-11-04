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
 * （[NetworkSecurity.resolveAndValidateSafeHttpTarget]），并对解析后的 IP 复查私网/回环
 * （防 DNS 重绑定 —— 建连前那一下解析结果可能与构造 URL 时不同）。
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
        return delegate.send(req, responseBodyHandler)
    }

    override fun <T> sendAsync(req: HttpRequest, responseBodyHandler: HttpResponse.BodyHandler<T>): CompletableFuture<HttpResponse<T>> {
        guard(req.uri())
        return delegate.sendAsync(req, responseBodyHandler)
    }

    override fun <T> sendAsync(
        req: HttpRequest,
        responseBodyHandler: HttpResponse.BodyHandler<T>,
        pushPromiseHandler: HttpResponse.PushPromiseHandler<T>,
    ): CompletableFuture<HttpResponse<T>> {
        guard(req.uri())
        return delegate.sendAsync(req, responseBodyHandler, pushPromiseHandler)
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
        // 2) 防 DNS 重绑定：构造时解析过，建连前再解析一次并复查。
        //    两次解析之间若被重绑到私网，这里兜底拦下。
        val resolved = try {
            InetAddress.getAllByName(uri.host)
        } catch (e: Exception) {
            throw NetworkSecurity.UnreachableTargetException("无法解析目标域名: ${uri.host}（${e.message}）", e)
        }
        for (addr in resolved) {
            val loopback = addr.isLoopbackAddress || (addr.hostAddress?.startsWith("127.") == true)
            // 放开回环时跳过它，但仍要挡私网/链路本地/保留段 —— 口子只开给本机模型，不开给整个内网。
            if (loopback && allowLoopback) continue
            if (addr.isAnyLocalAddress || addr.isLoopbackAddress || addr.isLinkLocalAddress ||
                addr.isSiteLocalAddress || addr.hostAddress == "169.254.169.254" ||
                NetworkSecurity.isSpecialV4(addr) || NetworkSecurity.isSpecialV6(addr)
            ) {
                throw NetworkSecurity.BlockedAddressException("拒绝访问内网或本机地址（DNS 解析结果）")
            }
        }
    }
}
