package io.legado

import io.legado.ops.LocalControlClient
import org.junit.Assert.assertThrows
import org.junit.Test
import java.net.URI

/**
 * 本机控制面的回环闸门（阶段 3.5）。
 *
 * 它守的是「内置浏览器只能连本机 DevTools」这条边界：`ExternalBrowserLogin` 的 URL
 * 目前全是 `127.0.0.1` 字面量，但 CDP 的 `webSocketDebuggerUrl` 来自浏览器响应，
 * 一旦以后有人把它接成可配置项，这里就是唯一能拦住 SSRF 的地方。
 */
class LocalControlClientTest {

    @Test
    fun `回环地址与 Chromium 会用的 localhost 都放行`() {
        LocalControlClient.requireLoopback(URI("http://127.0.0.1:9222/json/version"))
        LocalControlClient.requireLoopback(URI("ws://127.0.0.1:9222/devtools/browser/x"))
        LocalControlClient.requireLoopback(URI("ws://localhost:9222/devtools/browser/x"))
        LocalControlClient.requireLoopback(URI("http://[::1]:9222/json/list"))
    }

    @Test
    fun `公网与内网地址都被拒`() {
        for (url in listOf(
            "https://api.github.com/repos/x/y",
            "http://169.254.169.254/latest/meta-data",
            "http://10.0.0.8:9222/json/version",
            "ws://example.com/devtools/browser/x",
        )) {
            assertThrows("应拒绝 $url", IllegalArgumentException::class.java) {
                LocalControlClient.requireLoopback(URI(url))
            }
        }
    }

    @Test
    fun `非 HTTP 协议被拒`() {
        assertThrows(IllegalArgumentException::class.java) {
            LocalControlClient.requireLoopback(URI("file:///etc/passwd"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            LocalControlClient.requireLoopback(URI("ftp://127.0.0.1/x"))
        }
    }
}
