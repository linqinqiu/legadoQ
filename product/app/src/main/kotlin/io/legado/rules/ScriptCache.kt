package io.legado.rules

import io.legado.data.Database
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * 书源脚本的全局 `cache`（上游 `CacheManager`）。
 *
 * 启用库里有 49 份源在写 `cache.put`、36 份在读 `cache.get`：蓝批拿它缓存 pixiv API 结果、
 * 书山聚合把图片样式放这儿、番茄系把 token 放这儿。沙箱原来没有这个全局，脚本第一行就
 * `ReferenceError: “cache” 未定义`，整源不可用。
 *
 * 语义照上游、两处刻意不同：
 * - 内存 LRU + SQLite 两层。`put` 同时写内存与库；`get` 先内存后库。上游内存层不认
 *   deadline（进程活着就一直返回过期值），我们照 deadline 判 —— 否则「缓存 5 分钟」在
 *   常驻服务里等于永久。
 * - 键按**书源隔离**。上游是单机 App 的全局键空间，同名键（`imgstyle`）在不同源之间
 *   本来就不该互相覆盖；多书源并发跑在同一个 JVM 里，全局键会真的串数据。
 *
 * `saveTime` 单位秒，`<= 0` 表示不过期；值统一按文本落库（上游也是 `value.toString()`，
 * 对象本来就是 `[object Object]`，我们更实用一点：JSON 序列化）。
 */
internal object ScriptCache {
    private const val MAX_MEMORY_ENTRIES = 2048

    private data class Entry(val value: Any?, val deadline: Long)

    /** accessOrder=true：读也刷新顺序，冷键先淘汰。 */
    private val memory = object : LinkedHashMap<String, Entry>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Entry>?): Boolean =
            size > MAX_MEMORY_ENTRIES
    }
    private val lock = ReentrantLock()

    private fun key(sourceId: String?, key: String): String = (sourceId ?: "-") + "\u0000" + key

    fun putMemory(sourceId: String?, key: String, value: Any?) {
        lock.withLock { memory[key(sourceId, key)] = Entry(value, 0) }
    }

    fun getFromMemory(sourceId: String?, key: String, now: Long = System.currentTimeMillis()): Any? = lock.withLock {
        val entry = memory[key(sourceId, key)] ?: return@withLock null
        if (entry.deadline > 0 && entry.deadline <= now) {
            memory.remove(key(sourceId, key))
            return@withLock null
        }
        entry.value
    }

    fun deleteMemory(sourceId: String?, key: String) {
        lock.withLock { memory.remove(key(sourceId, key)) }
    }

    fun get(sourceId: String?, key: String, db: Database?, onlyDisk: Boolean = false): Any? {
        val now = System.currentTimeMillis()
        if (!onlyDisk) {
            getFromMemory(sourceId, key, now)?.let { return it }
        }
        val stored = runCatching { db?.asScriptCacheStore()?.getScriptCache(sourceId ?: "-", key, now) }.getOrNull() ?: return null
        // 只有默认的读路径回填内存；onlyDisk 的语义就是「绕过内存层」。
        if (!onlyDisk) putMemory(sourceId, key, stored)
        return stored
    }

    fun put(sourceId: String?, key: String, value: String, saveTimeSeconds: Int, db: Database?) {
        val now = System.currentTimeMillis()
        val deadline = if (saveTimeSeconds <= 0) 0 else now + saveTimeSeconds * 1000L
        lock.withLock { memory[key(sourceId, key)] = Entry(value, deadline) }
        runCatching { db?.asScriptCacheStore()?.putScriptCache(sourceId ?: "-", key, value, deadline) }
    }

    fun delete(sourceId: String?, key: String, db: Database?) {
        lock.withLock { memory.remove(key(sourceId, key)) }
        runCatching { db?.asScriptCacheStore()?.deleteScriptCache(sourceId ?: "-", key) }
    }
}
