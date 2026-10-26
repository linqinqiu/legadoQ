package io.legado.data

import io.legado.localbook.LocalBookParser
import io.legado.localbook.ParsedBook
import io.legado.model.BookshelfItem
import io.legado.model.CachedBookRequest
import io.legado.model.Chapter
import io.legado.model.ChapterContent
import io.legado.model.ContentProcess
import io.legado.model.ContentProcessRequest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * `Database` 的目录缓存、本地书入库、正文缓存与缓存任务状态面（0.8.2 结构重排从 `Database.kt` 逐字拆出）。
 * 写成同包扩展函数：调用点 `database.foo()` 与成员写法逐字一致；连接、`connect`/`write`（internal）、
 * 建表与迁移留在 `Database.kt`。跨包调用这些面需 `import io.legado.data.<方法>`（顶层扩展不是成员）。
 */
fun Database.getTocCache(sourceId: String, tocUrl: String): List<Chapter>? = connect { db ->
    readTocCache(db, sourceId, tocUrl)
}

/**
 * 这本书的目录章节（调用方不必知道 toc_url 是哪个）。给「章节窗口」这类只读目录的用法；
 * 没有目录缓存返回 null —— 别拿空列表冒充"这本书没有章节"。
 */
fun Database.tocChapters(sourceId: String, bookUrl: String): List<Chapter>? = connect { db ->
    readTocChapters(db, sourceId, bookUrl)
}

/** 单条目录缓存的读取（不自己开连接：给已在事务里的调用方用，也避免嵌套连接）。 */
private fun readTocCache(db: java.sql.Connection, sourceId: String, tocUrl: String): List<Chapter>? =
    db.prepareStatement("select chapters_json from book_toc_cache where source_id = ? and toc_url = ?").use { stmt ->
        stmt.setString(1, sourceId)
        stmt.setString(2, tocUrl)
        stmt.executeQuery().use { rs ->
            if (rs.next()) {
                runCatching { Json.decodeFromString<List<Chapter>>(rs.getString(1)) }.getOrNull()
            } else null
        }
    }

/**
 * 这本书的目录章节（不自己开连接）。先按 `book_url` 当 toc_url 取，再退回书架记的 `toc_url` ——
 * 目录缓存两条都写（见 [cacheBook]），但老库/局部缓存可能只有其中一条。
 * 没有目录缓存时返回 null（调用方据此区分"位置未知"与"章号 0"）。
 */
internal fun readTocChapters(db: java.sql.Connection, sourceId: String, bookUrl: String): List<Chapter>? {
    readTocCache(db, sourceId, bookUrl)?.let { return it }
    val tocUrl = db.prepareStatement("select toc_url from book_shelf where source_id = ? and book_url = ?").use { stmt ->
        stmt.setString(1, sourceId)
        stmt.setString(2, bookUrl)
        stmt.executeQuery().use { rs -> if (rs.next()) rs.getString(1) else null }
    } ?: return null
    return readTocCache(db, sourceId, tocUrl)
}

/** 章号从目录里查（正文缓存表按 URL 存正文，章号的权威在目录）。查不到返回 0。 */
internal fun tocChapterIndex(db: java.sql.Connection, sourceId: String, bookUrl: String, chapterUrl: String): Int =
    readTocChapters(db, sourceId, bookUrl)?.firstOrNull { it.url == chapterUrl }?.index ?: 0

fun Database.saveTocCache(sourceId: String, tocUrl: String, chapters: List<Chapter>) = write { db ->
    db.prepareStatement("""
        insert into book_toc_cache(source_id, toc_url, chapters_json, updated_at)
        values(?, ?, ?, ?)
        on conflict(source_id, toc_url) do update set
            chapters_json = excluded.chapters_json, updated_at = excluded.updated_at
    """.trimIndent()).use { stmt ->
        stmt.setString(1, sourceId)
        stmt.setString(2, tocUrl)
        stmt.setString(3, Json.encodeToString(chapters))
        stmt.setLong(4, System.currentTimeMillis())
        stmt.executeUpdate()
    }
}

