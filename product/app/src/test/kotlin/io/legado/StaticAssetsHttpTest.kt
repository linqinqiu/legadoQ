package io.legado

import io.ktor.client.request.get
import io.ktor.client.request.head
import io.ktor.client.request.header
import io.ktor.client.statement.bodyAsBytes
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.nio.file.Files
import java.nio.file.Path
import java.util.zip.GZIPInputStream

/**
 * 烤进 jar 的前端资源的交付契约：`/assets` 下的资源带内容哈希，所以必须**可长期缓存 + 压缩 + 支持 HEAD**；
 * 而 `index.html` 不带哈希，必须**永不缓存**。这两件事在 0.8.6 之前一条都没有：
 * bundle 每次原样传 ~700 KB、响应里没有任何 `Cache-Control`，HEAD 干脆 404。
 *
 * 用例不写死文件名 —— 从 classpath 的 `static/index.html` 现读主 bundle 名。
 * 干净检出（没跑过 `npm run build`）里没这份资源，用 `assumeTrue` 跳过而不是假红。
 */
class StaticAssetsHttpTest {

    private val tempDirs = mutableListOf<Pair<String, Path>>()

    /** 与 `ApiRoutesHttpTest` 同一套起法：临时库 + 临时封面目录，跑完删。 */
    private fun tempConfig(): ServerConfig {
        val dbPath = Files.createTempFile("legado-static", ".sqlite").toString()
        val coverDir = Files.createTempDirectory("legado-static-covers")
        tempDirs += dbPath to coverDir
        return ServerConfig(
            host = "0.0.0.0", port = 8080, databasePath = dbPath, allowExternalBind = true,
            coverCacheDirectory = coverDir
        )
    }

    private fun cleanup() {
        tempDirs.forEach { (db, covers) ->
            runCatching { Files.deleteIfExists(Path.of(db)) }
            runCatching { covers.toFile().deleteRecursively() }
        }
        tempDirs.clear()
    }

    private fun bundledIndexHtml(): String = String(
        StaticAssetsHttpTest::class.java.getResourceAsStream("/static/index.html")?.readBytes() ?: ByteArray(0),
        Charsets.UTF_8
    )

    private fun bundledAssetName(): String =
        Regex("""assets/(index-[A-Za-z0-9_-]+\.js)""").find(bundledIndexHtml())?.groupValues?.get(1) ?: ""

    @Test
    fun `hashed assets are served immutable with an etag`() {
        val asset = bundledAssetName()
        assumeTrue(asset.isNotEmpty())
        try {
            testApplication {
                application { legadoApplication(tempConfig()) }
                val resp = client.get("/assets/$asset")
                assertEquals(HttpStatusCode.OK, resp.status)
                assertEquals("public, max-age=31536000, immutable", resp.headers[HttpHeaders.CacheControl])
                assertTrue("ETag 必须给得出", resp.headers[HttpHeaders.ETag]?.isNotBlank() == true)
                assertEquals(HttpHeaders.AcceptEncoding, resp.headers[HttpHeaders.Vary])
            }
        } finally { cleanup() }
    }

    @Test
    fun `assets gzip when the client accepts it and stay whole after inflate`() {
        val asset = bundledAssetName()
        assumeTrue(asset.isNotEmpty())
        val raw = StaticAssetsHttpTest::class.java.getResourceAsStream("/static/assets/$asset")!!.readBytes()
        assumeTrue(raw.size > 1024)
        try {
            testApplication {
                application { legadoApplication(tempConfig()) }
                val plain = client.get("/assets/$asset")
                assertNotEquals("不带 Accept-Encoding 就不该压", "gzip", plain.headers[HttpHeaders.ContentEncoding])
                assertEquals(raw.size, plain.bodyAsBytes().size)

                val gz = client.get("/assets/$asset") { header(HttpHeaders.AcceptEncoding, "gzip, deflate") }
                assertEquals(HttpStatusCode.OK, gz.status)
                assertEquals("gzip", gz.headers[HttpHeaders.ContentEncoding])
                val gzBytes = gz.bodyAsBytes()
                val inflated = GZIPInputStream(ByteArrayInputStream(gzBytes)).readBytes()
                assertEquals("解压后必须与原字节完全一致", raw.size, inflated.size)
                assertTrue("压缩要真有收益（实测应少一半以上）", gzBytes.size < raw.size / 2)
            }
        } finally { cleanup() }
    }

    @Test
    fun `etag revalidation answers 304 and head is served`() {
        val asset = bundledAssetName()
        assumeTrue(asset.isNotEmpty())
        try {
            testApplication {
                application { legadoApplication(tempConfig()) }
                val etag = client.get("/assets/$asset").headers[HttpHeaders.ETag]
                assertTrue(etag?.isNotBlank() == true)
                assertEquals(
                    HttpStatusCode.NotModified,
                    client.get("/assets/$asset") { header(HttpHeaders.IfNoneMatch, etag!!) }.status
                )
                // HEAD 从前被 staticResources 判 404，外部探活与预取因此全部误判
                val head = client.head("/assets/$asset")
                assertEquals(HttpStatusCode.OK, head.status)
                assertEquals("public, max-age=31536000, immutable", head.headers[HttpHeaders.CacheControl])
            }
        } finally { cleanup() }
    }

    @Test
    fun `index html still never caches and unknown assets do not leak`() {
        try {
            testApplication {
                application { legadoApplication(tempConfig()) }
                val index = client.get("/")
                assertEquals(HttpStatusCode.OK, index.status)
                assertTrue(
                    "入口必须 no-store：否则换了新 bundle 也永远拿不到",
                    index.headers[HttpHeaders.CacheControl]?.contains("no-store") == true
                )
                assertEquals(HttpStatusCode.NotFound, client.get("/assets/index-definitely-not-here.js").status)
                // 穿越尝试：编码过的斜杠不该把请求变成"往上跳一层读文件"
                val traversal = client.get("/assets/..%2Fstatic%2Findex.html")
                assertTrue(
                    "穿越请求必须被拒（实际 ${traversal.status}）",
                    traversal.status == HttpStatusCode.NotFound || traversal.status == HttpStatusCode.BadRequest
                )
            }
        } finally { cleanup() }
    }

    @Test
    fun `healthz reports which frontend build is actually running`() {
        val asset = bundledAssetName()
        assumeTrue(asset.isNotEmpty())
        try {
            testApplication {
                application { legadoApplication(tempConfig()) }
                val body = client.get("/healthz").bodyAsText()
                assertTrue("healthz 要回显包内前端指纹：$body", body.contains("\"ui\":\"$asset\""))
                assertTrue("还要回显进程启动时刻：$body", body.contains("startedAtMs"))
            }
        } finally { cleanup() }
    }
}
