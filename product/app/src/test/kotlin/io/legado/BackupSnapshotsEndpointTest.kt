package io.legado

import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.*
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

/**
 * GET /api/backup/snapshots 的 HTTP 层验证（②-b）：真装配下打这一条。
 * 只测 DbSnapshot 的纯逻辑不够——/api/diagnostics 那次就是"逻辑单测全绿、端点回异构 Map
 * 触发 ContentNegotiation 500"没人验到。这条锁住：路由能返回、且回的是可序列化的 JSON 数组。
 * 启动时 initialize() 已跑过一次快照（keep 默认 5），所以 fresh 库也应能列到 ≥1 份且 verified。
 */
class BackupSnapshotsEndpointTest {

    @Test
    fun `快照清单端点回 200 且是能解析的 JSON 数组`() = testApplication {
        val dir = Files.createTempDirectory("legado-snap-ep")
        val cfg = ServerConfig(
            host = "127.0.0.1", port = 8080,
            databasePath = Files.createTempFile("legado-snap-ep", ".sqlite").toString(),
            coverCacheDirectory = dir,
        )
        try {
            application { legadoApplication(cfg) }
            val client = createClient {
                install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
            }
            val resp = client.get("/api/backup/snapshots")
            assertEquals(HttpStatusCode.OK, resp.status)
            val body = resp.bodyAsText()
            val arr = Json.parseToJsonElement(body)
            assertTrue("应是 JSON 数组：$body", arr is kotlinx.serialization.json.JsonArray)
            assertTrue("启动应已留下一份快照：$body", arr.toString().contains("verified"))
        } finally {
            runCatching { dir.toFile().deleteRecursively() }
        }
    }

    @Test
    fun `排定恢复端点：合法快照名回 200 需重启，非法名回 400`() = testApplication {
        val dir = Files.createTempDirectory("legado-snap-restore-ep")
        val cfg = ServerConfig(
            host = "127.0.0.1", port = 8080,
            databasePath = Files.createTempFile("legado-snap-restore-ep", ".sqlite").toString(),
            coverCacheDirectory = dir,
        )
        try {
            application { legadoApplication(cfg) }
            val client = createClient { install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) } }
            val listed = Json.parseToJsonElement(client.get("/api/backup/snapshots").bodyAsText())
                as kotlinx.serialization.json.JsonArray
            val name = listed.firstNotNullOfOrNull {
                val o = it as kotlinx.serialization.json.JsonObject
                if ((o["verified"] as? kotlinx.serialization.json.JsonPrimitive)?.booleanOrNull == true)
                    (o["name"] as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull
                else null
            }
            assertTrue("启动应留有可验证快照", name != null)
            val ok = client.post("/api/backup/snapshots/restore") {
                contentType(ContentType.Application.Json); setBody("""{"name":"$name"}""")
            }
            assertEquals(HttpStatusCode.OK, ok.status)
            assertTrue("应报已排定且需重启：${ok.bodyAsText()}", ok.bodyAsText().contains("\"scheduled\":true"))
            assertTrue(ok.bodyAsText().contains("\"restartRequired\":true"))
            val bad = client.post("/api/backup/snapshots/restore") {
                contentType(ContentType.Application.Json); setBody("""{"name":"legado-9999999999.sqlite"}""")
            }
            assertEquals(HttpStatusCode.BadRequest, bad.status)
            assertTrue("非法快照应回 invalid_snapshot：${bad.bodyAsText()}", bad.bodyAsText().contains("invalid_snapshot"))
        } finally {
            runCatching { dir.toFile().deleteRecursively() }
        }
    }
}
