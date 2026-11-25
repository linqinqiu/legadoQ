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
import io.legado.data.core.DatabaseEngine
import io.legado.localbook.LocalBookParser
import io.legado.localbook.ParsedBook
import io.legado.model.BackupShelfEntry
import io.legado.model.CachedBookRequest
import io.legado.model.CookieBucket
import io.legado.model.LibraryImportResult
import io.legado.model.ReplaceRule
import io.legado.model.ReplaceRuleImportResponse
import io.legado.model.SourceLoginStateRecord
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

/** 数据库领域门面：委托核心引擎，并持有书源缓存与规则内核端口。 */
class Database(private val path: String) : Closeable, AutoCloseable, PortBundle {

    /** 库文件路径的只读视图：备份快照清单端点据此定位 `<同目录>/backups`。 */
    val dbPath: String get() = path

    private val random = SecureRandom()
    private val engine = DatabaseEngine(
        dbPath = path,
        maxPoolSize = AppConfig.dbPoolSize,
        snapshotKeep = AppConfig.dbSnapshotKeep,
        snapshotMinIntervalMs = AppConfig.dbSnapshotMinIntervalMs,
    )

    @Volatile internal var isClosed = false

    /** 书源清单缓存：两张清单只在 source 表写入时变化。所有写入路径统一走 invalidateSourceCaches()。 */
    @Volatile internal var sourceSummariesCache: List<SourceSummary>? = null
    @Volatile internal var exploreSourcesCache: List<SourceSummary>? = null

    /** 凭据桶「被多少书源提到」的统计缓存，定义与说明见 `CookieDao.kt`。 */
    internal val cookieMentions = CookieMentions()

    /** 读连接：先从池里复用，池空则新建；失效连接直接丢弃并重建。 */
    internal fun <T> connect(block: (java.sql.Connection) -> T): T = engine.read(block)

    /** 写连接：全局单写，复用同一连接，全局锁保护。 */
    internal fun <T> write(block: (java.sql.Connection) -> T): T = engine.write(block)

    /** 可嵌套事务：只有最外层提交或回滚，内层用 SAVEPOINT。 */
    fun <T> transaction(block: (java.sql.Connection) -> T): T = engine.transaction(block)

    /** 首次启动：核心引擎建表与快照，领域迁移在单独事务里执行。 */
    fun initialize() {
        try {
            engine.initialize { tx -> SchemaVersion.migrate(tx) }
        } catch (error: Throwable) {
            val version = runCatching { engine.read(SchemaVersion::current) }.getOrDefault(-1)
            throw IllegalStateException(
                "数据库迁移失败（停在 v$version，已回滚到迁移前状态，可修复后重试）：${error.message}",
                error,
            )
        }
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
            runCatching { engine.reclaimFreePages() }
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
        engine.close()
    }

    /** 书源表被写过几次（`app_meta.source_revision`，由 source 表上的触发器维护）。 */
    internal fun sourceRevision(): Long = engine.read { db ->
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
