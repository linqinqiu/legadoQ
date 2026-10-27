package io.legado.rules

import java.util.Base64

/**
 * `ruleContent.imageDecode` 的返回值解析。
 *
 * 约定（与沙箱里暴露的 `result` 对称）：
 * - JS 拿到的是原图字节的 Base64 字符串（绑定名 `result`）；
 * - JS 返回的可以是**纯 Base64**，也可以是 `data:image/…;base64,…` 这种 data URL；
 * - 返回空串、非法 Base64、或不是图片字节时返回 null，调用方回退原图 ——
 *   解密失败不该让用户连原图都看不到。
 *
 * 只做解析，不跑 JS：JS 执行在 [RuleRunner.imageDecoder] 里，判据可以单独打这一层。
 */
object ImageDecode {

    private val DATA_URL = Regex("^data:image/[a-zA-Z0-9.+-]+;base64,", RegexOption.IGNORE_CASE)

    /**
     * 把 JS 返回值解析成图片字节。
     *
     * @param raw JS 返回的字符串（纯 Base64 或 data URL）
     * @returns 解密后的字节；解析不出来返回 null
     */
    fun parse(raw: String?): ByteArray? {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return null
        val payload = DATA_URL.replaceFirst(text, "")
        if (payload.isEmpty()) return null
        val bytes = runCatching {
            Base64.getDecoder().decode(payload)
        }.recoverCatching {
            // 部分源用 URL-safe Base64
            Base64.getUrlDecoder().decode(payload)
        }.getOrNull() ?: return null
        return bytes.takeIf { it.isNotEmpty() }
    }

    /**
     * 判断一段字节是不是常见的图片格式（PNG / JPEG / GIF / WEBP）。
     *
     * 解密脚本跑错时经常返回一段文本字节；把它当图片回给浏览器会是一张裂图，
     * 不如判出来直接回退原图。
     *
     * @param bytes 待判字节
     * @returns 是图片返回 true
     */
    fun looksLikeImage(bytes: ByteArray): Boolean {
        if (bytes.size < 4) return false
        fun at(index: Int, vararg expected: Int) = expected.indices.all { bytes[index + it].toInt() and 0xFF == expected[it] }
        return when {
            at(0, 0x89, 0x50, 0x4E, 0x47) -> true      // PNG
            at(0, 0xFF, 0xD8, 0xFF) -> true            // JPEG
            at(0, 0x47, 0x49, 0x46, 0x38) -> true      // GIF8
            bytes.size >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50) -> true // WEBP
            else -> false
        }
    }
}
