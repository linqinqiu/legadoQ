package io.legado

import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.statement.bodyAsBytes
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.nio.file.Files
import java.nio.file.Path
import java.util.zip.GZIPInputStream

/**
 * 接口 JSON 的压缩契约。
 *
 * 书源清单 5,574 条实测 1,063,255 字节，发现页书源 ~540KB —— 全是重复度极高的对象，
 * 原样传等于每次冷启动都多搬一兆。这里钉住三件事：
 * ① 客户端声明 gzip 时大 JSON 真的被压，且解压后逐字节还原；
 * ② 没声明 Accept-Encoding 时不压（老客户端不该收到看不懂的字节）；
 * ③ 小 JSON 不压（< 1KB 压了只剩几个字节的头，纯亏）。
 */
class ApiCompressionHttpTest {

    private fun tempConfig(): ServerConfig {
        val dbPath = Files.createTempFile("legado-compression", ".sqlite").toString()
        val coverDir = Files.createTempDirectory("legado-compression-covers")
        return ServerConfig(
            host = "0.0.0.0", port = 8080, databasePath = dbPath, allowExternalBind = true,
            coverCacheDirectory = coverDir
        )
    }

    private fun cleanup(config: ServerConfig) {
        runCatching { Files.deleteIfExists(Path.of(config.databasePath)) }
        runCatching { config.coverCacheDirectory.toFile().deleteRecursively() }
    }

    @Test
    fun `large api json gzips when accepted and inflates to the original bytes`() {
        val config = tempConfig()
        try {
            testApplication {
                application { legadoApplication(config) }
                // /api/agent/manifest 是随包的 8.6KB 静态 JSON，不依赖库内容，适合当样本。
                val plain = client.get("/api/agent/manifest")
                assertEquals(HttpStatusCode.OK, plain.status)
                assertNotEquals("不带 Accept-Encoding 就不该压", "gzip", plain.headers[HttpHeaders.ContentEncoding])
                val raw = plain.bodyAsBytes()
                assertTrue("样本要大到会触发压缩：${raw.size} 字节", raw.size > 1024)

                val gz = client.get("/api/agent/manifest") { header(HttpHeaders.AcceptEncoding, "gzip") }
                assertEquals(HttpStatusCode.OK, gz.status)
                assertEquals("gzip", gz.headers[HttpHeaders.ContentEncoding])
                val compressed = gz.bodyAsBytes()
                assertTrue("压缩要真有收益：${compressed.size} / ${raw.size}", compressed.size < raw.size / 2)
                assertArrayEquals(
                    "解压后必须与原响应逐字节一致",
                    raw,
                    GZIPInputStream(ByteArrayInputStream(compressed)).readBytes(),
                )
            }
        } finally { cleanup(config) }
    }

    @Test
    fun `small api json stays uncompressed even when gzip is accepted`() {
        val config = tempConfig()
        try {
            testApplication {
                application { legadoApplication(config) }
                val resp = client.get("/healthz") { header(HttpHeaders.AcceptEncoding, "gzip") }
                assertEquals(HttpStatusCode.OK, resp.status)
                assertNotEquals("104 字节的 healthz 不值得压", "gzip", resp.headers[HttpHeaders.ContentEncoding])
                assertTrue(resp.bodyAsBytes().isNotEmpty())
            }
        } finally { cleanup(config) }
    }
}
