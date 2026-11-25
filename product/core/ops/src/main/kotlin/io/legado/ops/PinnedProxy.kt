package io.legado.ops

import java.io.BufferedInputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * 连接级 IP 固定的出站代理（P0-2）。
 *
 * 为什么需要它：JDK 17 的 `java.net.http.HttpClient` 没有 DNS 解析钩子，发送时会**再解析一次**
 * 目标域名，于是「解析 → 校验 → 交给 JDK 发送」之间留着一个 DNS TOCTOU 窗口（解析期校验拦不住
 * 重绑定到内网）。本代理是**唯一**建立 TCP 连接的地方：它解析一次、校验这一批地址、然后连
 * **同一个** `InetAddress`。客户端只跟 `127.0.0.1` 建连，不再自己解析目标。
 *
 * 两种模式都必须有（实测见 `docs/research/研究-P0-2-连接级IP固定-spike-2026-11-14.md`）：
 * - `https://`：客户端先发 `CONNECT host:port`，本代理校验后回 200，之后是**盲字节隧道**
 *   —— TLS 握手、证书校验、SNI、ALPN 全在客户端与源站之间完成，代理不看明文。
 * - `http://`：客户端直接发**绝对形式请求行**（`GET http://host/path HTTP/1.1`）。只写 CONNECT
 *   隧道会让所有明文 http 书源 405，所以这里要自己改写请求行再转发。
 *
 * 边界：
 * - 只绑回环，端口由系统分配；绑 `0.0.0.0` 等于给局域网开正向代理。
 * - 隧道不做任何字节改写，也不缓冲整包（SSE / 媒体流必须逐块到达）。
 * - 明文 http 转发每请求一条到源站的连接，响应带 `Connection: close` 后关闭；不复用、不流水线。
 */
