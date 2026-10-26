package io.legado

import io.ktor.http.*
import io.ktor.http.content.PartData
import io.ktor.http.content.forEachPart
import io.ktor.http.content.streamProvider
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.http.content.*
import io.legado.http.requireSameOriginWrite
import io.legado.model.ApiError
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.zip.GZIPOutputStream

/**
 * 烤进 jar 的 `/assets` 目录下那些文件：名字带 Vite 的内容哈希，同一个 URL 的内容**永远不会变**，
 * 所以这一格该有三样原本没有的东西 —— 一年 `immutable` 缓存、gzip、ETag/HEAD。
 *
 * 为什么不装 `ktor-server-compression`：那是给**所有**响应套一层，包括 SSE、TTS 音频流、
 * 备份下载 —— 那些要么已经压过、要么必须逐字节流出去，套 gzip 只会拖慢甚至卡住。
 * 真正需要压的就这一类静态文本，而且它们可以在首次读到时一次算好常驻内存（整批约 1.2 MB）。
 *
 * 只管 `/assets/`：`index.html`、`sw.js`、`manifest.webmanifest` 仍走 [staticWeb] 里的
 * `respondNoCache` —— 它们的名字不带哈希，缓存住就等于"服务端改了、界面永远是旧的"。
 */
private object BundledAssets {
    /** 小于这个数不值得压：光 gzip 头就占 ~20 字节，小文件压了反而变大。 */
    private const val MIN_GZIP_BYTES = 1024
    private const val IMMUTABLE = "public, max-age=31536000, immutable"

    private class Loaded(val bytes: ByteArray, val contentType: ContentType, val etag: String, val gzipped: ByteArray?)

    private val cache = ConcurrentHashMap<String, Loaded>()
    private val missing = ConcurrentHashMap.newKeySet<String>()

    private fun gzipOf(input: ByteArray): ByteArray {
        val out = ByteArrayOutputStream(input.size / 3 + 64)
        GZIPOutputStream(out).use { it.write(input) }
        return out.toByteArray()
    }

    /** 只压文本：图片/字体/woff2 出厂已经压过，再压一遍是纯烧 CPU。 */
    private fun compressible(type: ContentType): Boolean =
        type.match(ContentType.Text.Any) || type.match(ContentType.Application.Json) ||
            type == ContentType.Application.JavaScript || type == ContentType.Image.SVG

    private fun load(resource: String): Loaded? {
        if (resource in missing) return null
        cache[resource]?.let { return it }
        val bytes = runCatching {
            BundledAssets::class.java.classLoader.getResourceAsStream(resource)?.use { it.readAllBytes() }
        }.getOrNull()
        if (bytes == null) {
            missing.add(resource)
            return null
        }
        val base = ContentType.fromFilePath(resource).firstOrNull() ?: ContentType.Application.OctetStream
        val type = if (compressible(base)) base.withCharset(Charsets.UTF_8) else base
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        val etag = "\"" + digest.joinToString("") { "%02x".format(it) }.substring(0, 16) + "\""
        val loaded = Loaded(bytes, type, etag, if (bytes.size >= MIN_GZIP_BYTES && compressible(type)) gzipOf(bytes) else null)
        cache[resource] = loaded
        return loaded
    }

    private suspend fun respond(call: ApplicationCall, name: String, withBody: Boolean): Boolean {
        // name 来自 URL，只可能是一段文件名：挡掉穿越与空串
        if (name.isBlank() || name.contains('/') || name.contains('\\') || name.contains("..")) return false
        val loaded = load("static/assets/$name") ?: return false
        call.response.header(HttpHeaders.CacheControl, IMMUTABLE)
        call.response.header(HttpHeaders.ETag, loaded.etag)
        call.response.header(HttpHeaders.Vary, HttpHeaders.AcceptEncoding)
        if (call.request.headers[HttpHeaders.IfNoneMatch] == loaded.etag) {
            call.respond(HttpStatusCode.NotModified)
            return true
        }
        val acceptsGzip = call.request.headers[HttpHeaders.AcceptEncoding].orEmpty().contains("gzip", ignoreCase = true)
        val gz = loaded.gzipped?.takeIf { acceptsGzip }
        if (gz != null) call.response.header(HttpHeaders.ContentEncoding, "gzip")
        if (withBody) {
            call.respondBytes(gz ?: loaded.bytes, loaded.contentType)
        } else {
            // HEAD：头给全、体必须没有。（原来走 staticResources，HEAD 直接 404，探活与预取全误判）
            call.response.header(HttpHeaders.ContentType, loaded.contentType.toString())
            call.respond(HttpStatusCode.OK)
        }
        return true
    }

    suspend fun respondAsset(call: ApplicationCall, name: String): Boolean = respond(call, name, withBody = true)

    suspend fun respondAssetHead(call: ApplicationCall, name: String): Boolean = respond(call, name, withBody = false)
}

