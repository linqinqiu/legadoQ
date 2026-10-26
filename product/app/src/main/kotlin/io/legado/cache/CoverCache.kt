package io.legado.cache

import io.ktor.http.*
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.time.Duration
import java.util.zip.GZIPInputStream
import java.util.zip.InflaterInputStream
import io.legado.data.Database
import io.legado.data.forgetCover
import io.legado.data.generatedLocalCoverKeys
import io.legado.http.NetworkSecurity
import io.legado.http.proxyRequestHeaders

data class CachedCover(val key: String, val contentType: String)

/**
 * @param cookieFor 这台机器上某个地址该带的 Cookie（按注册域取，与文本链路同一个 `Database.getCookieForUrl`）。
 *
 * 为什么必须有它：浏览器自己发 `<img>` / `<audio>` / `<video>` 时**带不上自定义请求头**，
 * 所以这些资源一律由服务端代取。以前代取只补了 Referer，不补 Cookie，
 * 于是"书源登录成功、目录正文都读得出，图和音频流一打开还是 403" —— 登录白做。
 * 每一跳都按**那一跳的落地地址**重新取：跳去别的域名时不能把原域的凭据捎过去。
 */
class CoverCache(
    private val directory: Path,
    private val cookieFor: (String) -> String? = { null },
    /** 只有测试注入（生产为 null）；**必须留在最后一个参数位** —— 测试用的是尾随 lambda，
     *  换到前面就会把 `{ "image/png" to bytes }` 绑给 `cookieFor`，五个既有用例一起编译不过。 */
    private val fetcher: ((String) -> Pair<String, ByteArray>)? = null,
) {
    private val client = io.legado.http.NetworkSecurity.newHttpClient(connectTimeout = Duration.ofSeconds(10), followRedirects = HttpClient.Redirect.NEVER)

    init { Files.createDirectories(directory) }

    /**
     * 书架那条路用的封面抓取。`referer` 传这本书的**书源地址**：
     * 搜索页与发现页走 `/covers/proxy` 早就带 Referer 了，书架这条不带，
     * 于是同一张封面在搜索结果里出得来、加进书架就变灰块（防盗链站按来源判）。
     */
    fun cache(url: String, referer: String? = null): CachedCover {
        val key = sha256(url)
        val stored = directory.resolve(key)
        if (Files.exists(stored)) return CachedCover(key, "image/*")
        val (contentType, body) = fetcher?.invoke(url) ?: download(url, referer)
        val type = contentType.substringBefore(';').trim().lowercase()
        require(type.startsWith("image/")) { "封面不是图片" }
        // 与正文配图同一条规矩：同源 SVG 里可以带脚本，存下来再同源发出去就是给自己开个执行面。
        require(type != "image/svg+xml") { "封面不许是 SVG" }
        require(body.size <= MAX_BYTES) { "封面超过 5 MiB 限制" }
        writeAtomic(key, body)
        return CachedCover(key, type)
    }

    fun getIfCached(url: String): CachedCover? {
        if (url.isBlank()) return null
        val key = if (url.matches(Regex("[0-9a-f]{64}"))) url else sha256(url)
        val stored = directory.resolve(key)
        return if (Files.exists(stored)) CachedCover(key, "image/*") else null
    }

    fun file(key: String): Path? = key.takeIf { it.matches(Regex("[0-9a-f]{64}")) }?.let(directory::resolve)?.takeIf(Files::exists)

    /**
     * 一次性回收我们替本地书生成的假封面（`LocalBookParser` 里那段彩色 SVG 已经删掉）。
     * 判据只认自家写死的那个天蓝角标色 `#38bdf8`，所以 EPUB 内嵌的真 SVG 封面不会被误删；
     * 文件读不到或不含该签名的，一律原样留着。
     */
    fun purgeGeneratedLocalCovers(database: Database): Int {
        var purged = 0
        database.generatedLocalCoverKeys().forEach { key ->
            val stored = file(key) ?: return@forEach
            val generated = runCatching { String(Files.readAllBytes(stored), Charsets.UTF_8) }
                .getOrDefault("").contains("#38bdf8")
            if (!generated) return@forEach
            Files.deleteIfExists(stored)
            database.forgetCover(key)
            purged++
        }
        return purged
    }

    /**
     * 正文配图：与封面共用一套落盘缓存，但两条约束不同 ——
     * ① 必须带 Referer（图站普遍防盗链，直连拿回来是 403 占位图）；
     * ② 拒 `image/svg+xml`：代理后与主应用同源，SVG 里可以带脚本，等于给自己开个 XSS 执行面。
     */
    fun cacheContentImage(url: String, referer: String?): CachedCover {
        val key = sha256(url)
        val stored = directory.resolve(key)
        if (Files.exists(stored)) return CachedCover(key, sniffContentType(stored))
        return fetchAndStore(url, referer, key, MAX_CONTENT_BYTES)
    }

    /**
     * 「重取这一张」：绕开盘上那份重新取一次。顺序是**先取成功再原子覆盖**，不是"先删再取" ——
     * 站点这一次也可能不给，删了就把用户手上那张还能凑合看的图也弄没了。
     * 浏览器那两份副本（HTTP 7 天 `max-age` 与 SW 的 `legado-covers`）由取图地址上的代次参数绕开，
     * 见 `web/src/reader/readerImage.ts`。
     */
    fun refetchContentImage(url: String, referer: String?): CachedCover =
        fetchAndStore(url, referer, sha256(url), MAX_CONTENT_BYTES)

    private fun fetchAndStore(url: String, referer: String?, key: String, limit: Int): CachedCover {
        val stored = directory.resolve(key)
        // `fetcher` 只在测试里注入（生产为 null）；正文图片也走它，单元测试才能不联网地钉住"图被缓存了"。
        val (rawType, body) = fetcher?.invoke(url) ?: download(url, referer, limit)
        val type = rawType.substringBefore(';').trim().lowercase()
        require(type.startsWith("image/") && type != "image/svg+xml") { "正文图片类型不被允许：${type.ifBlank { "未知" }}" }
        require(body.size <= limit) { "正文图片超过 ${limit / 1024 / 1024} MiB 限制" }
        writeAtomic(key, body)
        return CachedCover(key, sniffContentType(stored))
    }

    /** 缓存命中时没有响应头可依据，按文件头判类型；判不出按最通用的 png 给，浏览器仍会嗅探。 */
    private fun sniffContentType(path: Path): String = runCatching {
        val head = ByteArray(16)
        Files.newInputStream(path).use { input -> input.read(head) }
        fun marker(offset: Int, vararg signature: Int) = signature.indices.all { head[offset + it] == signature[it].toByte() }
        when {
            marker(0, 0x89, 0x50, 0x4E, 0x47) -> "image/png"
            marker(0, 0xFF, 0xD8, 0xFF) -> "image/jpeg"
            marker(0, 0x47, 0x49, 0x46) -> "image/gif"
            marker(0, 0x52, 0x49, 0x46, 0x46) && marker(8, 0x57, 0x45, 0x42, 0x50) -> "image/webp"
            else -> "image/png"
        }
    }.getOrDefault("image/png")

    fun delete(key: String) { file(key)?.let(Files::deleteIfExists) }

    fun saveCoverBytes(bytes: ByteArray, contentType: String = "image/jpeg"): String {
        require(bytes.size <= MAX_BYTES) { "封面超过 5 MiB 限制" }
        val key = sha256Bytes(bytes)
        val stored = directory.resolve(key)
        if (!Files.exists(stored)) {
            Files.write(stored, bytes)
        }
        return key
    }

    private fun download(url: String, referer: String? = null, limit: Int = MAX_BYTES): Pair<String, ByteArray> {
        var uri = URI(url); validate(uri)
        repeat(4) {
            val builder = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(20)).GET()
            proxyRequestHeaders(uri, referer, cookieFor).forEach { (name, value) -> builder.header(name, value) }
            val response = client.send(builder.build(), HttpResponse.BodyHandlers.ofInputStream())
            if (response.statusCode() in 300..399) {
                response.body().close()
                uri = uri.resolve(response.headers().firstValue("location").orElseThrow { IllegalArgumentException("封面重定向缺少地址") }); validate(uri); return@repeat
            }
            require(response.statusCode() in 200..299) { "封面上游返回 HTTP ${response.statusCode()}" }
            val body = response.body().use { readBounded(it, limit) }
            return response.headers().firstValue("content-type").orElse("") to decode(response.headers().firstValue("content-encoding").orElse(""), body)
        }
        throw IllegalArgumentException("封面重定向次数超过限制")
    }

    /**
     * 边读边限：恶意上游可以回一个巨大的响应体 —— 原来用 ofByteArray 整包读进内存
     * 之后才检查 5 MiB 上限，等于先挨打后验伤。超限在读的过程中就抛。
     */
    private fun readBounded(stream: InputStream, limit: Int): ByteArray {
        val buffer = ByteArrayOutputStream()
        val chunk = ByteArray(16 * 1024)
        var total = 0
        while (true) {
            val n = stream.read(chunk)
            if (n < 0) break
            total += n
            require(total <= limit) { "图片超过 ${limit / 1024 / 1024} MiB 限制" }
            buffer.write(chunk, 0, n)
        }
        return buffer.toByteArray()
    }

    /** 落盘原子化：并发首取同一封面时不会互相覆盖出半截文件（读到一半的图会被当合法缓存）。 */
    private fun writeAtomic(key: String, body: ByteArray) {
        val target = directory.resolve(key)
        val tmp = directory.resolve("$key.tmp-${System.nanoTime()}")
        try {
            Files.write(tmp, body)
            try { Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE) }
            catch (_: java.nio.file.AtomicMoveNotSupportedException) { Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING) }
        } finally {
            Files.deleteIfExists(tmp)
        }
    }

    /**
     * 有些站点（如 shukuge.com）不管客户端有没有请求都回 `Content-Encoding: gzip`，
     * 直接落盘会把 gzip 字节当成 image/jpeg 存下来，浏览器显示为破图。
     */
    private fun decode(contentEncoding: String, bytes: ByteArray): ByteArray {
        val encoding = contentEncoding.lowercase()
        return when {
            encoding.contains("gzip") -> runCatching { GZIPInputStream(bytes.inputStream()).use { it.readAllBytes() } }.getOrDefault(bytes)
            encoding.contains("deflate") -> runCatching { InflaterInputStream(bytes.inputStream()).use { it.readAllBytes() } }.getOrDefault(bytes)
            else -> bytes
        }
    }

    private fun validate(uri: URI) {
        NetworkSecurity.resolveAndValidateSafeHttpTarget(uri, "封面")
    }
    private fun sha256(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
    private fun sha256Bytes(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private companion object {
        const val MAX_BYTES = 5 * 1024 * 1024
        /** 正文配图（尤其漫画长图）比封面大得多：5 MiB 会把正常页直接拒掉。 */
        const val MAX_CONTENT_BYTES = 20 * 1024 * 1024
    }
}
