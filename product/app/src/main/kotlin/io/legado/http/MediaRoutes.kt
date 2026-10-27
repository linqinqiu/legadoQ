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
import io.legado.data.getSource
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
    /** 书源图片解密（`ruleContent.imageDecode`）用；不传就退化成"只代理不解密"。 */
    runner: io.legado.rules.RuleRunner? = null,
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
            // `sourceId`：这个图属于哪个书源。只有带上它、且该书源配了 ruleContent.imageDecode，
            // 才会在落盘前跑一次解密；解密结果单独缓存（key 带源与解密标记）。
            val sourceId = call.request.queryParameters["sourceId"]?.trim()?.takeIf { it.isNotBlank() }
            val decoder = sourceId?.let { id ->
                database.getSource(id)?.json?.let { json -> runner?.imageDecoder(json) }
            }
            val decodeSuffix = if (decoder != null) "#decode:${sourceId}" else ""
            try {
                val cached = coverCache.cacheContentImage(url, referer, decoder, decodeSuffix)
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
            val sourceId = call.request.queryParameters["sourceId"]?.trim()?.takeIf { it.isNotBlank() }
            val decoder = sourceId?.let { id ->
                database.getSource(id)?.json?.let { json -> runner?.imageDecoder(json) }
            }
            val decodeSuffix = if (decoder != null) "#decode:${sourceId}" else ""
            try {
                val cached = coverCache.refetchContentImage(url, referer, decoder, decodeSuffix)
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
        get("/book/media") { respondMedia(call, database, headOnly = false) }
        head("/book/media") { respondMedia(call, database, headOnly = true) }
}

/**
 * 媒体代理的公共实现：GET 与 HEAD 共用。HEAD 只回头部、不推流（部分播放器/浏览器先探 HEAD 再决定拉不拉）。
 *
 * 与拆出前逐字一致的部分：注入 Referer 与该域 Cookie、原样转发 Range。新增的几层都是"不改协议、只补洞"：
 * - `Content-Type` 上游没给或只给 `application/octet-stream` 时按后缀补一个能播的类型，否则 `<video>` 可能不认；
 * - 上游回 416（拖动越过文件尾）原样回 416，不再当成 502；
 * - `download=1` 时补 `Content-Disposition`，文件源的下载链接才有正常文件名；
 * - m3u8 播放列表改写成"每一段都走本代理"的地址，配合前端的 hls.js 才能真正播放 HLS。
 */
private suspend fun respondMedia(call: ApplicationCall, database: Database, headOnly: Boolean) {
    val url = call.request.queryParameters["url"].orEmpty()
    if (!url.startsWith("http://", ignoreCase = true) && !url.startsWith("https://", ignoreCase = true)) {
        call.respond(HttpStatusCode.BadRequest, ApiError("invalid_media", "媒体地址无效")); return
    }
    // `referer` 用这一章的地址：媒体站按防盗链判来源，不带就回 403。
    val referer = call.request.queryParameters["referer"]?.takeIf { it.startsWith("http", ignoreCase = true) }
    val range = call.request.headers["Range"]
    val download = call.request.queryParameters["download"] == "1"
    withContext(Dispatchers.IO) {
        try {
            val media = fetchMediaStream(url, referer, range) { database.getCookieForUrl(it) }
            if (isHlsPlaylist(url, media.contentType)) {
                if (headOnly) {
                    media.stream.close()
                    call.response.headers.append("Content-Type", "application/vnd.apple.mpegurl")
                    call.response.headers.append("Cache-Control", "no-store")
                    call.respond(HttpStatusCode.OK)
                    return@withContext
                }
                val text = readBoundedText(media.stream, media.contentEncoding, HLS_PLAYLIST_LIMIT)
                val rewritten = rewriteHlsPlaylist(text, media.finalUrl, referer)
                call.response.headers.append("Cache-Control", "no-store")
                call.response.headers.append("X-Content-Type-Options", "nosniff")
                call.respondText(rewritten, ContentType.parse("application/vnd.apple.mpegurl"))
                return@withContext
            }
            // 视频源的「播放页」：正文脚本只给了一个 HTML 地址（本机库 12/15 个视频源）。
            // 直接流回去，iframe 里的相对资源会以 `/api/book/media?...` 为基准解析，全走错；
            // 注入 `<base href="最终地址">` 后，页面自己的脚本/样式/图片才会回到原站加载。
            if (!download && media.contentType?.trim()?.startsWith("text/html", ignoreCase = true) == true) {
                if (headOnly) {
                    media.stream.close()
                    call.response.headers.append("Content-Type", "text/html; charset=utf-8")
                    call.respond(HttpStatusCode.OK)
                    return@withContext
                }
                val html = readBoundedText(media.stream, media.contentEncoding, HTML_PAGE_LIMIT)
                call.response.headers.append("Cache-Control", "no-store")
                call.response.headers.append("X-Content-Type-Options", "nosniff")
                call.respondText(injectBaseHref(html, media.finalUrl), ContentType.Text.Html.withCharset(Charsets.UTF_8))
                return@withContext
            }
            val status = when {
                media.statusCode == 416 -> HttpStatusCode.RequestedRangeNotSatisfiable
                range != null && media.statusCode == 206 -> HttpStatusCode.PartialContent
                else -> HttpStatusCode.OK
            }
            call.response.headers.apply {
                append("Accept-Ranges", "bytes")
                append("Cache-Control", "private, max-age=300")
                mediaContentType(url, media.contentType)?.let { append("Content-Type", it) }
                media.contentLength?.let { append("Content-Length", it) }
                media.contentRange?.let { append("Content-Range", it) }
                if (download) append("Content-Disposition", attachmentDisposition(url))
            }
            if (headOnly || status == HttpStatusCode.RequestedRangeNotSatisfiable) {
                media.stream.close()
                call.respond(status)
            } else {
                call.respondOutputStream(status = status) {
                    media.stream.use { input -> input.copyTo(this) }
                }
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

private const val HLS_PLAYLIST_LIMIT = 4 * 1024 * 1024
private const val HTML_PAGE_LIMIT = 4 * 1024 * 1024

/**
 * 给播放页 HTML 注入 `<base href="原始地址">`：页面自己的相对资源才会回到原站解析。
 * 已有 `<base>` 的不动；找不到 `<head>` 就放最前面（浏览器仍认）。
 */
internal fun injectBaseHref(html: String, base: URI): String {
    if (Regex("(?i)<base\\b").containsMatchIn(html)) return html
    val href = base.toString().replace("&", "&amp;").replace("\"", "%22")
    val tag = "<base href=\"$href\">"
    val head = Regex("(?i)<head[^>]*>").find(html)
    return if (head != null) html.substring(0, head.range.last + 1) + tag + html.substring(head.range.last + 1) else tag + html
}

/** 上游没给或只给 `application/octet-stream` 时按后缀补一个能播的类型。 */
internal fun mediaContentType(url: String, upstream: String?): String? {
    val type = upstream?.substringBefore(';')?.trim()?.lowercase().orEmpty()
    if (type.isNotEmpty() && type != "application/octet-stream" && type != "binary/octet-stream") return type
    val path = runCatching { URI(url).path }.getOrNull()?.lowercase().orEmpty()
    return when {
        path.endsWith(".mp3") -> "audio/mpeg"
        path.endsWith(".m4a") || path.endsWith(".aac") -> "audio/mp4"
        path.endsWith(".ogg") || path.endsWith(".oga") -> "audio/ogg"
        path.endsWith(".wav") -> "audio/wav"
        path.endsWith(".flac") -> "audio/flac"
        path.endsWith(".mp4") || path.endsWith(".m4v") -> "video/mp4"
        path.endsWith(".webm") -> "video/webm"
        path.endsWith(".mkv") -> "video/x-matroska"
        path.endsWith(".mov") -> "video/quicktime"
        path.endsWith(".ts") -> "video/mp2t"
        path.endsWith(".m3u8") || path.endsWith(".m3u") -> "application/vnd.apple.mpegurl"
        else -> type.takeIf { it.isNotEmpty() }
    }
}

/** 按扩展名或上游 Content-Type 判断是不是 HLS 播放列表。 */
internal fun isHlsPlaylist(url: String, contentType: String?): Boolean {
    val type = contentType?.lowercase().orEmpty()
    if (type.contains("mpegurl")) return true
    val path = runCatching { URI(url).path }.getOrNull()?.lowercase().orEmpty()
    return path.endsWith(".m3u8") || path.endsWith(".m3u")
}

/**
 * 把 m3u8 里的每一段、以及 `URI="…"` 形式的密钥/初始化段，改写成走本代理的绝对地址。
 * 相对地址按播放列表的**最终**地址解析（重定向后不能拿原始地址当基准）。注释行原样保留。
 */
internal fun rewriteHlsPlaylist(playlist: String, base: URI, referer: String?): String {
    val uriAttr = Regex("""URI="([^"]+)"""", RegexOption.IGNORE_CASE)
    fun proxied(raw: String): String {
        val target = runCatching { base.resolve(raw.trim()).toString() }.getOrDefault(raw.trim())
        return proxyMediaUrl(target, referer)
    }
    return playlist.lineSequence().joinToString("\n") { raw ->
        val line = raw.trim()
        when {
            line.isEmpty() -> ""
            line.startsWith("#") -> uriAttr.replace(raw) { match -> "URI=\"${proxied(match.groupValues[1])}\"" }
            else -> proxied(line)
        }
    }
}

private fun proxyMediaUrl(target: String, referer: String?): String =
    "/api/book/media?url=${encodeQuery(target)}" + (referer?.let { "&referer=${encodeQuery(it)}" } ?: "")

private fun encodeQuery(value: String): String =
    java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20")

private fun attachmentDisposition(url: String): String {
    val name = runCatching { URI(url).path.substringAfterLast('/') }.getOrNull()?.takeIf { it.isNotBlank() } ?: "download"
    val encoded = java.net.URLEncoder.encode(name, "UTF-8").replace("+", "%20")
    return "attachment; filename=\"download\"; filename*=UTF-8''$encoded"
}

private fun readBoundedText(stream: java.io.InputStream, contentEncoding: String?, limit: Int): String {
    val raw = stream.use { input ->
        val out = java.io.ByteArrayOutputStream()
        val chunk = ByteArray(16 * 1024)
        var total = 0
        while (true) {
            val n = input.read(chunk)
            if (n < 0) break
            total += n
            require(total <= limit) { "播放列表超过 ${limit / 1024 / 1024} MiB 限制" }
            out.write(chunk, 0, n)
        }
        out.toByteArray()
    }
    val bytes = when {
        contentEncoding?.contains("gzip", true) == true ->
            java.util.zip.GZIPInputStream(raw.inputStream()).use { it.readBytes() }
        contentEncoding?.contains("deflate", true) == true ->
            java.util.zip.InflaterInputStream(raw.inputStream()).use { it.readBytes() }
        else -> raw
    }
    require(bytes.size <= limit) { "播放列表超过 ${limit / 1024 / 1024} MiB 限制" }
    return bytes.toString(Charsets.UTF_8).removePrefix("\uFEFF")
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
    val contentEncoding: String?,
    /** 跟完重定向后的最终地址：HLS 播放列表里的相对地址要以它为基准解析。 */
    val finalUrl: URI,
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
        require(status in 200..299 || status == 206 || status == 416) { "媒体上游返回 HTTP $status" }
        val cType = resp.headers().firstValue("content-type").orElse(null)
        val cLen = resp.headers().firstValue("content-length").orElse(null)
        val cRange = resp.headers().firstValue("content-range").orElse(null)
        val cEnc = resp.headers().firstValue("content-encoding").orElse(null)
        return FetchedMedia(status, cType, cLen, cRange, cEnc, uri, resp.body())
    }
    throw IllegalArgumentException("媒体重定向次数超过限制")
}

