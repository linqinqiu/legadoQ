package io.legado

import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S2a 端到端判据：声明长度超限必须在路由处理器之前转成 413（body 一个字节都不读）。
 *
 * 用一个"解析必失败"的大 JSON body 打写端点：若闸生效 → 413 body_too_large；
 * 若闸失效、body 被读进 ContentNegotiation → 400 invalid_request。以此证明 413 发生在反序列化之前。
 */
class BodyLimitHttpTest {

    private fun config() = ServerConfig(
        host = "127.0.0.1",
        port = 8080,
        databasePath = Files.createTempFile("legado-bodylimit-test", ".sqlite").toString(),
        coverCacheDirectory = Files.createTempDirectory("legado-bodylimit-covers"),
    )

    @Test
    fun `超声明长度的写请求在反序列化前被挡成 413`() = testApplication {
        application { legadoApplication(config()) }
        val response = client.post("/api/replace-rules") {
            contentType(ContentType.Application.Json)
            // 9MB > 8MB 默认闸；内容是非法 JSON，若被读进反序列化会得到 400 而非 413
            setBody("x".repeat(9 * 1024 * 1024 + 1))
        }
        assertEquals(HttpStatusCode.PayloadTooLarge, response.status)
        assertTrue("错误码应是 body_too_large：${response.bodyAsText()}",
            response.bodyAsText().contains("body_too_large"))
    }

    @Test
    fun `图标端点的超声明长度返回专属错误码`() = testApplication {
        application { legadoApplication(config()) }
        val response = client.post("/brand/icon") {
            contentType(ContentType.Application.Json)
            setBody("x".repeat(5 * 1024 * 1024 + 1))
        }
        assertEquals(HttpStatusCode.PayloadTooLarge, response.status)
        assertTrue("错误码应是 icon_too_large：${response.bodyAsText()}",
            response.bodyAsText().contains("icon_too_large"))
    }

    @Test
    fun `正常大小的写请求与只读请求不受影响`() = testApplication {
        application { legadoApplication(config()) }
        val write = client.post("/api/replace-rules") {
            contentType(ContentType.Application.Json)
            setBody("""{"name":"小 body 规则","pattern":"aaa","replacement":"bbb","scope":"probe-bodylimit"}""")
        }
        assertTrue("正常写请求应放行，实际 ${write.status} ${write.bodyAsText()}",
            write.status == HttpStatusCode.OK || write.status == HttpStatusCode.Created)
        assertEquals(HttpStatusCode.OK, client.get("/healthz").status)
    }
}
