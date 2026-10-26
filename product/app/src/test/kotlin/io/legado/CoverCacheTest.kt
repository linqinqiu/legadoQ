package io.legado

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import io.legado.cache.CoverCache
import io.legado.http.tryCacheCover
import io.legado.http.tryFindCachedCover
import io.legado.model.SearchResult

class CoverCacheTest {
    @Test
    fun `stores a valid image and returns the disk cache on repeat access`() {
        val directory = Files.createTempDirectory("legado-cover-cache")
        var calls = 0
        val cache = CoverCache(directory) { calls++; "image/png" to byteArrayOf(1, 2, 3) }
        val first = cache.cache("https://example.com/a.png")
        val second = cache.cache("https://example.com/a.png")
        assertEquals(first.key, second.key); assertEquals(1, calls); assertTrue(cache.file(first.key) != null)
        cache.delete(first.key); Files.deleteIfExists(directory)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `rejects a non image response`() {
        val directory = Files.createTempDirectory("legado-cover-cache")
        try { CoverCache(directory) { "text/html" to byteArrayOf(1) }.cache("https://example.com/not-image") } finally { Files.deleteIfExists(directory) }
    }

    @Test(expected = IllegalArgumentException::class)
    fun `rejects an svg cover because same-origin svg can carry script`() {
        val directory = Files.createTempDirectory("legado-cover-cache")
        try {
            CoverCache(directory) { "image/svg+xml" to "<svg><script>alert(1)</script></svg>".toByteArray() }
                .cache("https://example.com/evil.svg", referer = "https://book.example")
        } finally { Files.deleteIfExists(directory) }
    }

    @Test
    fun `tryCacheCover falls back to alternate sources when primary cover fails`() {
        val directory = Files.createTempDirectory("legado-cover-cache")
        try {
            val cache = CoverCache(directory) { url ->
                if (url.contains("broken")) throw RuntimeException("404 Not Found")
                "image/jpeg" to byteArrayOf(10, 20, 30)
            }
            val alts = listOf(
                SearchResult("s1", "书名", "作者", "https://s1/book", "https://example.com/broken.jpg"),
                SearchResult("s2", "书名", "作者", "https://s2/book", "https://example.com/valid.jpg")
            )
            val result = tryCacheCover(cache, "https://example.com/primary-broken.jpg", alts, referer = "https://book.example")
            assertTrue(result != null)
            assertEquals("image/jpeg", result!!.contentType)
            assertTrue(cache.file(result.key) != null)
            cache.delete(result.key)
        } finally {
            Files.deleteIfExists(directory)
        }
    }

    @Test
    fun `tryCacheCover returns null when no candidate covers succeed`() {
        val directory = Files.createTempDirectory("legado-cover-cache")
        try {
            val cache = CoverCache(directory) { throw RuntimeException("failed") }
            val alts = listOf(
                SearchResult("s1", "书名", "作者", "https://s1/book", "https://example.com/broken.jpg")
            )
            val result = tryCacheCover(cache, null, alts, referer = null)
            assertTrue(result == null)
        } finally {
            Files.deleteIfExists(directory)
        }
    }

    @Test
    fun `getIfCached returns cached cover if file exists and null if not downloaded`() {
        val directory = Files.createTempDirectory("legado-cover-cache")
        try {
            val cache = CoverCache(directory) { "image/png" to byteArrayOf(1, 2, 3) }
            val url = "https://example.com/cover.png"
            org.junit.Assert.assertNull(cache.getIfCached(url))

            val cached = cache.cache(url)
            val check = cache.getIfCached(url)
            org.junit.Assert.assertNotNull(check)
            assertEquals(cached.key, check!!.key)

            // Test by key directly
            val checkByKey = cache.getIfCached(cached.key)
            org.junit.Assert.assertNotNull(checkByKey)
            assertEquals(cached.key, checkByKey!!.key)
        } finally {
            directory.toFile().deleteRecursively()
        }
    }

    @Test
    fun `tryFindCachedCover returns immediate match if candidate is in cache`() {
        val directory = Files.createTempDirectory("legado-cover-cache")
        try {
            val cache = CoverCache(directory) { "image/jpeg" to byteArrayOf(1, 2) }
            val cached = cache.cache("https://example.com/already-cached.jpg")

            val alts = listOf(
                SearchResult("s1", "书名", "作者", "https://s1/book", "https://example.com/not-cached.jpg"),
                SearchResult("s2", "书名", "作者", "https://s2/book", "https://example.com/already-cached.jpg")
            )
            val found = tryFindCachedCover(cache, "https://example.com/not-cached.jpg", alts)
            org.junit.Assert.assertNotNull(found)
            assertEquals(cached.key, found!!.key)

            val notFound = tryFindCachedCover(cache, "https://example.com/other.jpg", null)
            org.junit.Assert.assertNull(notFound)
        } finally {
            directory.toFile().deleteRecursively()
        }
    }

    /**
     * 「重取这一张」（`refetchContentImage`）。要钉住的是顺序：**先取成功再原子覆盖**，
     * 不是"先删再取" —— 站点这一次也可能不给，删了就把用户手上那张还能看的图也一起弄没了。
     */
    @Test
    fun `refetch replaces the stored copy and still keeps exactly one file per url`() {
        val directory = Files.createTempDirectory("legado-cover-refetch")
        try {
            var version = 0
            val cache = CoverCache(directory) { "image/png" to byteArrayOf(1, 2, (++version).toByte()) }
            val url = "https://img.example/a.png"
            val referer = "https://book.example/ch/1"
            val first = cache.cacheContentImage(url, referer)
            assertEquals(1, version)
            cache.cacheContentImage(url, referer)
            assertEquals("盘上有了就该命中，不再联网", 1, version)

            val refreshed = cache.refetchContentImage(url, referer)
            assertEquals(2, version)
            assertEquals(first.key, refreshed.key)
            org.junit.Assert.assertArrayEquals(byteArrayOf(1, 2, 2), cache.file(refreshed.key)?.let { Files.readAllBytes(it) } ?: ByteArray(0))
            val stored = Files.list(directory).use { it.count() }
            assertEquals("换代次不许让盘上多存一份", 1L, stored)
        } finally {
            directory.toFile().deleteRecursively()
        }
    }

    @Test
    fun `a failed refetch keeps the bytes already on disk`() {
        val directory = Files.createTempDirectory("legado-cover-refetch-fail")
        try {
            var attempt = 0
            val cache = CoverCache(directory) {
                attempt++
                if (attempt == 1) "image/png" to byteArrayOf(9, 9) else throw java.io.IOException("上游这次不给")
            }
            val url = "https://img.example/b.png"
            val stored = cache.cacheContentImage(url, null)
            try {
                cache.refetchContentImage(url, null)
                org.junit.Assert.fail("第二次取失败应当抛出来，界面要把这句原因显示给用户")
            } catch (expected: java.io.IOException) {
                // 抛得出来，但旧字节必须还在
            }
            org.junit.Assert.assertArrayEquals(byteArrayOf(9, 9), cache.file(stored.key)?.let { Files.readAllBytes(it) } ?: ByteArray(0))
        } finally {
            directory.toFile().deleteRecursively()
        }
    }

    @Test
    fun `refetch still refuses svg`() {
        val directory = Files.createTempDirectory("legado-cover-refetch-svg")
        try {
            val cache = CoverCache(directory) { "image/svg+xml" to "<svg><script>alert(1)</script></svg>".toByteArray() }
            try {
                cache.refetchContentImage("https://img.example/evil.svg", "https://book.example/ch/1")
                org.junit.Assert.fail("同源 SVG 能带脚本，重取这条路也不许放行")
            } catch (expected: IllegalArgumentException) {
                assertTrue("拒绝原因要说清是 SVG：${expected.message}", expected.message!!.lowercase().contains("svg"))
            }
        } finally {
            directory.toFile().deleteRecursively()
        }
    }
}

