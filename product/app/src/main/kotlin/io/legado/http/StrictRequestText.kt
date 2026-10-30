package io.legado.http

import io.ktor.http.charset
import io.ktor.server.application.ApplicationCall
import io.ktor.server.plugins.BadRequestException
import io.ktor.server.request.contentType
import io.ktor.server.request.receiveChannel
import io.ktor.utils.io.readRemaining
import io.legado.decodeStrict
import kotlinx.io.readByteArray
import java.nio.charset.CharacterCodingException
import java.nio.charset.Charset

/**
 * `call.receiveText()` 的严格版：按 `Content-Type` 声明的编码解码，遇到非法字节直接 400。
 *
 * Ktor 自带的 `receiveText()` 走 `readText(charset)`，非法字节被换成 U+FFFD 后照常返回 ——
 * 用 GBK 发中文的客户端会得到 200，库里却是乱码（2026-10-30 的净化规则导入就踩在这上面：
 * 导入一批中文规则，存进去的是一串替换字符）。JSON 请求体已由 [StrictJsonConverter] 统一拦截；
 * 这个函数给**按原始文本读**的接口（净化规则导入、外部浏览器登录地址）用同一条口径。
 */
suspend fun ApplicationCall.receiveStrictText(): String {
    val declared = runCatching { request.contentType()?.charset() }.getOrNull()
    val charset = declared ?: Charsets.UTF_8
    val bytes = receiveChannel().readRemaining().readByteArray()
    return try {
        decodeStrict(bytes, charset)
    } catch (error: CharacterCodingException) {
        throw BadRequestException(invalidBodyEncodingMessage(charset))
    }
}

/** 请求体编码错误时的统一说法：讲清楚发生了什么、怎么办。 */
internal fun invalidBodyEncodingMessage(charset: Charset): String =
    "请求体不是有效的 ${charset.name()} 文本：里面有无法解码的字节（最常见的原因是用 GBK/GB2312 " +
        "发送了中文）。请按 UTF-8 重新发送；如果确实要用其它编码，请在 Content-Type 里写明 charset。"
