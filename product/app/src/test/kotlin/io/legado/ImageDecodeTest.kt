package io.legado

import io.legado.rules.ImageDecode
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

/**
 * `imageDecode` 返回值解析的判据：纯 Base64、data URL、坏数据、以及"解出来不是图片"的兜底。
 *
 * 这一层不跑 JS —— 它只回答"这段字符串能不能还原成图片字节"，
 * 跑 JS 的部分在 RuleRunner.imageDecoder 里，需要书源与沙箱。
 */
class ImageDecodeTest {

    private val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3)

    @Test
    fun `纯 Base64 还原成原字节`() {
        val encoded = Base64.getEncoder().encodeToString(png)
        assertArrayEquals(png, ImageDecode.parse(encoded))
    }

    @Test
    fun `data URL 前缀被剥掉`() {
        val encoded = Base64.getEncoder().encodeToString(png)
        assertArrayEquals(png, ImageDecode.parse("data:image/png;base64,$encoded"))
    }

    @Test
    fun `空串与非法 Base64 返回 null`() {
        assertNull(ImageDecode.parse(null))
        assertNull(ImageDecode.parse(""))
        assertNull(ImageDecode.parse("   "))
        assertNull(ImageDecode.parse("not base64 !!!"))
    }

    @Test
    fun `图片头判定能区分图片与文本字节`() {
        assertTrue(ImageDecode.looksLikeImage(png))
        assertTrue(ImageDecode.looksLikeImage(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0x00)))
        assertTrue(ImageDecode.looksLikeImage("GIF89a".toByteArray()))
        assertFalse(ImageDecode.looksLikeImage("decrypt failed".toByteArray()))
        assertFalse(ImageDecode.looksLikeImage(ByteArray(0)))
    }
}
