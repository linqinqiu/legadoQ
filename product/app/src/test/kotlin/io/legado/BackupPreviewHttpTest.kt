package io.legado

import io.ktor.client.request.*
import io.ktor.client.request.forms.*
import io.ktor.client.statement.bodyAsText
import io.ktor.client.call.body
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.install
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.routing.*
import io.ktor.server.testing.testApplication
import io.legado.backup.BackupStore
import io.legado.data.*
import io.legado.http.backupRoutes
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.nio.file.Files
import java.io.ByteArrayOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream
import org.junit.Assert.*
import org.junit.Test

class BackupPreviewHttpTest {
    @Test fun `迁移包 HTTP 导出预览确认保留字节 畸形包返回400 损坏目录导出不泄漏路径`() {
        val directory = Files.createTempDirectory("legado-migration-http")
        val database = Database(directory.resolve("test.sqlite").toString())
        val store = BackupStore(directory.resolve("kept"))
        fun body(bytes: ByteArray, previewToken: String? = null) = MultiPartFormDataContent(formData {
            append("file", bytes, Headers.build { append(HttpHeaders.ContentDisposition, "filename=\"migration.zip\"") })
            previewToken?.let {
                append("previewToken", it)
                append("libraryPolicy", """{"metadata":"keep_local","progress":"newer"}""")
            }
            append("sections", "[\"kept\"]")
        })
        try {
            database.initialize()
            val original = "[ {\"fontSize\": 23} ]\n"
            store.keep("readConfig.json", original)
            testApplication {
                application {
                    install(ContentNegotiation) { json() }
                    routing { route("/api") { backupRoutes(database, store) } }
                }
                val exported = client.get("/api/backup/export?domain=recovery")
                assertEquals(HttpStatusCode.OK, exported.status)
                assertTrue(exported.headers[HttpHeaders.ContentDisposition]!!.contains("legadoq-migration-"))
                val bytes = exported.body<ByteArray>()
                assertTrue("迁移响应必须包含完整ZIP字节", bytes.size > 100)
                Files.delete(directory.resolve("kept/readConfig.json"))
                val preview = client.post("/api/backup/import?preview=true") { setBody(body(bytes)) }
                assertEquals(preview.bodyAsText(), HttpStatusCode.OK, preview.status)
                assertTrue(store.list().isEmpty())
                val token = Json.parseToJsonElement(preview.bodyAsText()).jsonObject.getValue("previewToken").jsonPrimitive.content
                val confirmed = client.post("/api/backup/import") { setBody(body(bytes, token)) }
                assertEquals(confirmed.bodyAsText(), HttpStatusCode.OK, confirmed.status)
                assertEquals(original, store.read("readConfig.json"))
                for (manifest in listOf("{\"format\":\"legadoq-migration-v1\"}".toByteArray(), byteArrayOf(0xc3.toByte(), 0x28))) {
                    val corrupt = ByteArrayOutputStream()
                    ZipInputStream(bytes.inputStream()).use { source -> ZipOutputStream(corrupt).use { target ->
                        while (true) {
                            val entry = source.nextEntry ?: break
                            target.putNextEntry(ZipEntry(entry.name))
                            target.write(if (entry.name == "legadoq-migration.json") manifest else source.readBytes())
                            target.closeEntry()
                        }
                    } }
                    for (query in listOf("?preview=true", "")) {
                        val bad = client.post("/api/backup/import$query") { setBody(body(corrupt.toByteArray())) }
                        assertEquals(bad.bodyAsText(), HttpStatusCode.BadRequest, bad.status)
                        assertTrue(bad.bodyAsText().contains("invalid_backup"))
                        assertFalse(bad.bodyAsText().contains(directory.toString()))
                    }
                    assertEquals(original, store.read("readConfig.json"))
                }
                Files.writeString(directory.resolve("kept/source-variants-${"a".repeat(64)}.json"), "{}")
                val failed = client.get("/api/backup/export?domain=recovery")
                assertEquals(HttpStatusCode.InternalServerError, failed.status)
                assertTrue(failed.bodyAsText().contains("backup_export_failed"))
                assertFalse(failed.bodyAsText().contains(directory.toString()))
                assertFalse(failed.bodyAsText().contains("Exception"))
            }
        } finally { database.close(); directory.toFile().deleteRecursively() }
    }

    @Test fun `留档失败返回稳定错误且数据库回滚 不泄漏服务端路径`() {
        val directory = Files.createTempDirectory("legado-backup-archive-http")
        val database = Database(directory.resolve("test.sqlite").toString())
        val blocked = directory.resolve("blocked")
        Files.writeString(blocked, "不是目录")
        try {
            database.initialize()
            testApplication {
                application {
                    install(ContentNegotiation) { json() }
                    routing { route("/api") { backupRoutes(database, BackupStore(blocked)) } }
                }
                val response = client.post("/api/backup/import") {
                    setBody(MultiPartFormDataContent(formData {
                        append("file", """{"bookSource":[
                            {"bookSourceUrl":"https://collision.example/#甲","bookSourceName":"甲"},
                            {"bookSourceUrl":"https://collision.example/#乙","bookSourceName":"乙"}
                        ],"bookshelf":[{"origin":"https://collision.example/#甲","bookUrl":"book","name":"书"}]}""".toByteArray(),
                            Headers.build { append(HttpHeaders.ContentDisposition, "filename=\"backup.json\"") })
                    }))
                }
                assertEquals(HttpStatusCode.InternalServerError, response.status)
                val body = response.bodyAsText()
                assertTrue(body.contains("backup_archive_failed"))
                assertTrue(body.contains("已回滚"))
                assertFalse(body.contains(directory.toString()))
                assertFalse(body.contains("Exception"))
                assertTrue(database.listSources(null).isEmpty())
                assertTrue(database.listBookshelf().isEmpty())
            }
        } finally {
            database.close()
            directory.toFile().deleteRecursively()
        }
    }

