package io.legado

import com.sun.net.httpserver.HttpServer
import io.legado.ops.NetworkSecurity
import io.legado.ops.PinnedProxy
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * P0-2：连接级 IP 固定的本地代理（[PinnedProxy]）。
 *
 * 判据都是**负向优先**：该拒的必须拒；隧道必须逐块透传；明文 http 必须被正确改写转发
 * （只写 CONNECT 会让所有明文 http 书源 405，这是 spike 实测出来的）。
 */
class PinnedProxyTest {

    private val closables = mutableListOf<AutoCloseable>()

    @After
    fun tearDown() {
        closables.reversed().forEach { runCatching { it.close() } }
        closables.clear()
    }

    @Test
    fun `CONNECT 隧道字节透传 分块写入逐块到达`() {
        val origin = echoServer()
        val proxy = pinnedProxy(allowLoopback = true).also { closables += it }
        Socket(InetAddress.getLoopbackAddress(), proxy.port).use { client ->
            client.soTimeout = 5_000
            val out = client.getOutputStream()
            out.write("CONNECT 127.0.0.1:${origin.localPort} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".toByteArray())
            out.flush()
            assertTrue(readHead(client).startsWith("HTTP/1.1 200"))
            listOf("data: 一\n\n", "data: 二\n\n").forEach { chunk ->
                out.write(chunk.toByteArray())
                out.flush()
                assertEquals("分块必须立刻到达，不能被攒包", chunk, String(readExactly(client, chunk.toByteArray().size)))
            }
        }
    }

    @Test
    fun `解析只发生一次 且连的是校验过的那个地址`() {
        val origin = echoServer()
        val resolutions = AtomicInteger()
        val proxy = PinnedProxy(
            allowLoopback = true,
            resolve = { _ -> resolutions.incrementAndGet(); arrayOf(InetAddress.getLoopbackAddress()) },
        ).start().also { closables += it }
        Socket(InetAddress.getLoopbackAddress(), proxy.port).use { client ->
            client.soTimeout = 5_000
            client.getOutputStream().write(
                "CONNECT rebind.example:${origin.localPort} HTTP/1.1\r\nHost: rebind.example\r\n\r\n".toByteArray()
            )
            client.getOutputStream().flush()
            assertTrue(readHead(client).startsWith("HTTP/1.1 200"))
        }
        assertEquals("一次 CONNECT 只解析一次", 1, resolutions.get())
    }

    @Test
    fun `CONNECT 指向私网直接 403 且不建连`() {
        var connects = 0
        val proxy = PinnedProxy(
            allowLoopback = false,
            resolve = { _ -> arrayOf(InetAddress.getByName("10.1.2.3")) },
            connect = { _, _ -> connects++; error("不该建连") },
        ).start().also { closables += it }
        Socket(InetAddress.getLoopbackAddress(), proxy.port).use { client ->
            client.soTimeout = 5_000
            client.getOutputStream().write("CONNECT rebind.example:80 HTTP/1.1\r\n\r\n".toByteArray())
            client.getOutputStream().flush()
            val head = readHead(client)
            assertTrue("私网目标必须 403，实际：$head", head.startsWith("HTTP/1.1 403"))
        }
        assertEquals("被拒时不许有任何建连尝试", 0, connects)
    }

