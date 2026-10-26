package io.legado.http

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.http.content.LocalFileContent
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import io.legado.cache.CoverCache
import io.legado.data.Database
import io.legado.data.coverContentType
import io.legado.data.getCookieForUrl
import io.legado.model.ApiError
import io.legado.model.RefreshedImage
import io.legado.ops.LogService
import io.legado.ops.logNetwork
import java.net.URI
import java.nio.file.Path
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * 从 `Routes.kt` 拆出（0.8.2 结构重排）：封面与正文图片代理、本地书内嵌资源、音视频流式代理。
 * 处理器文本逐字未动；本函数由 `Routes.kt` 的 `apiRoutes` 挂在 `route("/api")` 内，顺序与拆前一致。
 * 契约核对：`web/test/ApiCatalog.test.ts` 把本目录全部 `*Routes.kt` 视为挂在 `/api` 之下逐条比对。
 */
fun Route.mediaRoutes(
    database: Database,
    coverCache: CoverCache,
    localBooksDirectory: Path,
) {
        get("/covers/{key}") {
            val key = call.parameters["key"] ?: return@get call.respond(HttpStatusCode.NotFound)
            val file = coverCache.file(key) ?: return@get call.respond(HttpStatusCode.NotFound)
            // 只把 SVG 这一种降级：同源发 SVG 等于给自己开一个脚本执行面。
            // `CoverCache.cache()` 现在也拒收它，这条管的是已经躺在盘上的历史文件。
            val stored = database.coverContentType(key)?.lowercase()?.substringBefore(';')
            val type = if (stored == "image/svg+xml") ContentType.Application.OctetStream
            else stored?.let { ContentType.parse(it) } ?: ContentType.Application.OctetStream
            call.response.cacheControl(CacheControl.MaxAge(maxAgeSeconds = 7 * 24 * 60 * 60, visibility = CacheControl.Visibility.Private))
            call.respond(LocalFileContent(file.toFile(), type))
        }
        /**
         * 封面代理（0.6.22）：搜索/发现/详情的封面原来直指外域 URL，浏览器经常取不到
         * （本机系统代理、防盗链、http 混掺）—— 书架早就是 `/covers/{key}` 这条路，所以只有书架正常
         * （用户 2026-10-09：手机端 00小说网封面全显示、legadoQ 的却不行）。本路由按需在服务端抓取、
         * 校验、落盘缓存，浏览器只加载同源地址；7 天内再命中直接出盘。
         * 闸门全是现成的（`CoverCache.cacheContentImage`）：SSRF 校验（只许公网 http/https）、
         * 只收图片类型且拒 SVG（同源 SVG 可带脚本）、5 MiB 上限、gzip 解码；Referer 带着原页地址走完整个
         * 重定向链（图站常是"主域 → 图片 CDN"两跳，中途收掉会把能出图的站打回 403），
         * Cookie 则按每一跳的落地域名现取 —— 见 `proxyRequestHeaders`。
         */
        get("/covers/proxy") {
            val url = call.request.queryParameters["url"].orEmpty()
            if (!url.startsWith("http://", ignoreCase = true) && !url.startsWith("https://", ignoreCase = true)) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_image", "封面地址无效")); return@get
            }
            // 防盗链图站按 Referer 判来源：调用方把书源地址（sourceId）带上来
            val referer = call.request.queryParameters["referer"]?.takeIf { it.startsWith("http", ignoreCase = true) }
            try {
                val cached = coverCache.cacheContentImage(url, referer)
                val file = coverCache.file(cached.key) ?: return@get call.respond(HttpStatusCode.NotFound)
                call.response.cacheControl(CacheControl.MaxAge(maxAgeSeconds = 7 * 24 * 60 * 60, visibility = CacheControl.Visibility.Private))
                call.response.header("X-Content-Type-Options", "nosniff")
                call.respond(LocalFileContent(file.toFile(), ContentType.parse(cached.contentType)))
            } catch (error: Exception) {
                // 一张封面取不到不是事故：走 LogService 留一行警告，接口回 502 让前端退化成占位书封
                Unit.logNetwork(
                    "封面代理取图失败",
                    mapOf(
                        "host" to (runCatching { java.net.URI(url.trim()).host }.getOrNull() ?: "未知"),
                        "原因" to (error.message ?: error.javaClass.simpleName),
                        "url" to url.take(120),
                    ),
                )
                call.respond(HttpStatusCode.BadGateway, ApiError("image_failed", error.message ?: "封面抓取失败"))
            }
        }
        /**
         * 本地 EPUB 的内嵌插图（用户 2026-10-02：本地阅读器要「支持图片」）。
         *
         * 包里的图不会自己出现在网上，只能从原始文件里按 zip entry 取字节。三条边界写死在这里：
         * ① `bookId` 必须是导入时生成的那串十六进制 —— 它同时是磁盘上的文件名，
         *    放开形状等于"用文件名读盘上任意文件"；
         * ② entry 路径拒绝 `..`，且只接受包里真实存在、归一化后完全相等的那个名字（不做前缀匹配）；
         * ③ 只回真正的图片（按魔数判，扩展名只作兜底），svg 一律不回 —— 同源 SVG 能带脚本。
         */
        get("/books/local/asset") {
            val bookId = call.request.queryParameters["bookId"].orEmpty()
            val wanted = call.request.queryParameters["path"].orEmpty().replace('\\', '/').trimStart('/')
            if (!LOCAL_BOOK_ID.matches(bookId) || wanted.isBlank() || wanted.contains("..")) {
                return@get call.respond(HttpStatusCode.NotFound)
            }
            val archive = runCatching {
                localBooksDirectory.toFile().listFiles()?.firstOrNull {
                    it.isFile && it.name.startsWith("$bookId.") && it.name.endsWith(".epub", ignoreCase = true)
                }
            }.getOrNull() ?: return@get call.respond(HttpStatusCode.NotFound)
            val asset = runCatching {
                java.util.zip.ZipFile(archive).use { zip ->
                    val entry = zip.entries().asSequence().firstOrNull { candidate ->
                        !candidate.isDirectory &&
                            candidate.name.replace('\\', '/').removePrefix("./") == wanted
                    } ?: return@use null
                    if (entry.size > 5L * 1024 * 1024 || entry.size < 0) return@use null
                    val bytes = zip.getInputStream(entry).readBytes()
                    localAssetType(wanted, bytes)?.let { Triple(bytes, it, entry.time) }
                }
            }.getOrNull() ?: return@get call.respond(HttpStatusCode.NotFound)
            call.response.cacheControl(CacheControl.MaxAge(maxAgeSeconds = 30 * 24 * 60 * 60, visibility = CacheControl.Visibility.Private))
            call.response.header("X-Content-Type-Options", "nosniff")
            call.respondBytes(asset.first, ContentType.parse(asset.second))
        }
        get("/book/image") {
            val url = call.request.queryParameters["url"].orEmpty()
            if (!url.startsWith("http://", ignoreCase = true) && !url.startsWith("https://", ignoreCase = true)) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_image", "图片地址无效")); return@get
            }
            // `page` 是图片所在的那一页，拿来当 Referer —— 图站按防盗链判来源，不带就回 403 占位图。
            val referer = call.request.queryParameters["page"]?.takeIf { it.startsWith("http", ignoreCase = true) }
            try {
                val cached = coverCache.cacheContentImage(url, referer)
                val file = coverCache.file(cached.key) ?: return@get call.respond(HttpStatusCode.NotFound)
                call.response.cacheControl(CacheControl.MaxAge(maxAgeSeconds = 7 * 24 * 60 * 60, visibility = CacheControl.Visibility.Private))
                call.respond(LocalFileContent(file.toFile(), ContentType.parse(cached.contentType)))
            } catch (error: Exception) {
                // 走 LogService，不走 Ktor 的 debug 档：图挂了就只在控制台留一行 debug，
                // 「运行日志」里什么都没有 —— 与这一轮修掉的"收集了却看不见"是同一个病。
                // 级别是警告不是错误：一张图取不到，阅读器会退化成占位图，不算事故。
                Unit.logNetwork(
                    "正文图片代理失败",
                    mapOf(
                        "host" to (runCatching { java.net.URI(url.trim()).host }.getOrNull() ?: "未知"),
                        "原因" to (error.message ?: error.javaClass.simpleName),
                        "url" to url.take(120),
                    ),
                )
                call.respond(HttpStatusCode.BadGateway, ApiError("image_failed", error.message ?: "图片抓取失败"))
            }
        }
        /**
         * 「重取这一张」：绕开服务端盘上那份，重新向上游走一次并原子覆盖。
         *
         * 为什么要有这条：站点用**同一个 URL** 换图（改了封面、把占位图换成真图、图被重新上传）时，
         * 我们那份按 `sha256(url)` 落盘的副本**永不过期**，界面上没有任何动作能救 —— 用户只能看着那张错的图。
         * 光删盘还不够：浏览器那两份副本（这条 GET 给的 7 天 `max-age`，以及 SW 里 `legado-covers` 那条
         * SWR 30 天）会先拿旧的，所以前端在地址上带一个代次参数绕开它们（`web/src/reader/readerImage.ts`）。
         * 写操作，照例过同源闸门。
         */
        post("/book/image/refresh") {
            if (!call.requireSameOriginWrite()) return@post
            val url = call.request.queryParameters["url"].orEmpty()
            if (!url.startsWith("http://", ignoreCase = true) && !url.startsWith("https://", ignoreCase = true)) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_image", "图片地址无效")); return@post
            }
            val referer = call.request.queryParameters["page"]?.takeIf { it.startsWith("http", ignoreCase = true) }
            try {
                val cached = coverCache.refetchContentImage(url, referer)
                call.respond(RefreshedImage(cached.key, cached.contentType))
            } catch (error: Exception) {
                Unit.logNetwork(
                    "重取正文图片失败",
                    mapOf(
                        "host" to (runCatching { java.net.URI(url.trim()).host }.getOrNull() ?: "未知"),
                        "原因" to (error.message ?: error.javaClass.simpleName),
                        "url" to url.take(120),
                    ),
                )
                call.respond(HttpStatusCode.BadGateway, ApiError("image_failed", error.message ?: "图片抓取失败"))
            }
        }
        /**
         * 媒体流式代理（音频/视频/EPUB 直链）：浏览器原生 `<audio>/<video>` 无法自定义请求头，
         * 带不上 Referer 也带不上 Cookie，遇到防盗链或要登录的源就 403 播不了；且需要 Range 支持才能拖动进度、才能被浏览器接受为可播放媒体。
         * 这里由服务端代取并流式回传：注入 Referer 与该域已登录的 Cookie、原样转发/回传 Range。媒体文件可能很大，
         * 不落盘缓存（与 5MiB 上限的封面缓存不同），只在传输途中于内存里中转。
         */
        get("/book/media") {
            val url = call.request.queryParameters["url"].orEmpty()
            if (!url.startsWith("http://", ignoreCase = true) && !url.startsWith("https://", ignoreCase = true)) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_media", "媒体地址无效")); return@get
            }
            // `referer` 用这一章的地址：媒体站按防盗链判来源，不带就回 403。
            val referer = call.request.queryParameters["referer"]?.takeIf { it.startsWith("http", ignoreCase = true) }
            val range = call.request.headers["Range"]
            withContext(Dispatchers.IO) {
                try {
                    val media = fetchMediaStream(url, referer, range) { database.getCookieForUrl(it) }
                    val status = when {
                        range != null && media.statusCode == 206 -> HttpStatusCode.PartialContent
                        else -> HttpStatusCode.OK
                    }
                    call.response.headers.apply {
                        append("Accept-Ranges", "bytes")
                        append("Cache-Control", "private, max-age=300")
                        media.contentType?.let { append("Content-Type", it) }
                        media.contentLength?.let { append("Content-Length", it) }
                        media.contentRange?.let { append("Content-Range", it) }
                    }
                    call.respondOutputStream(status = status) {
                        media.stream.use { input -> input.copyTo(this) }
                    }
                } catch (error: Exception) {
                    Unit.logNetwork(
                        "媒体代理失败",
                        mapOf(
                            "host" to (runCatching { java.net.URI(url.trim()).host }.getOrNull() ?: "未知"),
                            "原因" to (error.message ?: error.javaClass.simpleName),
                            "url" to url.take(120),
                        ),
                    )
                    call.respond(HttpStatusCode.BadGateway, ApiError("media_failed", error.message ?: "媒体抓取失败"))
                }
            }
        }
}

