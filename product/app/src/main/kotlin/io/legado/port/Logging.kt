package io.legado.port

/**
 * 结构化日志的**门面** —— 住在域层，因为**每一层都要打日志**。
 *
 * ## 为什么要拆出来
 *
 * 原先 `LogCategory` / `LogLevel` 与八个 `logXxx` 便捷函数都长在 `ops/LogService.kt` 里，
 * 而 `ops/` 属 infra。于是 `rules/`（`RuleRunner`）、`content/`（`ContentProcessor`）、
 * `localbook/`（`TxtTocRule`）三个 engine 包**仅仅为了打一行日志**就反向够 infra，
 * 在 `ArchitectureBoundaryTest` 的判据 5 上留下 4 条 `engine → infra`。
 * 那 4 条里没有一条是真正的能力依赖 —— 这正是判据注释里说的"顺手拿了个纯工具"。
 *
 * "把日志当能力依赖"是错的：日志是**横切关注点**，不是某一层的专属能力。
 * 所以正确的处置不是给日志造一个 capability 端口（那会让每个调用点都要先拿到端口实例），
 * 而是把**门面**下沉到谁都允许依赖的域层，把**实现**（落库 / 去重 / 写文件）留在 `ops/`。
 *
 * ## 装配约定
 *
 * 域层**不知道** `LogService` 的存在，它只认 [LogSink]。
 * 实现由 infra 侧在启动最早处装进来：`Application` 里的 `LogService.initialize(...)`。
 *
 * 装配之前 [logSink] 是 [StdoutLogSink]（**打到标准输出，不静默丢弃**）——
 * 启动早期那几行日志恰恰是最需要看见的，丢掉它们会让"服务起不来"变成没有线索的黑盒。
 *
 * 方向纪律：本文件**只允许**被 `ops/`、engine、api、组合根 import，
 * 自身**绝不** import `io.legado.ops` / `io.legado.data` 等 infra 包
 * （否则就把 domain → infra 的倒挂从 engine 搬到了 port，问题只是换了个地方）。
 */

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

/** 日志出口。实现见 `ops/LogService.kt`；域层与 engine 只依赖这个接口。 */
interface LogSink {
    fun log(
        category: LogCategory,
        level: LogLevel,
        rawMessage: String,
        context: Map<String, String> = emptyMap(),
        exception: Throwable? = null,
    )
}

/**
 * 未装配时的兜底出口。
 *
 * 只做最小的一件事：折行 + 打到对应流。**不做**去重、不落库、不进内存队列 ——
 * 那些是要替换它的 `LogService` 的职责，在这里复刻一份就等于两份真相。
 *
 * 折行仍然要做：`LogService` 的头号硬规则就是"一条日志一行"，
 * 兜底出口要是把带裸换行的文本原样吐出来，它自己就成了那条规则要防的东西。
 */
private object StdoutLogSink : LogSink {
    private fun oneLine(value: String): String =
        value.replace('\r', ' ').replace('\n', '⏎').replace(Regex("\\s{2,}"), " ").trim()

    override fun log(
        category: LogCategory,
        level: LogLevel,
        rawMessage: String,
        context: Map<String, String>,
        exception: Throwable?,
    ) {
        val suffix = if (context.isEmpty()) "" else " · " + context.entries.joinToString(" ") { "${it.key}=${it.value}" }
        val line = "[${category.name}] [${level.name}] ${oneLine(rawMessage)}$suffix"
        val withStack = exception?.let { "$line ⏎ ${it.javaClass.simpleName}: ${oneLine(it.message ?: "")}" } ?: line
        when (level) {
            LogLevel.DEBUG, LogLevel.INFO -> println(withStack)
            LogLevel.WARN, LogLevel.ERROR -> System.err.println(withStack)
        }
    }
}

/**
 * 当前日志出口。`volatile`：装配发生在启动线程，而写入来自任意请求线程，
 * 不保证可见性的话，早起的请求会一直往已经废弃的兜底出口里写。
 */
@Volatile
var logSink: LogSink = StdoutLogSink

// —— 便捷扩展函数，签名与原 `ops/LogService.kt` 里的完全一致，调用点无需改动 ——
// 等级默认值就是这些调用点的真实严重程度 —— 需要 ERROR 的地方显式传，别靠默认。

fun Any.logEngine(message: String, context: Map<String, String> = emptyMap(), exception: Throwable? = null, level: LogLevel = LogLevel.ERROR) {
    logSink.log(LogCategory.ENGINE, level, message, context, exception)
}

fun Any.logNetwork(message: String, context: Map<String, String> = emptyMap(), exception: Throwable? = null, level: LogLevel = LogLevel.WARN) {
    logSink.log(LogCategory.NETWORK, level, message, context, exception)
}

fun Any.logParsing(message: String, context: Map<String, String> = emptyMap(), exception: Throwable? = null, level: LogLevel = LogLevel.WARN) {
    logSink.log(LogCategory.PARSING, level, message, context, exception)
}

fun Any.logRuleExecution(message: String, context: Map<String, String> = emptyMap(), exception: Throwable? = null, level: LogLevel = LogLevel.ERROR) {
    logSink.log(LogCategory.RULE_EXECUTION, level, message, context, exception)
}

fun Any.logDatabase(message: String, context: Map<String, String> = emptyMap(), exception: Throwable? = null, level: LogLevel = LogLevel.ERROR) {
    logSink.log(LogCategory.DATABASE, level, message, context, exception)
}

fun Any.logCache(message: String, context: Map<String, String> = emptyMap(), exception: Throwable? = null, level: LogLevel = LogLevel.WARN) {
    logSink.log(LogCategory.CACHE, level, message, context, exception)
}

fun Any.logGuard(message: String, context: Map<String, String> = emptyMap(), exception: Throwable? = null, level: LogLevel = LogLevel.WARN) {
    logSink.log(LogCategory.GUARD, level, message, context, exception)
}

fun Any.logSystem(message: String, context: Map<String, String> = emptyMap(), exception: Throwable? = null, level: LogLevel = LogLevel.INFO) {
    logSink.log(LogCategory.SYSTEM, level, message, context, exception)
}
