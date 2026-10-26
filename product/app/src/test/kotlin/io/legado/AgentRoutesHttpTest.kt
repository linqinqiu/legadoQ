package io.legado

import io.ktor.client.*
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.client.request.*
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

// 校验 `/api/agent/*` 这一组自定义接入面的 HTTP 行为。
// manifest / connections 是只读（无写门），不需 Origin；connections 的 POST / DELETE 是写操作，
// 同源写门按 Ktor 测试默认（同进程内放行）放行。sources 新建/校验、comprehend 走各自处理器。
// 用临时 homeDirectory 隔离 agent-profiles.json，避免污染本机配置。
// 回包统一走 bodyAsText + Json.parseToJsonElement，避免 kotlinx 对擦除类型 Map<String,Any> 无序列化器。
class AgentRoutesHttpTest {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    private fun tempDir(tag: String) = Files.createTempDirectory("legado-agent-$tag")

    private fun ApplicationTestBuilder.makeClient() = createClient {
        install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
    }

    private suspend fun readJson(resp: HttpResponse): JsonElement =
        json.parseToJsonElement(resp.bodyAsText())

    @Test
    fun `GET manifest returns disabled and no builtin connection`() = testApplication {
        val dbPath = Files.createTempFile("legado-agent-manifest", ".sqlite").toString()
        val home = tempDir("home-manifest")
        try {
            application { legadoApplication(serverConfig(dbPath, home)) }
            val c = makeClient()
            val resp = c.get("/api/agent/manifest")
            assertEquals(HttpStatusCode.OK, resp.status)
            val body = readJson(resp).jsonObject
            assertEquals(false, body["enabled"]?.jsonPrimitive?.boolean)
            val builtin = body["builtinConnections"]?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty()
            assertTrue("no builtin connections anymore", builtin.isEmpty())
        } finally {
            cleanup(dbPath, home)
        }
    }

    @Test
    fun `GET connections is empty before registering`() = testApplication {
        val dbPath = Files.createTempFile("legado-agent-conn", ".sqlite").toString()
        val home = tempDir("home-conn")
        try {
            application { legadoApplication(serverConfig(dbPath, home)) }
            val c = makeClient()
            val resp = c.get("/api/agent/connections")
            assertEquals(HttpStatusCode.OK, resp.status)
            val list = readJson(resp).jsonArray
            assertTrue("list should be empty", list.isEmpty())
        } finally {
            cleanup(dbPath, home)
        }
    }

    @Test
    fun `POST then DELETE a user connection`() = testApplication {
        val dbPath = Files.createTempFile("legado-agent-crud", ".sqlite").toString()
        val home = tempDir("home-crud")
        try {
            application { legadoApplication(serverConfig(dbPath, home)) }
            val c = makeClient()
            val create = c.post("/api/agent/connections") {
                contentType(ContentType.Application.Json)
                setBody("""{"name":"test-gateway","kind":"openai-compatible","baseUrl":"https://example.com/v1","model":"gpt-4o"}""")
            }
            assertEquals("create should be 200: ${create.status}", HttpStatusCode.OK, create.status)
            val created = readJson(create).jsonObject
            val id = created["id"]?.jsonPrimitive?.content ?: ""
            assertNotEquals("local", id)
            val del = c.delete("/api/agent/connections/$id")
            assertEquals(HttpStatusCode.OK, del.status)
            val again = c.delete("/api/agent/connections/$id")
            assertEquals(HttpStatusCode.NotFound, again.status)
        } finally {
            cleanup(dbPath, home)
        }
    }

    @Test
    fun `DELETE missing connection returns 404`() = testApplication {
        val dbPath = Files.createTempFile("legado-agent-builtin", ".sqlite").toString()
        val home = tempDir("home-builtin")
        try {
            application { legadoApplication(serverConfig(dbPath, home)) }
            val c = makeClient()
            val resp = c.delete("/api/agent/connections/local")
            assertEquals(HttpStatusCode.NotFound, resp.status)
        } finally {
            cleanup(dbPath, home)
        }
    }

