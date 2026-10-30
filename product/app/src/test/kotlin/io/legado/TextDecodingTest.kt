package io.legado

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import java.nio.charset.Charset
import java.nio.charset.CharacterCodingException
import java.nio.charset.StandardCharsets

/**
 * 共用解码口径：严格解码负责"宁可拒绝也不写坏"，自动探测负责"文件已经拿到手，总得给出正确文字"。
 *
 * 上一版备份导入的回退是死代码，就是因为 `String(bytes, UTF_8)` 从不抛异常——
 * 这里第一条用例专门钉住"严格解码确实会抛"。
 */
class TextDecodingTest {

    private val gbk = Charset.forName("GBK")
    private val text = "中文编码测试：书源备份"

    @Test
    fun `严格解码遇到 GBK 字节会抛错而不是替换`() {
        val bytes = text.toByteArray(gbk)
        assertThrows(CharacterCodingException::class.java) {
            decodeStrict(bytes, StandardCharsets.UTF_8)
        }
    }

    @Test
    fun `没有声明时 GBK 内容按 GB18030 认出来`() {
        val bytes = text.toByteArray(Charset.forName("GB18030"))
        assertEquals(text, decodeTextAuto(bytes))
    }

    @Test
    fun `UTF-8 内容永远按 UTF-8 读，哪怕声明说是 GBK`() {
        // 服务器把 UTF-8 标成 GBK 的谎报在野外很常见；严格 UTF-8 能通过就以它为准。
        val bytes = text.toByteArray(StandardCharsets.UTF_8)
        assertEquals(text, decodeTextAuto(bytes, gbk))
    }

    @Test
    fun `GBK 内容在声明为 UTF-8 时仍能救回来`() {
        val bytes = text.toByteArray(gbk)
        assertEquals(text, decodeTextAuto(bytes, StandardCharsets.UTF_8))
    }

    @Test
    fun `UTF-8 BOM 会被剥掉`() {
        val bytes = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()) + text.toByteArray(StandardCharsets.UTF_8)
        assertEquals(text, decodeTextAuto(bytes))
    }

    @Test
    fun `UTF-16LE 的 BOM 内容能读`() {
        val bytes = byteArrayOf(0xFF.toByte(), 0xFE.toByte()) + text.toByteArray(StandardCharsets.UTF_16LE)
        assertEquals(text, decodeTextAuto(bytes))
    }

    @Test
    fun `UTF-16BE 没有 BOM 时按声明解`() {
        val bytes = text.toByteArray(StandardCharsets.UTF_16BE)
        assertEquals(text, decodeTextAuto(bytes, StandardCharsets.UTF_16BE))
    }

    @Test
    fun `ASCII 内容任何路径都一致`() {
        val bytes = """{"bookSourceUrl":"https://example.com"}""".toByteArray(StandardCharsets.US_ASCII)
        assertEquals(String(bytes, StandardCharsets.UTF_8), decodeTextAuto(bytes))
        assertEquals(String(bytes, StandardCharsets.UTF_8), decodeTextAuto(bytes, gbk))
    }

    @Test
    fun `charsetOf 解析带参数的 Content-Type`() {
        assertNotNull(charsetOf("application/json; charset=GBK"))
        assertEquals(gbk, charsetOf("application/json; charset=GBK"))
        assertEquals(StandardCharsets.UTF_8, charsetOf("text/html; charset=\"utf-8\""))
        assertEquals(Charset.forName("GB2312"), charsetOf("text/plain;charset=gb2312"))
        assertNull(charsetOf("application/json"))
        assertNull(charsetOf(null))
        assertNull(charsetOf("text/plain; charset=not-a-real-charset"))
    }
}
