package io.legado.data

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.Closeable
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec
import io.legado.AppConfig
import io.legado.cache.CachedCover
import io.legado.content.ContentProcessor
import io.legado.data.db.ConnectionPool
import io.legado.data.db.Migration
import io.legado.data.db.Schema
import io.legado.localbook.LocalBookParser
import io.legado.localbook.ParsedBook
import io.legado.model.BackupShelfEntry
import io.legado.model.CachedBookRequest
import io.legado.model.CookieBucket
import io.legado.model.LibraryImportResult
import io.legado.model.ReplaceRule
import io.legado.model.ReplaceRuleImportResponse
import io.legado.model.SourceLoginStateRecord
import io.legado.ops.LogEntry
import io.legado.port.CookieStore
import io.legado.port.KernelReader
import io.legado.port.LoginStateStore
import io.legado.port.PortBundle
import io.legado.port.ScriptCacheStore
import io.legado.port.VariableStore
import io.legado.source.ParsedRssSource
import io.legado.source.ParsedSource
import io.legado.source.SourceCodec
import io.legado.source.WebViewProxy
import io.legado.model.BookGroup
import io.legado.model.BookIdentifier
import io.legado.model.BookshelfInfoUpdateRequest
import io.legado.model.BookshelfItem
import io.legado.model.BookshelfWriteRequest
import io.legado.model.Chapter
import io.legado.model.ChapterContent
import io.legado.model.ImportResponse
import io.legado.model.ReadingProgress
import io.legado.model.ReadingLogEntry
import io.legado.model.ReadingLogRequest
import io.legado.model.BookNote
import io.legado.model.BookNoteWrite
import io.legado.model.RssSourceSummary
import io.legado.model.SearchResult
import io.legado.model.SourceRecord
import io.legado.model.SourceSubscription
import io.legado.model.SourceSummary
import io.legado.model.SubscriptionWriteRequest

/**
 * 数据库组合根：从原有 641 行的 Database.kt 重构为轻量装配点。
 *
 * 职责拆分：
 * - `ConnectionPool`：读写连接池、WAL 配置、连接健康检查（`select 1`）
 * - `Schema`：建表 SQL（首次启动时执行）
 * - `Migration`：旧库缺列补列、cookie_jar 折叠、VACUUM 碎片回收
 *
 * `Database` 本身只负责组装这三者，并暴露向后兼容的 `connect` / `write` / `close`
 * 接口给现有 DAO 调用，无需改动调用方。
 */
class Database(private val path: String) : Closeable, AutoCloseable, PortBundle {

    /** 库文件路径的只读视图：备份快照清单端点据此定位 `<同目录>/backups`。 */
    val dbPath: String get() = path

    private val random = SecureRandom()
    private val pool = ConnectionPool.default(path)

    @Volatile internal var isClosed = false

    /** 书源清单缓存：两张清单只在 source 表写入时变化。所有写入路径统一走 invalidateSourceCaches()。 */
    @Volatile internal var sourceSummariesCache: List<SourceSummary>? = null
    @Volatile internal var exploreSourcesCache: List<SourceSummary>? = null

    /** 凭据桶「被多少书源提到」的统计缓存，定义与说明见 `CookieDao.kt`。 */
    internal val cookieMentions = CookieMentions()

    init {
        // 目录由 ConnectionPool 构造时创建，此处保留显式声明以兼容旧行为。
        java.nio.file.Files.createDirectories(java.nio.file.Path.of(path).toAbsolutePath().parent)
    }

    /** 读连接：先从池里复用，池空则新建；失效连接直接丢弃并重建。 */
    internal fun <T> connect(block: (java.sql.Connection) -> T): T {
        check(!isClosed) { "Database is closed" }
        val connection = pool.borrowRead()
        return try {
            val result = block(connection)
            pool.releaseRead(connection)
            result
        } catch (error: Throwable) {
            pool.releaseRead(connection)
            throw error
        }
    }

    /** 写连接：全局单写，复用同一连接，全局锁保护。 */
    internal fun <T> write(block: (java.sql.Connection) -> T): T =
        pool.useWrite(block)

    /**
     * 事务里当前线程的嵌套深度。用 `ThreadLocal` 而不是成员变量：写连接由 `writeLock`
     * 独占，同一时刻只有一个线程在事务里，深度天然是「这一层调用栈的深度」。
     */
    private val transactionDepth = ThreadLocal.withInitial { 0 }

