package io.legado

import io.ktor.client.request.*
import io.ktor.client.statement.bodyAsText
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.install
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.routing.*
import io.ktor.server.testing.testApplication
import io.legado.data.getSource
import io.legado.data.core.DbSnapshot
import io.legado.http.backupSourceVersionRoutes
import io.legado.model.SourceVersionListRequest
import io.legado.model.SourceVersionPreview
import io.legado.model.SourceVersionResult
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

class BackupSourceVersionsHttpTest {
    @Test fun `HTTP列出预览激活返回可序列化结果和安全快照 重放409`() = SourceVersionsFixture().use { f ->
        testApplication {
            application {
                install(ContentNegotiation) { json() }
                routing { route("/api") { backupSourceVersionRoutes(f.db, f.store) } }
            }
            val before = f.state()
            val listed = client.post("/api/backup/source-versions/list") {
                contentType(ContentType.Application.Json)
                setBody(Json.encodeToString(SourceVersionListRequest(f.archive)))
            }
            assertEquals(listed.bodyAsText(), HttpStatusCode.OK, listed.status)
            assertEquals("no-store", listed.headers[HttpHeaders.CacheControl])
            assertEquals(f.canonical, Json.parseToJsonElement(listed.bodyAsText()).jsonObject.getValue("groups")
                .jsonArray.single().jsonObject.getValue("sourceId").jsonPrimitive.content)
            val request = f.request(listOf(f.link()))
            val previewed = client.post("/api/backup/source-versions/preview") {
                contentType(ContentType.Application.Json); setBody(Json.encodeToString(request))
            }
            assertEquals(previewed.bodyAsText(), HttpStatusCode.OK, previewed.status)
            assertEquals("no-store", previewed.headers[HttpHeaders.CacheControl])
            val preview = Json.decodeFromString<SourceVersionPreview>(previewed.bodyAsText())
            assertEquals(before, f.state())
            val body = Json.encodeToString(request.copy(previewToken = preview.previewToken))
            val activated = client.post("/api/backup/source-versions/activate") {
                contentType(ContentType.Application.Json); setBody(body)
            }
            assertEquals(activated.bodyAsText(), HttpStatusCode.OK, activated.status)
            assertEquals("no-store", activated.headers[HttpHeaders.CacheControl])
            val result = Json.decodeFromString<SourceVersionResult>(activated.bodyAsText())
            assertEquals(f.canonical, result.sourceId)
            assertEquals(1, result.relinked)
            assertTrue(DbSnapshot.isVerified(f.db.dbPath, result.snapshot))
            assertEquals(preview.sourceVersion!! + 1, f.db.getSource(f.canonical)!!.version)
            val once = f.state()
            val replayed = client.post("/api/backup/source-versions/activate") {
                contentType(ContentType.Application.Json); setBody(body)
            }
            assertEquals(replayed.bodyAsText(), HttpStatusCode.Conflict, replayed.status)
            assertEquals("no-store", replayed.headers[HttpHeaders.CacheControl])
            assertEquals("source_version_changed", Json.parseToJsonElement(replayed.bodyAsText()).jsonObject.getValue("code").jsonPrimitive.content)
            assertEquals(once, f.state())
        }
    }

    @Test fun `三个POST端点均拒绝跨站请求且不写任何数据`() = SourceVersionsFixture().use { f ->
        testApplication {
            application {
                install(ContentNegotiation) { json() }
                routing { route("/api") { backupSourceVersionRoutes(f.db, f.store) } }
            }
            val before = f.state()
            val request = f.confirmed(listOf(f.link()))
            val snapshots = DbSnapshot.list(f.db.dbPath)
            for (path in listOf("list", "preview", "activate")) {
                val body = if (path == "list") Json.encodeToString(SourceVersionListRequest(f.archive)) else Json.encodeToString(request)
                val response = client.post("/api/backup/source-versions/$path") {
                    header(HttpHeaders.Origin, "https://foreign.example")
                    contentType(ContentType.Application.Json); setBody(body)
                }
                assertEquals(response.bodyAsText(), HttpStatusCode.Forbidden, response.status)
                assertTrue(response.bodyAsText().contains("cross_origin"))
            }
            assertEquals(before, f.state())
            assertEquals(snapshots, DbSnapshot.list(f.db.dbPath))
        }
    }