internal class PinnedProxy(
    /** 放行回环（本机模型 Ollama / LM Studio 用）。私网、链路本地、保留段照旧拒绝。 */
    private val allowLoopback: Boolean,
    /** 测试注入用：数解析次数、模拟重绑定。默认走系统解析。 */
    private val resolve: (String) -> Array<InetAddress> = { InetAddress.getAllByName(it) },
    /** 测试注入用：默认直连解析出来的地址。 */
    private val connect: (InetAddress, Int) -> Socket = { address, port -> Socket(address, port) },
) : AutoCloseable {

    private val server = ServerSocket(0, BACKLOG, InetAddress.getLoopbackAddress())
    private val closed = AtomicBoolean(false)

    /** 交给 `ProxySelector.of(InetSocketAddress(loopback, port))` 的端口。 */
    val port: Int = server.localPort

    fun start(): PinnedProxy {
        thread(isDaemon = true, name = "pinned-proxy-${if (allowLoopback) "loopback" else "strict"}") {
            while (!closed.get()) {
                val socket = runCatching { server.accept() }.getOrNull() ?: break
                thread(isDaemon = true) { runCatching { handle(socket) } }
            }
        }
        return this
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        runCatching { server.close() }
    }

    private fun handle(client: Socket) = client.use {
        // 只给「读请求头」设超时；隧道建立后必须清掉，否则长时间空闲的 SSE 会被掐断。
        client.soTimeout = HEAD_TIMEOUT_MS
        val input = BufferedInputStream(client.getInputStream())
        val head = readHead(input) ?: return@use
        val requestLine = head.lineSequence().firstOrNull().orEmpty()
        when {
            requestLine.startsWith("CONNECT ") -> tunnel(client, head, requestLine)
            requestLine.endsWith(" HTTP/1.1") || requestLine.endsWith(" HTTP/1.0") ->
                forward(client, input, head, requestLine)
            else -> respondAndClose(client, "400 Bad Request")
        }
    }

    /** `CONNECT host:port`：校验一次 → 连同一个地址 → 回 200 → 双向盲转发。 */
    private fun tunnel(client: Socket, head: String, requestLine: String) {
        val authority = requestLine.removePrefix("CONNECT ").substringBefore(" HTTP/").trim()
        val host = authority.substringBeforeLast(':', authority).trim('[', ']')
        val port = authority.substringAfterLast(':', "").toIntOrNull() ?: 443
        when (val target = resolveTarget(host)) {
            Target.Blocked -> return respondAndClose(client, "403 Forbidden")
            Target.Unreachable -> return respondAndClose(client, "502 Bad Gateway", ERROR_UNREACHABLE)
            is Target.Ready -> {
                val origin = runCatching { connect(target.address, port) }.getOrElse {
                    return respondAndClose(client, "502 Bad Gateway", ERROR_UNREACHABLE)
                }
                origin.use {
                    val out = client.getOutputStream()
                    out.write("HTTP/1.1 200 Connection Established\r\n\r\n".toByteArray())
                    out.flush()
                    client.soTimeout = 0
                    origin.soTimeout = 0
                    val upstream = thread(isDaemon = true) {
                        runCatching { client.getInputStream().copyTo(origin.getOutputStream()) }
                    }
                    runCatching { origin.getInputStream().copyTo(client.getOutputStream()) }
                    runCatching { client.shutdownInput() }
                    upstream.join(TUNNEL_JOIN_MS)
                    runCatching { origin.close() }
                }
            }
        }
    }

    /** 绝对形式请求行：校验一次 → 改写为 origin-form → 转发 → 原样回流响应。 */
    private fun forward(client: Socket, input: InputStream, head: String, requestLine: String) {
        val parts = requestLine.split(' ')
        if (parts.size != 3) return respondAndClose(client, "400 Bad Request")
        val (method, target, version) = parts
        val uri = runCatching { URI(target) }.getOrNull() ?: return respondAndClose(client, "400 Bad Request")
        if (uri.scheme?.lowercase() != "http" || uri.host.isNullOrBlank()) return respondAndClose(client, "400 Bad Request")
        val port = if (uri.port > 0) uri.port else 80
        val address = when (val resolved = resolveTarget(uri.host)) {
            Target.Blocked -> return respondAndClose(client, "403 Forbidden")
            Target.Unreachable -> return respondAndClose(client, "502 Bad Gateway", ERROR_UNREACHABLE)
            is Target.Ready -> resolved.address
        }

        val origin = runCatching { connect(address, port) }.getOrElse {
            return respondAndClose(client, "502 Bad Gateway", ERROR_UNREACHABLE)
        }
        origin.use {
            origin.soTimeout = ORIGIN_TIMEOUT_MS
            val path = buildString {
                append(uri.rawPath?.takeIf { it.isNotEmpty() } ?: "/")
                uri.rawQuery?.let { append('?').append(it) }
            }
            val headers = head.lineSequence().drop(1).filter { it.isNotBlank() }
            val out = origin.getOutputStream()
            out.write("$method $path $version\r\n".toByteArray())
            out.write("Host: ${uri.host}${if (uri.port > 0) ":${uri.port}" else ""}\r\n".toByteArray())
            headers.forEach { line ->
                val name = line.substringBefore(':').trim().lowercase()
                // 逐跳头与 Host 由本代理重写；其余原样带过去（含 Cookie / Authorization / Range）。
                if (name in HOP_BY_HOP) return@forEach
                out.write((line + "\r\n").toByteArray())
            }
            out.write("Connection: close\r\n\r\n".toByteArray())
            out.flush()
            copyRequestBody(input, head, out)
            out.flush()

            val response = BufferedInputStream(origin.getInputStream())
            response.copyTo(client.getOutputStream())
            client.getOutputStream().flush()
        }
    }

    /**
     * 请求体按声明长度转发；`Transfer-Encoding: chunked` 原样透传到结束块。
     * 没有体（绝大多数书源请求）时直接返回。
     */
    private fun copyRequestBody(input: InputStream, head: String, out: java.io.OutputStream) {
        val headers = head.lineSequence().drop(1).map { it.lowercase() }.toList()
        val chunked = headers.any { it.startsWith("transfer-encoding:") && it.contains("chunked") }
        if (chunked) {
            copyChunked(input, out)
            return
        }
        val length = headers.firstOrNull { it.startsWith("content-length:") }
            ?.substringAfter(':')?.trim()?.toLongOrNull() ?: return
        var remaining = length
        val buffer = ByteArray(8192)
        while (remaining > 0) {
            val n = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
            if (n < 0) return
            out.write(buffer, 0, n)
            remaining -= n
        }
    }

    private fun copyChunked(input: InputStream, out: java.io.OutputStream) {
        while (true) {
            val sizeLine = readLine(input) ?: return
            out.write((sizeLine + "\r\n").toByteArray())
            val size = sizeLine.substringBefore(';').trim().toIntOrNull(16) ?: return
            if (size == 0) {
                // 结束块后面可能跟 trailer，读到空行为止
                while (true) {
                    val trailer = readLine(input) ?: break
                    out.write((trailer + "\r\n").toByteArray())
                    if (trailer.isEmpty()) break
                }
                return
            }
            var remaining = size.toLong()
            val buffer = ByteArray(8192)
            while (remaining > 0) {
                val n = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
                if (n < 0) return
                out.write(buffer, 0, n)
                remaining -= n
            }
            readLine(input) // 块尾的 CRLF
            out.write("\r\n".toByteArray())
        }
    }

    /**
     * 解析一次 → 校验 → 给出要连的那个地址。
     *
     * 「被策略拒绝」与「到不了」必须分开：前者是用户填错地址（4xx），后者是网络问题（502 +
     * [ERROR_UNREACHABLE] 标记，由 [GuardedHttpClient] 还原成 `UnreachableTargetException`）。
     * 混成一种会让"域名解析失败"被报成"你的地址非法"。
     */
    private fun resolveTarget(host: String): Target {
        val addresses = runCatching { resolve(host) }.getOrNull() ?: return Target.Unreachable
        if (addresses.isEmpty()) return Target.Unreachable
        val blocked = runCatching { NetworkSecurity.validateResolvedAddresses(addresses, allowLoopback) }.isFailure
        return if (blocked) Target.Blocked else Target.Ready(addresses.first())
    }

    private fun respondAndClose(client: Socket, status: String, marker: String? = null) {
        runCatching {
            val extra = marker?.let { "$ERROR_HEADER: $it\r\n" }.orEmpty()
            client.getOutputStream().write(
                "HTTP/1.1 $status\r\n$extra Connection: close\r\nContent-Length: 0\r\n\r\n".toByteArray()
            )
            client.getOutputStream().flush()
        }
    }

    private fun readHead(input: InputStream): String? {
        val out = StringBuilder()
        while (!out.endsWith("\r\n\r\n")) {
            val b = input.read()
            if (b < 0) return null
            out.append(b.toChar())
            if (out.length > MAX_HEAD_BYTES) return null
        }
        return out.toString()
    }

    private fun readLine(input: InputStream): String? {
        val out = StringBuilder()
        while (!out.endsWith("\r\n")) {
            val b = input.read()
            if (b < 0) return null
            out.append(b.toChar())
            if (out.length > MAX_HEAD_BYTES) return null
        }
        return out.toString().removeSuffix("\r\n")
    }

    internal companion object {
        private const val BACKLOG = 64
        private const val HEAD_TIMEOUT_MS = 15_000
        private const val ORIGIN_TIMEOUT_MS = 60_000
        private const val TUNNEL_JOIN_MS = 5_000L
        private const val MAX_HEAD_BYTES = 64 * 1024

        /** 逐跳头与连接管理头：由代理重写，不能原样带给源站。 */
        private val HOP_BY_HOP = setOf("host", "connection", "proxy-connection", "keep-alive", "te", "trailer", "upgrade")

        /** 代理建连/解析失败时回的响应头；`GuardedHttpClient` 见到它就把响应还原成"到不了"。 */
        const val ERROR_HEADER = "X-Legado-Proxy-Error"
        const val ERROR_UNREACHABLE = "unreachable"
    }

    private sealed interface Target {
        data class Ready(val address: InetAddress) : Target
        data object Blocked : Target
        data object Unreachable : Target
    }
}
