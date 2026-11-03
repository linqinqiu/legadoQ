package io.legado

import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

/**
 * ① 新增的 GET /api/diagnostics 端点在 HTTP 层的验证 —— 之前只单测了 Metrics 本体，
 * 路由没在真实装配下打过。GET 属安全方法（同源门直接放行），用仓库成熟的 testApplication 相对路径模式。
 */
class DiagnosticsEndpointTest {

    @Test
    fun `diagnostics 端点回 200 且带指标快照的键`() = testApplication {
        val dir = Files.createTempDirectory("legado-diagnostics")
        val cfg = ServerConfig(
            host = "127.0.0.1", port = 8080,
            databasePath = Files.createTempFile("legado-diagnostics", ".sqlite").toString(),
            coverCacheDirectory = dir,
        )
        try {
            application { legadoApplication(cfg) }
            val client = createClient {
                install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
            }
            val resp = client.get("/api/diagnostics")
            assertEquals(HttpStatusCode.OK, resp.status)
            val body = resp.bodyAsText()
            assertTrue("应含整批请求计数键：$body", body.contains("\"searchRequests\""))
            assertTrue("应含按源指标数组键：$body", body.contains("\"topSources\""))
        } finally {
            runCatching { dir.toFile().deleteRecursively() }
        }
    }
}