/**
 * 本地书 id 的形状：导入时 `UUID.randomUUID().toString().replace("-", "")` 生成，32 位小写十六进制。
 * 取包内图片时拿它当文件名用，所以宁可窄：不匹配就直接 404，不去猜。
 */
private val LOCAL_BOOK_ID = Regex("^[0-9a-f]{16,64}$")

/**
 * 包内资源的媒体类型。**先按魔数判，扩展名只作兜底**：zip 里的名字是作者起的，
 * 内容与扩展名不符时按扩展名回会让浏览器拿错的类型渲染（而这里回的是同源地址）。
 * 认不出来的一律不回（null → 404），svg 显式排除 —— 同源 SVG 可以带脚本。
 * `internal` 而不是 `private`：这是路由的安全边界，判据要能直接打到它，不该靠反射。
 */
internal fun localAssetType(path: String, bytes: ByteArray): String? {
    // 小于这个尺寸不可能是能显示的图片（1x1 的 gif 也有三十几字节）。
    // 有了这一档，"扩展名叫 cover.png 但内容只有几个字节"也不会被当图片同源回出去。
    if (bytes.size < 32) return null
    fun isPrefix(offset: Int, text: String) = bytes.size > offset + text.length &&
        (0 until text.length).all { bytes[offset + it] == text[it].code.toByte() }
    val magic = when {
        bytes.size > 8 && bytes[0] == 0x89.toByte() && isPrefix(1, "PNG") -> "image/png"
        bytes.size > 3 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte() -> "image/jpeg"
        isPrefix(0, "GIF8") -> "image/gif"
        isPrefix(0, "RIFF") && isPrefix(8, "WEBP") -> "image/webp"
        isPrefix(0, "BM") -> "image/bmp"
        else -> null
    }
    if (magic != null) return magic
    val ext = path.substringAfterLast('.', "").lowercase()
    return when (ext) {
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        "bmp" -> "image/bmp"
        // svg / xml / html / 未知：同源回出去就是 XSS 面，宁可不显示
        else -> null
    }
}

