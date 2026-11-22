package io.legado

import io.legado.ops.NetworkSecurity
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URI
import java.net.http.WebSocket
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

/**
 * 受控 client 的 WebSocket 闸门（阶段 3.5）。
 *
 * 只钉"拒绝路径"：真正建立 wss 需要外网，不能进 CI；这里证明
 * - 明文 ws 在发请求前就被明确拒绝；
 * - wss 指向回环/链路本地时同样过不了地址判定。
 */
class GuardedHttpClientWebSocketTest {

    private val listener = object : WebSocket.Listener {}

    private fun buildAsync(url: String): ExecutionException {
        val client = NetworkSecurity.newHttpClient()
        return assertThrows(ExecutionException::class.java) {
            client.newWebSocketBuilder()
                .buildAsync(URI(url), listener)
                .get(5, TimeUnit.SECONDS)
        }
    }

    @Test
    fun `明文 ws 被明确拒绝而不是让握手自然失败`() {
        val error = buildAsync("ws://example.com/socket")
        assertTrue("应抛 IllegalArgumentException：${error.cause}", error.cause is IllegalArgumentException)
        assertTrue(
            "错误里要说明只支持 wss：${error.cause?.message}",
            error.cause?.message.orEmpty().contains("wss"),
        )
    }

    @Test
    fun `wss 指向回环时被地址闸门拒绝`() {
        val error = buildAsync("wss://127.0.0.1:1/socket")
        assertTrue(
            "应抛 BlockedAddressException：${error.cause}",
            error.cause is NetworkSecurity.BlockedAddressException,
        )
    }

    @Test
    fun `wss 指向云元数据地址时被地址闸门拒绝`() {
        val error = buildAsync("wss://169.254.169.254/latest/meta-data")
        assertTrue(
            "应抛 BlockedAddressException：${error.cause}",
            error.cause is NetworkSecurity.BlockedAddressException,
        )
    }
}
