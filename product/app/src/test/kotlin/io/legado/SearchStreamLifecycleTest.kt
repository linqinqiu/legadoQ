package io.legado

import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.client.request.header
import io.ktor.http.HttpHeaders
import io.ktor.server.application.install
import io.ktor.server.routing.route
import io.ktor.server.routing.routing
import io.ktor.server.testing.testApplication
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import io.ktor.websocket.readText
import io.legado.data.Database
import io.legado.data.saveSource
import io.legado.http.searchRoutes
import io.legado.http.sourceSearchConcurrency
import io.legado.model.SearchStreamEvent
import io.legado.ops.ServerIdentity
import io.legado.rules.RuleRunner
import io.legado.source.SourceCodec
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

/** 真实 WS 路由 + 可中断的受控阻塞源：验证截止、cancel 帧和无 cancel 的断连。 */
class SearchStreamLifecycleTest {
    @Test fun `deadline keeps partial results and releases active sources`() = scenario("deadline")
    @Test fun `cancel frame releases active sources without starting queued work`() = scenario("cancel")
    @Test fun `disconnect releases active sources without a cancel frame`() = scenario("disconnect")

    private fun scenario(mode: String) {
        val path = Files.createTempFile("legado-search-lifecycle", ".sqlite")
        val release = CountDownLatch(1)
        val cap = sourceSearchConcurrency()
        val started = CountDownLatch(cap)
        val exited = CountDownLatch(cap)
        val slowCalls = AtomicInteger()
        val active = AtomicInteger()
        try {
            Database(path.toString()).use { database ->
                database.initialize()
                fun source(name: String) = """{
                    "bookSourceUrl":"https://$name.example","bookSourceName":"$name",
                    "searchUrl":"/search?k={{key}}",
                    "ruleSearch":{"bookList":"$.data","name":"$.title","bookUrl":"$.url"}
                }"""
                val fast = source("a-fast")
                database.saveSource(SourceCodec.parse(fast), null)
                repeat(cap + 3) { database.saveSource(SourceCodec.parse(source("z-slow-$it")), null) }
                val runner = RuleRunner { url ->
                    if (url.contains("z-slow")) {
                        slowCalls.incrementAndGet()
                        active.incrementAndGet()
                        started.countDown()
                        try {
                            check(release.await(15, TimeUnit.SECONDS)) { "source not interrupted" }
                        } finally {
                            active.decrementAndGet()
                            exited.countDown()
                        }
                    }
                    """{"data":[{"title":"kept","url":"https://a-fast.example/book"}]}"""
                }
                runner.search(fast, "warmup")
                testApplication {
                    application {
                        install(io.ktor.server.websocket.WebSockets)
                        routing { route("/api") { searchRoutes(database, runner, streamTotalTimeoutMs = if (mode == "deadline") 3_000 else 12_000) } }
                    }
                    val wsClient = createClient { install(WebSockets) }
                    withTimeout(10_000) {
                        wsClient.webSocket("/api/search/stream", request = {
                            header(HttpHeaders.Origin, "http://127.0.0.1:${ServerIdentity.port}")
                        }) {
                            send(Frame.Text("""{"keyword":"test"}"""))
                            assertTrue(withContext(Dispatchers.IO) { started.await(5, TimeUnit.SECONDS) })
                            when (mode) {
                                "cancel" -> send(Frame.Text("""{"type":"cancel"}"""))
                                "disconnect" -> close()
                                else -> {
                                    val events = mutableListOf<SearchStreamEvent>()
                                    do {
                                        val event = Json.decodeFromString<SearchStreamEvent>((incoming.receive() as Frame.Text).readText())
                                        events.add(event)
                                    } while (event.type != "done")
                                    val done = events.last()
                                    assertTrue(done.truncated)
                                    assertEquals(1, done.completedSources)
                                    assertEquals(cap + 4, done.totalSources)
                                    assertEquals(0, done.failedSources)
                                    assertEquals(1, done.resultCount)
                                    assertEquals(listOf("kept"), events.flatMap { it.results }.map { it.name })
                                }
                            }
                            assertTrue("取消后工作线程应退出", withContext(Dispatchers.IO) { exited.await(2, TimeUnit.SECONDS) })
                            assertEquals("排队源不应继续启动", cap, slowCalls.get())
                            assertEquals(0, active.get())
                        }
                    }
                }
            }
        } finally {
            release.countDown()
            Files.deleteIfExists(path)
            Files.deleteIfExists(path.resolveSibling("${path.fileName}-wal"))
            Files.deleteIfExists(path.resolveSibling("${path.fileName}-shm"))
        }
    }
}
