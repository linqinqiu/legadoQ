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
import org.sqlite.SQLiteConfig
import java.io.Closeable
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.security.SecureRandom
import java.sql.Connection
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.locks.ReentrantLock
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec
import kotlin.concurrent.withLock
import io.legado.AppConfig
import io.legado.cache.CachedCover
import io.legado.content.ContentProcessor
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

class Database(private val path: String) : Closeable, AutoCloseable {
    private val random = SecureRandom()
    private val writeLock = ReentrantLock()
    private val readPool = ConcurrentLinkedQueue<Connection>()
    private val maxPoolSize = AppConfig.dbPoolSize
    @Volatile internal var isClosed = false
    private var _writeConnection: Connection? = null
    private val allConnections = ConcurrentHashMap.newKeySet<Connection>()

    private val sqliteConfig = SQLiteConfig().apply {
        setJournalMode(SQLiteConfig.JournalMode.WAL)
        setSynchronous(SQLiteConfig.SynchronousMode.NORMAL)
        setBusyTimeout(10000)
        enforceForeignKeys(true)
    }

    init { Files.createDirectories(Path.of(path).toAbsolutePath().parent) }

    private fun createConnection(): Connection = sqliteConfig.createConnection("jdbc:sqlite:$path").also { allConnections.add(it) }

    private fun getWriteConnection(): Connection {
        var conn = _writeConnection
        if (conn == null || conn.isClosed) {
            conn = createConnection()
            _writeConnection = conn
        }
        return conn
    }

    internal fun <T> connect(block: (Connection) -> T): T {
        check(!isClosed) { "Database is closed" }
        var connection = readPool.poll()?.takeIf { !it.isClosed } ?: createConnection()
        return try {
            val result = block(connection)
            if (!isClosed && !connection.isClosed && readPool.size < maxPoolSize) {
                readPool.offer(connection)
            } else {
                runCatching { connection.close() }
            }
            result
        } catch (error: Throwable) {
            runCatching { connection.close() }
            if (error is java.sql.SQLException && !isClosed) {
                val fresh = createConnection()
                try {
                    val result = block(fresh)
                    if (!isClosed && !fresh.isClosed && readPool.size < maxPoolSize) {
                        readPool.offer(fresh)
                    } else {
                        runCatching { fresh.close() }
                    }
                    result
                } catch (retryError: Throwable) {
                    runCatching { fresh.close() }
                    throw retryError
                }
            } else {
                throw error
            }
        }
    }

    internal fun <T> write(block: (Connection) -> T): T = writeLock.withLock {
        check(!isClosed) { "Database is closed" }
        block(getWriteConnection())
    }

    override fun close() {
        if (isClosed) return
        isClosed = true
        writeLock.withLock {
            _writeConnection?.let { conn -> runCatching { conn.close() } }
            _writeConnection = null
        }
        while (true) {
            val conn = readPool.poll() ?: break
            runCatching { conn.close() }
        }
        // 关闭所有曾经创建的连接（含仍被在途 worker 借出、未归还池的连接），避免关闭时文件句柄残留导致 Windows 下删除失败。
        for (conn in allConnections) runCatching { conn.close() }
        allConnections.clear()
    }