    /**
     * **可嵌套的事务入口**：只有最外层 `commit` / `rollback`，内层用 SAVEPOINT。
     *
     * 为什么需要它：库里有六七个函数自己写 `autoCommit = false … commit() … autoCommit = true`
     * （六个备份导入步骤都是这个形状）。把它们串成一个整批事务时，直接在外面套一层
     * `write { autoCommit = false }` 会静默失效 —— 第一个内层函数在 `finally` 里把
     * `autoCommit` 复位成 true，外层事务当场被提交掉；0.2.35 的批量删书事故就是这条。
     *
     * 所以规矩改成：**谁都不许自己动 `autoCommit`**，要么走本函数，要么走 `write {}`（不碰
     * `autoCommit`，语句自动并入当前事务）。内层失败用 SAVEPOINT 回滚到入口，外层的其它
     * 步骤不受影响；外层失败则整体回滚。
     *
     * 约束：事务内**不要做网络 / 文件 IO**（单写连接被独占，所有写请求排队），也**不要调用
     * 仍然自己管 `autoCommit` 的 DAO**（`ShelfDao` / `CacheDao` 里的老函数），它们会把
     * 外层事务提交掉。
     */
    fun <T> transaction(block: (java.sql.Connection) -> T): T = write { db ->
        val depth = transactionDepth.get()
        val savepoint = if (depth == 0) {
            db.autoCommit = false
            null
        } else {
            db.setSavepoint("legado_tx_$depth")
        }
        transactionDepth.set(depth + 1)
        try {
            val result = block(db)
            if (savepoint != null) db.releaseSavepoint(savepoint)
            if (depth == 0) db.commit()
            result
        } catch (error: Throwable) {
            // 回滚自己失败不能盖掉真因：真正要抛给上层的还是 block 里那个异常。
            runCatching { if (savepoint != null) db.rollback(savepoint) else db.rollback() }
            throw error
        } finally {
            transactionDepth.set(depth)
            if (depth == 0) runCatching { db.autoCommit = true }
        }
    }

    /** 首次启动：建表 + 迁移 + 快照。碎片回收不在这条同步路径里，见 [scheduleReclaimFragmentation]。 */
    fun initialize() = write { db ->
        Schema.createTables(db)
        Migration.maybeSnapshot(db, path)
        Migration.migrateReadingProgress(db)
        Migration.migrateBookshelf(db)
        Migration.migrateSourceTable(db)
        Migration.migrateLegacyCookieJars(db)
        Migration.migrateBookNote(db)
        Migration.migrateBookContentCache(db)
    }

    /**
     * 把 VACUUM 碎片回收挪到启动之后（文档第22项：大库高碎片时全量 VACUUM 重写整文件，
     * 卡在 HTTP 端口 bind 之前会明显拉慢冷启动）。
     *
     * 策略：起一条 daemon 线程，宽限 [delayMs] 毫秒让首屏读写先跑起来，再走同一把全局写锁 `write{}`
     * 触发 reclaim。VACUUM 期间读连接仍能读（WAL 快照语义），只是写要排队——但 reclaim 只在碎片率
     * 超过阈值时才真跑，多数启动直接跳过；对首屏基本无感。
     *
     * 失败只打 stderr，不抛错——回收不上是"文件没缩回去"，不影响功能。
     */
    fun scheduleReclaimFragmentation(delayMs: Long = 3_000L) {
        Thread {
            try {
                if (delayMs > 0) Thread.sleep(delayMs)
            } catch (_: InterruptedException) {
                return@Thread
            }
            if (isClosed) return@Thread
            runCatching { write { db -> Migration.reclaimFreePages(db) } }
                .onFailure { error ->
                    System.err.println(
                        "启动后异步碎片回收失败：${error.javaClass.simpleName}: ${error.message} —— 不影响功能，只是文件没缩回去",
                    )
                }
        }.apply { isDaemon = true; name = "db-vacuum-async"; start() }
    }

    override fun close() {
        if (isClosed) return
        isClosed = true
        pool.close()
    }

    /** 书源表被写过几次（`app_meta.source_revision`，由 source 表上的触发器维护）。 */
    internal fun sourceRevision(): Long = connect { db ->
        db.prepareStatement("select value from app_meta where key = 'source_revision'").use { statement ->
            statement.executeQuery().use { rs -> if (rs.next()) rs.getString(1)?.toLongOrNull() ?: 0L else 0L }
        }
    }

    /** 列表顺序：排过序的在前，没排过的按名称跟在后面。 */
    internal fun invalidateSourceCaches() {
        sourceSummariesCache = null
        exploreSourcesCache = null
        cookieMentions.invalidate()
        MentionsWarmer.schedule(this)
    }

    /**
     * 以 [CookieStore] 端口视角暴露本库的 Cookie 能力。规则内核（`rules/`）据此按能力索取，
     * 不再直接 import `io.legado.data` 的 Cookie 扩展函数（见 docs/architecture-audit.md §3.1）。
     * 内部委托给仍保留的扩展实现，http/ai 等既有调用点不受影响。
     */
    override fun asCookieStore(): CookieStore = DatabaseCookieStore(this)

    /** 以 [VariableStore] 端口视角暴露本库的书源变量/键值能力。同上，委托既有扩展，不删扩展。 */
    override fun asVariableStore(): VariableStore = DatabaseVariableStore(this)

    /** 以 [ScriptCacheStore] 端口视角暴露脚本全局 cache 的落盘能力。委托 ScriptCacheDao 扩展。 */
    override fun asScriptCacheStore(): ScriptCacheStore = DatabaseScriptCacheStore(this)

    /** 以 [LoginStateStore] 端口视角暴露登录态读写能力。委托 LoginDao 扩展。 */
    override fun asLoginStateStore(): LoginStateStore = DatabaseLoginStateStore(this)

    /** 以 [KernelReader] 端口视角暴露只读投影（源/书架/目录缓存/净化规则）。委托各 DAO 扩展。 */
    override fun asReader(): KernelReader = DatabaseKernelReader(this)
}

/** 书源并发改写的乐观锁异常，由 HTTP 层转成 409 version_conflict。 */
class VersionConflict : RuntimeException()