fun Database.importLocalBook(
    bookId: String,
    parsed: ParsedBook,
    coverKey: String?,
    groupId: Long = 0,
): BookshelfItem = write { db ->
    db.autoCommit = false
    try {
        val sourceId = LocalBookParser.LOC_BOOK_SOURCE_ID
        val bookUrl = "local://$bookId"
        val tocUrl = "local://$bookId/toc"
        val now = System.currentTimeMillis()

        // 1. Insert/update book_shelf
        db.prepareStatement("""
            insert into book_shelf(source_id, book_url, name, author, toc_url, cover_url, cover_key, last_read_at, completed, alternate_sources, group_id, toc_rule)
            values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(source_id, book_url) do update set
                name = excluded.name, author = excluded.author, toc_url = excluded.toc_url,
                cover_key = coalesce(excluded.cover_key, book_shelf.cover_key),
                last_read_at = excluded.last_read_at, group_id = excluded.group_id,
                toc_rule = coalesce(excluded.toc_rule, book_shelf.toc_rule)
        """.trimIndent()).use { stmt ->
            stmt.setString(1, sourceId)
            stmt.setString(2, bookUrl)
            stmt.setString(3, parsed.title)
            stmt.setString(4, parsed.author)
            stmt.setString(5, tocUrl)
            stmt.setString(6, null)
            stmt.setString(7, coverKey)
            stmt.setLong(8, now)
            stmt.setInt(9, 0)
            stmt.setString(10, "[]")
            stmt.setLong(11, groupId)
            // 存"这次实际生效的规则"，不是"用户当时选的那条"
            stmt.setString(12, parsed.tocRuleUsed)
            stmt.executeUpdate()
        }

        // 2. Insert cover into cover_cache if present
        if (coverKey != null && parsed.coverContentType != null) {
            db.prepareStatement("insert into cover_cache(cache_key, content_type) values(?, ?) on conflict(cache_key) do update set content_type=excluded.content_type").use {
                it.setString(1, coverKey)
                it.setString(2, parsed.coverContentType)
                it.executeUpdate()
            }
        }

        // 3. Insert TOC cache
        val chapters = parsed.chapters.mapIndexed { idx, ch ->
            Chapter(
                index = idx,
                title = ch.title,
                url = "local://$bookId/chapter_${idx + 1}"
            )
        }
        db.prepareStatement("""
            insert into book_toc_cache(source_id, toc_url, chapters_json, updated_at)
            values(?, ?, ?, ?)
            on conflict(source_id, toc_url) do update set
                chapters_json = excluded.chapters_json, updated_at = excluded.updated_at
        """.trimIndent()).use { stmt ->
            stmt.setString(1, sourceId)
            stmt.setString(2, tocUrl)
            stmt.setString(3, Json.encodeToString(chapters))
            stmt.setLong(4, now)
            stmt.executeUpdate()
        }
        db.prepareStatement("""
            insert into book_toc_cache(source_id, toc_url, chapters_json, updated_at)
            values(?, ?, ?, ?)
            on conflict(source_id, toc_url) do update set
                chapters_json = excluded.chapters_json, updated_at = excluded.updated_at
        """.trimIndent()).use { stmt ->
            stmt.setString(1, sourceId)
            stmt.setString(2, bookUrl)
            stmt.setString(3, Json.encodeToString(chapters))
            stmt.setLong(4, now)
            stmt.executeUpdate()
        }

        // 4. Batch insert chapters into book_content_cache
        db.prepareStatement("delete from book_content_cache where source_id = ? and book_url = ?").use {
            it.setString(1, sourceId)
            it.setString(2, bookUrl)
            it.executeUpdate()
        }
        db.prepareStatement("""
            insert into book_content_cache(source_id, book_url, chapter_url, chapter_index, title, content, cached_at)
            values(?, ?, ?, ?, ?, ?, ?)
        """.trimIndent()).use { stmt ->
            chapters.forEachIndexed { idx, ch ->
                val contentText = parsed.chapters.getOrNull(idx)?.content ?: ""
                stmt.setString(1, sourceId)
                stmt.setString(2, bookUrl)
                stmt.setString(3, ch.url)
                stmt.setInt(4, ch.index)
                stmt.setString(5, ch.title)
                stmt.setString(6, contentText)
                stmt.setLong(7, now)
                stmt.addBatch()
            }
            stmt.executeBatch()
        }

        // 5. Update book_cache_status to ready
        db.prepareStatement("""
            insert into book_cache_status(source_id, book_url, total_chapters, cached_chapters, state, last_error, updated_at)
            values(?, ?, ?, ?, 'ready', null, ?)
            on conflict(source_id, book_url) do update set
                total_chapters = excluded.total_chapters, cached_chapters = excluded.cached_chapters,
                state = 'ready', last_error = null, updated_at = excluded.updated_at
        """.trimIndent()).use { stmt ->
            stmt.setString(1, sourceId)
            stmt.setString(2, bookUrl)
            stmt.setInt(3, chapters.size)
            stmt.setInt(4, chapters.size)
            stmt.setLong(5, now)
            stmt.executeUpdate()
        }

        db.commit()
        getBookshelf(db, sourceId, bookUrl)!!
    } catch (e: Throwable) {
        db.rollback()
        throw e
    } finally {
        db.autoCommit = true
    }
}