    fun initialize() = write { db ->
        db.createStatement().use { statement ->
            statement.execute("pragma journal_mode = wal")
            statement.executeUpdate("""
                create table if not exists source (
                  id text primary key, name text not null, source_url text not null,
                  source_group text, enabled integer not null, is_js integer not null,
                  payload text not null, version integer not null, updated_at integer not null
                );
                create index if not exists source_name_idx on source(name);
                create index if not exists idx_source_name_nocase on source(name collate nocase);
                -- 键值小仓库：目前放「书源表被写过几次」（source_revision）和凭据统计的落盘结果。
                create table if not exists app_meta (
                  key text primary key, value text not null
                );
                insert or ignore into app_meta(key, value) values ('source_revision', '0');
                -- 书源一变，凭据管理里「N 个书源用到」的统计就该重算。用触发器计数而不是在
                -- 各条写入路径上手动 +1：导入、单个保存、批量改组、删除都走同一张表，
                -- 触发器不会漏，也不怕"改完数据忘了作废旧数"——那个旧数现在会带到下次启动。
                create trigger if not exists source_revision_insert after insert on source begin
                  update app_meta set value = cast(cast(value as integer) + 1 as text) where key = 'source_revision';
                end;
                create trigger if not exists source_revision_update after update on source begin
                  update app_meta set value = cast(cast(value as integer) + 1 as text) where key = 'source_revision';
                end;
                create trigger if not exists source_revision_delete after delete on source begin
                  update app_meta set value = cast(cast(value as integer) + 1 as text) where key = 'source_revision';
                end;
                create table if not exists reading_progress (
                  source_id text not null, book_url text not null, chapter_url text not null,
                  chapter_index integer not null, updated_at integer not null,
                  primary key (source_id, book_url)
                );
                create table if not exists cover_cache (
                  cache_key text primary key, content_type text not null
                );
                create table if not exists book_shelf (
                  source_id text not null, book_url text not null, name text not null,
                  author text, toc_url text not null, cover_url text, cover_key text,
                  last_read_at integer not null, completed integer not null default 0,
                  alternate_sources text, group_id integer not null default 0,
                  primary key (source_id, book_url)
                );
                create index if not exists book_shelf_last_read_idx on book_shelf(last_read_at desc);
                -- 书架分组（上游 data/entities/BookGroup.kt：主键 groupId、groupName、order）。
                -- 上游另有一批负数虚拟组（IdAll=-1 全部、IdLocal=-2 本地），我们不照抄：
                -- 虚拟组在界面上和真组混在一起会分不清"能不能改名/删除"，所以只做真组 + 未分组(0)。
                create table if not exists book_group (
                  group_id integer primary key, name text not null, sort_order integer not null default 0, created_at integer not null
                );
                -- `chapter_index` 是「这本书里第几章」：本书正文检索要按它排序、命中要能跳章。
                -- 正文按 URL 存，章号本来属于目录（book_toc_cache），但这张表被检索直接读，
                -- 不在行上留一份就只能每次去解目录 JSON —— 写入时目录就在手边，落下来更省事。
                -- 老库缺这一列由 migrateBookContentCache 补，并按目录回填。
                create table if not exists book_content_cache (
                  source_id text not null, book_url text not null, chapter_url text not null,
                  chapter_index integer not null default 0,
                  title text, content text not null, cached_at integer not null,
                  primary key (source_id, book_url, chapter_url)
                );
                create index if not exists book_content_cache_book_idx on book_content_cache(source_id, book_url);
                create table if not exists book_content_process (
                  source_id text not null, book_url text not null, chapter_url text not null,
                  kind text not null, original text not null, processed text not null, updated_at integer not null,
                  primary key (source_id, book_url, chapter_url, kind)
                );
                create table if not exists book_cache_status (
                  source_id text not null, book_url text not null, total_chapters integer not null default 0,
                  cached_chapters integer not null default 0, state text not null default 'idle',
                  last_error text, updated_at integer not null,
                  primary key (source_id, book_url)
                );
                create table if not exists source_subscription (
                  id integer primary key autoincrement, url text not null unique,
                  enabled integer not null, created_at integer not null, updated_at integer not null,
                  last_success_at integer, last_attempt_at integer, last_error text,
                  last_imported integer not null default 0, content_hash text
                );
                create index if not exists source_subscription_enabled_idx on source_subscription(enabled);
                -- 手机「订阅」页的 RSS 源（上游 data/entities/RssSource.kt，表名 rssSources，主键 sourceUrl）。
                -- 与书源同一套做法：只把列表/筛选要用的字段摊平出来，规则原文整体留在 payload 里交给引擎。
                create table if not exists rss_source (
                  source_url text primary key, name text not null, source_group text, source_icon text,
                  enabled integer not null, has_list_rule integer not null, payload text not null, updated_at integer not null
                );
                create index if not exists rss_source_group_idx on rss_source(source_group);
                create table if not exists book_toc_cache (
                  source_id text not null, toc_url text not null, chapters_json text not null, updated_at integer not null,
                  primary key (source_id, toc_url)
                );
                create table if not exists source_login_state (
                  source_id text primary key,
                  login_info text,
                  login_header text,
                  source_variable text,
                  source_kv text,
                  cookie_jar text,
                  updated_at integer not null
                );
                -- 登录凭据按**注册域**全局存一张表，与上游一致（Cookie.kt 只有 url/cookie 两列，
                -- 键是 NetworkUtils.getSubDomain(url) 的 eTLD+1）。所以「登录一次、所有访问该域
                -- 的书源都带上」是这套语义自带的结果，不需要也不存在"判定某书源是否已登录"的机制。
                -- source_login_state.cookie_jar 是改造前的旧形状，启动时一次性折叠进来后置空。
                create table if not exists cookie (
                  url text primary key,
                  cookie text not null,
                  updated_at integer not null
                );
                create table if not exists replace_rule (
                  id text primary key,
                  name text not null,
                  group_name text,
                  pattern text not null,
                  replacement text not null default '',
                  is_regex integer not null default 1,
                  scope text,
                  exclude_scope text,
                  scope_title integer not null default 0,
                  scope_content integer not null default 1,
                  is_enabled integer not null default 1,
                  sort_order integer not null default 0,
                  timeout_ms integer not null default 3000,
                  created_at integer not null,
                  updated_at integer not null
                );
                create index if not exists idx_replace_rule_enabled on replace_rule(is_enabled, sort_order asc);
                create index if not exists idx_replace_rule_group on replace_rule(group_name);
                -- 结构化日志落库（LogService 文档里承诺的 SQLite 持久化，此前只写了滚动文件）。
                -- 内存队列只有最近 1000 条、进程一退就没；入库后前端「运行日志」才能翻历史、按类别筛。
                create table if not exists log_entry (
                  id integer primary key autoincrement, ts integer not null,
                  category text not null, level text not null, message text not null,
                  context text, stack_trace text
                );
                create index if not exists idx_log_entry_ts on log_entry(ts desc);
                create index if not exists idx_log_entry_category on log_entry(category);
                -- 阅读记录（PROPOSAL-019 D）。粒度是「一天 · 一本书」一行：心跳累加秒数，
                -- 不是为了留审计流水，而是为了「今天读了多久 / 这本书累计读了多久」这类时间轴。
                -- 只增不改：接口只有 POST（累加）与 GET（读），没有编辑/删除单条的入口。
                create table if not exists reading_log (
                  day text not null, source_id text not null, book_url text not null,
                  book_name text, chapter_index integer not null default 0,
                  seconds integer not null default 0, updated_at integer not null,
                  primary key (day, source_id, book_url)
                );
                create index if not exists idx_reading_log_day on reading_log(day desc);
                -- 笔记 / 划线（PROPOSAL-019 E）。偏移是**章节内字符偏移**（`start_offset`/`end_offset`），
                -- 不是像素 / 列号 —— 字号、字体、分栏一改位置就跳，这是阅读器那条老教训。
                -- 同时留一份 `excerpt`（选中的原文）：偏移算错了还能靠它找回来，也让导出可读。
                create table if not exists book_note (
                  id integer primary key autoincrement,
                  source_id text not null, book_url text not null, book_name text,
                  chapter_url text, chapter_index integer not null default 0,
                  start_offset integer not null, end_offset integer not null,
                  excerpt text not null, note text not null default '',
                  bookmark integer not null default 0,
                  created_at integer not null, updated_at integer not null
                );
                create index if not exists idx_book_note_book on book_note(source_id, book_url, chapter_index);

                -- 书源体检结论（0.8.5）。以前体检结果只活在浏览器 localStorage 里：
                -- 服务端看不到，于是「搜索优先搜能用的源」这件事根本无从做起。
                -- 一场体检跑几十分钟的结论只有体检弹窗自己消费，而最该用它的搜索却拿不到。
                -- 一个源一行（按 id 覆盖），字段只留搜索排序与界面要用的那些。
                create table if not exists source_health (
                  source_id text primary key,
                  name text not null default '',
                  ok integer not null default 0,
                  latency_ms integer not null default 0,
                  status_category text not null default '',
                  error text,
                  checked_at integer not null default 0
                );
                create index if not exists idx_source_health_rank on source_health(ok desc, latency_ms asc);
            """.trimIndent())
            // 不再有账号与会话：这台服务不设身份（写操作只留 Guard.kt 的同源闸门）。
            // 老库里的这两张表是死重量，启动时收掉。
            statement.executeUpdate("drop table if exists app_user")
            statement.executeUpdate("drop table if exists session")
        }
        migrateReadingProgress(db)
        migrateBookshelf(db)
        migrateSourceTable(db)
        migrateLegacyCookieJars(db)
        migrateBookNote(db)
        migrateBookContentCache(db)
        reclaimFreePages(db)
    }

