package io.legado.rules

import java.io.InputStream
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.supervisorScope

/** 同步规则调用的取消资源域；取消既中断等待响应头，也关闭正在读取的响应体。 */
internal object RuleIoCancellation {
    private val current = ThreadLocal<Resources?>()

    suspend fun <T> run(block: () -> T): T = supervisorScope {
        val resources = Resources()
        val worker = async(Dispatchers.IO) {
            runInterruptible {
                val previous = current.get()
                current.set(resources)
                try {
                    ensureActive()
                    block()
                } finally {
                    if (previous == null) current.remove() else current.set(previous)
                }
            }
        }
        // await 在父级取消时立即恢复，先关闭流，随后结构化并发等待 worker 退出。
        try { worker.await() } finally { resources.cancel() }
    }

    fun ensureActive() { current.get()?.ensureActive() }

    fun <T> useResponseBody(stream: InputStream, read: (InputStream) -> T): T {
        val resources = current.get()
        try {
            resources?.register(stream)
            return stream.use(read)
        } finally {
            resources?.unregister(stream)
        }
    }

    internal class Resources {
        private val streams = mutableSetOf<InputStream>()
        private var cancelled = false

        @Synchronized fun ensureActive() {
            if (cancelled) throw CancellationException("规则请求已取消")
        }

        fun register(stream: InputStream) {
            val rejected = synchronized(this) {
                if (cancelled) true else { streams.add(stream); false }
            }
            // 响应可能恰好在取消之后才抵达；不允许漏掉它，也不再开始读取。
            if (rejected) {
                runCatching { stream.close() }
                throw CancellationException("规则请求已取消")
            }
        }

        @Synchronized fun unregister(stream: InputStream) { streams.remove(stream) }

        fun cancel() {
            val pending = synchronized(this) {
                cancelled = true
                streams.toList().also { streams.clear() }
            }
            pending.forEach { runCatching { it.close() } }
        }
    }
}
