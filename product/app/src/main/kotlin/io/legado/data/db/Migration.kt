package io.legado.data.db

import io.legado.AppConfig
import io.legado.data.cookieBucket
import io.legado.data.Database
import io.legado.data.parseCookieString
import io.legado.data.readTocChapters
import kotlinx.serialization.json.Json
import kotlin.collections.buildSet
import kotlin.collections.linkedMapOf
import java.sql.Connection
import java.util.Base64

/**
 * 数据库迁移：从 `Database.kt.initialize()` 拆出。
 *
 * 职责：旧库缺列补列、旧表折叠（cookie_jar → cookie）、VACUUM 碎片回收。
 * 所有迁移在 `initialize()` 之后执行，确保表已存在。
 */
object Migration {

    /** 启动快照：距最近一份不足间隔则跳过，否则 `VACUUM INTO`。 */
    fun maybeSnapshot(db: Connection, dbPath: String) {
        val keep = io.legado.AppConfig.dbSnapshotKeep
        if (keep <= 0) return
        val dir = io.legado.data.DbSnapshot.backupsDirOf(dbPath)
        val minInterval = io.legado.AppConfig.dbSnapshotMinIntervalMs
        val latest = io.legado.data.DbSnapshot.latestSnapshotTs(dir)
        if (minInterval > 0L && latest != null && System.currentTimeMillis() - latest < minInterval) return
        io.legado.data.DbSnapshot.run(db, dbPath, keep)
    }

    /** 回收空闲页：碎片率超过阈值时全量 VACUUM。 */
    fun reclaimFreePages(db: Connection) {
        val pageCount = runCatching {
            db.createStatement().use { st -> st.executeQuery("pragma page_count").use { if (it.next()) it.getLong(1) else 0L } }
        }.getOrNull() ?: return
        val freePages = runCatching {
            db.createStatement().use { st -> st.executeQuery("pragma freelist_count").use { if (it.next()) it.getLong(1) else 0L } }
        }.getOrNull() ?: return
        if (pageCount <= 0 || freePages <= 0) return
        val ratio = freePages.toDouble() / pageCount
        val threshold = 0.25
        if (ratio < threshold) return

        val before = pageCount
        runCatching {
            db.createStatement().use { it.execute("VACUUM") }
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

    /** 折叠旧的 `source_login_state.cookie_jar` 进全局 `cookie` 表。 */
    fun migrateLegacyCookieJars(db: Connection) {
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

    /** 补 `reading_progress` 缺失列。 */
    fun migrateReadingProgress(db: Connection) {
        val columns = db.createStatement().use { statement ->
            statement.executeQuery("pragma table_info(reading_progress)").use { result ->
                buildSet { while (result.next()) add(result.getString("name")) }
            }
        }
        if ("scroll_position" !in columns) {
            db.createStatement().use { it.executeUpdate("alter table reading_progress add column scroll_position real not null default 0") }
        }
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

    /** 补 `book_shelf` 缺失列。 */
    fun migrateBookshelf(db: Connection) {
        val columns = db.createStatement().use { statement -> statement.executeQuery("pragma table_info(book_shelf)").use { rs -> buildSet { while (rs.next()) add(rs.getString("name")) } } }
        if ("completed" !in columns) db.createStatement().use { it.executeUpdate("alter table book_shelf add column completed integer not null default 0") }
        if ("alternate_sources" !in columns) db.createStatement().use { it.executeUpdate("alter table book_shelf add column alternate_sources text") }
        if ("group_id" !in columns) db.createStatement().use { it.executeUpdate("alter table book_shelf add column group_id integer not null default 0") }
        if ("toc_rule" !in columns) db.createStatement().use { it.executeUpdate("alter table book_shelf add column toc_rule text") }
        if ("sort_order" !in columns) db.createStatement().use { it.executeUpdate("alter table book_shelf add column sort_order integer") }
    }

    /** 补 `source` 缺失列并回填 has_login。 */
    fun migrateSourceTable(db: Connection) {
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
        if ("sort_order" !in columns) {
            db.createStatement().use { it.executeUpdate("alter table source add column sort_order integer") }
        }
        db.createStatement().use {
            it.executeUpdate("update source set has_login = 1 where (payload like '%\\\"loginUi\\\"%' or payload like '%\\\"loginUrl\\\"%' or payload like '%\\\"loginCheckJs\\\"%') and (has_login is null or has_login = 0)")
        }
    }

    /** 补 `book_note` 缺失列。 */
    fun migrateBookNote(db: Connection) {
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

    /** 补 `book_content_cache.chapter_index` 并按目录回填。 */
    fun migrateBookContentCache(db: Connection) {
        val columns = db.createStatement().use { statement ->
            statement.executeQuery("pragma table_info(book_content_cache)").use { rs ->
                buildSet { while (rs.next()) add(rs.getString("name")) }
            }
        }
        if ("chapter_index" in columns) return
        db.createStatement().use {
            it.executeUpdate("alter table book_content_cache add column chapter_index integer not null default 0")
        }

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

    /** 读该书的目录章节（迁移用，不自己开连接）。 */
    private fun readTocChapters(db: Connection, sourceId: String, bookUrl: String): List<io.legado.model.Chapter>? =
        io.legado.data.readTocChapters(db, sourceId, bookUrl)
}