    @Test fun `无效版本路径和篡改证据返回400且不泄漏规则及目录`() = SourceVersionsFixture().use { f ->
        testApplication {
            application {
                install(ContentNegotiation) { json() }
                routing { route("/api") { backupSourceVersionRoutes(f.db, f.store) } }
            }
            val before = f.state()
            val cases = listOf(
                "list" to Json.encodeToString(SourceVersionListRequest("../${f.archive}")),
                "list" to Json.encodeToString(SourceVersionListRequest(f.archive, offset = -1)),
                "preview" to Json.encodeToString(f.request().copy(index = Int.MAX_VALUE)),
                "preview" to Json.encodeToString(f.request().copy(archive = f.archivePath.toString())),
                "activate" to Json.encodeToString(f.request()),
                "activate" to Json.encodeToString(f.request().copy(previewToken = "invalid")),
            )
            for ((path, body) in cases) {
                val response = client.post("/api/backup/source-versions/$path") {
                    contentType(ContentType.Application.Json); setBody(body)
                }
                assertEquals(response.bodyAsText(), HttpStatusCode.BadRequest, response.status)
                assertEquals("no-store", response.headers[HttpHeaders.CacheControl])
                assertTrue(response.bodyAsText().contains("invalid_source_version"))
                assertSafe(response.bodyAsText(), f)
            }
            Files.writeString(f.archivePath, Files.readString(f.archivePath).replace("旧规则-secret", "tampered-rule"))
            for (path in listOf("list", "preview")) {
                val response = client.post("/api/backup/source-versions/$path") {
                    contentType(ContentType.Application.Json)
                    setBody(if (path == "list") Json.encodeToString(SourceVersionListRequest(f.archive)) else Json.encodeToString(f.request()))
                }
                assertEquals(response.bodyAsText(), HttpStatusCode.BadRequest, response.status)
                assertEquals("no-store", response.headers[HttpHeaders.CacheControl])
                assertSafe(response.bodyAsText(), f)
            }
            assertEquals(before, f.state())
        }
    }

    @Test fun `确认期间阅读进度变化返回409 快照失败返回稳定500且均不应用`() = SourceVersionsFixture().use { f ->
        testApplication {
            application {
                install(ContentNegotiation) { json() }
                routing { route("/api") { backupSourceVersionRoutes(f.db, f.store) } }
            }
            val stale = f.confirmed(listOf(f.link()))
            f.execute("update reading_progress set char_offset=999 where source_id=? and book_url='one'", f.alias)
            val changed = f.state()
            val rejected = client.post("/api/backup/source-versions/activate") {
                contentType(ContentType.Application.Json); setBody(Json.encodeToString(stale))
            }
            assertEquals(rejected.bodyAsText(), HttpStatusCode.Conflict, rejected.status)
            assertTrue(rejected.bodyAsText().contains("source_version_changed"))
            assertEquals("no-store", rejected.headers[HttpHeaders.CacheControl])
            assertSafe(rejected.bodyAsText(), f)
            assertEquals(changed, f.state())
            val fresh = f.confirmed(listOf(f.link()))
            val backups = DbSnapshot.backupsDirOf(f.db.dbPath)
            val saved = f.directory.resolve("http-saved-backups")
            val existed = Files.exists(backups)
            if (existed) Files.move(backups, saved)
            Files.writeString(backups, "blocked")
            try {
                val failed = client.post("/api/backup/source-versions/activate") {
                    contentType(ContentType.Application.Json); setBody(Json.encodeToString(fresh))
                }
                assertEquals(failed.bodyAsText(), HttpStatusCode.InternalServerError, failed.status)
                assertEquals("no-store", failed.headers[HttpHeaders.CacheControl])
                assertTrue(failed.bodyAsText().contains("source_version_snapshot_failed"))
                assertSafe(failed.bodyAsText(), f)
                assertEquals(changed, f.state())
            } finally {
                Files.deleteIfExists(backups)
                if (existed) Files.move(saved, backups)
            }
        }
    }

    @Test fun `重关联执行异常不暴露SQL规则与服务端目录且事务回滚`() = SourceVersionsFixture().use { f ->
        f.execute("""create trigger reject_http_note_relink before update of source_id on book_note
            begin select raise(abort,'${f.directory} 旧规则-secret'); end""")
        testApplication {
            application {
                install(ContentNegotiation) { json() }
                routing { route("/api") { backupSourceVersionRoutes(f.db, f.store) } }
            }
            val before = f.state()
            val request = f.confirmed(listOf(f.link()))
            val response = client.post("/api/backup/source-versions/activate") {
                contentType(ContentType.Application.Json); setBody(Json.encodeToString(request))
            }
            assertEquals(response.bodyAsText(), HttpStatusCode.InternalServerError, response.status)
            assertEquals("no-store", response.headers[HttpHeaders.CacheControl])
            assertTrue(response.bodyAsText().contains("source_version_failed"))
            assertSafe(response.bodyAsText(), f)
            assertEquals(before, f.state())
        }
    }

    private fun assertSafe(body: String, fixture: SourceVersionsFixture) {
        assertFalse(body, body.contains(fixture.directory.toString()))
        assertFalse(body, body.contains("旧规则-secret"))
        assertFalse(body, body.contains("新规则-secret"))
        assertFalse(body, body.contains("tampered-rule"))
        assertFalse(body, body.contains("Exception"))
    }
}
