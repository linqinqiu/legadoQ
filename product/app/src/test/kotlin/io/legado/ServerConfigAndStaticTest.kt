package io.legado

import io.ktor.client.*
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

class ServerConfigAndStaticTest {

    @Test
    fun `server config from environment handles defaults and custom settings`() {
        // Default environment
        val defaultConfig = ServerConfig.fromEnvironment(emptyMap())
        assertEquals("127.0.0.1", defaultConfig.host)
        assertEquals(8080, defaultConfig.port)
        assertTrue(defaultConfig.databasePath.endsWith("legado.sqlite"))
        assertTrue(defaultConfig.coverCacheDirectory.endsWith("covers"))

        // Custom environment
        val customEnv = mapOf(
            "LEGADO_HOST" to "0.0.0.0",
            "LEGADO_PORT" to "9090",
            "LEGADO_DATABASE" to "/tmp/test.db",
        )
        val customConfig = ServerConfig.fromEnvironment(customEnv)
        assertEquals("0.0.0.0", customConfig.host)
        assertEquals(9090, customConfig.port)
        assertEquals("/tmp/test.db", customConfig.databasePath)
    }

}
