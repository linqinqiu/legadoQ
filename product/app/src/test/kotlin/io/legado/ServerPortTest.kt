package io.legado

import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.get
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.testing.testApplication
import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「设置 → 服务端口」（用户 2026-10-09：「用户可以自定义端口……重启生效」）。
 *
 * 判的是两件事：① `/api/server` 报的是**这次运行实际绑的**端口（不是 port.txt 里那个）；
 * ② 改端口只往安装根的 `port.txt` 写一行数字，越界要拒且不落文件。
 */
class ServerPortTest {

    private fun home(): Path = Files.createTempDirectory("legado-port-home")

    private fun config(home: Path) = ServerConfig(
        host = "127.0.0.1",
        port = 8080,
        databasePath = Files.createTempFile("legado-port-test", ".sqlite").toString(),
        coverCacheDirectory = Files.createTempDirectory("legado-port-covers"),
        homeDirectory = home,
    )

    @Test
    fun `GET server 报出这次运行实际绑的端口`() = testApplication {
        application { legadoApplication(config(home())) }
        val client = createClient { install(ContentNegotiation) { json() } }
        val body = client.get("/api/server").bodyAsText()
        assertTrue("要报 host 与 port，实际 $body", body.contains("\"port\":8080") && body.contains("127.0.0.1"))
    }

    @Test
    fun `PUT port 把端口写进安装根的端口文件`() = testApplication {
        val home = home()
        application { legadoApplication(config(home)) }
        val client = createClient { install(ContentNegotiation) { json() } }
        val response = client.put("/api/server/port") {
            contentType(ContentType.Application.Json)
            setBody("""{"port":1235}""")
        }
        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals("1235", Files.readString(home.resolve("port.txt")).trim())
    }

    @Test
    fun `PUT port 拒绝越界端口且不落文件`() = testApplication {
        val home = home()
        application { legadoApplication(config(home)) }
        val client = createClient { install(ContentNegotiation) { json() } }
        for (bad in listOf(0, 70000)) {
            val response = client.put("/api/server/port") {
                contentType(ContentType.Application.Json)
                setBody("""{"port":$bad}""")
            }
            assertEquals("端口 $bad 应被拒", HttpStatusCode.BadRequest, response.status)
        }
        assertFalse("越界不该写文件", Files.exists(home.resolve("port.txt")))
    }
}