    /**
     * 回收空闲页（SQLite 的 `auto_vacuum=0` 是默认值：删掉的行腾出的页**不归还文件**，
     * 只进 freelist 等下次复用）。本机实测 216.6 MB 的库里 freelist 占 135.9 MB（62.7%），
     * 而真正在用的只有 80.7 MB —— 用户删书、清缓存、日志按 5000 行滚动淘汰，腾出的空间
     * 全部滞留在文件里，看起来像"库莫名其妙这么大"。
     *
     * 这里不改成 `auto_vacuum=INCREMENTAL`（那要一次性全量 VACUUM 迁移，且会让每次删除
     * 都多一次页移动），而是启动时按碎片率判断：超过 [VACUUM_THRESHOLD] 才跑一次全量
     * VACUUM，一次把文件缩回去。碎片率低时什么都不做，不给启动加负担。
     *
     * 注意：VACUUM 不能在事务里跑，也不能有其他连接在读 —— 此时刚 initialize，只有写连接。
     */
    private fun reclaimFreePages(db: Connection) {
        // 读碎片率这一步失败（老库/权限问题）静默跳过 —— 压缩是优化，不是功能前提。
        val pageCount = runCatching {
            db.createStatement().use { st -> st.executeQuery("pragma page_count").use { if (it.next()) it.getLong(1) else 0L } }
        }.getOrNull() ?: return
        val freePages = runCatching {
            db.createStatement().use { st -> st.executeQuery("pragma freelist_count").use { if (it.next()) it.getLong(1) else 0L } }
        }.getOrNull() ?: return
        if (pageCount <= 0 || freePages <= 0) return
        val ratio = freePages.toDouble() / pageCount
        if (ratio < VACUUM_THRESHOLD) return

        // **VACUUM 失败必须说出来。**
        // 原来整段包在一个 runCatching 里，VACUUM 抛异常（磁盘满、库被别的进程锁着、
        // WAL 未落盘）会被静默吞掉：用户只知道"库还是那么大"，日志里一个字都没有，
        // 排查时连"它试过压缩、但失败了"都看不出来。失败不影响功能，但必须留痕。
        val before = pageCount
        runCatching {
            db.createStatement().use { it.execute("VACUUM") }
            // optimize 只在确实压过之后跑：它做的是 ANALYZE 与索引统计刷新。
            db.createStatement().use { it.execute("pragma optimize") }
        }.onSuccess {
            val after = runCatching {
                db.createStatement().use { st -> st.executeQuery("pragma page_count").use { if (it.next()) it.getLong(1) else before } }
            }.getOrDefault(before)
            System.err.println(
                "数据库碎片回收：空闲页 $freePages/$pageCount（${(ratio * 100).toInt()}%）" +
                    "已 VACUUM，${before} → $after 页",
            )
        }.onFailure { error ->
            System.err.println(
                "数据库碎片回收失败（空闲页 $freePages/$pageCount，${(ratio * 100).toInt()}%）：" +
                    "${error.javaClass.simpleName}: ${error.message} —— 不影响功能，只是文件没缩回去",
            )
        }
    }

