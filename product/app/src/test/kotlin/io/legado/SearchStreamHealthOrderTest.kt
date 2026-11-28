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
import io.ktor.websocket.readText
import io.legado.data.Database
import io.legado.data.saveHealthResults
import io.legado.data.saveSource
import io.legado.http.searchRoutes
import io.legado.http.sourceSearchConcurrency
import io.legado.model.SearchStreamEvent
import io.legado.model.SourceHealthCheckItem
import io.legado.ops.ServerIdentity
import io.legado.rules.RuleRunner
import io.legado.source.SourceCodec
import java.net.URI
import java.nio.file.Files
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 走页面实际使用的 WS 路由，锁住首批启动的源；不访问外网，不靠结果到达顺序推断调度顺序。 */
class SearchStreamHealthOrderTest {
    @Test
    fun `stream starts healthy high weight fast sources first and still searches the rest`() {
        val path = Files.createTempFile("legado-search-stream-order", ".sqlite")
        val release = CountDownLatch(1)
        try {
            Database(path.toString()).use { database ->
                database.initialize()
                val concurrency = sourceSearchConcurrency()
                val started = Collections.synchronizedList(mutableListOf<String>())
                val firstWave = CountDownLatch(concurrency)
                val preferredHosts = (1..concurrency).map { "e-preferred-$it.example" }.toSet()
                // 名称顺序与期望优先级相反；每组填满并发名额，让健康、权重、耗时任一项漏接都能被发现。
                for ((group, weight, latency) in listOf(
                    Triple("a-unknown", 9999, -1L),
                    Triple("b-failed", 9999, 1L),
                    Triple("c-low-weight", 0, 1L),
                    Triple("d-slower", 100, 150L),
                    Triple("e-preferred", 100, 10L),
                )) {
                    for (index in 1..concurrency) {
                        val host = "$group-$index.example"
                        val parsed = SourceCodec.parse("""{
                            "bookSourceUrl":"https://$host", "bookSourceName":"$host", "weight":$weight,
                            "searchUrl":"/search?k={{key}}",
                            "ruleSearch":{"bookList":"$.data","name":"$.title","bookUrl":"$.url"}
                        }""")
                        database.saveSource(parsed, null)
                        if (latency >= 0) database.saveHealthResults(listOf(SourceHealthCheckItem(
                            id = parsed.id, name = host, ok = group != "b-failed", latencyMs = latency,
                            statusCategory = if (group == "b-failed") "unreachable" else "valid",
                        )))
                    }
                }
                val runner = RuleRunner { url ->
                    val host = URI(url).host
                    started.add(host)
                    firstWave.countDown()
                    check(release.await(15, TimeUnit.SECONDS)) { "test did not release search workers" }
                    """{"data":[{"title":"$host","url":"https://$host/book"}]}"""
                }
                testApplication {
                    application {
                        install(io.ktor.server.websocket.WebSockets)
                        routing { route("/api") { searchRoutes(database, runner) } }
                    }
                    val wsClient = createClient { install(WebSockets) }
                    withTimeout(30_000) {
                        wsClient.webSocket("/api/search/stream", request = {
                            header(HttpHeaders.Origin, "http://127.0.0.1:${ServerIdentity.port}")
                        }) {
                            send(Frame.Text("""{"keyword":"test"}"""))
                            val start = Json.decodeFromString<SearchStreamEvent>((incoming.receive() as Frame.Text).readText())
                            assertEquals("start", start.type)
                            val (ready, launched) = try {
                                val ready = withContext(Dispatchers.IO) { firstWave.await(10, TimeUnit.SECONDS) }
                                ready to synchronized(started) { started.toList() }
                            } finally {
                                release.countDown()
                            }
                            val results = mutableListOf<String>()
                            while (true) {
                                val event = Json.decodeFromString<SearchStreamEvent>((incoming.receive() as Frame.Text).readText())
                                results.addAll(event.results.map { it.name })
                                if (event.type == "done") {
                                    assertEquals(concurrency * 5, event.completedSources)
                                    assertEquals(concurrency * 5, event.resultCount)
                                    break
                                }
                            }
                            assertEquals("排序不应丢掉失败或未体检源", concurrency * 5, results.toSet().size)
                            // 收完 done 再检查调度，断言失败也不让 WS 服务端悬在发送半途。
                            assertTrue("首批搜索应填满并发名额", ready)
                            assertEquals("页面搜索应先用健康、权重、耗时排序后的源填满首批名额", preferredHosts, launched.toSet())
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
