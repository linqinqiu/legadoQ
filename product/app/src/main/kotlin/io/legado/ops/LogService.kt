package io.legado.ops

import kotlinx.serialization.Serializable
import java.io.File
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import io.legado.data.Database
import io.legado.data.bumpLogRepeat
import io.legado.data.clearLogEntries
import io.legado.data.ensureLogTable
import io.legado.data.insertLog
import io.legado.data.queryLogs

/**
 * 结构化日志服务：按类别收集，落库 + 单行写文件 + 单行写标准输出，前端「运行日志」读这里。
 * 类别见 `LogLevel`/`LogEntry.category`（ENGINE / NETWORK / PARSING / RULE_EXECUTION /
 * DATABASE / CACHE / GUARD / SYSTEM）。
 *
 * 三条硬规则都是被"日志把真问题埋掉"实测逼出来的：
 * 1. **一条日志一行** —— 消息与 context 一律折行、压空白、截断；整段 JSON / 请求体 / 堆栈
 *    绝不原样打到标准输出（带裸换行的输出会把 server.log 冲成上千行碎片）。
 * 2. **级别要说实话** —— 死源反复 404、重试成功的抖动不是 ERROR；ERROR 留给真失败。
 * 3. **同类要合并** —— 同一（类别, 等级, 消息, 关键上下文）在 [DEDUPE_WINDOW_MS] 内只占一行，
 *    次数记在 `count` 上；一个坏源就能把保留窗口整个吃掉，把真问题挤出去。
 */
object LogService {
    private const val MAX_IN_MEMORY = 1000
    private const val DEDUPE_WINDOW_MS = 60_000L
    /** 单行里消息与上下文各自的长度上限：够定位，又不会一行撑成一段文章。 */
    private const val MESSAGE_MAX = 300
    private const val CONTEXT_VALUE_MAX = 160
    private const val CONTEXT_MAX_PAIRS = 8

    private val lock = ReentrantLock()
    /** id → 条目。用有序表而不是队列，是为了"合并时能就地改计数"，不是只能追加。 */
    private val recent = LinkedHashMap<Long, LogEntry>()
    private val nextFallbackId = AtomicLong(-1)
    private data class Slot(var id: Long, var count: Int, var lastAt: Long, var level: LogLevel)
    private val slots = ConcurrentHashMap<String, Slot>()

    private var logFile: File? = null
    private var database: Database? = null

    fun initialize(databasePath: String, logDirectory: String = "logs") {
        this.database = try { Database(databasePath) } catch (_: Exception) { null }
        // 自建日志表：本方法比 Application 的 database.initialize() 更早跑，
        // 不先建表的话，紧随其后的「服务器启动」SYSTEM 日志会落库失败。
        database?.let { db -> runCatching { db.ensureLogTable() } }
        val dir = File(logDirectory)
        if (!dir.exists()) dir.mkdirs()
        logFile = File(dir, "legado-${LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd"))}.log")
    }

    fun log(
        category: LogCategory,
        level: LogLevel,
        rawMessage: String,
        context: Map<String, String> = emptyMap(),
        exception: Throwable? = null,
    ) {
        val message = oneLine(rawMessage, MESSAGE_MAX)
        val cleanContext = context
            .filterKeys { it.isNotBlank() }
            .entries.take(CONTEXT_MAX_PAIRS)
            .associate { (key, value) -> key to oneLine(value, CONTEXT_VALUE_MAX) }
        val now = System.currentTimeMillis()
        val stamp = LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)

        val key = "${category.name}|${level.name}|$message|${cleanContext["sourceId"] ?: cleanContext["host"] ?: ""}|${cleanContext["statusCode"] ?: ""}|${cleanContext["rule"] ?: ""}"
        val existing = slots[key]
        if (existing != null && now - existing.lastAt < DEDUPE_WINDOW_MS && existing.level == level) {
            existing.count++
            existing.lastAt = now
            database?.let { db -> runCatching { db.bumpLogRepeat(existing.id, existing.count) } }
            lock.withLock { recent[existing.id]?.let { recent[existing.id] = it.copy(count = existing.count) } }
            // 只在数量翻一个量级时再喊一次，避免"合并了但还是刷屏"。
            if (existing.count == 50 || existing.count % 1000 == 0) {
                emit(category, level, "$message ·同类累计 ${existing.count} 次", cleanContext, null, stamp, existing.id, existing.count)
            }
            return
        }

        val entry = LogEntry(
            timestamp = stamp,
            category = category.name,
            level = level.name,
            message = message,
            context = cleanContext,
            stackTrace = exception?.stackTraceToString()?.let { oneLine(it, 4000) },
            count = 1,
        )
        val id = database?.let { db -> runCatching { db.insertLog(entry, now) }.getOrNull() } ?: 0L
        val storedId = if (id > 0) id else nextFallbackId.decrementAndGet()
        slots[key] = Slot(storedId, 1, now, level)
        // 合并表本身也会无限增长：一个坏源一种 key，几千个源就是几万个 key。
        if (slots.size > 2000) slots.entries.sortedBy { it.value.lastAt }.take(500).forEach { slots.remove(it.key) }
        emit(category, level, message, cleanContext, exception, stamp, storedId, 1)
        lock.withLock {
            recent[storedId] = entry.copy(id = storedId)
            while (recent.size > MAX_IN_MEMORY) recent.remove(recent.keys.first())
        }
    }

    /** 真正往外说的地方：标准输出与日志文件都是**一行**。 */
    private fun emit(
        category: LogCategory,
        level: LogLevel,
        message: String,
        context: Map<String, String>,
        exception: Throwable?,
        stamp: String,
        id: Long,
        count: Int,
    ) {
        val suffix = if (context.isEmpty()) "" else " · " + context.entries.joinToString(" ") { "${it.key}=${it.value}" }
        val tail = if (count > 1) " ×$count" else ""
        val line = "[$stamp] [${category.name}] [${level.name}] $message$suffix$tail"
        val withStack = exception?.let { "$line ⏎ ${it.javaClass.simpleName}: ${oneLine(it.message ?: "", 200)}" } ?: line
        logFile?.let { file -> runCatching { file.appendText(withStack + "\n") } }
        when (level) {
            LogLevel.DEBUG, LogLevel.INFO -> println(withStack)
            LogLevel.WARN, LogLevel.ERROR -> System.err.println(withStack)
        }
    }

    /** 折行、压空白、截断。任何进日志的自由文本都要过这里。 */
    internal fun oneLine(value: String, limit: Int): String {
        val flat = value.replace('\r', ' ').replace('\n', '⏎').replace(Regex("\\s{2,}"), " ").trim()
        return if (flat.length <= limit) flat else flat.take(limit - 1) + "…"
    }

    fun getRecentLogs(category: LogCategory? = null, limit: Int = 100): List<LogEntry> {
        val snapshot = lock.withLock { recent.values.toList() }
        val filtered = if (category == null) snapshot else snapshot.filter { it.category == category.name }
        return filtered.sortedByDescending { it.timestamp }.take(limit)
    }

    /**
     * 前端「运行日志」用：优先查库（有历史、可按等级筛），库不可用时退回内存队列。
     * 结果统一按时间倒序（最新在前）。
     */
    fun queryLogs(category: LogCategory? = null, level: LogLevel? = null, limit: Int = 200): List<LogEntry> {
        val fromDb = database?.let { db -> runCatching { db.queryLogs(category?.name, level?.name, limit) }.getOrNull() }
        if (fromDb != null) return fromDb
        return getRecentLogs(category, limit).filter { level == null || it.level == level.name }
    }

    fun clearLogs() {
        lock.withLock { recent.clear() }
        slots.clear()
        logFile?.delete()
        database?.let { db -> runCatching { db.clearLogEntries() } }
    }
}

