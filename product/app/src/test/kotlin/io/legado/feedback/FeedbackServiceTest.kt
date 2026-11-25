package io.legado.feedback

import io.legado.model.FEEDBACK_TOKEN_HEADER
import io.legado.model.FeedbackRequest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FeedbackServiceTest {

    private data class Call(
        val url: String,
        val method: String,
        val headers: Map<String, String>,
        val body: String?,
    )

    private class CapturingHttp(
        var status: Int = 201,
        var responseBody: String = "",
    ) : FeedbackHttp {
        val calls = mutableListOf<Call>()

        override fun send(
            url: String,
            method: String,
            headers: Map<String, String>,
            body: String?,
        ): FeedbackOutcome {
            calls += Call(url, method, headers, body)
            return FeedbackOutcome(status, responseBody)
        }
    }

    @Test
    fun `submit sends only the allowlisted payload and uses return minimal`() {
        val http = CapturingHttp()
        val service = FeedbackService("https://example.supabase.co/", "anon-key", http)
        val tokenHash = "a".repeat(64)

        val outcome = service.submit(
            FeedbackRequest(
                category = "BUG",
                content = "  阅读器翻页后会跳动  ",
                contact = "  user@example.test  ",
                tokenHash = tokenHash,
            ),
        )

        assertTrue(outcome is SubmitOutcome.Ok)
        val call = http.calls.single()
        assertEquals("https://example.supabase.co/rest/v1/feedback", call.url)
        assertEquals("POST", call.method)
        assertEquals("anon-key", call.headers["apikey"])
        assertEquals("Bearer anon-key", call.headers["Authorization"])
        assertEquals("return=minimal", call.headers["Prefer"])

        val payload = Json.parseToJsonElement(call.body!!).jsonObject
        assertEquals("legadoQ", payload["app_id"]!!.jsonPrimitive.content)
        assertEquals("bug", payload["category"]!!.jsonPrimitive.content)
        assertEquals("阅读器翻页后会跳动", payload["content"]!!.jsonPrimitive.content)
        assertEquals("user@example.test", payload["contact"]!!.jsonPrimitive.content)
        assertEquals(tokenHash, payload["user_token_hash"]!!.jsonPrimitive.content)
        assertTrue(payload["metadata"]!!.jsonObject.isEmpty())
        assertTrue(payload.keys.none { it in setOf("ip", "user_agent", "device_id", "email") })
    }

    @Test
    fun `invalid submit is rejected before any outbound call`() {
        val http = CapturingHttp()
        val service = FeedbackService("https://example.supabase.co", "anon-key", http)
        val hash = "b".repeat(64)
        val invalid = listOf(
            FeedbackRequest(category = "other", content = "内容", tokenHash = hash),
            FeedbackRequest(category = "bug", content = "   ", tokenHash = hash),
            FeedbackRequest(category = "bug", content = "字".repeat(2001), tokenHash = hash),
            FeedbackRequest(category = "bug", content = "内容", contact = "联".repeat(201), tokenHash = hash),
            FeedbackRequest(category = "bug", content = "内容", tokenHash = "not-a-hash"),
        )

        for (request in invalid) {
            assertEquals(SubmitOutcome.Failed(400), service.submit(request))
        }
        assertTrue(http.calls.isEmpty())
    }

    @Test
    fun `missing configuration is a no op`() {
        val http = CapturingHttp()
        val service = FeedbackService("https://example.supabase.co", null, http)

        assertEquals(SubmitOutcome.NotConfigured, service.submit(FeedbackRequest(content = "内容", tokenHash = "a".repeat(64))))
        assertEquals(MineOutcome.NotConfigured, service.mine("a".repeat(64)))
        assertTrue(http.calls.isEmpty())
    }

    @Test
    fun `mine forwards the token hash and returns the upstream json`() {
        val http = CapturingHttp(status = 200, responseBody = "[{\"id\":1}]")
        val service = FeedbackService("https://example.supabase.co", "anon-key", http)
        val hash = "c".repeat(64)

        assertEquals(MineOutcome.Ok("[{\"id\":1}]"), service.mine(hash))
        val call = http.calls.single()
        assertEquals("GET", call.method)
        assertEquals("https://example.supabase.co/rest/v1/feedback?select=id,created_at,category,content&limit=20", call.url)
        assertEquals(hash, call.headers[FEEDBACK_TOKEN_HEADER])
    }

    @Test
    fun `invalid mine token never reaches supabase`() {
        val http = CapturingHttp()
        val service = FeedbackService("https://example.supabase.co", "anon-key", http)

        assertEquals(MineOutcome.InvalidToken, service.mine(null))
        assertEquals(MineOutcome.InvalidToken, service.mine("ABC"))
        assertTrue(http.calls.isEmpty())
    }

    @Test
    fun `upstream failures preserve status for the route to map`() {
        val http = CapturingHttp(status = 500)
        val service = FeedbackService("https://example.supabase.co", "anon-key", http)

        assertEquals(SubmitOutcome.Failed(500), service.submit(FeedbackRequest(content = "内容", tokenHash = "d".repeat(64))))
        assertEquals(MineOutcome.Failed(500), service.mine("d".repeat(64)))
    }
}
