package io.legado

import io.legado.ai.ProviderHttp
import io.legado.ai.SseIdleTimeoutException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.IOException
import java.io.InputStream

/**
 * SSE 读空闲超时（2026-11-10 审计的后端第 8 条）。
 *
 * 上游半开连接（TCP 活着、再也不吐字）会让 `readLine()` 永远挂住：界面只看到"卡住"，
 * 用户只能刷新页面。这里用一个"吐完一段就装死"的流模拟它，钉住两件事：
 * ① 到点真的结束并说清是空闲超时；② 已经收到的负载不能被丢掉。
 */
class SseIdleTest {

    /** 半开连接：吐完 [payload] 就不再给字节，也不 EOF；close() 时把阻塞的 read 叫醒。 */
    private class HalfOpenStream(payload: String) : InputStream() {
        private val bytes = payload.toByteArray()
        private var position = 0

        @Volatile
        private var closed = false

        override fun read(): Int {
            if (position < bytes.size) return bytes[position++].toInt() and 0xFF
            while (!closed) Thread.sleep(5)
            throw IOException("closed")
        }

        override fun close() {
            closed = true
        }
    }

    @Test
    fun `SSE 读到一半没数据了按空闲超时结束，而不是永远挂住`() {
        val seen = mutableListOf<String>()
        val stream = HalfOpenStream("data: {\"a\":1}\n\n")

        assertThrows(SseIdleTimeoutException::class.java) {
            ProviderHttp.forEachSseData(stream, idleMs = 150) { seen += it }
        }
        assertEquals("已经收到的负载不能因为超时丢掉", listOf("{\"a\":1}"), seen)
    }

    @Test
    fun `idleMs 为 0 时不装看门狗：正常读到 EOF 为止`() {
        val seen = mutableListOf<String>()
        "data: a\ndata: b\n".byteInputStream().use { stream ->
            ProviderHttp.forEachSseData(stream, idleMs = 0) { seen += it }
        }
        assertEquals(listOf("a", "b"), seen)
    }
}
