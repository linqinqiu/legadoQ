package io.legado

import com.sun.net.httpserver.HttpServer
import io.legado.http.searchSourceOutcome
import io.legado.ops.NetworkSecurity
import io.legado.rules.RuleRunner
import io.legado.rules.RuleIoCancellation
import java.io.ByteArrayInputStream
import java.net.InetSocketAddress
import java.net.URI
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test

/** 使用本机受控 HTTP；只在测试的客户端显式允许回环，不改书源出站策略。 */
class SearchHttpCancellationTest {
    @Test fun `cancel exits while waiting for HTTP headers`() = exercise(false)
    @Test fun `cancel exits while reading HTTP response body`() = exercise(true)

    @Test fun `response arriving after cancellation is closed before reading`() {
        val resources = RuleIoCancellation.Resources()
        var closed = false
        val stream = object : ByteArrayInputStream(byteArrayOf()) {
            override fun close() { closed = true; super.close() }
        }
        resources.cancel()
        try {
            resources.register(stream)
            fail("取消后不得再注册响应流")
        } catch (_: CancellationException) { }
        assertTrue("迟到的响应体必须关闭", closed)
    }

    private fun exercise(sendHeaders: Boolean) = runBlocking {
        val reached = CountDownLatch(1)
        val release = CountDownLatch(1)
        val exited = CountDownLatch(1)
        val readingBody = CountDownLatch(1)
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/search") { exchange ->
            try {
                if (sendHeaders) {
                    exchange.sendResponseHeaders(200, 0)
                    // 超过受控代理的复制缓冲区，确保客户端已拿到头并进入体读取，
                    // 而不是等代理在上游 EOF 时才 flush 后误测成自然完成。
                    exchange.responseBody.write(("{\"data\":[" + " ".repeat(32 * 1024)).toByteArray())
                    exchange.responseBody.flush()
                }
                reached.countDown()
                release.await(30, TimeUnit.SECONDS)
            } finally { exchange.close() }
        }
        server.start()
        val client = NetworkSecurity.newHttpClient(allowLoopback = true)
        val request = HttpRequest.newBuilder(URI("http://127.0.0.1:${server.address.port}/search"))
            .timeout(Duration.ofSeconds(10)).build()
        val runner = RuleRunner {
            try {
                RuleIoCancellation.useResponseBody(client.send(request, HttpResponse.BodyHandlers.ofInputStream()).body()) {
                    readingBody.countDown()
                    it.readBytes().decodeToString()
                }
            } finally { exited.countDown() }
        }
        val source = """{"bookSourceUrl":"https://src.example","searchUrl":"/search","ruleSearch":{"bookList":"$.data","name":"$.title","bookUrl":"$.url"}}"""
        var cancelled = false
        var outcome: Any? = null
        val job = launch {
            try { outcome = searchSourceOutcome(runner, source, "test", timeoutMs = 60_000) }
            catch (_: CancellationException) { cancelled = true }
        }
        try {
            assertTrue("HTTP 请求应到达本机测试端点", withContext(Dispatchers.IO) { reached.await(5, TimeUnit.SECONDS) })
            if (sendHeaders) assertTrue("应已开始读取响应体", withContext(Dispatchers.IO) { readingBody.await(5, TimeUnit.SECONDS) })
            assertTrue("发送取消时请求应仍在运行，outcome=$outcome", job.isActive)
            job.cancel()
            withTimeout(2_000) { job.join() }
            assertEquals("HTTP 阻塞代码必须已退出", 0L, exited.count)
            assertTrue("调用方取消必须继续传播，outcome=$outcome", cancelled)
        } finally {
            release.countDown()
            job.cancelAndJoin()
            server.stop(0)
        }
    }
}