    companion object {
        /** 空闲页占比超过这个值就在启动时压缩一次；低于则不动（避免每次启动都重写 200MB）。 */
        private const val VACUUM_THRESHOLD = 0.25
    }







    /**
     * 列表顺序：排过序的在前，没排过的按名称跟在后面。
     * 全库都没编号时 `sort_order is null` 恒为 1、`sort_order` 全 NULL，等价于原来那条按名称排 ——
     * 所以这条改动对没用过自定义排序的人是零影响的，不会因为一次拖动就把整库顺序钉死。
     */
    // —— 书源清单缓存：两张清单只在 source 表写入时变化，而每次重算要 0.5~1.1s
    // （5,574 行投影的序列化 + explore 的 JSON1 全表扫描），书源页/发现页每次进入都重算
    // 就是「部分情景加载缓慢」的主因。所有写入路径统一走 invalidateSourceCaches()。
    @Volatile internal var sourceSummariesCache: List<SourceSummary>? = null
    @Volatile internal var exploreSourcesCache: List<SourceSummary>? = null
    /** 凭据桶「被多少书源提到」的统计缓存，定义与说明见 `CookieDao.kt`。 */
    internal val cookieMentions = CookieMentions()
    internal fun invalidateSourceCaches() {
        sourceSummariesCache = null; exploreSourcesCache = null
        // 凭据管理的「N 个书源提到」也是从 source 表算出来的，同样在这里失效；
        // 接着让后台线程提前重算（全库扫描要 0.7 秒，摊在打开凭据管理那一下太贵）。
        cookieMentions.invalidate()
        MentionsWarmer.schedule(this)
    }