fun Route.staticWeb(homeDirectory: Path = Path.of(".")) {
    val respondNoCache: suspend (ApplicationCall, String, ContentType?) -> Unit = { call, resource, contentType ->
        call.response.header(HttpHeaders.CacheControl, "no-cache, no-store, must-revalidate")
        call.response.header(HttpHeaders.Pragma, "no-cache")
        call.response.header(HttpHeaders.Expires, "0")
        if (contentType != null) {
            call.response.header(HttpHeaders.ContentType, contentType.toString())
        }
        call.respondResource(resource)
    }

    val respondIndex: suspend (ApplicationCall) -> Unit = { call ->
        respondNoCache(call, "static/index.html", ContentType.Text.Html.withCharset(Charsets.UTF_8))
    }

    get("/index.html") { respondIndex(call) }
    head("/index.html") { respondIndex(call) }

    get("/sw.js") { respondNoCache(call, "static/sw.js", ContentType.parse("application/javascript")) }
    head("/sw.js") { respondNoCache(call, "static/sw.js", ContentType.parse("application/javascript")) }
    // manifest 带 no-cache，所以运行时按品牌改写它**立刻生效**（用户：「允许自定义图标和名称」）。
    // 没设品牌时原样发内置那份文本，一个字节都不动 —— 见 BrandManifest.render 的理由。
    val respondManifest: suspend (ApplicationCall) -> Unit = { call ->
        val brand = BrandStore.load(homeDirectory)
        val icon = if (brand.hasIcon) "/brand/icon" else null
        val text = BrandManifest.render(brand, icon, BrandStore.iconType(homeDirectory, brand))
        if (text.isBlank()) {
            respondNoCache(call, "static/manifest.webmanifest", ContentType.parse("application/manifest+json"))
        } else {
            call.response.header(HttpHeaders.CacheControl, "no-cache, no-store, must-revalidate")
            call.respondText(text, ContentType.parse("application/manifest+json"))
        }
    }
    get("/manifest.webmanifest") { respondManifest(call) }
    head("/manifest.webmanifest") { respondManifest(call) }
    get("/manifest.json") { respondManifest(call) }
    head("/manifest.json") { respondManifest(call) }

    // ===== 自定义品牌：读写安装根的 brand.json + brand/ 里的图标字节 =====
    // 放这里而不是 http/ 那批路由文件：与 /sw.js、/manifest.webmanifest 同一档"静态表面"，
    // 不进 /api/catalog 的端点计数（142 条那道闸门只扫 io/legado/http/，见 ApiCatalog.test.ts）。
    // 但写操作照样过同源闸门 —— 它改的是这台机器的外观，跨站页面不该代用户改。
    get("/brand") {
        val brand = BrandStore.load(homeDirectory)
        call.respond(BrandManifest.brandJson(brand, if (brand.hasIcon) "/brand/icon" else null))
    }
    put("/brand") {
        if (!call.requireSameOriginWrite()) return@put
        val brand = runCatching { call.receive<Brand>() }.getOrElse {
            call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 {name, shortName, themeColor}")); return@put
        }
        val saved = BrandStore.save(homeDirectory, brand)
        call.respond(BrandManifest.brandJson(saved, if (saved.hasIcon) "/brand/icon" else null))
    }
    delete("/brand") {
        if (!call.requireSameOriginWrite()) return@delete
        val cleared = BrandStore.clear(homeDirectory)
        call.respond(BrandManifest.brandJson(cleared, null))
    }
    post("/brand/icon") {
        if (!call.requireSameOriginWrite()) return@post
        val multipart = runCatching { call.receiveMultipart() }.getOrElse {
            call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "要 multipart/form-data，字段名 file")); return@post
        }
        // 形状照 `BackupRoutes` 那一条：先收成 Pair，循环外再判（那里还漏了 import
        // `io.ktor.http.content.streamProvider` —— 它是扩展函数，不跟着 import 就报 Unresolved）。
        var upload: Pair<String, ByteArray>? = null
        multipart.forEachPart { part ->
            val file = part as? PartData.FileItem
            if (file != null && upload == null) {
                upload = (file.originalFileName ?: "icon") to file.streamProvider().readBytes()
            }
            part.dispose()
        }
        val raw = upload?.second
        val reject: String? = when {
            raw == null || raw.isEmpty() -> "没收到图标文件"
            raw.size.toLong() > BrandStore.MAX_ICON_BYTES -> "图标太大（上限 ${BrandStore.MAX_ICON_BYTES / 1024 / 1024} MB）"
            // 只按魔数认图、不收 SVG：品牌图标会被浏览器当"本站自己的资源"取用，
            // 放进一张能带脚本的 SVG 等于自己开一条同源脚本执行面
            // （与 CoverCache 拒 image/svg+xml、MediaRoutes 把同源 SVG 降级同一纪律）。
            BrandStore.sniffImageType(raw) == null -> "图标只能是 PNG / JPEG / WebP（不收 SVG）"
            else -> null
        }
        if (reject != null) {
            call.respond(HttpStatusCode.BadRequest, ApiError("invalid_icon", reject)); return@post
        }
        val data = raw!!
        val saved = BrandStore.saveIcon(homeDirectory, data)
        if (saved == null) {
            call.respond(HttpStatusCode.InternalServerError, ApiError("write_failed", "图标写不进 brand/ 目录")); return@post
        }
        val brand = BrandStore.save(homeDirectory, BrandStore.load(homeDirectory).copy(iconFile = saved))
        call.respond(BrandManifest.brandJson(brand, "/brand/icon"))
    }
    delete("/brand/icon") {
        if (!call.requireSameOriginWrite()) return@delete
        val brand = BrandStore.deleteIcon(homeDirectory)
        call.respond(BrandManifest.brandJson(brand, null))
    }
    // 自定义图标本身：URL 固定 /brand/icon，**缓存指纹靠 ETag**（不是文件名 ?v=）。
    // 图标没有 no-cache 的必要 —— 内容变了 ETag 就变了，浏览器拿旧的也不会显示错。
    get("/brand/icon") {
        val brand = BrandStore.load(homeDirectory)
        val pair = BrandStore.iconBytes(homeDirectory, brand)
        if (pair == null) { call.respond(HttpStatusCode.NotFound, ApiError("not_found", "没有自定义图标")); return@get }
        val (data, type) = pair
        val etag = "\"" + BrandManifest.iconEtag(data) + "\""
        if (call.request.headers[HttpHeaders.IfNoneMatch] == etag) {
            call.response.header(HttpHeaders.ETag, etag)
            call.respond(HttpStatusCode.NotModified); return@get
        }
        call.response.header(HttpHeaders.ETag, etag)
        call.response.header(HttpHeaders.CacheControl, "public, max-age=31536000, immutable")
        call.respondBytes(data, ContentType.parse(type))
    }

    // 带内容哈希的 bundle：显式一条路由，才拿得到 immutable + gzip + ETag + HEAD。
    // 必须注册在下面 `staticResources("/")` **之前** —— 根那条通配同样能命中 `/assets/x.js`
    // （资源在 classpath 里就在 `static/assets/` 下），两条并存时谁先注册谁说话，
    // 顺序写反了缓存头会静默失效，curl 看着还是 200。
    get("/assets/{name}") {
        if (!BundledAssets.respondAsset(call, call.parameters["name"] ?: "")) call.respond(HttpStatusCode.NotFound)
    }
    head("/assets/{name}") {
        if (!BundledAssets.respondAssetHead(call, call.parameters["name"] ?: "")) call.respond(HttpStatusCode.NotFound)
    }
    staticResources("/", "static")
    get("/") { respondIndex(call) }
    head("/") { respondIndex(call) }
}