fun Database.getCachedChaptersFallback(sourceId: String, bookUrl: String): List<Chapter> = connect { db ->
    db.prepareStatement("""
        select chapter_url, title from book_content_cache
        where source_id = ? and (book_url = ? or chapter_url like ?)
        order by rowid asc
    """.trimIndent()).use { stmt ->
        stmt.setString(1, sourceId)
        stmt.setString(2, bookUrl)
        stmt.setString(3, "%$bookUrl%")
        stmt.executeQuery().use { rs ->
            buildList {
                var index = 0
                while (rs.next()) {
                    val url = rs.getString(1)
                    val title = rs.getString(2)?.ifBlank { null } ?: "第 ${index + 1} 章"
                    add(Chapter(index++, title, url))
                }
            }
        }
    }
}

fun Database.cachedContent(sourceId: String, bookUrl: String, chapterUrl: String): ChapterContent? = connect { db -> db.prepareStatement("select title,content from book_content_cache where source_id=? and book_url=? and chapter_url=?").use {
    it.setString(1, sourceId); it.setString(2, bookUrl); it.setString(3, chapterUrl); it.executeQuery().use { rs -> if (rs.next()) ChapterContent(rs.getString(1), rs.getString(2)) else null }
} }

/**
 * AI 闭环（阅读器 AI 闭环 feature）：读某一章某一种类的 AI 覆盖正文（净化/润色）。
 * 没有就回 null，调用方照常回原始缓存正文。
 */
fun Database.getContentProcess(sourceId: String, bookUrl: String, chapterUrl: String, kind: String): ContentProcess? = connect { db -> db.prepareStatement(
    "select source_id, book_url, chapter_url, kind, original, processed, updated_at from book_content_process where source_id=? and book_url=? and chapter_url=? and kind=?",
).use { st ->
    st.setString(1, sourceId); st.setString(2, bookUrl); st.setString(3, chapterUrl); st.setString(4, kind)
    st.executeQuery().use { rs -> if (rs.next()) ContentProcess(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4), rs.getString(5), rs.getString(6), rs.getLong(7)) else null }
} }

