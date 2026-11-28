package io.legado.data

import io.legado.model.BackupLibraryDiff
import io.legado.model.BackupLibraryPolicy
import io.legado.model.BackupShelfEntry
import io.legado.model.LibraryImportResult
import java.security.MessageDigest
import java.sql.Connection

/** 只读快照：借用读连接，不经过写连接池，不提交任何数据。 */
internal fun Database.previewLibraryRestore(entries: List<BackupShelfEntry>, policy: BackupLibraryPolicy, fileHash: String): LibraryRestorePlan =
    connect { db ->
        db.autoCommit = false
        try { planLibraryRestore(db, entries, policy, fileHash) }
        finally { try { db.rollback() } finally { db.autoCommit = true } }
    }

internal data class LibraryRestoreAction(val entry: BackupShelfEntry, val metadata: Boolean, val progress: Boolean)
internal data class LibraryRestorePlan(val actions: List<LibraryRestoreAction>, val diff: BackupLibraryDiff, val token: String)

internal fun libraryRestoreContext(policy: BackupLibraryPolicy, fileHash: String): String =
    MessageDigest.getInstance("SHA-256").digest("library-restore-v1:$fileHash:${policy.metadata}:${policy.progress}".toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }

/** 预览和写入使用同一判据；指纹包含文件、策略及相关行的完整值，避免同毫秒变化漏检。 */
internal fun planLibraryRestore(db: Connection, entries: List<BackupShelfEntry>, policy: BackupLibraryPolicy, fileHash: String): LibraryRestorePlan {
    policy.validate()
    val digest = MessageDigest.getInstance("SHA-256")
    fun hash(value: String?) {
        val bytes = value?.toByteArray(Charsets.UTF_8)
        digest.update(java.nio.ByteBuffer.allocate(4).putInt(bytes?.size ?: -1).array())
        if (bytes != null) digest.update(bytes)
    }
    val context = libraryRestoreContext(policy, fileHash)
    hash(context)
    val unique = entries.associateBy { it.sourceId to it.bookUrl }.values
    var added = 0; var updated = 0; var kept = 0; var deleted = 0
    var applied = 0; var progressKept = 0; var unknown = 0
    val actions = mutableListOf<LibraryRestoreAction>()
    val tables = listOf("book_shelf", "reading_progress", "book_shelf_tombstone")
    val queries = tables.map { db.prepareStatement("select * from $it where source_id=? and book_url=?") }
    try {
        for (entry in unique) {
            hash(entry.sourceId); hash(entry.bookUrl)
            val rows = queries.mapIndexed { index, query ->
                query.setString(1, entry.sourceId); query.setString(2, entry.bookUrl)
                query.executeQuery().use { rs ->
                    hash(tables[index])
                    if (!rs.next()) { hash("absent"); null } else {
                        hash("present")
                        buildMap<String, String?> {
                            for (column in 1..rs.metaData.columnCount) {
                                val name = rs.metaData.getColumnName(column)
                                val value = rs.getString(column)
                                hash(name); hash(value); put(name, value)
                            }
                        }
                    }
                }
            }
            if (rows[2] != null) { deleted++; continue }
            val exists = rows[0] != null
            val metadata = !exists || policy.metadata == "overwrite"
            if (!exists) added++ else if (metadata) updated++ else kept++
            val hasProgress = entry.hasProgress && entry.chapterIndex >= 0
            val progress = hasProgress && when (policy.progress) {
                "overwrite" -> true
                "newer" -> entry.readAt > 0 && (rows[1] == null || entry.readAt > (rows[1]?.get("updated_at")?.toLongOrNull() ?: 0))
                else -> false
            }
            if (progress) applied++ else if (hasProgress) progressKept++
            if (hasProgress && entry.readAt <= 0) unknown++
            actions += LibraryRestoreAction(entry, metadata, progress)
        }
    } finally { queries.forEach { it.close() } }
    return LibraryRestorePlan(actions, BackupLibraryDiff(added, updated, kept, deleted, applied, progressKept, unknown,
        entries.size - unique.size), context + ":" + digest.digest().joinToString("") { "%02x".format(it) })
}

/** 调用方先在同一写事务中检查 token，再写其他域及此计划。保留本机分组与删除决定。 */
internal fun applyLibraryRestore(db: Connection, plan: LibraryRestorePlan): LibraryImportResult {
    val now = System.currentTimeMillis()
    db.prepareStatement("""
        insert into book_shelf(source_id,book_url,name,author,toc_url,cover_url,cover_key,last_read_at,completed,alternate_sources,group_id)
        values(?,?,?,?,?,?,null,?,?,null,?)
        on conflict(source_id,book_url) do update set
          name=excluded.name,author=excluded.author,toc_url=excluded.toc_url,
          cover_url=coalesce(excluded.cover_url,book_shelf.cover_url),
          last_read_at=max(book_shelf.last_read_at,excluded.last_read_at),completed=excluded.completed
    """.trimIndent()).use { save ->
        db.prepareStatement("""
            insert into reading_progress(source_id,book_url,chapter_url,chapter_index,scroll_position,char_offset,updated_at)
            values(?,?, '',?,0,?,?)
            on conflict(source_id,book_url) do update set
              chapter_url=excluded.chapter_url,chapter_index=excluded.chapter_index,
              scroll_position=0,char_offset=excluded.char_offset,paragraph_anchor=null,
              position_version=1,position_checksum=null,updated_at=excluded.updated_at
        """.trimIndent()).use { progress ->
            for (action in plan.actions) {
                val entry = action.entry
                if (action.metadata) {
                    save.setString(1, entry.sourceId); save.setString(2, entry.bookUrl); save.setString(3, entry.name)
                    save.setString(4, entry.author); save.setString(5, entry.tocUrl); save.setString(6, entry.coverUrl)
                    save.setLong(7, entry.readAt.coerceAtLeast(0)); save.setInt(8, if (entry.completed) 1 else 0)
                    save.setLong(9, entry.groupId); save.addBatch()
                }
                if (action.progress) {
                    progress.setString(1, entry.sourceId); progress.setString(2, entry.bookUrl)
                    progress.setInt(3, entry.chapterIndex); progress.setInt(4, entry.chapterPos)
                    progress.setLong(5, if (entry.readAt > 0) entry.readAt else now); progress.addBatch()
                }
            }
            save.executeBatch(); progress.executeBatch()
        }
    }
    db.prepareStatement("update book_shelf set last_read_at=max(last_read_at,?) where source_id=? and book_url=?").use { update ->
        plan.actions.filter { it.progress }.forEach { action ->
            update.setLong(1, if (action.entry.readAt > 0) action.entry.readAt else now)
            update.setString(2, action.entry.sourceId); update.setString(3, action.entry.bookUrl); update.addBatch()
        }
        update.executeBatch()
    }
    return plan.diff.let { LibraryImportResult(it.booksAdded, it.booksUpdated, it.progressApplied, it.skippedDeleted, it) }
}
