package io.legado.ops

import io.legado.port.LocalControl
import java.net.URI
import java.net.http.HttpClient
import java.time.Duration

/**
 * 本机控制面的 HTTP 客户端：只给「和本机上的另一个进程说话」用（当前唯一使用者是
 * `source/ExternalBrowserLogin` 连 Chromium 的 DevTools 端口）。
 *
 * 为什么单独开一个签发点，而不是塞进 [NetworkSecurity.newHttpClient]：
 * - 那条路会把请求交给 `PinnedProxy` 再出站，而这里的目标恒为 `127.0.0.1`，代理一跳
 *   没有任何安全收益，反而给「双击没反应 / 浏览器附着不上」这类启动路径加一个故障点；
 * - DevTools 还要用 WebSocket（CDP），`GuardedHttpClient` 的代理链路对 `Upgrade` 的
 *   行为没有验证过，不能拿登录主路径去赌。
 *
 * 但「只连本机」必须是**代码判据**，不能只写在注释里：所有 URL 在发出前都要过
 * [requireLoopback]，以后有人把参数接进来，也不会把这里变成第二个 SSRF 门。
 */
object LocalControlClient : LocalControl {

    /** 只认字面回环。`localhost` 保留是因为 Chromium 的 `webSocketDebuggerUrl` 会用它。 */
    private val LOOPBACK_HOSTS = setOf("127.0.0.1", "::1", "[::1]", "localhost")
    private val ALLOWED_SCHEMES = setOf("http", "https", "ws", "wss")

    override fun newClient(
        connectTimeout: Duration,
        followRedirects: HttpClient.Redirect,
    ): HttpClient = HttpClient.newBuilder()
        .connectTimeout(connectTimeout)
        .followRedirects(followRedirects)
        .build()

    /**
     * 本机控制面的 URL 闸门：协议必须是 HTTP(S)/WS(S)，主机必须是回环。
     *
     * @throws IllegalArgumentException 目标不是本机 —— 这是编程错误，不是网络错误
     */
    override fun requireLoopback(uri: URI) {
        val scheme = uri.scheme?.lowercase()
        require(scheme != null && scheme in ALLOWED_SCHEMES) {
            "本机控制面只允许 HTTP(S)/WS(S) 地址：$uri"
        }
        val host = uri.host?.lowercase()
        require(host != null && host in LOOPBACK_HOSTS) {
            "本机控制面只允许回环地址，拒绝 ${host ?: "(无主机)"}"
        }
    }
}
