package io.legado

import io.legado.http.BodyLimits
import io.legado.http.PayloadTooLargeException
import io.legado.http.readBounded
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.InputStream

/**
 * S2 的纯逻辑判据：路径分档上限，以及 multipart 流式读取"边读边判、超限即停"。
 *
 * 这里不启动服务器 —— S2b 的核心是"读取过程中就停"，用一个永不 EOF 的流来逼它：
 * 若实现退化成 readBytes()（读到 EOF 才判），这个测试会因为永远读不完而超时。
 */
class BodyLimitTest {

    @Test
    fun `路径分档上限与错误码`() {
        val json = BodyLimits.limitFor("/api/replace-rules")
        assertEquals(8L * 1024 * 1024, json.maxBytes)
        assertEquals("body_too_large", json.errorCode)

        val backup = BodyLimits.limitFor("/api/backup/import")
        assertEquals(64L * 1024 * 1024, backup.maxBytes)
        assertEquals("backup_too_large", backup.errorCode)

        val icon = BodyLimits.limitFor("/brand/icon")
        assertEquals(5L * 1024 * 1024, icon.maxBytes)
        assertEquals("icon_too_large", icon.errorCode)
    }

    @Test
    fun `流式读取恰好等于上限时完整返回`() {
        val bytes = ByteArray(5000) { 0x61 }
        val result = readBounded(ByteArrayInputStream(bytes), 5000L, "icon_too_large", "图标")
        assertTrue(result.contentEquals(bytes))
    }

    @Test
    fun `流式读取跨多次小块累计超限时抛出且错误码正确`() {
        // 每次 read 只给 1KB，逼出"多块累计"而不是"单次读超限"的路径。
        val endless = object : InputStream() {
            override fun read(): Int = 0x61
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                val n = minOf(len, 1024)
                java.util.Arrays.fill(b, off, off + n, 0x61)
                return n // 永不返回 -1：读到 EOF 才算的旧实现会在这里永远转下去
            }
        }
        try {
            readBounded(endless, 5000L, "backup_too_large", "备份包")
            fail("累计超过 5000 字节应抛 PayloadTooLargeException")
        } catch (e: PayloadTooLargeException) {
            assertEquals("backup_too_large", e.errorCode)
            assertTrue(e.message!!.contains("备份包"))
        }
    }

    @Test
    fun `流式读取空输入返回空数组`() {
        val result = readBounded(ByteArrayInputStream(ByteArray(0)), 10L, "body_too_large", "请求体")
        assertEquals(0, result.size)
    }
}
