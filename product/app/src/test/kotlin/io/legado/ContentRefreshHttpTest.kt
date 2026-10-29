package io.legado

import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.testing.testApplication
import io.legado.http.refreshChapterBatch
import io.legado.model.ChapterContent
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicInteger

/**
 * 手动刷新正文（批量 content-refresh）的规则。
 *
 * 「真的回源」不好在测试里造：书源抓取要过 SSRF 闸门，回环地址一律被拒。所以把调度那段
 * 抽成 [refreshChapterBatch]，用假 fetch 直接验去重/上限/失败隔离/超大正文；HTTP 层只验入参校验。
 * 单章 force 回源由手工验收覆盖（测试服务器 + 真书源）。
 */
class ContentRefreshHttpTest {

    @Test
    fun `batch helper dedupes, caps and keeps failures per chapter`() = runBlocking {
        val stored = mutableMapOf<String, String>()
        val outcome = refreshChapterBatch(
            chapterUrls = listOf("a", "", "a", "b", "c", "d"),
            maxChapters = 3,
            fetch = { url -> if (url == "b") throw IllegalStateException("站点 500") else ChapterContent(content = "正文-$url") },
            store = { url, content -> stored[url] = content.content },
        )
        assertEquals("同一章只刷新一次", setOf("a", "c"), outcome.refreshed.toSet())
        assertEquals(listOf("b"), outcome.failed.map { it.chapterUrl })
        assertEquals("站点 500", outcome.failed.single().message)
        assertEquals("超出的章节交给前端另开一批", 1, outcome.remaining)
        assertEquals("失败章节不该写缓存", setOf("a", "c"), stored.keys)
        assertEquals("正文-a", stored["a"])
    }

    @Test
    fun `oversized content is reported instead of overwriting the cache`() = runBlocking {
        val stored = mutableListOf<String>()
        val outcome = refreshChapterBatch(
            chapterUrls = listOf("big", "ok"),
            maxBytes = 1024,
            fetch = { url ->
                ChapterContent(content = if (url == "big") "x".repeat(1025) else "正常正文")
            },
            store = { url, _ -> stored += url },
        )
        assertEquals(listOf("big"), outcome.failed.map { it.chapterUrl })
        assertTrue(outcome.failed.single().message.contains("未覆盖缓存"))
        assertEquals(listOf("ok"), stored)
    }

    @Test
    fun `refresh keeps concurrency bounded`() = runBlocking {
        val inFlight = AtomicInteger(0)
        val peak = AtomicInteger(0)
        val outcome = refreshChapterBatch(
            chapterUrls = (1..12).map { "c$it" },
            concurrency = 3,
            fetch = { url ->
                val now = inFlight.incrementAndGet()
                peak.accumulateAndGet(now) { a, b -> maxOf(a, b) }
                delay(20)
                inFlight.decrementAndGet()
                ChapterContent(content = url)
            },
            store = { _, _ -> },
        )
        assertTrue("同时在飞的请求不能超过 3，实测 ${peak.get()}", peak.get() <= 3)
        assertEquals(12, outcome.refreshed.size)
    }

    @Test
    fun `batch refresh endpoint validates input`() = testApplication {
        val dbPath = Files.createTempFile("legado-content-refresh", ".sqlite").toString()
        val tempDir = Files.createTempDirectory("legado-content-refresh-covers")
        try {
            val config = ServerConfig(
                host = "0.0.0.0", port = 8080, databasePath = dbPath, allowExternalBind = true,
                coverCacheDirectory = tempDir,
            )
            application { legadoApplication(config) }
            val client = createClient {
                install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
            }

            // 少章节列表 → 400
            val empty = client.post("/api/books/content-refresh") {
                contentType(ContentType.Application.Json)
                setBody("""{"sourceId":"https://src.example","bookUrl":"https://src.example/b/1","chapterUrls":[]}""")
            }
            assertEquals(HttpStatusCode.BadRequest, empty.status)

            // 本地书没有可回源的正文 → 400
            val local = client.post("/api/books/content-refresh") {
                contentType(ContentType.Application.Json)
                setBody("""{"sourceId":"loc_book","bookUrl":"local://a","chapterUrls":["local://a/1"]}""")
            }
            assertEquals(HttpStatusCode.BadRequest, local.status)

            // 不存在的书源 → 404
            val missing = client.post("/api/books/content-refresh") {
                contentType(ContentType.Application.Json)
                setBody("""{"sourceId":"https://nope.example","bookUrl":"x","chapterUrls":["y"]}""")
            }
            assertEquals(HttpStatusCode.NotFound, missing.status)
        } finally {
            runCatching { Files.deleteIfExists(Path.of(dbPath)) }
            runCatching { tempDir.toFile().deleteRecursively() }
        }
    }
}