/** 落一份 AI 覆盖正文（同一 source/book/chapter/kind 覆盖写）。 */
fun Database.saveContentProcess(req: ContentProcessRequest): ContentProcess = write { db ->
    val now = System.currentTimeMillis()
    db.prepareStatement(
        """insert into book_content_process(source_id, book_url, chapter_url, kind, original, processed, updated_at)
           values(?, ?, ?, ?, ?, ?, ?)
           on conflict(source_id, book_url, chapter_url, kind) do update set
             original = excluded.original, processed = excluded.processed, updated_at = excluded.updated_at""",
    ).use { st ->
        st.setString(1, req.sourceId); st.setString(2, req.bookUrl); st.setString(3, req.chapterUrl); st.setString(4, req.kind)
        st.setString(5, req.original); st.setString(6, req.processed); st.setLong(7, now)
        st.executeUpdate()
    }
    ContentProcess(req.sourceId, req.bookUrl, req.chapterUrl, req.kind, req.original, req.processed, now)
}

/** 撤掉某一章某一种类的 AI 覆盖（恢复原始正文）。 */
fun Database.deleteContentProcess(sourceId: String, bookUrl: String, chapterUrl: String, kind: String): Boolean = write { db ->
    db.prepareStatement("delete from book_content_process where source_id=? and book_url=? and chapter_url=? and kind=?").use {
        it.setString(1, sourceId); it.setString(2, bookUrl); it.setString(3, chapterUrl); it.setString(4, kind)
        it.executeUpdate() > 0
    }
}

fun Database.cachedChapterUrls(sourceId: String, bookUrl: String): Set<String> = connect { db ->
    db.prepareStatement("select chapter_url from book_content_cache where source_id = ? and book_url = ?").use { statement ->
        statement.setString(1, sourceId)
        statement.setString(2, bookUrl)
        statement.executeQuery().use { rs ->
            buildSet {
                while (rs.next()) add(rs.getString(1))
            }
        }
    }
}

/**
 * 已缓存章节的「地址 → 字数」。字数用 `length(content)` 现算：
 * SQLite 对 TEXT 的 `length()` 返回**字符数**而非字节数，中文一章 2000 字就报 2000，
 * 与阅读器里看到的排版字数一致，不必另存一列去维护双写一致性。
 *
 * 只包含正文**已落库**的章节 —— 这正是用户要的「当获取到内容的时候」才显示字数：
 * 没取到内容就没有字数可说，界面上那一格留空（而不是显示 0 骗人）。
 */
fun Database.cachedChapterWordCounts(sourceId: String, bookUrl: String): List<Pair<String, Int>> = connect { db ->
    db.prepareStatement("select chapter_url, length(content) from book_content_cache where source_id = ? and book_url = ? order by rowid asc").use { statement ->
        statement.setString(1, sourceId)
        statement.setString(2, bookUrl)
        statement.executeQuery().use { rs ->
            buildList {
                while (rs.next()) add(rs.getString(1) to rs.getInt(2))
            }
        }
    }
}

fun Database.clearBookCacheContent(sourceId: String, bookUrl: String): Int = write { db ->
    val deleted = db.prepareStatement("delete from book_content_cache where source_id = ? and book_url = ?").use { statement ->
        statement.setString(1, sourceId)
        statement.setString(2, bookUrl)
        statement.executeUpdate()
    }
    db.prepareStatement("update book_cache_status set cached_chapters = 0, state = 'idle', last_error = null, updated_at = ? where source_id = ? and book_url = ?").use { statement ->
        statement.setLong(1, System.currentTimeMillis())
        statement.setString(2, sourceId)
        statement.setString(3, bookUrl)
        statement.executeUpdate()
    }
    deleted
}

fun Database.updateBookCacheProgress(sourceId: String, bookUrl: String, cachedCount: Int) = write { db ->
    db.prepareStatement("update book_cache_status set cached_chapters = ?, updated_at = ? where source_id = ? and book_url = ?").use { statement ->
        statement.setInt(1, cachedCount)
        statement.setLong(2, System.currentTimeMillis())
        statement.setString(3, sourceId)
        statement.setString(4, bookUrl)
        statement.executeUpdate()
    }
}

