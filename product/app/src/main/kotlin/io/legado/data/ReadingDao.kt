package io.legado.data

import io.legado.model.BookNote
import io.legado.model.BookNoteWrite
import io.legado.model.BookSearchHit
import io.legado.model.ReadingLogEntry
import io.legado.model.ReadingLogRequest
import io.legado.model.ReadingProgress

/**
 * `Database` 的阅读进度、阅读记录与笔记划线面（0.8.2 结构重排从 `Database.kt` 逐字拆出）。
 * 写成同包扩展函数：调用点 `database.foo()` 与成员写法逐字一致；连接、`connect`/`write`（internal）、
 * 建表与迁移留在 `Database.kt`。跨包调用这些面需 `import io.legado.data.<方法>`（顶层扩展不是成员）。
 */
fun Database.saveProgress(progress: ReadingProgress): ReadingProgress = write { db ->
    val now = System.currentTimeMillis()
    db.prepareStatement("""insert into reading_progress(source_id,book_url,chapter_url,chapter_index,scroll_position,char_offset,paragraph_anchor,position_version,position_checksum,updated_at) values(?,?,?,?,?,?,?,?,?,?)
        on conflict(source_id,book_url) do update set chapter_url=excluded.chapter_url,chapter_index=excluded.chapter_index,scroll_position=excluded.scroll_position,char_offset=excluded.char_offset,paragraph_anchor=excluded.paragraph_anchor,position_version=excluded.position_version,position_checksum=excluded.position_checksum,updated_at=excluded.updated_at""").use {
        it.setString(1, progress.sourceId); it.setString(2, progress.bookUrl); it.setString(3, progress.chapterUrl); it.setInt(4, progress.chapterIndex); it.setDouble(5, progress.scrollPosition)
        it.setInt(6, progress.charOffset); it.setString(7, progress.paragraphAnchor); it.setInt(8, progress.positionVersion); it.setString(9, progress.positionChecksum); it.setLong(10, now)
        it.executeUpdate()
    }
    db.prepareStatement("update book_shelf set last_read_at=? where source_id=? and book_url=?").use {
        it.setLong(1, now); it.setString(2, progress.sourceId); it.setString(3, progress.bookUrl); it.executeUpdate()
    }
    progress.copy(updatedAt = now)
}

fun Database.getProgress(sourceId: String, bookUrl: String): ReadingProgress? = connect { db -> db.prepareStatement("select source_id,book_url,chapter_url,chapter_index,scroll_position,char_offset,paragraph_anchor,position_version,position_checksum,updated_at from reading_progress where source_id=? and book_url=?").use {
    it.setString(1, sourceId); it.setString(2, bookUrl); it.executeQuery().use { rs -> if (rs.next()) ReadingProgress(rs.getString(1), rs.getString(2), rs.getString(3), rs.getInt(4), rs.getDouble(5), rs.getInt(6), rs.getString(7), rs.getInt(8), rs.getString(9), rs.getLong(10)) else null }
} }

/**
 * 阅读记录（PROPOSAL-019 D）：把一段停留累加进「今天 · 这本书」那一行。
 * 只增不改 —— 没有编辑/删除单条的接口；同一天同一本书再来一段就是秒数相加，
 * 章节号取当天读到的最远那一章。
 */
fun Database.addReadingLog(request: ReadingLogRequest): ReadingLogEntry = write { db ->
    val day = java.time.LocalDate.now().toString()
    val now = System.currentTimeMillis()
    val seconds = request.seconds.coerceAtLeast(0)
    db.prepareStatement("""insert into reading_log(day,source_id,book_url,book_name,chapter_index,seconds,updated_at) values(?,?,?,?,?,?,?)
        on conflict(day,source_id,book_url) do update set
          seconds = reading_log.seconds + excluded.seconds,
          chapter_index = max(reading_log.chapter_index, excluded.chapter_index),
          book_name = case when excluded.book_name <> '' then excluded.book_name else reading_log.book_name end,
          updated_at = excluded.updated_at""").use {
        it.setString(1, day); it.setString(2, request.sourceId); it.setString(3, request.bookUrl)
        it.setString(4, request.bookName); it.setInt(5, request.chapterIndex); it.setInt(6, seconds); it.setLong(7, now)
        it.executeUpdate()
    }
    ReadingLogEntry(day, request.sourceId, request.bookUrl, request.bookName, request.chapterIndex, seconds.toLong(), now)
}

/** 最近 `days` 天的阅读记录（含今天）。按天倒序、天内按秒数倒序 —— 时间轴直接照这个顺序画。 */
fun Database.listReadingLog(days: Int): List<ReadingLogEntry> = connect { db ->
    val since = java.time.LocalDate.now().minusDays((days - 1).coerceAtLeast(0).toLong()).toString()
    db.prepareStatement("select day,source_id,book_url,book_name,chapter_index,seconds,updated_at from reading_log where day >= ? order by day desc, seconds desc").use {
        it.setString(1, since)
        it.executeQuery().use { rs ->
            val list = mutableListOf<ReadingLogEntry>()
            while (rs.next()) list += ReadingLogEntry(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4) ?: "", rs.getInt(5), rs.getLong(6), rs.getLong(7))
            list
        }
    }
}