@Serializable
data class LogEntry(
    /** SQLite 的 rowid。界面按它做行标识与"展开的是哪一条"，没有它只能按数组下标，一刷新就串行。 */
    val id: Long = 0,
    val timestamp: String,
    val category: String,
    val level: String,
    val message: String,
    val context: Map<String, String> = emptyMap(),
    val stackTrace: String? = null,
    /** 合并窗口内同类日志的条数；1 表示就这一条。界面上念成「×N」。 */
    val count: Int = 1,
)

enum class LogCategory {
    ENGINE,         // 规则引擎
    NETWORK,        // 网络请求
    PARSING,        // 内容解析
    RULE_EXECUTION, // 书源规则
    DATABASE,       // 数据库
    CACHE,          // 缓存服务
    GUARD,          // 同源闸门
    SYSTEM,         // 系统事件
}

enum class LogLevel {
    DEBUG, INFO, WARN, ERROR
}

// 便捷扩展函数，让现有代码无需大幅改动即可接入。
// 等级默认值就是这些调用点的真实严重程度 —— 需要 ERROR 的地方显式传，别靠默认。
fun Any.logEngine(message: String, context: Map<String, String> = emptyMap(), exception: Throwable? = null, level: LogLevel = LogLevel.ERROR) {
    LogService.log(LogCategory.ENGINE, level, message, context, exception)
}

fun Any.logNetwork(message: String, context: Map<String, String> = emptyMap(), exception: Throwable? = null, level: LogLevel = LogLevel.WARN) {
    LogService.log(LogCategory.NETWORK, level, message, context, exception)
}

fun Any.logParsing(message: String, context: Map<String, String> = emptyMap(), exception: Throwable? = null, level: LogLevel = LogLevel.WARN) {
    LogService.log(LogCategory.PARSING, level, message, context, exception)
}

fun Any.logRuleExecution(message: String, context: Map<String, String> = emptyMap(), exception: Throwable? = null, level: LogLevel = LogLevel.ERROR) {
    LogService.log(LogCategory.RULE_EXECUTION, level, message, context, exception)
}

fun Any.logDatabase(message: String, context: Map<String, String> = emptyMap(), exception: Throwable? = null, level: LogLevel = LogLevel.ERROR) {
    LogService.log(LogCategory.DATABASE, level, message, context, exception)
}

fun Any.logCache(message: String, context: Map<String, String> = emptyMap(), exception: Throwable? = null, level: LogLevel = LogLevel.WARN) {
    LogService.log(LogCategory.CACHE, level, message, context, exception)
}

fun Any.logGuard(message: String, context: Map<String, String> = emptyMap(), exception: Throwable? = null, level: LogLevel = LogLevel.WARN) {
    LogService.log(LogCategory.GUARD, level, message, context, exception)
}

fun Any.logSystem(message: String, context: Map<String, String> = emptyMap(), exception: Throwable? = null, level: LogLevel = LogLevel.INFO) {
    LogService.log(LogCategory.SYSTEM, level, message, context, exception)
}
