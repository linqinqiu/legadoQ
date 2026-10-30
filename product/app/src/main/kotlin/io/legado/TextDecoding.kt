package io.legado

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction

/**
 * 文本解码的共用口径。2026-10-30 的 GBK 覆盖事故之后，全仓只有这一份"怎么把字节变成文字"。
 *
 * 两类入口对应两类风险：
 * - [decodeStrict]：请求体/接口入参。字节不是声明的编码就直接抛 [CharacterCodingException]，
 *   由调用方回 400 并提示改用 UTF-8 —— 解析失败的请求宁可整条拒绝，也不写半个错字进库。
 * - [decodeTextAuto]：文件、订阅源这类"编码不由我们规定"的内容。BOM → UTF-8 → 声明 →
 *   GB18030 逐档试探，最后才用替换法兜底（文件已经拿到手了，总得给用户一个能看的结果）。
 *
 * 反例是必须防住的：`String(bytes, UTF_8)` **从不抛异常**，非法字节会被静默换成 U+FFFD。
 * 所以"先用它试试、不行再换编码"的写法是死代码 —— 以前备份导入的 GB18030 回退就是这么失效的。
 */

/** 严格解码：有任何一个无法解码的字节就抛 [CharacterCodingException]。 */
fun decodeStrict(bytes: ByteArray, charset: Charset): String =
    charset.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes))
        .toString()

/**
 * 从 `Content-Type` 里取 `charset`。取不到或写错都返回 null —— 响应头写错不该让整条链路失败。
 * 手动按 `;` 拆参数而不是用 `ContentType.parse`，是因为这里也收裸 header（java.net.http 的原文）。
 */
fun charsetOf(contentType: String?): Charset? {
    if (contentType.isNullOrBlank()) return null
    for (part in contentType.split(';')) {
        val eq = part.indexOf('=')
        if (eq <= 0) continue
        if (!part.substring(0, eq).trim().equals("charset", ignoreCase = true)) continue
        val name = part.substring(eq + 1).trim().trim('"', '\'')
        if (name.isEmpty()) return null
        return runCatching { Charset.forName(name) }.getOrNull()
    }
    return null
}

/**
 * 自动认编码：BOM → 严格 UTF-8 → 声明的编码 → 严格 GB18030 → UTF-8 替换法。
 *
 * 为什么"严格 UTF-8"排在响应头声明前面：能整份通过 UTF-8 校验的字节几乎肯定是 UTF-8，
 * 而服务器把 UTF-8 内容标成 GBK 这类谎报在野外很常见；反过来，GBK 中文能整体通过
 * UTF-8 校验的概率极低（GBK 汉字的前后字节基本落在 UTF-8 的非法区）。UTF-16/UTF-32 例外 ——
 * 纯 ASCII 的 UTF-16 文本在 UTF-8 看来也是合法的，必须先按声明解。
 *
 * [declared] 来自 HTTP 的 `Content-Type`，文件/备份传 null。
 */
fun decodeTextAuto(bytes: ByteArray, declared: Charset? = null): String {
    if (bytes.isEmpty()) return ""

    // 1. BOM 是内容自己写的声明，优先于响应头。UTF-32 的 BOM 以 FF FE 开头，这里不认它——
    //    先按 UTF-16LE 读出来至少能看见 NUL 前缀，比把整份当 UTF-8 乱码好。
    bomOf(bytes)?.let { (charset, offset) ->
        return String(bytes, offset, bytes.size - offset, charset)
    }
    // 2. 宽字符编码的声明必须优先：UTF-16LE 的纯 ASCII 内容在 UTF-8 看来也是合法的。
    if (declared != null && isWideCharset(declared)) {
        tryDecode(bytes, declared)?.let { return it }
    }
    // 3. 严格 UTF-8：整份都能通过，基本可以认定就是 UTF-8。
    tryDecode(bytes, Charsets.UTF_8)?.let { return it }
    // 4. 响应头声明的编码。
    if (declared != null && declared != Charsets.UTF_8) {
        tryDecode(bytes, declared)?.let { return it }
    }
    // 5. 老站点/老备份最常见的 GB18030（向下兼容 GBK、GB2312）。
    tryDecode(bytes, GB18030)?.let { return it }
    // 6. 实在认不出：替换法保证有结果。走到这里说明内容多半不是文本，
    //    调用方（JSON 解析/分章）会自己发现不对，不需要在这里再抛一次。
    return String(bytes, Charsets.UTF_8)
}

/** BOM 声明的编码与正文起点；没有 BOM 返回 null。 */
private fun bomOf(bytes: ByteArray): Pair<Charset, Int>? = when {
    bytes.size >= 3 && bytes[0] == 0xEF.toByte() && bytes[1] == 0xBB.toByte() && bytes[2] == 0xBF.toByte() ->
        Charsets.UTF_8 to 3
    bytes.size >= 2 && bytes[0] == 0xFE.toByte() && bytes[1] == 0xFF.toByte() ->
        Charsets.UTF_16BE to 2
    bytes.size >= 2 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xFE.toByte() ->
        Charsets.UTF_16LE to 2
    else -> null
}

private fun isWideCharset(charset: Charset): Boolean =
    charset.name().startsWith("UTF-16", ignoreCase = true) ||
        charset.name().startsWith("UTF-32", ignoreCase = true)

private fun tryDecode(bytes: ByteArray, charset: Charset): String? =
    try {
        decodeStrict(bytes, charset)
    } catch (_: CharacterCodingException) {
        null
    }

private val GB18030: Charset = Charset.forName("GB18030")
