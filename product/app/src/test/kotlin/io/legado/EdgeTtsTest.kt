package io.legado

import io.ktor.client.call.*
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.client.plugins.cookies.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.nio.charset.StandardCharsets
import java.io.ByteArrayOutputStream
import java.net.http.HttpClient
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap
import io.legado.model.TtsSessionChunkRequest
import io.legado.model.TtsSessionInfo
import io.legado.model.TtsSpeakRequest
import io.legado.model.TtsVoice
import io.legado.tts.EdgeTtsService

class EdgeTtsTest {

    @Test
    fun `edge tts service lists default voices correctly`() {
        val service = EdgeTtsService()
        val voices = service.listVoices()
        assertTrue(voices.isNotEmpty())
        assertTrue(voices.any { it.id == "zh-CN-XiaoxiaoNeural" })
        assertTrue(voices.any { it.id == "zh-CN-YunxiNeural" })
        assertTrue(voices.any { it.lang == "zh-CN" })
        assertTrue(voices.any { it.lang == "zh-HK" })
        assertTrue(voices.any { it.lang == "en-US" })
    }

    @Test
    fun `edge tts empty text returns empty byte array`() {
        val service = EdgeTtsService()
        val res = service.synthesize("   ")
        assertEquals(0, res.size)
    }

