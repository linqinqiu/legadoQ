package io.legado.ai

import java.io.InputStream

/**
 * 流式应答读空闲超时：上游半开连接（TCP 活着、再也不吐字）。
 *
 * 上层把它翻成 `upstream_unreachable` 并带上这句话 —— 与"网络断了"分开说，
 * 因为修法不同：一个换模型/重试，一个查网络。
 */
class SseIdleTimeoutException(message: String) : RuntimeException(message)

/**
 * SSE 读空闲看门狗：daemon 线程按 `idleMs/4` 检查一次，到点**关掉底层流**把阻塞的读叫醒。
 *
 * 为什么关流而不是关 `BufferedReader`：`BufferedReader.readLine()` 与 `close()` 争同一把内部锁 ——
 * readLine 卡在 `in.read()` 时正持有那把锁，另一个线程调 `reader.close()` 会**等在锁上**，
 * 什么也关不掉（实测会把测试挂死）。`InputStream.close()` 不争这把锁，才真的能打断阻塞读。
 *
 * 为什么不是协程超时：providers 是阻塞 IO，`withTimeout` 打断不了 `InputStream.read()`。
 * 为什么不是 `available()` 轮询：它只回答"缓冲里有没有字节"，答不了"这一行还缺不缺换行"，
 * 上游发半行时照样会卡住。
 *
 * 生命周期由 [ProviderHttp.readSseData] 管：启动 → 每读到一行 `touch()` → finally 里 `stopQuietly()`。
 */
internal class SseIdleWatchdog(
    private val stream: InputStream,
    private val idleMs: Long,
) : Thread("legado-sse-idle") {

    init {
        isDaemon = true
    }

    @Volatile
    private var lastTouch = System.currentTimeMillis()

    /** 读中断是看门狗干的、还是调用方自己取消的 —— 决定上层报"空闲超时"还是原样抛。 */
    @Volatile
    var expired = false
        private set

    fun touch() {
        lastTouch = System.currentTimeMillis()
    }

    override fun run() {
        val step = (idleMs / 4).coerceIn(20, 500)
        while (!isInterrupted) {
            try {
                sleep(step)
            } catch (_: InterruptedException) {
                return
            }
            if (System.currentTimeMillis() - lastTouch >= idleMs) {
                expired = true
                runCatching { stream.close() }
                return
            }
        }
    }

    fun stopQuietly() {
        interrupt()
    }
}