// —— 笔记 / 划线（PROPOSAL-019 E）——
/** 新增一条划线 / 备注 / 书签。偏移是章节内字符偏移，`excerpt` 是选中原文。`bookmark=true` 表示只标位置不写想法。 */
fun Database.addNote(write: BookNoteWrite): BookNote = write { db ->
    val now = System.currentTimeMillis()
    val id = db.prepareStatement("""insert into book_note(source_id,book_url,book_name,chapter_url,chapter_index,start_offset,end_offset,excerpt,note,bookmark,paragraph_anchor,position_version,position_checksum,created_at,updated_at)
        values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", java.sql.Statement.RETURN_GENERATED_KEYS).use { st ->
        st.setString(1, write.sourceId); st.setString(2, write.bookUrl); st.setString(3, write.bookName)
        st.setString(4, write.chapterUrl); st.setInt(5, write.chapterIndex)
        st.setInt(6, write.startOffset); st.setInt(7, write.endOffset); st.setString(8, write.excerpt)
        st.setString(9, write.note); st.setInt(10, if (write.bookmark) 1 else 0)
        st.setString(11, write.paragraphAnchor); st.setInt(12, write.positionVersion); st.setString(13, write.positionChecksum)
        st.setLong(14, now); st.setLong(15, now)
        st.executeUpdate()
        st.generatedKeys.use { rs -> if (rs.next()) rs.getLong(1) else 0L }
    }
    BookNote(id, write.sourceId, write.bookUrl, write.bookName, write.chapterUrl, write.chapterIndex, write.startOffset, write.endOffset, write.excerpt, write.note, now, now, write.bookmark, write.paragraphAnchor, write.positionVersion, write.positionChecksum)
}

/** 这本书的全部笔记 / 书签，按章、按章内位置排 —— 阅读器按这个顺序渲染高亮与列表（书签靠 bookmark 字段区分）。 */
fun Database.listNotes(sourceId: String, bookUrl: String): List<BookNote> = connect { db ->
    db.prepareStatement("select id,source_id,book_url,book_name,chapter_url,chapter_index,start_offset,end_offset,excerpt,note,bookmark,paragraph_anchor,position_version,position_checksum,created_at,updated_at from book_note where source_id=? and book_url=? order by chapter_index asc, start_offset asc").use {
        it.setString(1, sourceId); it.setString(2, bookUrl)
        it.executeQuery().use { rs ->
            val list = mutableListOf<BookNote>()
            while (rs.next()) list += BookNote(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getString(4) ?: "", rs.getString(5) ?: "", rs.getInt(6), rs.getInt(7), rs.getInt(8), rs.getString(9), rs.getString(10) ?: "", rs.getLong(15), rs.getLong(16), rs.getInt(11) != 0, rs.getString(12), rs.getInt(13), rs.getString(14))
            list
        }
    }
}

fun Database.updateNote(id: Long, note: String): Boolean = write { db ->
    db.prepareStatement("update book_note set note=?, updated_at=? where id=?").use {
        it.setString(1, note); it.setLong(2, System.currentTimeMillis()); it.setLong(3, id); it.executeUpdate() > 0
    }
}

fun Database.deleteNote(id: Long): Boolean = write { db ->
    db.prepareStatement("delete from book_note where id=?").use { it.setLong(1, id); it.executeUpdate() > 0 }
}

/**
 * 本书正文检索（搜索本书 feature）：在已缓存的章节正文里按关键词子串找命中。
 * 只覆盖 `book_content_cache` 里这本书已离线缓存的章节——没缓存的自然搜不到，
 * 调用方（前端）应当提示「仅检索已缓存章节」。LIKE 用 ESCAPE 转义 % / _，
 * 避免关键词里出现这两个通配符时被吞掉。SQLite 的 LIKE 对中文是逐字子串匹配，够用。
 */
fun Database.searchBookContent(sourceId: String, bookUrl: String, query: String): List<BookSearchHit> = connect { db ->
    val escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    db.prepareStatement(
        """select chapter_url, chapter_index, title, content from book_content_cache
           where source_id=? and book_url=? and content like ? escape '\' order by chapter_index asc""",
    ).use { st ->
        st.setString(1, sourceId); st.setString(2, bookUrl); st.setString(3, "%$escaped%")
        st.executeQuery().use { rs ->
            val list = mutableListOf<BookSearchHit>()
            val ctx = 24
            while (rs.next()) {
                val content = rs.getString(4) ?: ""
                val idx = content.indexOf(query)
                val snippet = if (idx >= 0) {
                    val start = (idx - ctx).coerceAtLeast(0)
                    val end = (idx + query.length + ctx).coerceAtMost(content.length)
                    (if (start > 0) "…" else "") + content.substring(start, end) + (if (end < content.length) "…" else "")
                } else {
                    content.take(60)
                }
                list += BookSearchHit(rs.getString(1) ?: "", rs.getInt(2), rs.getString(3) ?: "", snippet)
            }
            list
        }
    }
}
