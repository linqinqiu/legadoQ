package io.legado

import io.ktor.server.testing.testApplication
import io.legado.http.isLoopbackBindHost
import io.legado.http.requireLoopbackBind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

/**
 * 启动期绑定闸门。
 *
 * 这台服务不设身份，写保护只有同源写门一道 —— 而那道门只对**浏览器**有效
 * （不带 Origin 的请求直接放行）。所以"能不能绑到 0.0.0.0"不是配置偏好，是安全边界：
 * 绑出去就等于整库对网络开放。这条判据盯的就是"不许悄悄绑出去"。
 */
class BindGuardTest {

    @Test
    fun `只有字面回环地址算本机`() {
        for (host in listOf("127.0.0.1", "127.0.0.2", "localhost", "LOCALHOST", "::1", "[::1]", " 127.0.0.1 ")) {
            assertTrue("「$host」应判为回环", isLoopbackBindHost(host))
        }
        for (host in listOf("0.0.0.0", "::", "[::]", "192.168.1.5", "10.0.0.1", "example.com", "")) {
            assertFalse("「$host」不应判为回环", isLoopbackBindHost(host))
        }
    }

    @Test
    fun `默认拒绝绑定到非回环地址`() {
        val error = assertThrows(IllegalStateException::class.java) {
            requireLoopbackBind("0.0.0.0", allowExternal = false)
        }
        assertTrue("错误话里要点名开关，否则用户不知道怎么办：${error.message}",
            error.message?.contains("LEGADO_ALLOW_EXTERNAL_BIND") == true)
    }

    @Test
    fun `显式放行时返回 true 以便上层写警告日志`() {
        assertEquals("回环不算外部绑定", false, requireLoopbackBind("127.0.0.1", allowExternal = false))
        assertEquals("显式放行的外部绑定要能被上层看见", true, requireLoopbackBind("0.0.0.0", allowExternal = true))
    }

    /** 真的起一次服务：绑 0.0.0.0 且未放行时，应用启动必须失败，而不是悄悄监听。 */
    @Test
    fun `绑非回环地址时应用启动直接失败`() {
        val dbPath = Files.createTempFile("legado-bind-guard", ".sqlite").toString()
        val tempDir = Files.createTempDirectory("legado-bind-guard-covers")
        try {
            val config = ServerConfig(
                host = "0.0.0.0",
                port = 8080,
                databasePath = dbPath,
                coverCacheDirectory = tempDir,
            )
            val error = runCatching {
                testApplication { application { legadoApplication(config) } }
            }.exceptionOrNull()
            assertTrue("绑 0.0.0.0 未放行时，启动应当抛错而不是静默监听", error != null)
        } finally {
            runCatching { Files.deleteIfExists(java.nio.file.Path.of(dbPath)) }
            runCatching { Files.deleteIfExists(java.nio.file.Path.of("$dbPath-wal")) }
            runCatching { Files.deleteIfExists(java.nio.file.Path.of("$dbPath-shm")) }
            runCatching { tempDir.toFile().deleteRecursively() }
        }
    }
}