    @Test
    fun `custom mp3 stream forwards response chunks and rejects other content types`() {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val audio = "fake-mp3-stream".toByteArray(StandardCharsets.UTF_8)
        server.createContext("/mp3") { exchange ->
            exchange.responseHeaders.add("Content-Type", "audio/mpeg; charset=binary")
            exchange.sendResponseHeaders(200, audio.size.toLong())
            exchange.responseBody.use { it.write(audio) }
        }
        server.createContext("/wav") { exchange ->
            exchange.responseHeaders.add("Content-Type", "audio/wav")
            exchange.sendResponseHeaders(200, audio.size.toLong())
            exchange.responseBody.use { it.write(audio) }
        }
        server.start()
        try {
            val service = EdgeTtsService(customClient = HttpClient.newHttpClient())
            val request = TtsSessionChunkRequest(
                chunkId = "chunk-1",
                text = "测试自定义流",
                engine = "custom",
                customUrl = "http://127.0.0.1:${server.address.port}/mp3?text={{speakText}}",
            )
            val received = ByteArrayOutputStream()
            val contentType = service.synthesizeCustomStream(request) { received.write(it) }
            assertEquals("audio/mpeg", contentType)
            assertArrayEquals(audio, received.toByteArray())

            val invalidRequest = request.copy(customUrl = "http://127.0.0.1:${server.address.port}/wav")
            try {
                service.synthesizeCustomStream(invalidRequest) { }
                fail("non-MP3 custom TTS should be rejected")
            } catch (error: IllegalArgumentException) {
                assertTrue(error.message!!.contains("audio/mpeg"))
            }
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun `custom tts forwards configured headers and drops smuggling attempts`() {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val seen = ConcurrentHashMap<String, String>()
        val audio = "header-ok".toByteArray(StandardCharsets.UTF_8)
        server.createContext("/tts") { exchange ->
            seen["authorization"] = exchange.requestHeaders.getFirst("Authorization") ?: ""
            seen["x-bad"] = exchange.requestHeaders.getFirst("X-Bad") ?: ""
            seen["x-injected"] = exchange.requestHeaders.getFirst("X-Injected") ?: ""
            if (seen["authorization"] != "Bearer test-key") {
                exchange.sendResponseHeaders(401, 0)
                exchange.close()
                return@createContext
            }
            exchange.responseHeaders.add("Content-Type", "audio/mpeg")
            exchange.sendResponseHeaders(200, audio.size.toLong())
            exchange.responseBody.use { it.write(audio) }
        }
        server.start()
        try {
            val service = EdgeTtsService(customClient = HttpClient.newHttpClient())
            val request = TtsSessionChunkRequest(
                chunkId = "chunk-header",
                text = "测试请求头",
                engine = "custom",
                customUrl = "http://127.0.0.1:${server.address.port}/tts",
                customHeader = """{"Authorization":"Bearer test-key","X-Bad":"a\r\nX-Injected: 1","Host":"evil.example"}""",
            )
            val received = ByteArrayOutputStream()
            val contentType = service.synthesizeCustomStream(request) { received.write(it) }
            assertEquals("audio/mpeg", contentType)
            assertArrayEquals(audio, received.toByteArray())
            assertEquals("Bearer test-key", seen["authorization"])
            assertEquals("", seen["x-bad"])
            assertEquals("", seen["x-injected"])
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun `sec ms gec token generation produces v2 cs64-sha256 format`() {
        // 2026-11 起服务端只认 v2：16 位 CS64 + '-' + 64 位 SHA256。
        val token = EdgeTtsService.generateSecMsGec()
        assertEquals(81, token.length)
        assertTrue("v2 格式不对：$token", token.matches(Regex("^[0-9A-F]{16}-[0-9A-F]{64}$")))
    }

    @Test
    fun `tts routes provide voice list and reject empty speak requests`() = testApplication {
        val dbPath = Files.createTempFile("legado-tts-test", ".sqlite").toString()
        val tempDir = Files.createTempDirectory("legado-tts-covers")
        try {
            val config = ServerConfig(
                host = "0.0.0.0", port = 8080, databasePath = dbPath, allowExternalBind = true,
                coverCacheDirectory = tempDir
            )
            application {
                legadoApplication(config)
                monitor.subscribe(io.ktor.server.application.ApplicationStopped) {
                    runCatching { Files.deleteIfExists(Path.of(dbPath)) }
                    runCatching { tempDir.toFile().deleteRecursively() }
                }
            }
            val client = createClient {
                install(HttpCookies)
                install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
            }

            // Unauthenticated should fail
            // 不设身份：这个端点直接可用，没有 401 也没有登录这一步

            // List voices
            val voicesResp = client.get("/api/tts/voices")
            assertEquals(HttpStatusCode.OK, voicesResp.status)
            val voices = voicesResp.body<List<TtsVoice>>()
            assertTrue(voices.any { it.id == "zh-CN-XiaoxiaoNeural" })

            // Empty text POST speak should return 400
            val emptyResp = client.post("/api/tts/speak") {
                contentType(ContentType.Application.Json)
                setBody(TtsSpeakRequest(text = "   "))
            }
            assertEquals(HttpStatusCode.BadRequest, emptyResp.status)

            // Empty text GET speak should return 400
            val emptyGetResp = client.get("/api/tts/speak?text=")
            assertEquals(HttpStatusCode.BadRequest, emptyGetResp.status)

            val createSessionResp = client.post("/api/tts/session") {
                contentType(ContentType.Application.Json)
                setBody("{}")
            }
            assertEquals(HttpStatusCode.OK, createSessionResp.status)
            val sessionInfo = createSessionResp.body<TtsSessionInfo>()
            assertTrue(sessionInfo.sessionId.isNotBlank())
            assertTrue(sessionInfo.audioUrl.endsWith("/audio"))

            val invalidChunkResp = client.post(sessionInfo.audioUrl.replace("/audio", "/chunks")) {
                contentType(ContentType.Application.Json)
                setBody(TtsSessionChunkRequest(chunkId = "invalid", text = "   "))
            }
            assertEquals(HttpStatusCode.BadRequest, invalidChunkResp.status)

            val stopResp = client.delete("/api/tts/session/${sessionInfo.sessionId}") {
            }
            assertEquals(HttpStatusCode.NoContent, stopResp.status)
        } finally {
            runCatching { Files.deleteIfExists(Path.of(dbPath)) }
            runCatching { tempDir.toFile().deleteRecursively() }
        }
    }

    @Test
    fun `speak route serves custom tts audio and blocks metadata targets`() = testApplication {
        // 路由层判据：前面的单测只到 EdgeTtsService，这里是真正从 HTTP 入口进来的那一层——
        // JSON 解析、engine 分支、附加头转发、Content-Type 透传、地址策略拒绝，全都要成立。
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val audio = "route-layer-mp3-payload".toByteArray(StandardCharsets.UTF_8)
        val seen = ConcurrentHashMap<String, String>()
        server.createContext("/tts") { exchange ->
            seen["authorization"] = exchange.requestHeaders.getFirst("Authorization") ?: ""
            seen["query"] = exchange.requestURI.rawQuery ?: ""
            if (seen["authorization"] != "Bearer route-key") {
                exchange.sendResponseHeaders(401, 0)
                exchange.close()
                return@createContext
            }
            exchange.responseHeaders.add("Content-Type", "audio/mpeg; charset=binary")
            exchange.sendResponseHeaders(200, audio.size.toLong())
            exchange.responseBody.use { it.write(audio) }
        }
        server.createContext("/unauthorized") { exchange ->
            val body = """{"error":"bad key"}""".toByteArray(StandardCharsets.UTF_8)
            exchange.responseHeaders.add("Content-Type", "application/json")
            exchange.sendResponseHeaders(401, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        server.start()

        val dbPath = Files.createTempFile("legado-tts-route", ".sqlite").toString()
        val tempDir = Files.createTempDirectory("legado-tts-route-covers")
        try {
            val config = ServerConfig(
                host = "0.0.0.0", port = 8080, databasePath = dbPath, allowExternalBind = true,
                coverCacheDirectory = tempDir
            )
            application {
                legadoApplication(config)
                monitor.subscribe(io.ktor.server.application.ApplicationStopped) {
                    runCatching { Files.deleteIfExists(Path.of(dbPath)) }
                    runCatching { tempDir.toFile().deleteRecursively() }
                }
            }
            val client = createClient {
                install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
            }

            val resp = client.post("/api/tts/speak") {
                contentType(ContentType.Application.Json)
                setBody(
                    TtsSpeakRequest(
                        text = "路由层冒烟",
                        engine = "custom",
                        customUrl = "http://127.0.0.1:${server.address.port}/tts?text={{speakText}}",
                        customHeader = """{"Authorization":"Bearer route-key"}""",
                    )
                )
            }
            assertEquals(HttpStatusCode.OK, resp.status)
            assertTrue(
                "路由应把上游 Content-Type 原样带回，实际 ${resp.headers[HttpHeaders.ContentType]}",
                resp.headers[HttpHeaders.ContentType]?.startsWith("audio/mpeg") == true,
            )
            assertArrayEquals(audio, resp.body<ByteArray>())
            assertEquals("Bearer route-key", seen["authorization"])
            assertTrue("{{speakText}} 未被替换，实际 query=${seen["query"]}", seen["query"]?.contains("text=") == true)
            assertFalse("原文不应原样出现在 query 中", seen["query"]!!.contains("路由层冒烟"))

            // 同一个入口再打一次元数据地址：必须在发请求之前拒掉，按输入错误报 400 而不是 500。
            val blocked = client.post("/api/tts/speak") {
                contentType(ContentType.Application.Json)
                setBody(
                    TtsSpeakRequest(
                        text = "元数据探测",
                        engine = "custom",
                        customUrl = "http://169.254.169.254/latest/meta-data",
                    )
                )
            }
            assertEquals(HttpStatusCode.BadRequest, blocked.status)
            val blockedBody = blocked.bodyAsText()
            assertTrue("应带明确拒绝原因，实际 $blockedBody", blockedBody.contains("拒绝访问"))
            assertTrue("错误码应为 tts_invalid_request，实际 $blockedBody", blockedBody.contains("tts_invalid_request"))

            // 上游自己失败（401）时不能再 200 把 JSON 当音频返回，走网关错误语义。
            val upstream = client.post("/api/tts/speak") {
                contentType(ContentType.Application.Json)
                setBody(
                    TtsSpeakRequest(
                        text = "上游鉴权失败",
                        engine = "custom",
                        customUrl = "http://127.0.0.1:${server.address.port}/unauthorized",
                    )
                )
            }
            assertEquals(HttpStatusCode.BadGateway, upstream.status)
            val upstreamBody = upstream.bodyAsText()
            assertTrue("应带上游状态码，实际 $upstreamBody", upstreamBody.contains("HTTP 401"))
        } finally {
            server.stop(0)
            runCatching { Files.deleteIfExists(Path.of(dbPath)) }
            runCatching { tempDir.toFile().deleteRecursively() }
        }
    }

    @Test
    fun `custom tts reports upstream errors and caps response size while reading`() {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val json = """{"error":"bad key"}""".toByteArray(StandardCharsets.UTF_8)
        server.createContext("/unauthorized") { exchange ->
            exchange.responseHeaders.add("Content-Type", "application/json")
            exchange.sendResponseHeaders(401, json.size.toLong())
            exchange.responseBody.use { it.write(json) }
        }
        server.createContext("/huge") { exchange ->
            exchange.responseHeaders.add("Content-Type", "audio/mpeg")
            exchange.sendResponseHeaders(200, 9L * 1024 * 1024)
            val chunk = ByteArray(64 * 1024)
            try {
                exchange.responseBody.use { body -> repeat(9 * 16) { body.write(chunk) } }
            } catch (_: java.io.IOException) {
                // 客户端读满上限后主动断开，服务端写失败是预期结果
            }
        }
        server.start()
        try {
            val service = EdgeTtsService(customClient = HttpClient.newHttpClient())

            val unauthorized = runCatching {
                service.synthesizeCustom(
                    TtsSpeakRequest(
                        text = "鉴权失败",
                        engine = "custom",
                        customUrl = "http://127.0.0.1:${server.address.port}/unauthorized",
                    )
                )
            }.exceptionOrNull()
            assertTrue("401 应报错而不是当音频返回，实际 $unauthorized", unauthorized is IllegalStateException)
            assertTrue(unauthorized?.message?.contains("HTTP 401") == true)

            val oversized = runCatching {
                service.synthesizeCustom(
                    TtsSpeakRequest(
                        text = "超大响应",
                        engine = "custom",
                        customUrl = "http://127.0.0.1:${server.address.port}/huge",
                    )
                )
            }.exceptionOrNull()
            assertTrue("超过 8MB 应被拒，实际 $oversized", oversized is IllegalArgumentException)
            assertTrue(oversized?.message?.contains("上限") == true)
        } finally {
            server.stop(0)
        }
    }
}