    @Test
    fun `明文 http 的绝对形式请求被改写并转发`() {
        val origin = httpOrigin { exchange ->
            val body = "path=${exchange.requestURI.path} query=${exchange.requestURI.query}".toByteArray()
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        val proxy = pinnedProxy(allowLoopback = true).also { closables += it }
        Socket(InetAddress.getLoopbackAddress(), proxy.port).use { client ->
            client.soTimeout = 5_000
            client.getOutputStream().write(
                ("GET http://127.0.0.1:${origin.address.port}/ok?a=1 HTTP/1.1\r\n" +
                    "Host: 127.0.0.1:${origin.address.port}\r\n\r\n").toByteArray()
            )
            client.getOutputStream().flush()
            val response = readAll(client)
            assertTrue("必须是 200：$response", response.contains("200"))
            assertTrue("请求行要改写成 origin-form 且带查询串：$response", response.contains("path=/ok query=a=1"))
        }
    }

    @Test
    fun `明文 http 的请求体按长度转发`() {
        val origin = httpOrigin { exchange ->
            val body = exchange.requestBody.readBytes()
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        val proxy = pinnedProxy(allowLoopback = true).also { closables += it }
        val payload = """{"jsonrpc":"2.0","method":"ping"}"""
        Socket(InetAddress.getLoopbackAddress(), proxy.port).use { client ->
            client.soTimeout = 5_000
            client.getOutputStream().write(
                ("POST http://127.0.0.1:${origin.address.port}/rpc HTTP/1.1\r\n" +
                    "Host: 127.0.0.1:${origin.address.port}\r\n" +
                    "Content-Type: application/json\r\n" +
                    "Content-Length: ${payload.toByteArray().size}\r\n\r\n" + payload).toByteArray()
            )
            client.getOutputStream().flush()
            val response = readAll(client)
            assertTrue("响应体必须原样回来：$response", response.endsWith(payload))
        }
    }

    @Test
    fun `真实客户端经代理访问本机服务`() {
        val origin = httpOrigin { exchange ->
            val body = "proxied".toByteArray()
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        val client = NetworkSecurity.newHttpClient(allowLoopback = true, connectTimeout = Duration.ofSeconds(5))
        val response = client.send(
            HttpRequest.newBuilder(URI.create("http://127.0.0.1:${origin.address.port}/hello"))
                .timeout(Duration.ofSeconds(10)).GET().build(),
            HttpResponse.BodyHandlers.ofString(),
        )
        assertEquals(200, response.statusCode())
        assertEquals("proxied", response.body())
    }

    @Test
    fun `真实客户端访问私网地址仍被解析期闸门拒绝`() {
        val client = NetworkSecurity.newHttpClient(allowLoopback = true, connectTimeout = Duration.ofSeconds(2))
        val failure = runCatching {
            client.send(
                HttpRequest.newBuilder(URI.create("http://10.1.2.3:80/")).timeout(Duration.ofSeconds(2)).GET().build(),
                HttpResponse.BodyHandlers.ofString(),
            )
        }
        assertTrue("私网地址必须被拒", failure.isFailure)
    }

    @Test
    fun `建连失败还原成到不了 不是 502 响应`() {
        // 先占一个端口再释放，保证这个端口上没人监听。
        val port = ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { it.localPort }
        val client = NetworkSecurity.newHttpClient(allowLoopback = true, connectTimeout = Duration.ofSeconds(2))
        val failure = runCatching {
            client.send(
                HttpRequest.newBuilder(URI.create("http://127.0.0.1:$port/down")).timeout(Duration.ofSeconds(5)).GET().build(),
                HttpResponse.BodyHandlers.ofString(),
            )
        }
        val error = failure.exceptionOrNull()
        assertTrue("必须是「到不了」那一类，实际：$error", error is NetworkSecurity.UnreachableTargetException)
        assertTrue("要能看出连的是哪儿：${error?.message}", error?.message.orEmpty().contains("127.0.0.1:$port"))
    }

    // ---- helpers ----

    private fun pinnedProxy(allowLoopback: Boolean): PinnedProxy =
        PinnedProxy(allowLoopback = allowLoopback).start()

    private fun echoServer(): ServerSocket {
        val server = ServerSocket(0, 16, InetAddress.getLoopbackAddress())
        closables += AutoCloseable { runCatching { server.close() } }
        thread(isDaemon = true) {
            runCatching {
                while (!server.isClosed) {
                    val socket = server.accept()
                    thread(isDaemon = true) {
                        socket.use {
                            val buffer = ByteArray(512)
                            while (true) {
                                val n = it.getInputStream().read(buffer)
                                if (n < 0) break
                                it.getOutputStream().write(buffer, 0, n)
                                it.getOutputStream().flush()
                            }
                        }
                    }
                }
            }
        }
        return server
    }

    private fun httpOrigin(handler: (com.sun.net.httpserver.HttpExchange) -> Unit): HttpServer {
        val server = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0)
        server.createContext("/") { exchange -> runCatching { handler(exchange) } }
        server.executor = java.util.concurrent.Executors.newCachedThreadPool { runnable ->
            Thread(runnable).apply { isDaemon = true }
        }
        server.start()
        closables += AutoCloseable { server.stop(0) }
        return server
    }

    private fun readHead(client: Socket): String {
        val out = StringBuilder()
        val input = client.getInputStream()
        while (!out.endsWith("\r\n\r\n")) {
            val b = input.read()
            if (b < 0) break
            out.append(b.toChar())
        }
        return out.toString()
    }

    private fun readExactly(client: Socket, size: Int): ByteArray {
        val buffer = ByteArray(size)
        var read = 0
        val input = client.getInputStream()
        while (read < size) {
            val n = input.read(buffer, read, size - read)
            if (n < 0) break
            read += n
        }
        return buffer.copyOf(read)
    }

    private fun readAll(client: Socket): String {
        val bytes = client.getInputStream().readBytes()
        return String(bytes, Charsets.UTF_8)
    }
}
