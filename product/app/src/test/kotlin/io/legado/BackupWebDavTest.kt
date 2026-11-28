package io.legado

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import io.legado.backup.BackupWebDav
import io.legado.model.BackupWebDavRequest
import io.legado.ops.NetworkSecurity
import java.net.InetSocketAddress
import java.net.http.HttpClient
import java.nio.file.Files
import java.security.MessageDigest
import java.time.Duration
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import org.junit.Assert.*
import org.junit.Test

internal class WebDavFixture : AutoCloseable {
    val files = ConcurrentHashMap<String, ByteArray>()
    val methods = CopyOnWriteArrayList<String>()
    @Volatile var handlerOverride: ((HttpExchange) -> Boolean)? = null
    private val executor = Executors.newCachedThreadPool { task -> Thread(task, "webdav-test").apply { isDaemon = true } }
    private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
        this.executor = this@WebDavFixture.executor
        createContext("/") { exchange ->
            exchange.use { call ->
                methods += call.requestMethod
                if (handlerOverride?.invoke(call) == true) return@use
                val basic = Base64.getEncoder().encodeToString("fixture:secret".toByteArray())
                if (call.requestHeaders.getFirst("Authorization") != "Basic $basic") {
                    reply(call, 401, "private-server-message".toByteArray()); return@use
                }
                val name = call.requestURI.path.removePrefix("/dav/")
                when (call.requestMethod) {
                    "PROPFIND" -> {
                        check(call.requestHeaders.getFirst("Depth") == "1")
                        val items = files.entries.joinToString("") { (file, bytes) -> entry("/dav/$file", bytes.size) }
                        reply(call, 207, "<d:multistatus xmlns:d=\"DAV:\">$items</d:multistatus>".toByteArray())
                    }
                    "PUT" -> {
                        check(call.requestHeaders.getFirst("If-None-Match") == "*")
                        val bytes = call.requestBody.readBytes()
                        val prior = files.putIfAbsent(name, bytes)
                        call.sendResponseHeaders(if (prior == null) 201 else 412, -1)
                    }
                    "GET" -> files[name]?.let { reply(call, 200, it) } ?: call.sendResponseHeaders(404, -1)
                    else -> call.sendResponseHeaders(405, -1)
                }
            }
        }
        start()
    }
    val url get() = "http://127.0.0.1:${server.address.port}/dav/"
    fun request(name: String? = null) = BackupWebDavRequest(url, "fixture", "secret", name)
    fun service(limit: Long = 64L * 1024 * 1024, timeout: Duration = Duration.ofSeconds(3)) = BackupWebDav(
        NetworkSecurity.newHttpClient(allowLoopback = true), allowHttpForTest = true, maxBytes = limit, bodyTimeout = timeout)
    override fun close() { server.stop(0); executor.shutdownNow() }
    companion object {
        fun reply(call: HttpExchange, code: Int, bytes: ByteArray) {
            call.sendResponseHeaders(code, bytes.size.toLong())
            call.responseBody.use { it.write(bytes) }
        }
        fun entry(href: String, size: Int, status: String = " HTTP/1.1 200 OK ") =
            "<d:response><d:href>$href</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>$size</d:getcontentlength></d:prop><d:status>$status</d:status></d:propstat></d:response>"
        fun name(bytes: ByteArray) = "legadoq-migration-20261127-120000-${"a".repeat(32)}-${digest(bytes)}.zip"
        fun digest(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }
}

class BackupWebDavTest {
    private fun failure(code: String, action: () -> Unit) {
        try { action(); fail("expected $code") } catch (error: BackupWebDav.Failure) {
            assertEquals(code, error.code)
            assertFalse(error.message.contains("secret"))
            assertFalse(error.message.contains("private-server-message"))
        }
    }

    @Test fun `真实 PUT 回读再列出拉取 字节不变且上传用唯一名称`() = WebDavFixture().use { dav ->
        val file = Files.createTempFile("webdav-input", ".zip")
        val output = Files.createTempFile("webdav-output", ".zip")
        try {
            val bytes = "synthetic snapshot".toByteArray()
            Files.write(file, bytes)
            val service = dav.service()
            val upload = service.upload(dav.request(), file)
            assertTrue(upload.verified)
            assertEquals(WebDavFixture.digest(bytes), upload.sha256)
            assertEquals(bytes.size.toLong(), upload.bytes)
            assertEquals(listOf("PUT", "GET"), dav.methods.toList())
            assertEquals(listOf(upload.name), service.list(dav.request()).map { it.name })
            service.download(dav.request(upload.name), output)
            assertArrayEquals(bytes, Files.readAllBytes(output))
            assertNotEquals(upload.name, service.upload(dav.request(), file).name)
            assertEquals(2, dav.files.size)
        } finally { Files.deleteIfExists(file); Files.deleteIfExists(output) }
    }

    @Test fun `上传拒绝覆盖且未校验的文件不报告成功`() = WebDavFixture().use { dav ->
        val file = Files.createTempFile("webdav-input", ".zip")
        try {
            Files.writeString(file, "original")
            dav.handlerOverride = { call -> WebDavFixture.reply(call, 412, "exists".toByteArray()); true }
            failure("webdav_exists") { dav.service().upload(dav.request(), file) }
            assertEquals(listOf("PUT"), dav.methods.toList())
            dav.handlerOverride = { call ->
                if (call.requestMethod == "GET") { WebDavFixture.reply(call, 200, "corrupt".toByteArray()); true } else false
            }
            failure("webdav_verify_failed") { dav.service().upload(dav.request(), file) }
            assertEquals(1, dav.files.size) // uncertain remote file is preserved for user inspection
        } finally { Files.deleteIfExists(file) }
    }