/**
 * 媒体流式代理用的 client：连接超时 10s、读超时 30s、重定向自己处理（跨域跳转不再补发 Referer，避免泄露来源）。
 * 媒体文件可能很大，用 `ofInputStream()` 拿到流再边读边回传，不整包进内存。
 */
// 媒体流式代理走受控 client：每个 send 都再过一遍 SSRF 闸门（含建连前 DNS 重绑定的 IP 复查），
// 与 fetchMediaStream 里按跳手动 resolveAndValidateSafeHttpTarget 互为纵深，杜绝"解析时公网、建连时私网"。
private val mediaFetchClient = NetworkSecurity.newHttpClient(
    connectTimeout = java.time.Duration.ofSeconds(10),
    followRedirects = java.net.http.HttpClient.Redirect.NEVER,
)

private data class FetchedMedia(
    val statusCode: Int,
    val contentType: String?,
    val contentLength: String?,
    val contentRange: String?,
    val stream: java.io.InputStream,
)

/**
 * 代取一段媒体并原样回传。支持 Range 透传（浏览器拖动进度条），不支持 Range 的上游回 200 时我们也回 200 全量流（退化成不能拖动，但仍能播放）。
 * 重定向最多 4 跳，跨域跳转后不再带 Referer。
 */
private fun fetchMediaStream(url: String, referer: String?, range: String?, cookieFor: (String) -> String? = { null }): FetchedMedia {
    var uri = URI(url)
    NetworkSecurity.resolveAndValidateSafeHttpTarget(uri, "媒体")
    repeat(4) {
        val builder = java.net.http.HttpRequest.newBuilder(uri).timeout(java.time.Duration.ofSeconds(30)).GET()
        proxyRequestHeaders(uri, referer, cookieFor, range).forEach { (name, value) -> builder.header(name, value) }
        val resp = mediaFetchClient.send(builder.build(), java.net.http.HttpResponse.BodyHandlers.ofInputStream())
        val status = resp.statusCode()
        if (status in 300..399) {
            resp.body().close()
            val loc = resp.headers().firstValue("location").orElse(null)
                ?: throw IllegalArgumentException("媒体重定向缺少地址")
            uri = uri.resolve(URI(loc))
            NetworkSecurity.resolveAndValidateSafeHttpTarget(uri, "媒体")
            return@repeat
        }
        require(status in 200..299 || status == 206) { "媒体上游返回 HTTP $status" }
        val cType = resp.headers().firstValue("content-type").orElse(null)
        val cLen = resp.headers().firstValue("content-length").orElse(null)
        val cRange = resp.headers().firstValue("content-range").orElse(null)
        return FetchedMedia(status, cType, cLen, cRange, resp.body())
    }
    throw IllegalArgumentException("媒体重定向次数超过限制")
}

