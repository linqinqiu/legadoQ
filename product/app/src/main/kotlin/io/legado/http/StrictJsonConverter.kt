package io.legado.http

import io.ktor.http.ContentType
import io.ktor.http.content.OutgoingContent
import io.ktor.serialization.ContentConverter
import io.ktor.serialization.kotlinx.KotlinxSerializationConverter
import io.ktor.serialization.kotlinx.serializerForTypeInfo
import io.ktor.server.plugins.BadRequestException
import io.ktor.util.reflect.TypeInfo
import io.ktor.utils.io.ByteReadChannel
import io.ktor.utils.io.readRemaining
import kotlinx.io.readByteArray
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.InternalSerializationApi
import kotlinx.serialization.json.Json
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction

/**
 * JSON 请求体的解码闸门：**字节不是声明的编码就 400，绝不带着替换字符入库**。
 *
 * 为什么要多这一层（2026-10-30 的真实事故）：Ktor 的 kotlinx 转换器把请求体按
 * `String(bytes, charset)` 解，遇到非法字节走 `REPLACE` —— 一个用 GBK 发中文的客户端
 * （cmd 里的 curl、某些脚本）发来的「体检异常」，会变成四个 `U+FFFD` 加一个残字存进
 * `source.source_group`，接口却回 200。界面上那串乱码既读不懂也搜不到，属于**静默改写用户数据**；
 * 数据一旦落库，原始字节就再也找不回来了。
 *
 * 现在在解码入口做严格解码：错的请求在边界上失败，报错里直接说清「用 UTF-8 发」。
 * 显式声明了 `charset=gbk` 之类的请求仍按声明的编码解 —— 老客户端只要把话说清楚就还能用。
 *
 * 响应方向完全委托给 Ktor 自带的转换器（同一份 [Json] 配置），序列化行为一个字没改。
 */
class StrictJsonConverter(private val format: Json) : ContentConverter {

    private val delegate = KotlinxSerializationConverter(format)

    override suspend fun serialize(
        contentType: ContentType,
        charset: Charset,
        typeInfo: TypeInfo,
        value: Any?,
    ): OutgoingContent? = delegate.serialize(contentType, charset, typeInfo, value)

    @OptIn(InternalSerializationApi::class, ExperimentalSerializationApi::class)
    override suspend fun deserialize(charset: Charset, typeInfo: TypeInfo, content: ByteReadChannel): Any? {
        val bytes = content.readRemaining().readByteArray()
        val text = try {
            charset.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes))
                .toString()
        } catch (error: CharacterCodingException) {
            throw BadRequestException(
                "请求体不是有效的 ${charset.name()} 文本：里面有无法解码的字节（最常见的原因是用 GBK/GB2312 " +
                    "发送了中文）。请按 UTF-8 重新发送；如果确实要用其它编码，请在 Content-Type 里写明 charset。"
            )
        }
        // 不是 kotlinx 能识别的类型（由别的转换器/原始字节负责）时，交回 Ktor 原路径，行为保持不变。
        val serializer = try {
            format.serializersModule.serializerForTypeInfo(typeInfo)
        } catch (error: IllegalArgumentException) {
            return delegate.deserialize(charset, typeInfo, ByteReadChannel(bytes))
        }
        return format.decodeFromString(serializer, text)
    }
}
