package io.legado

import io.legado.data.Database
import io.legado.rules.RuleRunner
import org.junit.Assert.assertEquals
import org.junit.Test
import java.nio.file.Files

/**
 * HTTP 层抽取到 `RuleHttp.kt` 前的判据护栏：钉住 `fetchResponse` 的透传（状态码/响应头/Set-Cookie）、
 * `fetch` 走注入的 `responseFetcher`、以及 `mergeCookieStrings` 的按键合并。
 * 其余 HTTP 行为由既有测试覆盖：`LooseUrlOptionsTest`（URL 选项）、`ResponseCharsetTest`（字符集）、
 * `RuleUrlScriptsTest`（地址 JS）、`RuleRunnerTest`（buildRequest/effectiveHeaders）。
 */
class RuleHttpGuardTest {

    private fun runner(): RuleRunner {
        val db = Database(Files.createTempFile("legado-http-guard", ".sqlite").toString())
        db.initialize()
        return RuleRunner(database = db)
    }

    @Test
    fun `fetchResponse passes through status headers and set-cookies from fetchedFetcher`() {
        val r = runner()
        r.fetchedFetcher = { url ->
            RuleRunner.Fetched(
                url = url,
                body = "hello-body",
                status = 201,
                headers = mapOf("x-test" to "v"),
                setCookies = listOf("a=1", "b=2"),
            )
        }
        val got = r.fetchResponse("https://example.com/x")
        assertEquals("https://example.com/x", got.url)
        assertEquals("hello-body", got.body)
        assertEquals(201, got.status)
        assertEquals("v", got.headers["x-test"])
        assertEquals(listOf("a=1", "b=2"), got.setCookies)
    }

    @Test
    fun `fetch returns the body from the injected responseFetcher`() {
        val r = RuleRunner(responseFetcher = { "mocked-body" })
        assertEquals("mocked-body", r.fetch("https://example.com/x"))
    }

    @Test
    fun `mergeCookieStrings merges per key with override winning`() {
        val r = runner()
        assertEquals("a=1; b=3; c=4", r.mergeCookieStrings("a=1; b=2", "b=3; c=4"))
        assertEquals("x=1", r.mergeCookieStrings(null, "x=1"))
        assertEquals("a=1", r.mergeCookieStrings("a=1", null))
        // 值里带 = 的照原样保留（只按第一个 = 切）
        assertEquals("t=a=b", r.mergeCookieStrings("t=a=b", null))
    }
}