    @Test fun `列表只接受成功的同目录本产品文件 不信任远端 href`() = WebDavFixture().use { dav ->
        val name = WebDavFixture.name("good".toByteArray())
        dav.handlerOverride = { call ->
            val items = listOf(
                WebDavFixture.entry("/dav/$name", 4), WebDavFixture.entry("/dav/$name", 4),
                WebDavFixture.entry("https://evil.example/dav/$name", 4),
                WebDavFixture.entry("/dav/sub/$name", 4), WebDavFixture.entry("/other/$name", 4),
                WebDavFixture.entry("/dav/not-a-migration.zip", 4),
                WebDavFixture.entry("/dav/${name.replace("120000", "120001")}", 4, "HTTP/1.1 404 Not Found"),
                WebDavFixture.entry("/dav/${name.replace("120000", "120002")}", 999),
            ).joinToString("")
            WebDavFixture.reply(call, 207, "<d:multistatus xmlns:d=\"DAV:\">$items</d:multistatus>".toByteArray()); true
        }
        val listed = dav.service(limit = 100).list(dav.request())
        assertEquals(listOf(name), listed.map { it.name })
        assertEquals(4L, listed.single().bytes)
        assertEquals(listOf("PROPFIND"), dav.methods.toList())
    }

    @Test fun `拒绝畸形XML与外部实体 不请求外部资源`() = WebDavFixture().use { dav ->
        for (xml in listOf("<broken", """<!DOCTYPE x [<!ENTITY leak SYSTEM "${dav.url}secret">]><d:multistatus xmlns:d="DAV:">&leak;</d:multistatus>""")) {
            dav.handlerOverride = { call -> WebDavFixture.reply(call, 207, xml.toByteArray()); true }
            failure("webdav_listing_invalid") { dav.service().list(dav.request()) }
        }
        assertEquals(listOf("PROPFIND", "PROPFIND"), dav.methods.toList())
    }

    @Test fun `错误密码权限目录及重定向都有稳定错误 不跟随转发凭据`() = WebDavFixture().use { dav ->
        failure("webdav_denied") { dav.service().list(dav.request().copy(password = "wrong")) }
        for ((status, code) in listOf(403 to "webdav_denied", 404 to "webdav_directory_missing", 500 to "webdav_response", 302 to "webdav_redirect")) {
            val before = dav.methods.size
            dav.handlerOverride = { call ->
                call.responseHeaders.set("Location", "${dav.url}credential-sink")
                WebDavFixture.reply(call, status, "private-server-message".toByteArray()); true
            }
            failure(code) { dav.service().list(dav.request()) }
            assertEquals(before + 1, dav.methods.size)
        }
    }

    @Test fun `拉取拒绝路径穿越错误哈希及实际流超限`() = WebDavFixture().use { dav ->
        val file = Files.createTempFile("webdav-output", ".zip")
        try {
            failure("invalid_webdav_name") { dav.service().download(dav.request("../other.zip"), file) }
            assertTrue(dav.methods.isEmpty())
            val name = WebDavFixture.name("good".toByteArray())
            dav.files[name] = "bad".toByteArray()
            failure("webdav_verify_failed") { dav.service().download(dav.request(name), file) }
            dav.files[name] = ByteArray(101)
            failure("webdav_too_large") { dav.service(limit = 100).download(dav.request(name), file) }
            dav.handlerOverride = { call -> WebDavFixture.reply(call, 207, ByteArray(2 * 1024 * 1024 + 1)); true }
            failure("webdav_too_large") { dav.service().list(dav.request()) }
        } finally { Files.deleteIfExists(file) }
    }

    @Test fun `生产禁止HTTP私网及混入URL的凭据 不放宽网络工厂`() {
        val service = BackupWebDav()
        for (url in listOf("http://public.example/dav/", "https://user:secret@public.example/dav/", "https://public.example/dav/?q=secret", "https://public.example/dav/#secret", "https://public.example/../", "https://public.example/%2e%2e/", "https://public.example/a%2fb/")) {
            failure("invalid_webdav") { service.list(BackupWebDavRequest(url)) }
        }
        for (url in listOf("https://127.0.0.1/dav/", "https://10.1.2.3/dav/")) {
            failure("webdav_blocked") { service.list(BackupWebDavRequest(url)) }
        }
        failure("invalid_webdav") { service.list(BackupWebDavRequest("https://public.example/", "bad:user", "secret")) }
        try {
            BackupWebDav(HttpClient.newBuilder().followRedirects(HttpClient.Redirect.ALWAYS).build())
            fail("redirecting clients must be rejected")
        } catch (_: IllegalArgumentException) { }
    }

    @Test fun `响应头已到但正文停滞仍按截止退出`() = WebDavFixture().use { dav ->
        val release = CountDownLatch(1)
        dav.handlerOverride = { call -> call.sendResponseHeaders(207, 0); call.responseBody.flush(); release.await(); true }
        try {
            val start = System.nanoTime()
            failure("webdav_timeout") { dav.service(timeout = Duration.ofMillis(150)).list(dav.request()) }
            assertTrue(Duration.ofNanos(System.nanoTime() - start).seconds < 3)
        } finally { release.countDown() }
    }
}
