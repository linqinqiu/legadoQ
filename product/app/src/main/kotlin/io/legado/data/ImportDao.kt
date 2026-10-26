package io.legado.data

import io.legado.model.BackupShelfEntry
import io.legado.model.ImportResponse
import io.legado.model.LibraryImportResult
import io.legado.source.ParsedRssSource
import io.legado.source.SourceCodec

/**
 * `Database` 的整批导入落库面：RSS 源、备份分组与备份库面（0.8.2 结构重排从 `Database.kt` 逐字拆出）。
 * 写成同包扩展函数：调用点 `database.foo()` 与成员写法逐字一致；连接、`connect`/`write`（internal）、
 * 建表与迁移留在 `Database.kt`。跨包调用这些面需 `import io.legado.data.<方法>`（顶层扩展不是成员）。
 */
/**
 * RSS 订阅源落库（备份包 `rssSources.json`、界面粘贴的 JSON 数组都走这里）。
 * 主键是 `sourceUrl`，同地址再导入是整体覆盖 —— 与上游 `Restore.kt` 的
 * `rssSourceDao.insert`（`@Insert(onConflict = REPLACE)`）同语义，不保留本地改动。
 */
fun Database.importRssSources(rawSources: List<String>): ImportResponse {
    val errors = mutableListOf<String>()
    val unique = linkedMapOf<String, ParsedRssSource>()
    rawSources.forEachIndexed { index, raw ->
        try {
            val parsed = SourceCodec.parseRss(raw)
            unique[parsed.sourceUrl] = parsed
        } catch (error: IllegalArgumentException) {
            errors += "第 ${index + 1} 项：${error.message}"
        }
    }
    if (unique.isEmpty()) return ImportResponse(0, 0, 0, errors)
    var imported = 0
    var updated = 0
    write { db ->
        db.autoCommit = false
        try {
            db.prepareStatement("select 1 from rss_source where source_url = ?").use { current ->
                db.prepareStatement("""insert into rss_source(source_url,name,source_group,source_icon,enabled,has_list_rule,payload,updated_at)
                    values(?,?,?,?,?,?,?,?) on conflict(source_url) do update set name=excluded.name,
                      source_group=excluded.source_group,source_icon=excluded.source_icon,enabled=excluded.enabled,
                      has_list_rule=excluded.has_list_rule,payload=excluded.payload,updated_at=excluded.updated_at""").use { save ->
                    val now = System.currentTimeMillis()
                    unique.values.forEach { parsed ->
                        current.setString(1, parsed.sourceUrl)
                        if (current.executeQuery().use { it.next() }) updated++ else imported++
                        save.setString(1, parsed.sourceUrl); save.setString(2, parsed.name); save.setString(3, parsed.group)
                        save.setString(4, parsed.icon); save.setInt(5, if (parsed.enabled) 1 else 0)
                        save.setInt(6, if (parsed.hasListRule) 1 else 0); save.setString(7, parsed.json)
                        save.setLong(8, now); save.addBatch()
                    }
                    save.executeBatch()
                }
            }
            db.commit()
        } catch (error: Throwable) { db.rollback(); throw error } finally { db.autoCommit = true }
    }
    invalidateSourceCaches()
    return ImportResponse(imported, updated, rawSources.size - unique.size, errors)
}

/**
 * 恢复手机备份里的 `bookGroup.json`（上游 `Backup.kt:285` ← `bookGroupDao.all`，
 * 字段是 `groupId/groupName/cover/order/…`，见 §2.1）。
 *
 * **不照抄手机那套号码**：`groupId` 是手机自己库里的自增号，本机同号可能完全是另一个组
 * （本机 1 号往往已经是导入本地书时建的「本地」）。所以按名字找已有组、没有就新建，
 * 返回「手机号 → 本机号」映射给书架条目落组用；同名组只留一个，重复导入不堆第二份。
 */
