package io.legado.backup

import io.legado.model.BackupWebDavEntry
import io.legado.model.BackupWebDavRequest
import io.legado.model.BackupWebDavUpload
import io.legado.ops.NetworkSecurity
import java.io.InputStream
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.time.Duration
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.Base64
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.xml.XMLConstants
import javax.xml.parsers.DocumentBuilderFactory
import org.w3c.dom.Element
import org.xml.sax.helpers.DefaultHandler

/** Manual snapshot transport. Credentials live in one request only; no remote state is applied here. */
internal class BackupWebDav(
    private val client: HttpClient = NetworkSecurity.newHttpClient(followRedirects = HttpClient.Redirect.NEVER),
    private val allowHttpForTest: Boolean = false,
    private val maxBytes: Long = 64L * 1024 * 1024,
    private val bodyTimeout: Duration = Duration.ofSeconds(60),
) {
    class Failure(val code: String, override val message: String) : RuntimeException(message)
    private val names = Regex("legadoq-migration-\\d{8}-\\d{6}-[a-f0-9]{32}-([a-f0-9]{64})\\.zip")

    init { require(client.followRedirects() == HttpClient.Redirect.NEVER) }

    private companion object {
        val deadlines = Executors.newSingleThreadScheduledExecutor { task ->
            Thread(task, "backup-webdav-deadline").apply { isDaemon = true }
        }
    }

    // ofInputStream completes at response headers; HttpRequest.timeout alone does not bound body reads.
    private fun <T> body(response: HttpResponse<InputStream>, allowed: Set<Int>, read: (InputStream) -> T): T {
        val expired = AtomicBoolean(false)
        val input = response.body()
        val deadline = deadlines.schedule({ expired.set(true); runCatching { input.close() } },
            bodyTimeout.toMillis(), TimeUnit.MILLISECONDS)
        try {
            return input.use { expect(response, allowed); read(it) }.also {
                if (expired.get()) throw Failure("webdav_timeout", "WebDAV 响应体读取超时，操作已停止；上传可能已留有文件，请刷新列表核对")
            }
        } catch (error: Exception) {
            if (expired.get()) throw Failure("webdav_timeout", "WebDAV 响应体读取超时，操作已停止；上传可能已留有文件，请刷新列表核对")
            throw error
        } finally { deadline.cancel(false) }
    }

    private fun endpoint(request: BackupWebDavRequest): URI {
        val uri = try { URI(request.url.trim()) } catch (_: Exception) { invalid() }
        if (uri.scheme != "https" && !(allowHttpForTest && uri.scheme == "http")) invalid()
        if (uri.host.isNullOrBlank() || uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null ||
            uri.port == 0 || uri.port > 65535 || uri.rawPath.contains(Regex("(?i)%2f|%5c|%2e")) ||
            uri.path.split('/').any { it == "." || it == ".." } || uri.path.contains('\\')) invalid()
        if (request.username.length > 1024 || request.password.length > 4096 ||
            request.username.contains(':') || request.username.any { it.isISOControl() } ||
            request.password.any { it.isISOControl() }) invalid()
        return URI(uri.toASCIIString().trimEnd('/') + "/")
    }

    private fun invalid(): Nothing = throw Failure("invalid_webdav", "请填写 HTTPS WebDAV 目录地址；账号密码须单独填写，地址不能含查询参数、片段或父级路径")

    private fun builder(request: BackupWebDavRequest, target: URI): HttpRequest.Builder {
        val builder = HttpRequest.newBuilder(target).timeout(Duration.ofSeconds(60))
            .header("Accept-Encoding", "identity")
        if (request.username.isNotEmpty() || request.password.isNotEmpty()) {
            val basic = Base64.getEncoder().encodeToString("${request.username}:${request.password}".toByteArray(Charsets.UTF_8))
            builder.header("Authorization", "Basic $basic")
        }
        return builder
    }

    private fun send(request: HttpRequest): HttpResponse<InputStream> = try {
        client.send(request, HttpResponse.BodyHandlers.ofInputStream())
    } catch (_: NetworkSecurity.BlockedAddressException) {
        throw Failure("webdav_blocked", "网络策略拒绝该地址；当前仅支持公网 HTTPS WebDAV，暂不支持本机或 NAS 私网直连")
    } catch (error: InterruptedException) {
        Thread.currentThread().interrupt()
        throw error
    } catch (_: Exception) {
        throw Failure("webdav_unreachable", "WebDAV 连接失败，请检查网络、TLS 证书和目录地址；上传失败时远端可能已留有文件，请刷新列表核对")
    }

    private fun expect(response: HttpResponse<InputStream>, allowed: Set<Int>) {
        if (response.statusCode() in allowed) return
        throw when (response.statusCode()) {
            401, 403 -> Failure("webdav_denied", "WebDAV 认证或权限不足，请检查账号、密码与目录读写权限")
            404, 409 -> Failure("webdav_directory_missing", "WebDAV 目录不存在，请先在服务端创建该目录")
            412 -> Failure("webdav_exists", "同名远端文件已存在，未请求覆盖；请刷新列表核对")
            in 300..399 -> Failure("webdav_redirect", "WebDAV 返回重定向，已停止；请填写最终 HTTPS 目录地址")
            else -> Failure("webdav_response", "WebDAV 返回 HTTP ${response.statusCode()}，操作未完成")
        }
    }

    fun list(request: BackupWebDavRequest): List<BackupWebDavEntry> {
        val base = endpoint(request)
        val xml = """<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>"""
        val response = send(builder(request, base).header("Depth", "1")
            .header("Content-Type", "application/xml; charset=utf-8")
            .method("PROPFIND", HttpRequest.BodyPublishers.ofString(xml)).build())
        val bytes = body(response, setOf(207)) { bounded(it, 2L * 1024 * 1024) }
        return try { parseList(base, bytes) } catch (error: Failure) { throw error } catch (_: Exception) {
            throw Failure("webdav_listing_invalid", "WebDAV 目录响应无效或超出上限，未读取任何外部 XML 资源")
        }
    }

    private fun parseList(base: URI, bytes: ByteArray): List<BackupWebDavEntry> {
        val factory = DocumentBuilderFactory.newInstance().apply {
            isNamespaceAware = true
            setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true)
            setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
            setFeature("http://xml.org/sax/features/external-general-entities", false)
            setFeature("http://xml.org/sax/features/external-parameter-entities", false)
            setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "")
            setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "")
            isXIncludeAware = false
            isExpandEntityReferences = false
        }
        val parser = factory.newDocumentBuilder().apply { setErrorHandler(DefaultHandler()) }
        val root = parser.parse(bytes.inputStream()).documentElement
        require(root.namespaceURI == "DAV:" && root.localName == "multistatus")
        val responses = root.getElementsByTagNameNS("DAV:", "response")
        require(responses.length <= 2000)
        val entries = mutableListOf<BackupWebDavEntry>()
        fun Element.children(local: String) = (0 until childNodes.length).mapNotNull { childNodes.item(it) as? Element }
            .filter { it.namespaceURI == "DAV:" && it.localName == local }
        for (index in 0 until responses.length) {
            val item = responses.item(index) as Element
            val href = item.children("href").singleOrNull()?.textContent?.trim() ?: continue
            val uri = runCatching { base.resolve(URI(href)) }.getOrNull() ?: continue
            // Never use a remote href as a request target. Only accept canonical direct children.
            if (!uri.toASCIIString().startsWith(base.toASCIIString())) continue
            val name = uri.toASCIIString().removePrefix(base.toASCIIString())
            if (!names.matches(name) || base.resolve(name) != uri) continue
            val props = item.children("propstat").filter {
                it.children("status").singleOrNull()?.textContent?.trim()?.matches(Regex("HTTP/\\S+ 200(?: .*)?")) == true
            }.flatMap { it.children("prop") }
            if (props.isEmpty() || props.any { it.getElementsByTagNameNS("DAV:", "collection").length > 0 }) continue
            val length = props.flatMap { it.children("getcontentlength") }.firstOrNull()?.textContent?.trim()?.toLongOrNull()
            if (length != null && (length < 0 || length > maxBytes)) continue
            val modified = props.flatMap { it.children("getlastmodified") }.firstOrNull()?.textContent?.take(100)
            entries += BackupWebDavEntry(name, length, modified)
        }
        return entries.distinctBy { it.name }.sortedByDescending { it.name }
    }

    fun upload(request: BackupWebDavRequest, file: Path): BackupWebDavUpload {
        val base = endpoint(request)
        val size = Files.size(file)
        if (size > maxBytes) throw Failure("webdav_too_large", "迁移包超过 64 MiB 传输上限，请分别保管留档")
        val digest = Files.newInputStream(file).use { hash(it, maxBytes).second }
        val stamp = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss"))
        val name = "legadoq-migration-$stamp-${UUID.randomUUID().toString().replace("-", "")}-$digest.zip"
        val target = base.resolve(name)
        val response = send(builder(request, target).header("If-None-Match", "*")
            .header("Content-Type", "application/zip").PUT(HttpRequest.BodyPublishers.ofFile(file)).build())
        body(response, setOf(201, 204, 200)) { }
        val verify = send(builder(request, target).GET().build())
        val actual = body(verify, setOf(200)) { hash(it, maxBytes) }
        if (actual.first != size || actual.second != digest) throw Failure("webdav_verify_failed", "远端回读校验失败，未标记为备份成功；远端可能留有文件，请刷新列表核对")
        return BackupWebDavUpload(name, size, digest, true)
    }

    fun download(request: BackupWebDavRequest, file: Path) {
        val base = endpoint(request)
        val name = request.name ?: throw Failure("invalid_webdav_name", "请选择列表中的迁移包")
        val expected = names.matchEntire(name)?.groupValues?.get(1)
            ?: throw Failure("invalid_webdav_name", "仅支持本产品生成的迁移包文件名")
        val response = send(builder(request, base.resolve(name)).GET().build())
        body(response, setOf(200)) { input ->
            Files.newOutputStream(file).use { output ->
                val actual = hash(input, maxBytes) { buffer, count -> output.write(buffer, 0, count) }
                if (actual.second != expected) throw Failure("webdav_verify_failed", "迁移包与文件名中的校验值不一致，已停止拉取；请核对远端文件")
            }
        }
    }

    private fun bounded(input: InputStream, limit: Long): ByteArray {
        val output = java.io.ByteArrayOutputStream()
        hash(input, limit) { bytes, count -> output.write(bytes, 0, count) }
        return output.toByteArray()
    }

    private fun hash(input: InputStream, limit: Long, consume: (ByteArray, Int) -> Unit = { _, _ -> }): Pair<Long, String> {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(16 * 1024)
        var total = 0L
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            total += count
            if (total > limit) throw Failure("webdav_too_large", "WebDAV 响应超过大小上限，操作已停止")
            digest.update(buffer, 0, count)
            consume(buffer, count)
        }
        return total to digest.digest().joinToString("") { "%02x".format(it) }
    }
}