    @Test
    fun `POST sources validate reports errors without persisting`() = testApplication {
        val dbPath = Files.createTempFile("legado-agent-validate", ".sqlite").toString()
        val home = tempDir("home-validate")
        try {
            application { legadoApplication(serverConfig(dbPath, home)) }
            val c = makeClient()
            val resp = c.post("/api/agent/sources/validate") {
                contentType(ContentType.Application.Json)
                setBody("""{"json":"not a valid source"}""")
            }
            assertEquals(HttpStatusCode.OK, resp.status)
            val body = readJson(resp).jsonObject
            assertEquals(false, body["valid"]?.jsonPrimitive?.boolean)
            val errs = body["errors"]?.jsonArray.orEmpty()
            assertTrue("should report errors", errs.isNotEmpty())
        } finally {
            cleanup(dbPath, home)
        }
    }

    @Test
    fun `POST sources creates a source`() = testApplication {
        val dbPath = Files.createTempFile("legado-agent-create", ".sqlite").toString()
        val home = tempDir("home-create")
        try {
            application { legadoApplication(serverConfig(dbPath, home)) }
            val c = makeClient()
            // `SourceWriteRequest.json` 是 String 字段：json 必须作为转义后的 JSON 字符串值传入，不能是嵌套对象。
            val sourceJson = """{"bookSourceName":"agent-test-source","bookSourceUrl":"https://agent-test.example.com","enabled":true,"searchUrl":"https://agent-test.example.com/s?q={{key}}"}"""
            val resp = c.post("/api/agent/sources") {
                contentType(ContentType.Application.Json)
                setBody("""{"json":"${sourceJson.replace("\"", "\\\"")}"}""")
            }
            assertEquals("create should be 201: ${resp.status}", HttpStatusCode.Created, resp.status)
            val body = readJson(resp).jsonObject
            assertNotNull(body["id"]?.jsonPrimitive?.content)
            assertNotNull(body["version"]?.jsonPrimitive?.long)
        } finally {
            cleanup(dbPath, home)
        }
    }

    @Test
    fun `POST comprehend without connection returns 409`() = testApplication {
        val dbPath = Files.createTempFile("legado-agent-comprehend", ".sqlite").toString()
        val home = tempDir("home-comprehend")
        try {
            application { legadoApplication(serverConfig(dbPath, home)) }
            val c = makeClient()
            val text = "QingYue is a single-machine reader. It uses SQLite. It supports source rules."
            val resp = c.post("/api/agent/comprehend") {
                contentType(ContentType.Application.Json)
                setBody("""{"text":"$text","question":"What is QingYue?"}""")
            }
            assertEquals("comprehend should be 409: ${resp.status}", HttpStatusCode.Conflict, resp.status)
            val body = readJson(resp).jsonObject
            assertEquals("no_connection", body["code"]?.jsonPrimitive?.content)
        } finally {
            cleanup(dbPath, home)
        }
    }

    @Test
    fun `POST chat without connection returns 409`() = testApplication {
        val dbPath = Files.createTempFile("legado-agent-chat", ".sqlite").toString()
        val home = tempDir("home-chat")
        try {
            application { legadoApplication(serverConfig(dbPath, home)) }
            val c = makeClient()
            val resp = c.post("/api/agent/chat") {
                contentType(ContentType.Application.Json)
                setBody("""{"messages":[{"role":"user","content":"ping"}]}""")
            }
            assertEquals("chat should be 409: ${resp.status}", HttpStatusCode.Conflict, resp.status)
            val body = readJson(resp).jsonObject
            assertEquals("no_connection", body["code"]?.jsonPrimitive?.content)
        } finally {
            cleanup(dbPath, home)
        }
    }

    private fun serverConfig(dbPath: String, home: Path) = ServerConfig(
        host = "127.0.0.1", port = 8080, databasePath = dbPath,
        coverCacheDirectory = Files.createTempDirectory("legado-agent-covers"),
        homeDirectory = home,
    )

    private fun cleanup(dbPath: String, vararg dirs: Path) {
        runCatching { Files.deleteIfExists(Path.of(dbPath)) }
        runCatching { Files.deleteIfExists(Path.of("$dbPath-wal")) }
        runCatching { Files.deleteIfExists(Path.of("$dbPath-shm")) }
        dirs.forEach { runCatching { it.toFile().deleteRecursively() } }
    }
}