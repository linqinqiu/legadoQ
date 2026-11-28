package io.legado.data

import io.legado.data.core.DbSnapshot
import io.legado.model.*
import io.legado.source.ParsedSource
import java.security.MessageDigest
import java.sql.Connection

private val versionBookTables = listOf("book_shelf", "reading_progress", "book_note", "reading_log",
    "book_content_cache", "book_content_process", "book_cache_status", "book_shelf_tombstone")

internal class SourceVersionChanged : RuntimeException()
internal class SourceVersionBusy : RuntimeException()
internal class SourceVersionSnapshotFailed : RuntimeException()

/** A read transaction gives the preview one consistent view without creating a backup or writing. */
internal fun Database.previewSourceVersion(source: ParsedSource, request: SourceVersionRequest,
    candidates: List<SourceVersionLink>): SourceVersionPreview = connect { db ->
    db.autoCommit = false
    try { sourceVersionPlan(db, source, request, candidates) }
    finally { try { db.rollback() } finally { db.autoCommit = true } }
}

/** Serialize validation, forced safety snapshot and mutation with the normal database write lock. */
internal fun Database.activateSourceVersion(source: ParsedSource, request: SourceVersionRequest,
    candidates: List<SourceVersionLink>): SourceVersionResult = write { db ->
    val plan = sourceVersionPlan(db, source, request, candidates)
    if (plan.previewToken != request.previewToken) throw SourceVersionChanged()
    val selected = request.relink.map { link ->
        plan.aliases.firstOrNull { it.sourceId == link.sourceId && it.bookUrl == link.bookUrl }
            ?.takeUnless { it.conflict } ?: throw SourceVersionChanged()
    }
    require(selected.map { it.bookUrl }.distinct().size == selected.size) { "多条别名指向同一目标书籍，请分别处理" }
    val tocCopies = linkedMapOf<String, String>()
    selected.forEach { alias ->
        val toc = rows(db, "select toc_url from book_shelf where source_id=? and book_url=?", alias.sourceId, alias.bookUrl).single()[0]!!
        setOf(alias.bookUrl, toc).forEach { key ->
            if (rows(db, "select 1 from book_toc_cache where source_id=? and toc_url=?", alias.sourceId, key).isNotEmpty()) {
                val previous = tocCopies.putIfAbsent(key, alias.sourceId)
                if (previous != null && previous != alias.sourceId) throw SourceVersionChanged()
            }
        }
    }
    val ids = setOf(source.id) + selected.map { it.sourceId }
    if (ids.any { id -> rows(db, "select 1 from book_cache_status where source_id=? and state='caching'", id).isNotEmpty() })
        throw SourceVersionBusy()
    // Never prune a previous recovery point as a side effect of activating a rule version.
    val snapshot = DbSnapshot.run(db, dbPath, Int.MAX_VALUE) ?: throw SourceVersionSnapshotFailed()
    if (!DbSnapshot.isVerified(dbPath, snapshot.fileName.toString())) throw SourceVersionSnapshotFailed()
    val result = transaction { tx ->
        if (sourceVersionPlan(tx, source, request, candidates).previewToken != request.previewToken) throw SourceVersionChanged()
        val imported = importSourcesOn(tx, listOf(source.json))
        check(imported.errors.isEmpty() && imported.imported + imported.updated == 1)
        // Health belongs to the old rules. Keep enabled/sort_order, invalidate old health claims.
        val group = source.group?.split(Regex("[,，、\\s]+"))?.filter { it.isNotBlank() && it !in HEALTH_GROUP_TAGS }
            ?.joinToString(",")?.ifBlank { null }
        tx.prepareStatement("update source set source_group=? where id=?").use {
            it.setString(1, group); it.setString(2, source.id); it.executeUpdate()
        }
        tx.prepareStatement("delete from source_health where source_id=?").use { it.setString(1, source.id); it.executeUpdate() }
        // Shared keys from one alias are copied once; distinct aliases must never silently mix caches.
        tocCopies.forEach { (key, owner) ->
            tx.prepareStatement("insert into book_toc_cache(source_id,toc_url,chapters_json,updated_at) select ?,toc_url,chapters_json,updated_at from book_toc_cache where source_id=? and toc_url=?").use {
                it.setString(1, source.id); it.setString(2, owner); it.setString(3, key); it.executeUpdate()
            }
        }
        selected.forEach { alias ->
            versionBookTables.forEach { table ->
                tx.prepareStatement("update $table set source_id=? where source_id=? and book_url=?").use {
                    it.setString(1, source.id); it.setString(2, alias.sourceId); it.setString(3, alias.bookUrl); it.executeUpdate()
                }
            }
        }
        SourceVersionResult(source.id, selected.size, snapshot.fileName.toString())
    }
    invalidateSourceCaches()
    result
}

