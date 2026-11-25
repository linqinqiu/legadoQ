package io.legado.http

import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.routing.route
import io.ktor.server.routing.routing
import io.ktor.server.testing.testApplication
import io.legado.feedback.FeedbackHttp
import io.legado.feedback.FeedbackOutcome
import io.legado.feedback.FeedbackService
import io.legado.model.FEEDBACK_TOKEN_HEADER
import io.legado.model.FeedbackRequest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FeedbackRoutesHttpTest {

    private fun Application.setup(service: FeedbackService) {
        install(ContentNegotiation) { json() }
        routing {
            route("/api") {
                feedbackRoutes(service)
            }
        }
    }

    @Test
    fun `unconfigured relay returns a stable fallback signal`() = testApplication {
        application { setup(FeedbackService(null, null)) }
        val response = client.post("/api/feedback") {
            contentType(ContentType.Application.Json)
            setBody(Json.encodeToString(FeedbackRequest(content = "建议", tokenHash = "a".repeat(64))))
        }

        assertEquals(HttpStatusCode.Conflict, response.status)
        assertTrue(response.bodyAsText().contains("feedback_not_configured"))
    }

    @Test
    fun `valid submit returns ok and sends the request upstream`() = testApplication {
        var sent = 0
        val service = FeedbackService(
            "https://example.supabase.co",
            "anon-key",
            FeedbackHttp { _, _, _, _ -> sent++; FeedbackOutcome(201) },
        )
        application { setup(service) }

        val response = client.post("/api/feedback") {
            contentType(ContentType.Application.Json)
            setBody(Json.encodeToString(FeedbackRequest(content = "建议", tokenHash = "a".repeat(64))))
        }

        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals(1, sent)
        assertTrue(response.bodyAsText().contains("\"ok\":true"))
    }

    @Test
    fun `invalid category and malformed json are client errors`() = testApplication {
        val service = FeedbackService("https://example.supabase.co", "anon-key", FeedbackHttp { _, _, _, _ -> FeedbackOutcome(201) })
        application { setup(service) }

        val invalid = client.post("/api/feedback") {
            contentType(ContentType.Application.Json)
            setBody(Json.encodeToString(FeedbackRequest(category = "other", content = "建议", tokenHash = "a".repeat(64))))
        }
        assertEquals(HttpStatusCode.BadRequest, invalid.status)
        assertTrue(invalid.bodyAsText().contains("invalid_feedback"))

        val malformed = client.post("/api/feedback") {
            contentType(ContentType.Application.Json)
            setBody("{")
        }
        assertEquals(HttpStatusCode.BadRequest, malformed.status)
        assertTrue(malformed.bodyAsText().contains("invalid_request"))
    }

    @Test
    fun `upstream failure is a bad gateway without leaking details`() = testApplication {
        val service = FeedbackService("https://example.supabase.co", "anon-key", FeedbackHttp { _, _, _, _ -> FeedbackOutcome(500, "secret upstream detail") })
        application { setup(service) }

        val response = client.post("/api/feedback") {
            contentType(ContentType.Application.Json)
            setBody(Json.encodeToString(FeedbackRequest(content = "建议", tokenHash = "a".repeat(64))))
        }

        assertEquals(HttpStatusCode.BadGateway, response.status)
        assertTrue(response.bodyAsText().contains("feedback_upstream_failed"))
        assertTrue(!response.bodyAsText().contains("secret upstream detail"))
    }

    @Test
    fun `mine validates the token and relays only the selected fields`() = testApplication {
        val service = FeedbackService(
            "https://example.supabase.co",
            "anon-key",
            FeedbackHttp { _, _, headers, _ -> FeedbackOutcome(200, "[{\"id\":1}]").also { assertEquals("a".repeat(64), headers[FEEDBACK_TOKEN_HEADER]) } },
        )
        application { setup(service) }

        val invalid = client.get("/api/feedback/mine")
        assertEquals(HttpStatusCode.BadRequest, invalid.status)
        assertTrue(invalid.bodyAsText().contains("invalid_feedback_token"))

        val valid = client.get("/api/feedback/mine") {
            header(FEEDBACK_TOKEN_HEADER, "a".repeat(64))
        }
        assertEquals(HttpStatusCode.OK, valid.status)
        assertEquals("[{\"id\":1}]", valid.bodyAsText())
    }

    @Test
    fun `cross origin submit is rejected`() = testApplication {
        val service = FeedbackService("https://example.supabase.co", "anon-key", FeedbackHttp { _, _, _, _ -> FeedbackOutcome(201) })
        application { setup(service) }

        val response = client.post("/api/feedback") {
            header(HttpHeaders.Origin, "https://attacker.example")
            contentType(ContentType.Application.Json)
            setBody(Json.encodeToString(FeedbackRequest(content = "建议", tokenHash = "a".repeat(64))))
        }

        assertEquals(HttpStatusCode.Forbidden, response.status)
    }
}