    /**
     * 书源表被写过几次（`app_meta.source_revision`，由 source 表上的触发器维护）。
     *
     * 凭据统计落盘时带上它：下次启动读到「落盘时的版本 == 现在的版本」就直接用，
     * 不必再把 24 MB payload 扫一遍。触发器让这个数**在同一个事务里**跟着书源走，
     * 不存在"数据改了、计数没来得及加"的窗口 —— 那正是启动时能安全跳过扫描的前提。
     */
    internal fun sourceRevision(): Long = connect { db ->
        db.prepareStatement("select value from app_meta where key = 'source_revision'").use { statement ->
            statement.executeQuery().use { rs -> if (rs.next()) rs.getString(1)?.toLongOrNull() ?: 0L else 0L }
        }
    }


    // —— 建表迁移（initialize 是唯一调用方）——
    /**
     * 一次性迁移：把旧的「按书源各存一份」`source_login_state.cookie_jar` 折叠进全局表。
     * 同域可能来自多个书源，所以仍走按键合并；迁完把旧列置空，避免下次又读回来源。
     */
    private fun migrateLegacyCookieJars(db: Connection) {
        val rows = db.prepareStatement("select source_id, cookie_jar from source_login_state where cookie_jar is not null and cookie_jar <> ''").use { stmt ->
            stmt.executeQuery().use { rs ->
                generateSequence { if (rs.next()) (rs.getString(2) ?: "") else null }.toList()
            }
        }
        if (rows.isEmpty()) return
        val folded = linkedMapOf<String, String>()
        rows.forEach { jarJson ->
            val jar = runCatching { Json.decodeFromString<Map<String, String>>(jarJson) }.getOrNull() ?: return@forEach
            jar.forEach { (host, value) ->
                if (host.isBlank() || value.isBlank()) return@forEach
                val bucket = cookieBucket(host)
                val merged = linkedMapOf<String, String>()
                folded[bucket]?.let { merged.putAll(parseCookieString(it)) }
                merged.putAll(parseCookieString(value))
                folded[bucket] = merged.entries.joinToString("; ") { "${it.key}=${it.value}" }
            }
        }
        if (folded.isNotEmpty()) {
            db.prepareStatement("""
                insert into cookie(url, cookie, updated_at) values(?, ?, ?)
                on conflict(url) do update set cookie=excluded.cookie, updated_at=excluded.updated_at
            """).use { stmt ->
                folded.forEach { (bucket, value) ->
                    stmt.setString(1, bucket)
                    stmt.setString(2, value)
                    stmt.setLong(3, System.currentTimeMillis())
                    stmt.addBatch()
                }
                stmt.executeBatch()
            }
        }
        db.prepareStatement("update source_login_state set cookie_jar = null where cookie_jar is not null").use { it.executeUpdate() }
    }

