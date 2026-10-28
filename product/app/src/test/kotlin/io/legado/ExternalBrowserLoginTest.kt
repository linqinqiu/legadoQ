package io.legado

import com.sun.net.httpserver.HttpServer
import io.legado.data.Database
import io.legado.source.ExternalBrowserLogin
import io.legado.source.historyHosts
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetSocketAddress
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.FileTime

/**
 * 真浏览器「重新附着」的单元测试：不拉真 Chromium，用一个只答 `/json/version` 的
 * 本地 HTTP 服务冒充调试端口。要钉住的是这样一件事 —— 服务重启后内存里的窗口句柄丢了，
 * 但只要 profile 里的 `DevToolsActivePort` 还有人在监听，状态就该是「已打开」，
 * 而不是被当成没开、进而再去启动第二个实例（Chromium 对同一 user-data-dir 会直接退出）。
 */
class ExternalBrowserLoginTest {

    private fun upServer(): Pair<HttpServer, Int> {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            val port = (exchange.localAddress as InetSocketAddress).port
            val body = """{"Browser":"Chrome/120.0.0.0","webSocketDebuggerUrl":"ws://127.0.0.1:$port/devtools/browser/fake"}"""
                .toByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json")
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        server.start()
        return server to server.address.port
    }

    private fun profileWithPort(dir: Path, port: Int) {
        Files.writeString(dir.resolve("DevToolsActivePort"), "$port\n/devtools/browser/fake")
    }

    @Test
    fun `status attaches to a browser left running by a previous server process`() {
        val (server, port) = upServer()
        val dir = Files.createTempDirectory("legado-browser-profile")
        val db = Database(Files.createTempFile("legado-browser-db", ".sqlite").toString())
        db.initialize()
        try {
            profileWithPort(dir, port)
            val login = ExternalBrowserLogin(db, dir)

            val running = login.status()
            assertNotNull("profile 里有活着的调试端口，就该附着成「已打开」", running)
            assertEquals(port, running!!.port)
            assertEquals("Chrome", running.browser)
            // 附着会话不是我们拉起的，拿不到 pid —— 界面据此不显示「进程 0」。
            assertEquals(0L, running.pid)
        } finally {
            server.stop(0)
            db.close()
        }
    }

    @Test
    fun `status ignores a stale port file and an empty profile`() {
        val dir = Files.createTempDirectory("legado-browser-profile-stale")
        val db = Database(Files.createTempFile("legado-browser-db", ".sqlite").toString())
        db.initialize()
        try {
            val login = ExternalBrowserLogin(db, dir)
            assertNull("profile 里什么都没有时不该有状态", login.status())

            // 端口文件还在、但没人监听（浏览器已经退了）：同样算没开。
            val deadPort = 1
            profileWithPort(dir, deadPort)
            assertNull("端口连不上就不该报告已打开", login.status())
        } finally {
            db.close()
        }
    }

    @Test
    fun `capture without a running browser stays empty instead of inventing cookies`() {
        val dir = Files.createTempDirectory("legado-browser-profile-capture")
        val db = Database(Files.createTempFile("legado-browser-db", ".sqlite").toString())
        db.initialize()
        try {
            val login = ExternalBrowserLogin(db, dir)
            assertTrue(login.capture(listOf("fanqienovel.com")).isEmpty())
            assertTrue(login.peekDomains(listOf("fanqienovel.com")).isEmpty())
        } finally {
            db.close()
        }
    }

    @Test
    fun `capture plan adds cookies set on login transit pages but not unrelated profile cookies`() {
        val dir = Files.createTempDirectory("legado-browser-profile-plan")
        val db = Database(Files.createTempFile("legado-browser-db", ".sqlite").toString())
        db.initialize()
        try {
            val login = ExternalBrowserLogin(db, dir)
            val cookies = listOf(
                ExternalBrowserLogin.BrowserCookie(".books.example", "session", "s1"),
                ExternalBrowserLogin.BrowserCookie(".passport.example", "sso", "token-new"),
                ExternalBrowserLogin.BrowserCookie(".ads.example", "tracker", "same"),
                ExternalBrowserLogin.BrowserCookie(".other.example", "token", "new"),
            )
            val baseline = mapOf(
                "passport.example|sso" to "token-old",
                "ads.example|tracker" to "same",
                "other.example|token" to "old",
            )

            val plan = login.capturePlan(
                cookies,
                baseline,
                // ads.example 开着页面但 Cookie 没变（登录前就有），不该被当成这次登录的成果；
                // other.example 的 Cookie 变了，但根本没在本窗口打开过，同样不认。
                setOf("https://books.example/", "https://passport.example/login", "https://ads.example/"),
                setOf("books.example"),
            )
            assertEquals(setOf("books.example", "passport.example"), plan)
        } finally {
            db.close()
        }
    }

    @Test
    fun `capture plan without a baseline only trusts the source domains`() {
        val dir = Files.createTempDirectory("legado-browser-profile-plan-nobase")
        val db = Database(Files.createTempFile("legado-browser-db", ".sqlite").toString())
        db.initialize()
        try {
            val login = ExternalBrowserLogin(db, dir)
            val cookies = listOf(
                ExternalBrowserLogin.BrowserCookie(".books.example", "session", "s1"),
                ExternalBrowserLogin.BrowserCookie(".passport.example", "sso", "token-new"),
            )
            // 服务重启后附着到旧窗口时没有基线：不知道登录从哪一刻开始，只认书源自己的域。
            val plan = login.capturePlan(cookies, null, setOf("https://passport.example/login"), setOf("books.example"))
            assertEquals(setOf("books.example"), plan)
        } finally {
            db.close()
        }
    }

    @Test
    fun `navigation history contributes only http page hosts`() {
        // 中转站登录完跳回书源后，当前标签只剩书源页；中转域只能从导航历史里认出来。
        val result = Json.parseToJsonElement(
            """
            {"entries":[
              {"url":"https://www.books.example/login"},
              {"url":"https://passport.example/sso?from=books"},
              {"url":"chrome://settings/"},
              {"url":"about:blank"},
              {"url":"http://127.0.0.1:8080/a"}
            ]}
            """.trimIndent(),
        ).jsonObject
        assertEquals(
            listOf("www.books.example", "passport.example", "127.0.0.1"),
            historyHosts(result),
        )
        assertTrue(historyHosts(null).isEmpty())
    }

    @Test
    fun `a port file left by the previous session is not taken as this launch's port`() {
        val dir = Files.createTempDirectory("legado-browser-profile-fresh-port")
        val db = Database(Files.createTempFile("legado-browser-db", ".sqlite").toString())
        db.initialize()
        try {
            val login = ExternalBrowserLogin(db, dir)
            profileWithPort(dir, 51520)
            val marker = dir.resolve("DevToolsActivePort")
            val old = System.currentTimeMillis() - 60_000
            Files.setLastModifiedTime(marker, FileTime.fromMillis(old))

            // 上次会话留下的端口文件还在：这次启动不能把它当成新窗口的端口，
            // 否则界面「已打开」是真的，抓 Cookie 却全发给一个死端口。
            assertNull(login.debugPortFrom(dir, System.currentTimeMillis()))

            // 本次启动后浏览器重写了文件：这才算数。
            profileWithPort(dir, 53024)
            Files.setLastModifiedTime(marker, FileTime.fromMillis(System.currentTimeMillis()))
            assertEquals(53024, login.debugPortFrom(dir, System.currentTimeMillis()))
        } finally {
            db.close()
        }
    }
}
