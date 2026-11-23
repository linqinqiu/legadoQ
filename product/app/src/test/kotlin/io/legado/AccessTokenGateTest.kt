package io.legado

import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.response.respond
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.ktor.server.testing.testApplication
import io.legado.http.AccessTokenGate
import io.legado.http.UnauthorizedException
import io.legado.model.ApiError
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S3-B 可选 token 鉴权闸判据。
 *
 * 用一个最小 application 精确控制"来源是否回环"：注入假的 isLoopback 判定，
 * 绕过 testApplication 固定用 127.0.0.1 的限制，端到端验证 401/放行两条分支。
 */
class AccessTokenGateTest {

    private val token = "s3-secret-token"

    /**
     * 最小 app 装配：ContentNegotiation + StatusPages(401) + AccessTokenGate + 只读探针路由。
     * [loopback] 决定注入的来源判定；[configuredToken] 为 null/空模拟"未设 token"。
     */
    private fun Application.setup(loopback: Boolean, configuredToken: String?) {
        install(ContentNegotiation) { json() }
        install(StatusPages) {
            exception<UnauthorizedException> { call, _ ->
                call.respond(HttpStatusCode.Unauthorized, ApiError("unauthorized", "需要访问令牌"))
            }
        }
        install(AccessTokenGate) {
            token = configuredToken
            isLoopback = { loopback }
        }
        routing { get("/probe") { call.respond(mapOf("ok" to true)) } }
    }

    @Test
    fun `未设 token 时非回环来源也放行（历史行为不变）`() = testApplication {
        application { setup(loopback = false, configuredToken = null) }
        assertEquals(HttpStatusCode.OK, client.get("/probe").status)
    }

    @Test
    fun `设了 token 后回环来源无凭据仍放行`() = testApplication {
        application { setup(loopback = true, configuredToken = token) }
        assertEquals(HttpStatusCode.OK, client.get("/probe").status)
    }

    @Test
    fun `非回环来源缺 token 返回 401`() = testApplication {
        application { setup(loopback = false, configuredToken = token) }
        val response = client.get("/probe")
        assertEquals(HttpStatusCode.Unauthorized, response.status)
        assertTrue("应回 unauthorized 错误码：${response.bodyAsText()}", response.bodyAsText().contains("unauthorized"))
    }

    @Test
    fun `非回环来源带错误 token 返回 401`() = testApplication {
        application { setup(loopback = false, configuredToken = token) }
        val response = client.get("/probe") { header(HttpHeaders.Authorization, "Bearer wrong-token") }
        assertEquals(HttpStatusCode.Unauthorized, response.status)
    }

    @Test
    fun `非回环来源带正确 Bearer 放行`() = testApplication {
        application { setup(loopback = false, configuredToken = token) }
        val response = client.get("/probe") { header(HttpHeaders.Authorization, "Bearer $token") }
        assertEquals(HttpStatusCode.OK, response.status)
    }

    @Test
    fun `非回环来源带 query token 放行（SSE WS 用这条）`() = testApplication {
        application { setup(loopback = false, configuredToken = token) }
        val response = client.get("/probe?token=$token")
        assertEquals(HttpStatusCode.OK, response.status)
    }

    @Test
    fun `Bearer 大小写不敏感且忽略首尾空格`() = testApplication {
        application { setup(loopback = false, configuredToken = token) }
        val response = client.get("/probe") { header(HttpHeaders.Authorization, "bearer   $token   ") }
        assertEquals(HttpStatusCode.OK, response.status)
    }

    @Test
    fun `非 Bearer 的 Authorization 头不算凭据`() = testApplication {
        application { setup(loopback = false, configuredToken = token) }
        val response = client.get("/probe") { header(HttpHeaders.Authorization, "Basic dXNlcjpwYXNz") }
        assertEquals(HttpStatusCode.Unauthorized, response.status)
    }

    @Test
    fun `空 token 配置等同未设（不鉴权）`() = testApplication {
        application { setup(loopback = false, configuredToken = "") }
        assertEquals(HttpStatusCode.OK, client.get("/probe").status)
    }

    /**
     * 走完整 legadoApplication（生产装配路径）：config.accessToken 正确传到插件。
     * testApplication 的来源固定是 127.0.0.1，真实 isLoopbackRemote 判为回环 → 设了 token 也放行。
     * 这条守的是"接线没接错"，避免插件单测全绿但 Application.kt 忘了读 config。
     */
    @Test
    fun `完整应用在设了 token 后回环来源仍放行`() = testApplication {
        application {
            legadoApplication(
                ServerConfig(
                    host = "127.0.0.1",
                    port = 8080,
                    databasePath = java.nio.file.Files.createTempFile("legado-s3-test", ".sqlite").toString(),
                    coverCacheDirectory = java.nio.file.Files.createTempDirectory("legado-s3-covers"),
                    accessToken = token,
                ),
            )
        }
        assertEquals(HttpStatusCode.OK, client.get("/healthz").status)
    }
}