fun Database.cacheBookContent(sourceId: String, bookUrl: String, chapterUrl: String, content: ChapterContent, chapterIndex: Int? = null): Unit = write { db ->
    // 章号缺省从目录里查：单章读正文这条路径手里只有 URL，目录是唯一的权威。
    val index = chapterIndex ?: tocChapterIndex(db, sourceId, bookUrl, chapterUrl)
    db.prepareStatement("""
        insert into book_content_cache(source_id, book_url, chapter_url, chapter_index, title, content, cached_at)
        values(?, ?, ?, ?, ?, ?, ?)
        on conflict(source_id, book_url, chapter_url) do update set
            chapter_index = excluded.chapter_index,
            title = excluded.title, content = excluded.content, cached_at = excluded.cached_at
    """.trimIndent()).use { statement ->
        statement.setString(1, sourceId)
        statement.setString(2, bookUrl)
        statement.setString(3, chapterUrl)
        statement.setInt(4, index)
        statement.setString(5, content.title)
        statement.setString(6, content.content)
        statement.setLong(7, System.currentTimeMillis())
        statement.executeUpdate()
    }
}

fun Database.beginBookCache(sourceId: String, bookUrl: String, total: Int) = write { db -> db.prepareStatement("insert into book_cache_status(source_id,book_url,total_chapters,cached_chapters,state,last_error,updated_at) values(?,?,?,?,?,?,?) on conflict(source_id,book_url) do update set total_chapters=excluded.total_chapters,cached_chapters=excluded.cached_chapters,state=excluded.state,last_error=null,updated_at=excluded.updated_at").use {
    val count = db.prepareStatement("select count(*) from book_content_cache where source_id=? and book_url=?").use { query -> query.setString(1, sourceId); query.setString(2, bookUrl); query.executeQuery().use { rs -> rs.next(); rs.getInt(1) } }
    it.setString(1, sourceId); it.setString(2, bookUrl); it.setInt(3, total); it.setInt(4, count); it.setString(5, "caching"); it.setString(6, null); it.setLong(7, System.currentTimeMillis()); it.executeUpdate()
} }

fun Database.finishBookCache(sourceId: String, bookUrl: String, error: String? = null) = write { db ->
    val state = if (error == null) "ready" else "failed"
    val cachedCount = db.prepareStatement("select count(*) from book_content_cache where source_id=? and book_url=?").use { it.setString(1, sourceId); it.setString(2, bookUrl); it.executeQuery().use { rs -> rs.next(); rs.getInt(1) } }
    val existingTotal = db.prepareStatement("select total_chapters from book_cache_status where source_id=? and book_url=?").use { it.setString(1, sourceId); it.setString(2, bookUrl); it.executeQuery().use { rs -> if (rs.next()) rs.getInt(1) else 0 } }
    val total = if (existingTotal > 0) existingTotal else cachedCount
    db.prepareStatement("insert into book_cache_status(source_id,book_url,total_chapters,cached_chapters,state,last_error,updated_at) values(?,?,?,?,?,?,?) on conflict(source_id,book_url) do update set total_chapters=excluded.total_chapters,cached_chapters=excluded.cached_chapters,state=excluded.state,last_error=excluded.last_error,updated_at=excluded.updated_at").use {
        it.setString(1, sourceId); it.setString(2, bookUrl); it.setInt(3, total); it.setInt(4, cachedCount); it.setString(5, state); it.setString(6, error?.take(500)); it.setLong(7, System.currentTimeMillis()); it.executeUpdate()
    }
}

fun Database.cacheRequests(): List<CachedBookRequest> = connect { db -> db.prepareStatement("select source_id,book_url,toc_url from book_shelf").use { query -> query.executeQuery().use { rs -> buildList { while (rs.next()) add(CachedBookRequest(rs.getString(1), rs.getString(2), rs.getString(3))) } } } }
