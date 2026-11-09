package io.legado.tts

import io.legado.AppConfig
import io.legado.model.TtsSessionChunkRequest
import java.io.StringWriter
import java.net.http.HttpClient
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `TtsSession` 的生命周期与队列语义。
 *
 * 这一组**故意不调用 `start()`**：worker 一起来就会去打 Edge 的 WebSocket，测试就变成
 * 依赖网络。不启动 worker，分片只会堆在队列里，正好用来盯这几条纯状态机行为 ——
 * 重复 id 去重、队列满拒绝、关闭后拒收、超时判定、事件顺序。
 *
 * 真正「合成并把字节按序推给播放器」那条链路由 `TtsSessionServiceTest` 用本地
 * HttpServer 覆盖，两边不重复。
 */
class TtsSessionLifecycleTest {

    private class Fixture {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val closedCount = AtomicInteger(0)
        val session = TtsSession(
            sessionId = "s-lifecycle",
            ownerId = "owner",
            edgeTts = EdgeTtsService(HttpClient.newHttpClient()),
            parentScope = scope,
            onClosed = { closedCount.incrementAndGet() },
        )

        fun close() {
            runCatching { session.close("test_done") }
            scope.cancel()
        }
    }

    private fun chunk(id: String, text: String = "一段正文") =
        TtsSessionChunkRequest(chunkId = id, text = text)

    // ==================== 校验 ====================

    @Test
    fun `chunkId 为空直接拒，不进队列`() {
        val fixture = Fixture()
        try {
            val error = runCatching { fixture.session.append(chunk("  ")) }.exceptionOrNull()
            assertTrue("空 chunkId 应当抛 IllegalArgumentException，实际 $error", error is IllegalArgumentException)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `朗读文本为空或超长直接拒`() {
        val fixture = Fixture()
        try {
            assertTrue(
                runCatching { fixture.session.append(chunk("a", "   ")) }.exceptionOrNull()
                    is IllegalArgumentException,
            )
            assertTrue(
                runCatching { fixture.session.append(chunk("b", "字".repeat(20_001))) }.exceptionOrNull()
                    is IllegalArgumentException,
            )
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `引擎只认 edge 与 custom，custom 必须带地址`() {
        val fixture = Fixture()
        try {
            assertTrue(
                runCatching { fixture.session.append(chunk("a").copy(engine = "browser")) }.exceptionOrNull()
                    is IllegalArgumentException,
            )
            assertTrue(
                "custom 没给 customUrl 应当拒",
                runCatching { fixture.session.append(chunk("b").copy(engine = "custom")) }.exceptionOrNull()
                    is IllegalArgumentException,
            )
            assertTrue(
                "custom 带地址就放行",
                fixture.session.append(chunk("c").copy(engine = "custom", customUrl = "http://127.0.0.1:1/tts")),
            )
        } finally {
            fixture.close()
        }
    }

    // ==================== 队列 ====================

    @Test
    fun `重复的 chunkId 只占一个位置，且两次都回 true`() {
        val fixture = Fixture()
        try {
            // 队列容量 48：先塞 46 个不同 id，留两个位置给后面的断言
            repeat(46) { assertTrue(fixture.session.append(chunk("fill-$it"))) }

            assertTrue("第一次", fixture.session.append(chunk("dup")))
            assertTrue("重复投递也算收下（幂等），不该报错", fixture.session.append(chunk("dup")))

            // 重复那次没有占位置：47 + 1(dup) = 48，所以下面这两个唯一 id 里只能进一个
            assertTrue("第 48 个位置应当还能进队", fixture.session.append(chunk("last")))
            assertFalse("满了：第 49 个必须被拒，而不是悄悄丢掉", fixture.session.append(chunk("overflow")))
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `关闭之后不再收新分片`() {
        val fixture = Fixture()
        try {
            assertTrue(fixture.session.append(chunk("before")))
            fixture.session.close("user_stopped")
            assertFalse("关了就不该再收", fixture.session.append(chunk("after")))
            assertTrue(fixture.session.isClosed())
        } finally {
            fixture.close()
        }
    }

    // ==================== 生命周期 ====================

    @Test
    fun `close 幂等，onClosed 只回调一次`() {
        val fixture = Fixture()
        try {
            fixture.session.close("first")
            fixture.session.close("second")
            fixture.session.close()
            assertEquals("重复关闭不该重复通知会话表", 1, fixture.closedCount.get())
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `刚建好的会话不会立刻过期，超过空闲与最大存活才过期`() {
        val fixture = Fixture()
        try {
            val now = System.currentTimeMillis()
            assertFalse("刚建好不该判过期", fixture.session.shouldExpire(now))
            assertTrue(
                "超过空闲阈值就该回收",
                fixture.session.shouldExpire(now + AppConfig.ttsIdleTimeoutMs + 1_000),
            )
            assertTrue(
                "超过最大存活也该回收",
                fixture.session.shouldExpire(now + AppConfig.ttsMaxLifetimeMs + 1_000),
            )
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `关闭后不再判过期（免得回收线程重复处理）`() {
        val fixture = Fixture()
        try {
            fixture.session.close("done")
            assertFalse(fixture.session.shouldExpire(System.currentTimeMillis() + AppConfig.ttsMaxLifetimeMs * 2))
        } finally {
            fixture.close()
        }
    }

    // ==================== 事件流 ====================

    @Test
    fun `暂停 继续 停止 三个事件按顺序写到 SSE 流里`() = runBlocking {
        val fixture = Fixture()
        try {
            val writer = StringWriter()
            val job = fixture.scope.launch { fixture.session.streamEvents(writer) }

            fixture.session.pause()
            fixture.session.resume()
            fixture.session.close("user_stopped")

            withTimeout(5_000) { job.join() }

            val text = writer.toString()
            assertTrue("应当有 paused 事件：$text", text.contains("event: paused"))
            assertTrue("应当有 resumed 事件：$text", text.contains("event: resumed"))
            assertTrue("应当有 stopped 事件：$text", text.contains("event: stopped"))
            assertTrue(
                "顺序不能乱：$text",
                text.indexOf("event: paused") < text.indexOf("event: resumed") &&
                    text.indexOf("event: resumed") < text.indexOf("event: stopped"),
            )
            assertTrue("停止原因要带出去：$text", text.contains("user_stopped"))
        } finally {
            fixture.close()
        }
    }
}
