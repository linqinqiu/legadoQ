package io.legado

import io.ktor.client.call.body
import io.ktor.client.request.*
import io.ktor.client.request.forms.*
import io.ktor.client.statement.bodyAsText
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.install
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.routing.*
import io.ktor.server.testing.testApplication
import io.legado.backup.BackupStore
import io.legado.data.Database
import io.legado.http.backupRoutes
import io.legado.http.backupWebDavRoutes
import io.legado.model.BackupWebDavUpload
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class BackupWebDavHttpTest {
    @Test fun `HTTP 上传校验列出拉取ZIP进入只读预览 不自动恢复`() = WebDavFixture().use { dav ->
        val directory = Files.createTempDirectory("webdav-http")
        val database = Database(directory.resolve("test.sqlite").toString())
        val store = BackupStore(directory.resolve("kept"))
        try {
            database.initialize()
            store.keep("readConfig.json", "{\"fontSize\":23}")
            testApplication {
                application {
                    install(ContentNegotiation) { json() }
                    routing { route("/api") { backupRoutes(database, store); backupWebDavRoutes(database, store, dav.service()) } }
                }
                val uploaded = client.post("/api/backup/webdav/upload") {
                    contentType(ContentType.Application.Json); setBody(Json.encodeToString(dav.request()))
                }
                assertEquals(uploaded.bodyAsText(), HttpStatusCode.OK, uploaded.status)
                assertEquals("no-store", uploaded.headers[HttpHeaders.CacheControl])
                val result = Json.decodeFromString<BackupWebDavUpload>(uploaded.bodyAsText())
                assertTrue(result.verified)
                Files.delete(directory.resolve("kept/readConfig.json"))
                val list = client.post("/api/backup/webdav/list") {
                    contentType(ContentType.Application.Json); setBody(Json.encodeToString(dav.request()))
                }
                assertEquals(HttpStatusCode.OK, list.status)
                assertTrue(list.bodyAsText().contains(result.name))
                val pull = client.post("/api/backup/webdav/pull") {
                    contentType(ContentType.Application.Json); setBody(Json.encodeToString(dav.request(result.name)))
                }
                assertEquals(HttpStatusCode.OK, pull.status)
                assertTrue(pull.headers[HttpHeaders.ContentDisposition]!!.contains(result.name))
                val bytes = pull.body<ByteArray>()
                assertArrayEquals(dav.files.getValue(result.name), bytes)
                assertEquals(result.sha256, WebDavFixture.digest(bytes))
                assertTrue(store.list().isEmpty())
                val preview = client.post("/api/backup/import?preview=true") {
                    setBody(MultiPartFormDataContent(formData {
                        append("file", bytes, Headers.build { append(HttpHeaders.ContentDisposition, "filename=\"migration.zip\"") })
                    }))
                }
                assertEquals(preview.bodyAsText(), HttpStatusCode.OK, preview.status)
                assertTrue(preview.bodyAsText().contains("\"id\":\"kept\""))
                assertTrue(store.list().isEmpty())
            }
        } finally { database.close(); directory.toFile().deleteRecursively() }
    }

    @Test fun `WebDAV 三条接口拒绝跨站且错误不泄漏账号路径或远端正文`() = WebDavFixture().use { dav ->
        val directory = Files.createTempDirectory("webdav-http-error")
        val database = Database(directory.resolve("test.sqlite").toString())
        try {
            database.initialize()
            testApplication {
                application {
                    install(ContentNegotiation) { json() }
                    routing { route("/api") { backupWebDavRoutes(database, BackupStore(directory.resolve("kept")), dav.service()) } }
                }
                for (path in listOf("list", "upload", "pull")) {
                    val response = client.post("/api/backup/webdav/$path") {
                        header(HttpHeaders.Origin, "https://evil.example")
                        contentType(ContentType.Application.Json); setBody(Json.encodeToString(dav.request()))
                    }
                    assertEquals(HttpStatusCode.Forbidden, response.status)
                }
                assertTrue(dav.methods.isEmpty())
                for ((body, status, code) in listOf(
                    Triple(Json.encodeToString(dav.request().copy(password = "wrong-secret")), HttpStatusCode.BadGateway, "webdav_denied"),
                    Triple(Json.encodeToString(dav.request().copy(url = "http://user:secret@localhost/")), HttpStatusCode.BadRequest, "invalid_webdav"),
                    Triple("{broken", HttpStatusCode.BadGateway, "webdav_failed"),
                )) {
                    val response = client.post("/api/backup/webdav/list") { contentType(ContentType.Application.Json); setBody(body) }
                    assertEquals(response.bodyAsText(), status, response.status)
                    assertTrue(response.bodyAsText().contains(code))
                    assertFalse(response.bodyAsText().contains("secret"))
                    assertFalse(response.bodyAsText().contains("private-server-message"))
                    assertFalse(response.bodyAsText().contains(directory.toString()))
                }
            }
        } finally { database.close(); directory.toFile().deleteRecursively() }
    }
}
