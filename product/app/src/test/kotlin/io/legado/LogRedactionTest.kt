package io.legado

import io.legado.ops.LogRedaction
import io.legado.ops.LogService
import io.legado.port.LogCategory
import io.legado.port.LogLevel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 日志脱敏的两类判据：**该擦的擦干净**、**不该擦的一个字都不动**。
 *
 * 后一半比前一半重要：这份日志是用户排障的唯一现场，把 `page=2` / `bookUrl` 一起擦掉，
 * 等于用"安全"换"瞎"。
 */
class LogRedactionTest {

    @Test
    fun `query credentials are masked but the rest of the url survives`() {
        val cases = listOf(
            "https://a.com/search?token=abc123&page=2" to "https://a.com/search?token=***&page=2",
            "https://a.com/x?Key=SECRET&kw=%E5%A4%A9" to "https://a.com/x?Key=***&kw=%E5%A4%A9",
            "https://a.com/x?a=1&api_key=k-9&b=2" to "https://a.com/x?a=1&api_key=***&b=2",
            "https://a.com/x?sign=deadbeef&t=1" to "https://a.com/x?sign=***&t=1",
            "https://a.com/x?client_secret=s&grant=1" to "https://a.com/x?client_secret=***&grant=1",
            "https://a.com/x?password=pw&user=bob" to "https://a.com/x?password=***&user=bob",
            "https://a.com/x?sessionid=s1" to "https://a.com/x?sessionid=***",
            "https://a.com/x?code=oauth-code&state=1" to "https://a.com/x?code=***&state=1",
        )
        for ((input, expected) in cases) {
            assertEquals(input, expected, LogRedaction.redact(input))
        }
    }

    @Test
    fun `non-secret params are untouched`() {
        val cases = listOf(
            "https://a.com/search?page=2&keyword=%E5%89%91",
            "https://a.com/book/1.html",
            "https://a.com/x?keyword=token&page=1",
            "https://a.com/x?monkey=1",
            "规则：class.odd@href",
            "书源 JS 执行时间已用尽，中止网络请求",
        )
        for (input in cases) {
            assertEquals("不该被改：$input", input, LogRedaction.redact(input))
        }
    }

    @Test
    fun `header style credentials are masked`() {
        assertEquals(
            "Authorization: *** 已发送",
            LogRedaction.redact("Authorization: Bearer eyJhbGciOi.payload.sig 已发送"),
        )
        assertEquals("Cookie: ***", LogRedaction.redact("Cookie: sid=1; uid=2"))
        assertEquals("X-Api-Key=***", LogRedaction.redact("X-Api-Key=abc-123"))
        assertEquals("Set-Cookie: ***", LogRedaction.redact("Set-Cookie: a=b"))
    }

    @Test
    fun `bare bearer and basic tokens are masked`() {
        assertEquals("token was Bearer ***", LogRedaction.redact("token was Bearer abcdefgh12345678"))
        assertEquals("auth Basic ***", LogRedaction.redact("auth Basic dXNlcjpwYXNz"))
        // 短于 8 位的 "Basic" 不当作凭据，避免把普通英文句子擦掉。
        assertEquals("Basic 说明", LogRedaction.redact("Basic 说明"))
    }

    @Test
    fun `url userinfo is masked`() {
        assertEquals(
            "https://***:***@host/x?page=1",
            LogRedaction.redact("https://user:pass@host/x?page=1"),
        )
    }

    @Test
    fun `redaction is idempotent`() {
        val once = LogRedaction.redact("https://a.com/x?token=abc&page=2")
        assertEquals(once, LogRedaction.redact(once))
        assertFalse(once.contains("abc"))
    }

    /**
     * 出口判据：脱敏必须发生在**落库/入内存队列之前**，而不是只做成一个纯函数。
     * 这里走真实门面（`LogService`），读回内存队列里那一条。
     */
    @Test
    fun `log service stores redacted message and context but keeps the host`() {
        LogService.install()
        val marker = "脱敏出口判据-${System.nanoTime()}"
        LogService.log(
            LogCategory.NETWORK,
            LogLevel.WARN,
            "请求失败 $marker?token=super-secret&page=2",
            mapOf(
                "host" to "a.com",
                "url" to "https://a.com/api?token=super-secret&page=2",
                "statusCode" to "502",
            ),
        )
        val row = LogService.getRecentLogs(limit = 1000).single { it.message.contains(marker) }
        assertFalse("消息里的 token 必须已被擦掉：${row.message}", row.message.contains("super-secret"))
        assertTrue(row.message.contains("token=***"))
        assertTrue("非敏感参数要留着：${row.message}", row.message.contains("page=2"))
        assertEquals("https://a.com/api?token=***&page=2", row.context["url"])
        assertEquals("host 是定位主键，不能擦", "a.com", row.context["host"])
        assertEquals("502", row.context["statusCode"])
    }
}
