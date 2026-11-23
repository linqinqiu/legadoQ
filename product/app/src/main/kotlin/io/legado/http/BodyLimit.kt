package io.legado.http

import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.server.application.Hook
import io.ktor.server.application.PipelineCall
import io.ktor.server.application.createApplicationPlugin
import io.ktor.server.request.ApplicationReceivePipeline
import io.ktor.server.request.contentLength
import io.legado.BrandStore
import io.ktor.utils.io.ByteReadChannel
import io.ktor.utils.io.readAvailable
import io.ktor.utils.io.writeFully
import io.ktor.utils.io.writer
import kotlinx.coroutines.DelicateCoroutinesApi
import kotlinx.coroutines.GlobalScope
import java.io.ByteArrayOutputStream
import java.io.InputStream

/**
 * 请求体超限异常：multipart 流式闸（S2b）与 chunked 流式闸（S2c）都抛它，由 `StatusPages` 转 413。
 *
 * 刻意继承 `RuntimeException` 而不是 `BadRequestException` —— 后者会被 ContentNegotiation 包掉；
 * 也不该落进 catch-all 的 `Throwable` 分支刷一整段 error 堆栈。
 *
 * 为什么是自定义类而不是 Ktor 的 `io.ktor.server.plugins.PayloadTooLargeException`：后者会在 receive
 * pipeline 边上溢出时被 ContentNegotiation 包进 `BadRequestException`/`ContentTransformationException`，
 * 且**根因被吞掉**（`isBodyLimitOverflow` 沿 cause 链都找不到），导致只能回 400 而非 413。自定义类
 * 不会被 Ktor 特殊对待，作为 cause 原样保留，StatusPages 的 `isBodyLimitOverflow` 能把它认回来转 413。
 */
internal class PayloadTooLargeException(
    val errorCode: String,
    message: String,
) : RuntimeException(message)

/**
 * 请求体上限的**单一真源**：声明长度闸（S2a）、chunked 流式计数（S2c）与 multipart 流式闸（S2b）共用同一组数字。
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
     * 写端点的请求体上限与 413 错误码（按路径分档，前端可区分"备份太大 / 图标太大 / 请求体太大"，也不误伤备份）。
     * `Long.MAX_VALUE` 表示不限制（chunked 闸对这类路径不介入）。
     */
    fun limitFor(path: String): Limit = when (path) {
        "/api/backup/import" -> Limit(BACKUP_BYTES, "backup_too_large")
        "/brand/icon" -> Limit(ICON_BYTES, "icon_too_large")
        else -> Limit(DEFAULT_JSON_BYTES, "body_too_large")
    }
}

/**
 * 全局请求体上限闸（S2a 声明长度 + S2c chunked 流式计数）。
 *
 * - `onCall`：声明长度（Content-Length）超限直接抛，pipeline 中断，路由处理器不跑、body 一个字节都不读。
 * - `on(BeforeReceive)`：无声明长度的 chunked body 在 receive pipeline 上边读边计数，超限即抛。
 *   形状照 Ktor 官方 `ktor-server-body-limit` 插件的 `BeforeReceive` hook，但其抛的是自定义
 *   `PayloadTooLargeException`（见类注释），这样 StatusPages 能把 chunked 的超限也归位成 413。
 *
 * 抛异常而非 `call.respond(413, …)`：Ktor 的 `onCall` 不阻断后续 pipeline，respond 之后路由仍会
 * `receive<T>()` 把 body 读进内存 —— 那就白挡了。抛异常真正中止 pipeline。
 */
val RequestBodyLimit = createApplicationPlugin("RequestBodyLimit") {
    onCall { call ->
        val method = call.request.local.method
        if (method != HttpMethod.Post && method != HttpMethod.Put && method != HttpMethod.Patch) return@onCall
        // WS 升级握手是 GET（上面已排除），这里再显式挡一次非标准实现。
        if (call.request.headers[HttpHeaders.Upgrade]?.equals("websocket", ignoreCase = true) == true) return@onCall
        // chunked / 未知长度：没有声明可判，交给下面的 BeforeReceive 流式闸。
        val declared = call.request.contentLength() ?: return@onCall
        if (declared <= 0) return@onCall
        val limit = BodyLimits.limitFor(call.request.local.uri.substringBefore('?'))
        if (declared > limit.maxBytes) {
            throw PayloadTooLargeException(
                limit.errorCode,
                "请求体 $declared 字节，超过 ${limit.maxBytes / 1024 / 1024} MB 上限",
            )
        }
    }
    on(BeforeReceive) { call, content ->
        val limit = BodyLimits.limitFor(call.request.local.uri.substringBefore('?'))
        if (limit.maxBytes == Long.MAX_VALUE) return@on null
        content.applyLimit(limit.maxBytes, limit.errorCode)
    }
}

/**
 * receive pipeline 的 hook：在 `ApplicationReceivePipeline.Before` 阶段把原始 `ByteReadChannel` 替换成
 * 一个边读边计数的包装。copy 自 Ktor 官方 `body-limit` 插件的 `BeforeReceive`（该符号是私有的，这里复刻）。
 */
private object BeforeReceive : Hook<(PipelineCall, ByteReadChannel) -> ByteReadChannel?> {
    override fun install(
        pipeline: io.ktor.server.application.ApplicationCallPipeline,
        handler: (PipelineCall, ByteReadChannel) -> ByteReadChannel?,
    ) {
        pipeline.receivePipeline.intercept(ApplicationReceivePipeline.Before) {
            if (subject !is ByteReadChannel) return@intercept
            val result = handler(context, subject as ByteReadChannel)
            if (result != null) proceedWith(result)
        }
    }
}

/**
 * 边读边计数的 channel 包装（S2c）：超限立即抛 [PayloadTooLargeException]，不把超限字节读进内存。
 * 形状照 Ktor 官方 `body-limit` 插件的 `ByteReadChannel.applyLimit`，但抛的是自定义异常（见类注释）。
 */
@OptIn(DelicateCoroutinesApi::class)
private fun ByteReadChannel.applyLimit(limit: Long, code: String): ByteReadChannel =
    GlobalScope.writer {
        val buffer = ByteArray(8192)
        var total = 0L
        while (!isClosedForRead) {
            val read = readAvailable(buffer, 0, buffer.size)
            if (read <= 0) continue
            channel.writeFully(buffer, 0, read)
            total += read
            if (total > limit) {
                throw PayloadTooLargeException(code, "请求体超过 ${limit / 1024 / 1024} MB 上限")
            }
        }
        closedCause?.let { throw it }
    }.channel

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