fun Database.importBookGroups(groups: List<Pair<Long, String>>): Map<Long, Long> {
    val mapping = LinkedHashMap<Long, Long>()
    if (groups.isEmpty()) return mapping
    write { db ->
        db.autoCommit = false
        try {
            groups.forEach { (phoneId, rawName) ->
                val name = rawName.trim()
                if (phoneId <= 0 || name.isEmpty() || name == "全部" || mapping.containsKey(phoneId)) return@forEach
                val existing = db.prepareStatement("select group_id from book_group where name = ? collate nocase").use { find ->
                    find.setString(1, name)
                    find.executeQuery().use { rs -> if (rs.next()) rs.getLong(1) else null }
                }
                val localId = existing ?: db.prepareStatement("select coalesce(max(group_id), 0) + 1 from book_group").use { q ->
                    q.executeQuery().use { rs -> rs.next(); rs.getLong(1) }
                }.also { id ->
                    db.prepareStatement("insert into book_group(group_id, name, sort_order, created_at) values(?,?,?,?)").use {
                        it.setLong(1, id); it.setString(2, name); it.setInt(3, id.toInt()); it.setLong(4, System.currentTimeMillis())
                        it.executeUpdate()
                    }
                }
                mapping[phoneId] = localId
            }
            db.commit()
        } catch (error: Throwable) { db.rollback(); throw error } finally { db.autoCommit = true }
    }
    return mapping
}

/**
 * 备份导入：批量写入书架条目，并写入阅读进度（仅当备份时间不早于库中进度时覆盖，避免进度回退）。
 * 备份包只带章节序号与字符偏移，因此 [BackupShelfEntry.chapterIndex] 之外的定位信息不落库。
 */
fun Database.importLibrary(entries: List<BackupShelfEntry>): LibraryImportResult {
    if (entries.isEmpty()) return LibraryImportResult(0, 0, 0)
    val now = System.currentTimeMillis()
    var imported = 0
    var updated = 0
    var progressApplied = 0
    write { db ->
        db.autoCommit = false
        try {
            db.prepareStatement("select 1 from book_shelf where source_id = ? and book_url = ?").use { existing ->
                db.prepareStatement("""
                    insert into book_shelf(source_id,book_url,name,author,toc_url,cover_url,cover_key,last_read_at,completed,alternate_sources,group_id)
                    values(?,?,?,?,?,?,null,?,?,null,?)
                    on conflict(source_id,book_url) do update set
                      name=excluded.name, author=excluded.author, toc_url=excluded.toc_url,
                      cover_url=coalesce(excluded.cover_url,book_shelf.cover_url),
                      last_read_at=excluded.last_read_at, completed=excluded.completed
                """.trimIndent()).use { save ->
                    entries.forEach { entry ->
                        existing.setString(1, entry.sourceId); existing.setString(2, entry.bookUrl)
                        if (existing.executeQuery().use { it.next() }) updated++ else imported++
                        save.setString(1, entry.sourceId); save.setString(2, entry.bookUrl); save.setString(3, entry.name)
                        save.setString(4, entry.author); save.setString(5, entry.tocUrl); save.setString(6, entry.coverUrl)
                        save.setLong(7, if (entry.readAt > 0) entry.readAt else now)
                        save.setInt(8, if (entry.completed) 1 else 0)
                        // 组号只在"新书进架"时生效（on conflict 那串里没有它）：
                        // 已在架的书保留本机分组，理由与书源 enabled 一样 —— 本机策展不被备份冲掉。
                        save.setLong(9, entry.groupId)
                        save.addBatch()
                    }
                    save.executeBatch()
                }
            }
            val progressed = entries.filter { it.chapterIndex > 0 }
            if (progressed.isNotEmpty()) {
                db.prepareStatement("""
                    insert into reading_progress(source_id,book_url,chapter_url,chapter_index,scroll_position,updated_at)
                    values(?,?,?,?,0,?)
                    on conflict(source_id,book_url) do update set
                      chapter_url=excluded.chapter_url, chapter_index=excluded.chapter_index, updated_at=excluded.updated_at
                    where excluded.updated_at >= reading_progress.updated_at
                """.trimIndent()).use { stmt ->
                    progressed.forEach { entry ->
                        stmt.setString(1, entry.sourceId); stmt.setString(2, entry.bookUrl); stmt.setString(3, "")
                        stmt.setInt(4, entry.chapterIndex); stmt.setLong(5, if (entry.readAt > 0) entry.readAt else now)
                        stmt.addBatch()
                    }
                    progressApplied = stmt.executeBatch().sum()
                }
            }
            db.commit()
        } catch (error: Throwable) { db.rollback(); throw error } finally { db.autoCommit = true }
    }
    return LibraryImportResult(imported, updated, progressApplied)
}
