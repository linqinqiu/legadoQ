package io.legado.http

import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.server.application.createApplicationPlugin
import io.ktor.server.request.contentLength
import io.legado.BrandStore
import java.io.ByteArrayOutputStream
import java.io.InputStream

/**
 * 请求体超限异常：由 `StatusPages` 统一转成 413 + `ApiError(code, message)`。
 *
 * 刻意继承 `RuntimeException` 而不是 `BadRequestException` —— 后者会被 `Application.kt` 里
 * 那条 400 handler 先接走；也不该落进 catch-all 的 `Throwable` 分支刷一整段 error 堆栈。
 */
internal class PayloadTooLargeException(
    val errorCode: String,
    message: String,
) : RuntimeException(message)

/**
 * 请求体上限的**单一真源**：声明长度闸（S2a）与 multipart 流式闸（S2b）共用同一组数字。
 *
 * 没有放进 `AppConfig` / 环境变量：这几档是产品口径（备份 64MB、图标 5MB），不是部署旋钮，
 * 也不该因为改了配置就悄悄放宽一道安全闸。
 */
internal object BodyLimits {
    /** 普通 JSON 写端点的默认上限。 */
    const val DEFAULT_JSON_BYTES = 8L * 1024 * 1024

    /** 备份包原始字节上限，沿用 `BackupImporter` 的产品口径。 */
    const val BACKUP_BYTES = 64L * 1024 * 1024

    /** 图标上限引用 `BrandStore` —— 它是 `saveIcon` 的真源，不在这里重复写 5MB。 */
    const val ICON_BYTES = BrandStore.MAX_ICON_BYTES

    data class Limit(val maxBytes: Long, val errorCode: String)

    /**
     * 写端点的声明长度上限与 413 错误码。
     *
     * 按路径分档是为了让前端能区分"备份太大"和"请求体太大"，也为了**不误伤**：
     * 备份导入本来就该收 64MB，若跟 JSON 共用 8MB 就会把正常备份挡在门外。
     */
    fun limitFor(path: String): Limit = when (path) {
        "/api/backup/import" -> Limit(BACKUP_BYTES, "backup_too_large")
        "/brand/icon" -> Limit(ICON_BYTES, "icon_too_large")
        else -> Limit(DEFAULT_JSON_BYTES, "body_too_large")
    }
}

/**
 * 全局声明长度闸（S2a）：对写方法先看 `Content-Length`，超上限直接抛
 * [PayloadTooLargeException]，由 `StatusPages` 转 413 —— **不读 body**。
 *
 * 这是它跟 multipart 流式闸（S2b）的分工：声明长度可信时零成本挡掉；
 * chunked / 伪造声明时，才轮到流式闸在读取过程中兜底。
 *
 * 为什么**抛异常**而不是 `call.respond(413, …)`：Ktor 的 `onCall` 不阻断后续 pipeline，
 * respond 之后 routing 仍会执行、路由里的 `receive<T>()` 仍会把 body 读进内存 —— 那就白挡了。
 * 抛异常真正中止 pipeline，路由处理器不会跑，body 一个字节都不读。
 */
val RequestBodyLimit = createApplicationPlugin("RequestBodyLimit") {
    onCall { call ->
        val method = call.request.local.method
        if (method != HttpMethod.Post && method != HttpMethod.Put && method != HttpMethod.Patch) return@onCall
        // WS 升级握手是 GET（上面已排除），这里再显式挡一次非标准实现。
        if (call.request.headers[HttpHeaders.Upgrade]?.equals("websocket", ignoreCase = true) == true) return@onCall
        // chunked / 未知长度：没有声明可判，交给 S2b 的流式闸。
        val declared = call.request.contentLength() ?: return@onCall
        if (declared <= 0) return@onCall
        val path = call.request.local.uri.substringBefore('?')
        val limit = BodyLimits.limitFor(path)
        if (declared > limit.maxBytes) {
            throw PayloadTooLargeException(
                limit.errorCode,
                "请求体 $declared 字节，超过 ${limit.maxBytes / 1024 / 1024} MB 上限",
            )
        }
    }
}

/**
 * 边读边计数的 multipart 文件读取（S2b），形状对齐 `tts/EdgeTtsService` 的 8MB 循环：
 * 超限时**立刻**抛 [PayloadTooLargeException]，不把超限的字节读进内存。
 *
 * 64MB 读进堆里交给导入器可以接受（既有口径），关键是"在超限那一刻就停"，
 * 而不是 `readBytes()` 先把 10GB 吃满再判大小。
 */
internal fun readBounded(
    stream: InputStream,
    maxBytes: Long,
    errorCode: String,
    label: String,
): ByteArray {
    val out = ByteArrayOutputStream()
    val buffer = ByteArray(16 * 1024)
    while (true) {
        val read = stream.read(buffer)
        if (read < 0) break
        if (out.size().toLong() + read > maxBytes) {
            throw PayloadTooLargeException(errorCode, "$label 超过 ${maxBytes / 1024 / 1024} MB 上限")
        }
        out.write(buffer, 0, read)
    }
    return out.toByteArray()
}