    @Test fun `multipart preview is read only and confirmation imports selected modules only`() {
        val directory = Files.createTempDirectory("legado-backup-preview-http")
        val database = Database(directory.resolve("test.sqlite").toString())
        val store = BackupStore(directory.resolve("kept"))
        val content = """{"bookSource":[{"bookSourceUrl":"https://http.example/","bookSourceName":"源"}],"bookshelf":[{"origin":"https://http.example/","bookUrl":"book","name":"书"}],"readConfig":[{"fontSize":20}]}"""
        fun body(sections: String? = null, file: String = content, policy: String? = null, token: String? = null) = MultiPartFormDataContent(formData {
            append("file", file.toByteArray(), Headers.build {
                append(HttpHeaders.ContentDisposition, "filename=\"backup.json\"")
                append(HttpHeaders.ContentType, "application/json")
            })
            sections?.let { append("sections", it) }
            policy?.let { append("libraryPolicy", it) }
            token?.let { append("previewToken", it) }
        })
        try {
            database.initialize()
            testApplication {
                application {
                    install(ContentNegotiation) { json() }
                    routing { route("/api") { backupRoutes(database, store) } }
                }
                val preview = client.post("/api/backup/import?preview=true") { setBody(body()) }
                assertEquals(preview.bodyAsText(), HttpStatusCode.OK, preview.status)
                assertTrue(preview.bodyAsText().contains("\"policy\""))
                assertFalse(preview.bodyAsText().contains("\"sourcesUpdated\""))
                assertTrue(database.listSources(null).isEmpty())
                assertTrue(database.listBookshelf().isEmpty())
                assertTrue(store.list().isEmpty())
                val policy = """{"metadata":"keep_local","progress":"newer"}"""
                val token = Json.parseToJsonElement(preview.bodyAsText()).jsonObject.getValue("previewToken").jsonPrimitive.content
                for (invalidPolicy in listOf("not-json", "{}x", """{"progress":"typo"}""", """{"metadata":"newest"}""")) {
                    val response = client.post("/api/backup/import?preview=true") { setBody(body(policy = invalidPolicy)) }
                    assertEquals(response.bodyAsText(), HttpStatusCode.BadRequest, response.status)
                }
                val noToken = client.post("/api/backup/import") { setBody(body(policy = policy)) }
                assertEquals(HttpStatusCode.BadRequest, noToken.status)
                val changedFile = client.post("/api/backup/import") { setBody(body(file = content.replace("书\"", "变更书\""), policy = policy, token = token)) }
                assertEquals(changedFile.bodyAsText(), HttpStatusCode.Conflict, changedFile.status)
                assertTrue(database.listSources(null).isEmpty()); assertTrue(database.listBookshelf().isEmpty()); assertTrue(store.list().isEmpty())
                for (sections in listOf("[]", "[\"sources\",\"oops\"]", "not-json", "{}")) {
                    val response = client.post("/api/backup/import") { setBody(body(sections)) }
                    assertEquals(response.bodyAsText(), HttpStatusCode.BadRequest, response.status)
                    assertTrue(database.listSources(null).isEmpty())
                }
                val wrongMode = client.post("/api/backup/import?preview=tru") { setBody(body()) }
                assertEquals(HttpStatusCode.BadRequest, wrongMode.status)
                assertTrue(database.listSources(null).isEmpty())
                val invalid = client.post("/api/backup/import?preview=true") { setBody(body(file = "{broken")) }
                assertEquals(HttpStatusCode.BadRequest, invalid.status)
                val missing = client.post("/api/backup/import?preview=true") {
                    setBody(MultiPartFormDataContent(formData { append("password", "pw") }))
                }
                assertEquals(HttpStatusCode.BadRequest, missing.status)
                val foreign = client.post("/api/backup/import?preview=true") {
                    header(HttpHeaders.Origin, "https://foreign.invalid")
                    setBody(body())
                }
                assertEquals(HttpStatusCode.Forbidden, foreign.status)
                val imported = client.post("/api/backup/import") { setBody(body("[\"sources\"]")) }
                assertEquals(imported.bodyAsText(), HttpStatusCode.OK, imported.status)
                assertEquals(1, database.listSources(null).size)
                assertTrue(database.listBookshelf().isEmpty())
                assertTrue(store.list().isEmpty())
                // 旧调用方不带选择项时仍走完整导入。
                val legacy = client.post("/api/backup/import") { setBody(body()) }
                assertEquals(legacy.bodyAsText(), HttpStatusCode.OK, legacy.status)
                assertEquals(1, database.listBookshelf().size)
                assertEquals(1, store.list().size)
                // 本地行已改变：旧凭证不得覆盖，也不能先写入其余模块。
                val stale = client.post("/api/backup/import") { setBody(body(policy = policy, token = token)) }
                assertEquals(stale.bodyAsText(), HttpStatusCode.Conflict, stale.status)
                assertTrue(stale.bodyAsText().contains("backup_preview_changed"))
                val refreshed = client.post("/api/backup/import?preview=true") { setBody(body(policy = policy)) }
                val nextToken = Json.parseToJsonElement(refreshed.bodyAsText()).jsonObject.getValue("previewToken").jsonPrimitive.content
                val confirmed = client.post("/api/backup/import") { setBody(body("[\"shelf\"]", policy = policy, token = nextToken)) }
                assertEquals(confirmed.bodyAsText(), HttpStatusCode.OK, confirmed.status)
                assertTrue(confirmed.bodyAsText().contains("libraryDiff"))
            }
        } finally {
            database.close()
            directory.toFile().deleteRecursively()
        }
    }
}