    private fun migrateReadingProgress(db: Connection) {
        val columns = db.createStatement().use { statement ->
            statement.executeQuery("pragma table_info(reading_progress)").use { result ->
                buildSet { while (result.next()) add(result.getString("name")) }
            }
        }
        if ("scroll_position" !in columns) {
            db.createStatement().use { it.executeUpdate("alter table reading_progress add column scroll_position real not null default 0") }
        }
        // 逻辑位置模型（P1-T1）：章节内字符偏移 + 段落锚点 + 编码版本 + 内容校验值。
        if ("char_offset" !in columns) {
            db.createStatement().use { it.executeUpdate("alter table reading_progress add column char_offset integer not null default 0") }
        }
        if ("paragraph_anchor" !in columns) {
            db.createStatement().use { it.executeUpdate("alter table reading_progress add column paragraph_anchor text") }
        }
        if ("position_version" !in columns) {
            db.createStatement().use { it.executeUpdate("alter table reading_progress add column position_version integer not null default 1") }
        }
        if ("position_checksum" !in columns) {
            db.createStatement().use { it.executeUpdate("alter table reading_progress add column position_checksum text") }
        }
    }

    private fun migrateBookshelf(db: Connection) {
        val columns = db.createStatement().use { statement -> statement.executeQuery("pragma table_info(book_shelf)").use { rs -> buildSet { while (rs.next()) add(rs.getString("name")) } } }
        if ("completed" !in columns) db.createStatement().use { it.executeUpdate("alter table book_shelf add column completed integer not null default 0") }
        if ("alternate_sources" !in columns) db.createStatement().use { it.executeUpdate("alter table book_shelf add column alternate_sources text") }
        if ("group_id" !in columns) db.createStatement().use { it.executeUpdate("alter table book_shelf add column group_id integer not null default 0") }
        // 本地书记住"这本书是用哪条目录规则切的"：换规则重切之后界面要能说实话，
        // 而不是显示一个全局设置值假装每本书都按它来。
        if ("toc_rule" !in columns) db.createStatement().use { it.executeUpdate("alter table book_shelf add column toc_rule text") }
        // 自定义排序位。**可空**，且空就是"没参与过自定义排序"：书架 24 本里拖动一本，
        // 不该顺手把另外 23 本钉死在拖动那一刻的界面上（那之后按最后阅读排就永远排不动了）。
        // 没参与的那些按 `last_read_at` 落在同一分组内的有序段之后（见前端 shelfOrder.ts）。
        if ("sort_order" !in columns) db.createStatement().use { it.executeUpdate("alter table book_shelf add column sort_order integer") }
    }