private fun sourceVersionPlan(db: Connection, source: ParsedSource, request: SourceVersionRequest,
    candidates: List<SourceVersionLink>): SourceVersionPreview {
    require(candidates.size <= 200) { "关联候选过多，请先整理留档" }
    val digest = MessageDigest.getInstance("SHA-256")
    fun bind(value: String?) {
        if (value == null) { digest.update("-1:".toByteArray()); return }
        val bytes = value.toByteArray(Charsets.UTF_8)
        digest.update("${bytes.size}:".toByteArray()); digest.update(bytes)
    }
    fun capture(sql: String, vararg args: String): List<List<String?>> {
        bind(sql); args.forEach(::bind)
        return rows(db, sql, *args).also { data ->
            bind(data.size.toString()); data.forEach { row -> row.forEach(::bind) }
        }
    }
    bind("legadoq-source-version-v1"); bind(request.archive); bind(request.index.toString()); bind(source.json)
    request.relink.sortedWith(compareBy({ it.sourceId }, { it.bookUrl })).forEach { bind(it.sourceId); bind(it.bookUrl) }
    val current = capture("select * from source where id=?", source.id)
    val version = rows(db, "select version from source where id=?", source.id).firstOrNull()?.first()?.toLong()
    val books = capture("select * from book_shelf where source_id=? order by book_url", source.id)
    val names = rows(db, "select name from book_shelf where source_id=? order by book_url limit 20", source.id).map { it[0]!! }
    // Bind reader changes as well: confirmation must not silently move a position being edited.
    capture("select * from reading_progress where source_id=? order by book_url", source.id)
    val cacheEntries = listOf("book_content_cache", "book_content_process", "book_toc_cache").sumOf {
        capture("select count(*) from $it where source_id=?", source.id).single()[0]!!.toInt()
    }
    val aliases = candidates.mapNotNull { link ->
        val shelf = capture("select name,toc_url from book_shelf where source_id=? and book_url=?", link.sourceId, link.bookUrl)
            .firstOrNull() ?: return@mapNotNull null
        var conflict = false
        versionBookTables.forEach { table ->
            // Cache content is preserved; bind keys, timestamps and lengths without loading full chapters.
            val columns = when (table) {
                "book_content_cache" -> "chapter_url,chapter_index,title,cached_at,length(content)"
                "book_content_process" -> "chapter_url,kind,updated_at,length(original),length(processed)"
                else -> "*"
            }
            capture("select $columns from $table where source_id=? and book_url=? order by rowid", link.sourceId, link.bookUrl)
            if (capture("select 1 from $table where source_id=? and book_url=? limit 1", source.id, link.bookUrl).isNotEmpty()) conflict = true
        }
        if (capture("select 1 from book_shelf_tombstone where source_id=? and book_url=?", link.sourceId, link.bookUrl).isNotEmpty()) conflict = true
        setOf(link.bookUrl, shelf[1]!!).forEach { key ->
            capture("select updated_at,length(chapters_json) from book_toc_cache where source_id=? and toc_url=?", link.sourceId, key)
            if (capture("select 1 from book_toc_cache where source_id=? and toc_url=?", source.id, key).isNotEmpty()) conflict = true
        }
        SourceVersionAlias(link.sourceId, link.bookUrl, shelf[0]!!, conflict)
    }
    return SourceVersionPreview(source.id, source.name, if (current.isEmpty()) null else version, books.size,
        names, cacheEntries, aliases, digest.digest().joinToString("") { "%02x".format(it) }, listOf(
            "将全局替换该规范书源 ID 的规则，影响所有关联书籍；保留本机启停和排序。",
            "保留已有正文、净化与目录缓存，可能继续显示旧规则结果；不自动联网重抓。",
            "沿用该 ID 的登录及脚本状态，不导入独立 Cookie 或登录记录，也不迁移别名整源状态；所选规则本身可能含请求头、脚本或内嵌凭据，请仅启用可信版本。书源体检结论将清除，需重新体检。",
            "确认前强制制作完整数据库快照；恢复需在启动快照区选择对应快照并重启，届时整库回滚，之后的新改动也会回退。",
            "仅明确勾选的别名书籍会重新关联，并保留进度、笔记、阅读记录及缓存；目标已有记录时拒绝，不合并或覆盖。"))
}

private fun rows(db: Connection, sql: String, vararg args: String): List<List<String?>> =
    db.prepareStatement(sql).use { statement ->
        args.forEachIndexed { index, value -> statement.setString(index + 1, value) }
        statement.executeQuery().use { result ->
            val count = result.metaData.columnCount
            buildList { while (result.next()) add((1..count).map { result.getString(it) }) }
        }
    }
