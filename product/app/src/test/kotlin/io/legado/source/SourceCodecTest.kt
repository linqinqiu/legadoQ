package io.legado.source

import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue

/**
 * 书源（Source）是 legado 最基础、最独特的内容形态：用户导入的不可信 JSON，
 * 由 [SourceCodec] 解析 / 校验后才能驱动搜书与阅读。这条解析链路没有任何单测，
 * 这里把最基础的契约钉死 —— 合法源能解析、缺地址的源被拒、URL 归一化、空规则与
 * 特殊字段（webView / preUpdateJs…）给出兼容性警告。
 */
class SourceCodecTest {

    private val fullSource = """
    {
      "bookSourceUrl": "https://example.com",
      "bookSourceName": "示例源",
      "ruleSearch": { "bookList": "x" },
      "ruleToc": { "bookList": "y" },
      "ruleContent": { "bookContent": "z" }
    }
    """.trimIndent()

    @Test
    fun `合法书源校验通过且能解析出 id 与名称`() {
        val resp = SourceCodec.validate(fullSource)
        assertTrue(resp.valid)
        val parsed = SourceCodec.parse(fullSource)
        assertEquals("https://example.com", parsed.id)
        assertEquals("示例源", parsed.name)
        assertTrue(parsed.hasRules)
    }

    @Test
    fun `缺少 bookSourceUrl 校验失败并给出明确错误`() {
        val text = """{"bookSourceName":"无地址源","ruleSearch":{"bookList":"x"}}"""
        val resp = SourceCodec.validate(text)
        assertFalse(resp.valid)
        assertTrue(resp.errors.any { "缺少 bookSourceUrl" in it })
    }

    @Test
    fun `非 JSON 文本校验失败`() {
        assertFalse(SourceCodec.validate("hello world").valid)
    }

    @Test
    fun `数组而非对象校验失败`() {
        assertFalse(SourceCodec.validate("[1,2,3]").valid)
    }

    @Test
    fun `相对协议 URL 归一化为 https`() {
        val parsed = SourceCodec.parse("""{"bookSourceUrl":"//example.com/path","ruleSearch":{"bookList":"x"}}""")
        assertEquals("https://example.com/path", parsed.id)
        assertEquals("https://example.com/path", parsed.url)
    }

    @Test
    fun `无规则的书源通过但给出警告`() {
        val resp = SourceCodec.validate("""{"bookSourceUrl":"https://empty.com","bookSourceName":"空规则"}""")
        assertTrue(resp.valid)
        assertTrue(resp.warnings.any { "没有任何规则字段" in it })
    }

    @Test
    fun `标记 webView 给出兼容性警告`() {
        val resp = SourceCodec.validate("""{"bookSourceUrl":"https://wv.com","webView":true,"ruleSearch":{"bookList":"x"}}""")
        assertTrue(resp.warnings.any { "webView" in it })
    }

    @Test
    fun `无名称时回落到 URL 作为名称`() {
        val parsed = SourceCodec.parse("""{"bookSourceUrl":"https://noname.com","ruleSearch":{"bookList":"x"}}""")
        assertEquals("https://noname.com", parsed.name)
    }

    @Test
    fun `超过 1MiB 的书源校验失败`() {
        val big = """{"bookSourceUrl":"https://big.com","ruleSearch":{"bookList":"x","pad":"${"a".repeat(1024 * 1024 + 100)}"}}"""
        assertFalse(SourceCodec.validate(big).valid)
    }
}