    private fun migrateSourceTable(db: Connection) {
        val columns = db.createStatement().use { statement ->
            statement.executeQuery("pragma table_info(source)").use { rs ->
                buildSet { while (rs.next()) add(rs.getString("name")) }
            }
        }
        if ("has_login" !in columns) {
            db.createStatement().use {
                it.executeUpdate("alter table source add column has_login integer not null default 0")
            }
        }
        // 自定义排序位，**可空**：只给拖过的那一列编号。全库 5,574 个源如果被一次拖动全编号，
        // 之后"按名称"就再也排不动了 —— 没参与过的必须保持没参与。
        if ("sort_order" !in columns) {
            db.createStatement().use { it.executeUpdate("alter table source add column sort_order integer") }
        }
        db.createStatement().use {
            it.executeUpdate("update source set has_login = 1 where (payload like '%\"loginUi\"%' or payload like '%\"loginUrl\"%' or payload like '%\"loginCheckJs\"%') and (has_login is null or has_login = 0)")
        }
    }

    /** 笔记表加 `bookmark` 列（0.8.x 书签需求）。老库缺列就补，已有就跳过。 */
    private fun migrateBookNote(db: Connection) {
        val columns = db.createStatement().use { statement ->
            statement.executeQuery("pragma table_info(book_note)").use { rs ->
                buildSet { while (rs.next()) add(rs.getString("name")) }
            }
        }
        if ("bookmark" !in columns) {
            db.createStatement().use {
                it.executeUpdate("alter table book_note add column bookmark integer not null default 0")
            }
        }
        // 逻辑位置模型（P1-T1）：段落锚点 + 编码版本 + 内容校验值，配合 char 偏移做失效回退。
        if ("paragraph_anchor" !in columns) {
            db.createStatement().use { it.executeUpdate("alter table book_note add column paragraph_anchor text") }
        }
        if ("position_version" !in columns) {
            db.createStatement().use { it.executeUpdate("alter table book_note add column position_version integer not null default 1") }
        }
        if ("position_checksum" !in columns) {
            db.createStatement().use { it.executeUpdate("alter table book_note add column position_checksum text") }
        }
    }

    /**
     * 缓存正文表加 `chapter_index` 列（本书正文检索要按章号排序、命中要能跳章）。
     *
     * 老库缺列就补；补完**必须按目录回填一次** —— 不回填的话历史缓存行的章号全是 0，
     * 检索命中会统统跳回第 1 章，比搜不到更误导。
     */
    private fun migrateBookContentCache(db: Connection) {
        val columns = db.createStatement().use { statement ->
            statement.executeQuery("pragma table_info(book_content_cache)").use { rs ->
                buildSet { while (rs.next()) add(rs.getString("name")) }
            }
        }
        if ("chapter_index" in columns) return
        db.createStatement().use {
            it.executeUpdate("alter table book_content_cache add column chapter_index integer not null default 0")
        }

        // 回填：一本书只解一次目录 JSON，再把这本已缓存的行按 URL 对回章号。
        val books = buildList {
            db.createStatement().use { statement ->
                statement.executeQuery("select distinct source_id, book_url from book_content_cache").use { rs ->
                    while (rs.next()) add(rs.getString(1) to rs.getString(2))
                }
            }
        }
        if (books.isEmpty()) return
        db.prepareStatement(
            "update book_content_cache set chapter_index = ? where source_id = ? and book_url = ? and chapter_url = ?",
        ).use { update ->
            var pending = 0
            for ((sourceId, bookUrl) in books) {
                val indexByUrl = readTocChapters(db, sourceId, bookUrl)
                    ?.associate { it.url to it.index }
                    ?.takeIf { it.isNotEmpty() }
                    ?: continue
                db.prepareStatement(
                    "select chapter_url from book_content_cache where source_id = ? and book_url = ?",
                ).use { select ->
                    select.setString(1, sourceId)
                    select.setString(2, bookUrl)
                    select.executeQuery().use { rs ->
                        while (rs.next()) {
                            val url = rs.getString(1) ?: continue
                            val index = indexByUrl[url] ?: continue
                            update.setInt(1, index)
                            update.setString(2, sourceId)
                            update.setString(3, bookUrl)
                            update.setString(4, url)
                            update.addBatch()
                            pending++
                        }
                    }
                }
            }
            if (pending > 0) update.executeBatch()
        }
    }
}

class VersionConflict : RuntimeException()