/**
 * 新骨架（qingyue 前端）挂在**同一个端口**的 `/next` 下，而不是另开一个开发端口。
 *
 * 为什么必须同端口：这台服务不设身份、只绑回环，写操作唯一的门是"Origin 的主机与端口
 * 等于请求的 Host"（见 [Guard.kt]）。前端换到 5200 之类的端口，所有写请求的 Origin 就对不上，
 * 要么放宽闸门、要么再加一层代理 —— 两条都比"多一个静态目录"贵得多，而且放宽闸门等于把
 * 这个服务唯一的写保护拆掉。挂在 `/next` 下，新旧界面同一个源，闸门一行都不用动。
 *
 * 目录从**磁盘**读而不是烤进 jar：这一格是每天在改的东西，每改一次就重打一次 jar
 * 会把"看一眼新界面"变成一次发版。目录不存在时整条不注册（`/next` 落到根路由的 404），
 * 而不是摆一张"这里什么都没有"的假页面。
 */
fun Route.staticNext(nextDirectory: Path) {
    val index = nextDirectory.resolve("index.html")
    if (!Files.isRegularFile(index)) return
    // index 必须 no-cache：它的名字不带哈希，浏览器一旦缓存，重新构建出新 bundle 也拿不到
    val respondIndex: suspend (ApplicationCall) -> Unit = { call ->
        call.response.header(HttpHeaders.CacheControl, "no-cache, no-store, must-revalidate")
        call.response.header(HttpHeaders.Pragma, "no-cache")
        call.response.header(HttpHeaders.Expires, "0")
        call.respondFile(index.toFile())
    }
    get("/next") { call.respondRedirect("/next/") }
    get("/next/") { respondIndex(call) }
    head("/next/") { respondIndex(call) }
    // 带哈希的 assets 走普通静态缓存；`/next/<别的东西>` 由 Ktor 找文件，找不到就 404
    staticFiles("/next", nextDirectory.toFile())
}
