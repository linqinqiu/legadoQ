package io.legado.data

import io.legado.cache.CachedCover
import io.legado.model.BookGroup
import io.legado.model.BookIdentifier
import io.legado.model.BookshelfInfoUpdateRequest
import io.legado.model.BookshelfItem
import io.legado.model.BookshelfWriteRequest
import io.legado.model.SearchResult
import java.sql.Connection
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * `Database` 的书架读写、分组归属、排序、换源、批量与封面元数据面（0.8.2 结构重排从 `Database.kt` 逐字拆出）。
 * 写成同包扩展函数：调用点 `database.foo()` 与成员写法逐字一致；连接、`connect`/`write`（internal）、
 * 建表与迁移留在 `Database.kt`。跨包调用这些面需 `import io.legado.data.<方法>`（顶层扩展不是成员）。
 */
/** 书架列表与单本查询共用同一份 SELECT：两处各写一遍迟早会漂移成不同字段。 */
internal const val SHELF_SELECT = "select s.source_id,s.book_url,s.name,s.author,s.toc_url,s.cover_key,p.chapter_index,p.scroll_position,s.last_read_at,coalesce(c.cached_chapters,0),coalesce(c.total_chapters,0),coalesce(c.state,'idle'),c.last_error,s.completed,s.alternate_sources,s.group_id,(select max(t.updated_at) from book_toc_cache t where t.source_id=s.source_id and (t.toc_url=s.toc_url or t.toc_url=s.book_url)),s.toc_rule,s.sort_order,coalesce(json_extract(src.payload,'\$.bookSourceType'),0) from book_shelf s left join reading_progress p on p.source_id=s.source_id and p.book_url=s.book_url left join book_cache_status c on c.source_id=s.source_id and c.book_url=s.book_url left join source src on src.id=s.source_id"

fun Database.saveBookshelf(request: BookshelfWriteRequest, cover: CachedCover?): BookshelfItem = write { db ->
    val now = System.currentTimeMillis()
    db.autoCommit = false
    try {
        cover?.let { value -> db.prepareStatement("insert into cover_cache(cache_key,content_type) values(?,?) on conflict(cache_key) do update set content_type=excluded.content_type").use { it.setString(1, value.key); it.setString(2, value.contentType); it.executeUpdate() } }
        val altJson = request.alternateSources?.let { Json.encodeToString(it) }
        db.prepareStatement("""insert into book_shelf(source_id,book_url,name,author,toc_url,cover_url,cover_key,last_read_at,alternate_sources) values(?,?,?,?,?,?,?,?,?)
            on conflict(source_id,book_url) do update set name=excluded.name,author=excluded.author,toc_url=excluded.toc_url,cover_url=excluded.cover_url,cover_key=coalesce(excluded.cover_key,book_shelf.cover_key),last_read_at=excluded.last_read_at,alternate_sources=coalesce(excluded.alternate_sources,book_shelf.alternate_sources)""").use {
            it.setString(1, request.sourceId); it.setString(2, request.bookUrl); it.setString(3, request.name); it.setString(4, request.author); it.setString(5, request.tocUrl); it.setString(6, request.coverUrl); it.setString(7, cover?.key); it.setLong(8, now); it.setString(9, altJson); it.executeUpdate()
        }
        db.commit(); getBookshelf(db, request.sourceId, request.bookUrl)!!
    } catch (error: Throwable) { db.rollback(); throw error } finally { db.autoCommit = true }
}

fun Database.updateBookshelfCover(sourceId: String, bookUrl: String, coverKey: String, contentType: String = "image/*"): Boolean = write { db ->
    val exists = db.prepareStatement("select 1 from book_shelf where source_id=? and book_url=?").use { stmt ->
        stmt.setString(1, sourceId)
        stmt.setString(2, bookUrl)
        stmt.executeQuery().use { rs -> rs.next() }
    }
    if (!exists) return@write false

    db.prepareStatement("insert into cover_cache(cache_key,content_type) values(?,?) on conflict(cache_key) do update set content_type=excluded.content_type").use {
        it.setString(1, coverKey)
        it.setString(2, contentType)
        it.executeUpdate()
    }
    db.prepareStatement("update book_shelf set cover_key=? where source_id=? and book_url=?").use {
        it.setString(1, coverKey)
        it.setString(2, sourceId)
        it.setString(3, bookUrl)
        it.executeUpdate() > 0
    }
}

fun Database.listBookshelf(): List<BookshelfItem> = connect { db -> db.prepareStatement(SHELF_SELECT + " order by s.last_read_at desc").use { query -> query.executeQuery().use { rs -> buildList { while (rs.next()) add(rs.toShelf()) } } } }

/**
 * 单本书的书架记录。规则求值每翻一章都要读一次上下文，
 * 不能拿 listBookshelf() 的全表 JOIN 顶替 —— 离线缓存一本 5,000 章的书就是 5,000 次全表扫。
 */
fun Database.shelfBook(sourceId: String, bookUrl: String): BookshelfItem? = connect { db ->
    db.prepareStatement(SHELF_SELECT + " where s.source_id=? and s.book_url=? limit 1").use {
        it.setString(1, sourceId); it.setString(2, bookUrl)
        it.executeQuery().use { rs -> if (rs.next()) rs.toShelf() else null }
    }
}

/**
 * 换规则重切目录后，把阅读进度夹回新的章节数范围内。
 * 读到第 900 章的书被切成 12 章时，进度不能留在 900 —— 那既进不去也不该被悄悄清零。
 */
fun Database.clampShelfProgress(sourceId: String, bookUrl: String, chapterCount: Int): Int = write { db ->
    db.prepareStatement("update reading_progress set chapter_index = ? where source_id = ? and book_url = ? and chapter_index > ?").use {
        it.setInt(1, (chapterCount - 1).coerceAtLeast(0))
        it.setString(2, sourceId)
        it.setString(3, bookUrl)
        it.setInt(4, (chapterCount - 1).coerceAtLeast(0))
        it.executeUpdate()
    }
}

fun Database.setBookshelfCompleted(sourceId: String, bookUrl: String, completed: Boolean): BookshelfItem? = write { db ->        db.prepareStatement("update book_shelf set completed=? where source_id=? and book_url=?").use {
        it.setInt(1, if (completed) 1 else 0); it.setString(2, sourceId); it.setString(3, bookUrl); it.executeUpdate()
    }
    getBookshelf(db, sourceId, bookUrl)
}

/** 分组列表带每组本数。「未分组」不是一条组记录，是 `group_id = 0` 那一档，界面自己给。 */
fun Database.listBookGroups(): List<BookGroup> = connect { db ->
    db.prepareStatement("""select g.group_id, g.name,
        (select count(*) from book_shelf s where s.group_id = g.group_id) as book_count
        from book_group g order by g.sort_order, g.name collate nocase""").use { query ->
        query.executeQuery().use { rs -> buildList { while (rs.next()) add(BookGroup(rs.getLong(1), rs.getString(2), rs.getInt(3))) } }
    }
}

fun Database.createBookGroup(name: String): BookGroup {
    val trimmed = name.trim()
    require(trimmed.isNotEmpty()) { "分组名不能为空" }
    require(trimmed.length <= 24) { "分组名最长 24 字" }
    return write { db ->
        db.prepareStatement("select group_id from book_group where name = ? collate nocase").use { find ->
            find.setString(1, trimmed)
            find.executeQuery().use { rs ->
                if (rs.next()) return@write BookGroup(rs.getLong(1), trimmed, countBooksInGroup(db, rs.getLong(1)))
            }
        }
        val id = db.prepareStatement("select coalesce(max(group_id), 0) + 1 from book_group").use { q ->
            q.executeQuery().use { rs -> rs.next(); rs.getLong(1) }
        }
        db.prepareStatement("insert into book_group(group_id, name, sort_order, created_at) values(?,?,?,?)").use {
            it.setLong(1, id); it.setString(2, trimmed); it.setInt(3, id.toInt()); it.setLong(4, System.currentTimeMillis())
            it.executeUpdate()
        }
        BookGroup(id, trimmed, 0)
    }
}

/** 删组不删书：组里的书回到「未分组」。 */
fun Database.deleteBookGroup(groupId: Long): Boolean = write { db ->
    if (groupId == 0L) return@write false
    val removed = db.prepareStatement("delete from book_group where group_id=?").use { it.setLong(1, groupId); it.executeUpdate() } == 1
    if (removed) db.prepareStatement("update book_shelf set group_id=0 where group_id=?").use { it.setLong(1, groupId); it.executeUpdate() }
    removed
}

fun Database.assignBookGroup(sourceId: String, bookUrl: String, groupId: Long): BookshelfItem? = write { db ->
    if (groupId != 0L && !bookGroupExists(db, groupId)) return@write null
    db.prepareStatement("update book_shelf set group_id=? where source_id=? and book_url=?").use {
        it.setLong(1, groupId); it.setString(2, sourceId); it.setString(3, bookUrl); it.executeUpdate()
    }
    getBookshelf(db, sourceId, bookUrl)
}

/**
 * 自定义排序：按给定的顺序写 `sort_order`（1 起）。只写点到的那些 ——
 * 没被拖过的书保持 null，界面上它们落在有序段之后、按最后阅读排。
 * 不在书架上的键跳过（前端拿的是上一次渲染的清单，中间可能已经移架）。
 */
fun Database.reorderBookshelf(keys: List<BookIdentifier>): Int = write { db ->
    db.autoCommit = false
    try {
        var written = 0
        db.prepareStatement("update book_shelf set sort_order=? where source_id=? and book_url=?").use { statement ->
            keys.forEachIndexed { index, key ->
                statement.setInt(1, index + 1)
                statement.setString(2, key.sourceId)
                statement.setString(3, key.bookUrl)
                written += statement.executeUpdate()
            }
        }
        db.commit()
        written
    } catch (error: Exception) {
        runCatching { db.rollback() }
        throw error
    } finally {
        db.autoCommit = true
    }
}

/**
 * 清掉全架的自定义顺序。切回「按最后阅读」不需要它 —— 那一档本来就无视 sort_order；
 * 这个动作是给"我把架子排乱了，想回到没拖过的状态"用的。
 */
fun Database.clearBookshelfOrder(): Int = write { db ->
    db.prepareStatement("update book_shelf set sort_order=null where sort_order is not null").use { it.executeUpdate() }
}

private fun Database.bookGroupExists(db: Connection, groupId: Long): Boolean =
    db.prepareStatement("select 1 from book_group where group_id=?").use { it.setLong(1, groupId); it.executeQuery().next() }

private fun Database.countBooksInGroup(db: Connection, groupId: Long): Int =
    db.prepareStatement("select count(*) from book_shelf where group_id=?").use { it.setLong(1, groupId); it.executeQuery().use { rs -> rs.next(); rs.getInt(1) } }

fun Database.updateBookshelfInfo(request: BookshelfInfoUpdateRequest, cover: CachedCover?): BookshelfItem? = write { db ->
    db.autoCommit = false
    try {
        var found = false
        var oldCover: String? = null
        db.prepareStatement("select cover_key from book_shelf where source_id=? and book_url=?").use {
            it.setString(1, request.sourceId); it.setString(2, request.bookUrl)
            it.executeQuery().use { rs ->
                if (rs.next()) {
                    found = true
                    oldCover = rs.getString(1)
                }
            }
        }
        if (!found) return@write null

        cover?.let { value ->
            db.prepareStatement("insert into cover_cache(cache_key,content_type) values(?,?) on conflict(cache_key) do update set content_type=excluded.content_type").use {
                it.setString(1, value.key); it.setString(2, value.contentType); it.executeUpdate()
            }
        }

        val newCoverKey = cover?.key ?: (if (request.coverUrl != null && request.coverUrl.isBlank()) null else oldCover)

        db.prepareStatement("update book_shelf set name=?, author=?, cover_url=?, cover_key=? where source_id=? and book_url=?").use {
            it.setString(1, request.name)
            it.setString(2, request.author)
            it.setString(3, request.coverUrl)
            it.setString(4, newCoverKey)
            it.setString(5, request.sourceId)
            it.setString(6, request.bookUrl)
            it.executeUpdate()
        }

        val orphan = oldCover.takeIf { value ->
            value != newCoverKey && db.prepareStatement("select 1 from book_shelf where cover_key=?").use {
                it.setString(1, value); !it.executeQuery().next()
            }
        }
        orphan?.let { value -> db.prepareStatement("delete from cover_cache where cache_key=?").use { it.setString(1, value); it.executeUpdate() } }
        db.commit()
        getBookshelf(db, request.sourceId, request.bookUrl)
    } catch (error: Throwable) {
        db.rollback(); throw error
    } finally {
        db.autoCommit = true
    }
}

fun Database.removeBookshelf(sourceId: String, bookUrl: String): String? = write { db ->
    db.autoCommit = false
    try {
        val key = db.prepareStatement("select cover_key from book_shelf where source_id=? and book_url=?").use { it.setString(1, sourceId); it.setString(2, bookUrl); it.executeQuery().use { rs -> if (rs.next()) rs.getString(1) else null } }
        db.prepareStatement("delete from book_shelf where source_id=? and book_url=?").use { it.setString(1, sourceId); it.setString(2, bookUrl); it.executeUpdate() }
        db.prepareStatement("delete from reading_progress where source_id=? and book_url=?").use { it.setString(1, sourceId); it.setString(2, bookUrl); it.executeUpdate() }
        db.prepareStatement("delete from book_note where source_id=? and book_url=?").use { it.setString(1, sourceId); it.setString(2, bookUrl); it.executeUpdate() }
        db.prepareStatement("delete from book_content_cache where source_id=? and book_url=?").use { it.setString(1, sourceId); it.setString(2, bookUrl); it.executeUpdate() }
        db.prepareStatement("delete from book_cache_status where source_id=? and book_url=?").use { it.setString(1, sourceId); it.setString(2, bookUrl); it.executeUpdate() }
        // 用 instr 而不是 like '%x%'：bookUrl 里的 `%`/`_` 会被 LIKE 当通配符，删一本书会连带删掉别的书的目录缓存。
        db.prepareStatement("delete from book_toc_cache where source_id=? and (toc_url=? or instr(toc_url, ?) > 0)").use { it.setString(1, sourceId); it.setString(2, bookUrl); it.setString(3, bookUrl); it.executeUpdate() }
        val orphan = key?.takeIf { value -> db.prepareStatement("select 1 from book_shelf where cover_key=?").use { it.setString(1, value); !it.executeQuery().next() } }
        orphan?.let { value -> db.prepareStatement("delete from cover_cache where cache_key=?").use { it.setString(1, value); it.executeUpdate() } }
        db.commit(); orphan
    } catch (error: Throwable) { db.rollback(); throw error } finally { db.autoCommit = true }
}

/** 批量删除多本书籍（事务内执行，失败回滚） */
fun Database.batchRemoveBookshelf(books: List<BookIdentifier>): Int = write { db ->
    db.autoCommit = false
    var deletedCount = 0
    try {
        for (book in books) {
            if (book.sourceId.isBlank() || book.bookUrl.isBlank()) continue
            db.prepareStatement("delete from book_shelf where source_id=? and book_url=?").use { 
                it.setString(1, book.sourceId); it.setString(2, book.bookUrl); it.executeUpdate() 
            }
            db.prepareStatement("delete from reading_progress where source_id=? and book_url=?").use { 
                it.setString(1, book.sourceId); it.setString(2, book.bookUrl); it.executeUpdate() 
            }
            db.prepareStatement("delete from book_note where source_id=? and book_url=?").use { 
                it.setString(1, book.sourceId); it.setString(2, book.bookUrl); it.executeUpdate() 
            }
            db.prepareStatement("delete from book_content_cache where source_id=? and book_url=?").use { 
                it.setString(1, book.sourceId); it.setString(2, book.bookUrl); it.executeUpdate() 
            }
            db.prepareStatement("delete from book_cache_status where source_id=? and book_url=?").use { 
                it.setString(1, book.sourceId); it.setString(2, book.bookUrl); it.executeUpdate() 
            }
            db.prepareStatement("delete from book_toc_cache where source_id=? and (toc_url=? or instr(toc_url, ?) > 0)").use { 
                it.setString(1, book.sourceId); it.setString(2, book.bookUrl); it.setString(3, book.bookUrl); it.executeUpdate() 
            }
            deletedCount++
        }
        db.commit()
    } catch (error: Throwable) { 
        db.rollback()
        throw error 
    } finally { 
        db.autoCommit = true 
    }
    deletedCount
}

/** 批量更新书籍分组 */
fun Database.batchUpdateBookshelfGroup(books: List<BookIdentifier>, groupId: Long?): Int = write { db ->
    db.autoCommit = false
    var updatedCount = 0
    try {
        for (book in books) {
            if (book.sourceId.isBlank() || book.bookUrl.isBlank()) continue
            db.prepareStatement("update book_shelf set group_id=? where source_id=? and book_url=?").use { 
                if (groupId == null) it.setNull(1, java.sql.Types.BIGINT) else it.setLong(1, groupId)
                it.setString(2, book.sourceId); it.setString(3, book.bookUrl)
                it.executeUpdate() 
            }
            updatedCount++
        }
        db.commit()
    } catch (error: Throwable) { 
        db.rollback()
        throw error 
    } finally { 
        db.autoCommit = true 
    }
    updatedCount
}

fun Database.switchBookshelf(oldSourceId: String, oldBookUrl: String, request: BookshelfWriteRequest, cover: CachedCover?, alternateSources: List<SearchResult>? = null): Pair<BookshelfItem, String?> = write { db ->
    val now = System.currentTimeMillis()
    db.autoCommit = false
    try {
        val oldCover = db.prepareStatement("select cover_key from book_shelf where source_id=? and book_url=?").use { it.setString(1, oldSourceId); it.setString(2, oldBookUrl); it.executeQuery().use { rs -> if (rs.next()) rs.getString(1) else null } }
        val existingAlts = db.prepareStatement("select alternate_sources from book_shelf where source_id=? and book_url=?").use {
            it.setString(1, oldSourceId); it.setString(2, oldBookUrl)
            it.executeQuery().use { rs ->
                if (rs.next()) rs.getString(1)?.let { raw -> runCatching { Json.decodeFromString<List<SearchResult>>(raw) }.getOrNull() } else null
            }
        } ?: emptyList()
        val oldSourceResult = SearchResult(sourceId = oldSourceId, name = request.name, author = request.author, bookUrl = oldBookUrl)
        val incomingAlts = alternateSources ?: request.alternateSources ?: emptyList()
        val combinedAlts = (listOf(oldSourceResult) + existingAlts + incomingAlts)
            .filter { it.sourceId != request.sourceId || it.bookUrl != request.bookUrl }
            .distinctBy { "${it.sourceId}\u0000${it.bookUrl}" }
        val altJson = Json.encodeToString(combinedAlts)

        db.prepareStatement("delete from book_shelf where source_id=? and book_url=?").use { it.setString(1, oldSourceId); it.setString(2, oldBookUrl); it.executeUpdate() }
        db.prepareStatement("delete from reading_progress where source_id=? and book_url=?").use { it.setString(1, oldSourceId); it.setString(2, oldBookUrl); it.executeUpdate() }
        db.prepareStatement("delete from book_note where source_id=? and book_url=?").use { it.setString(1, oldSourceId); it.setString(2, oldBookUrl); it.executeUpdate() }
        db.prepareStatement("delete from book_content_cache where source_id=? and book_url=?").use { it.setString(1, oldSourceId); it.setString(2, oldBookUrl); it.executeUpdate() }
        db.prepareStatement("delete from book_cache_status where source_id=? and book_url=?").use { it.setString(1, oldSourceId); it.setString(2, oldBookUrl); it.executeUpdate() }
        db.prepareStatement("delete from book_toc_cache where source_id=? and (toc_url=? or instr(toc_url, ?) > 0)").use { it.setString(1, oldSourceId); it.setString(2, oldBookUrl); it.setString(3, oldBookUrl); it.executeUpdate() }
        cover?.let { value -> db.prepareStatement("insert into cover_cache(cache_key,content_type) values(?,?) on conflict(cache_key) do update set content_type=excluded.content_type").use { it.setString(1, value.key); it.setString(2, value.contentType); it.executeUpdate() } }
        val newCoverKey = cover?.key ?: oldCover
        db.prepareStatement("""insert into book_shelf(source_id,book_url,name,author,toc_url,cover_url,cover_key,last_read_at,alternate_sources) values(?,?,?,?,?,?,?,?,?)
            on conflict(source_id,book_url) do update set name=excluded.name,author=excluded.author,toc_url=excluded.toc_url,cover_url=coalesce(excluded.cover_url,book_shelf.cover_url),cover_key=coalesce(excluded.cover_key,book_shelf.cover_key),last_read_at=excluded.last_read_at,alternate_sources=excluded.alternate_sources""").use {
            it.setString(1, request.sourceId); it.setString(2, request.bookUrl); it.setString(3, request.name); it.setString(4, request.author); it.setString(5, request.tocUrl); it.setString(6, request.coverUrl); it.setString(7, newCoverKey); it.setLong(8, now); it.setString(9, altJson); it.executeUpdate()
        }
        val orphan = oldCover?.takeIf { value -> value != newCoverKey && db.prepareStatement("select 1 from book_shelf where cover_key=?").use { it.setString(1, value); !it.executeQuery().next() } }
        orphan?.let { value -> db.prepareStatement("delete from cover_cache where cache_key=?").use { it.setString(1, value); it.executeUpdate() } }
        db.commit(); getBookshelf(db, request.sourceId, request.bookUrl)!! to orphan
    } catch (error: Throwable) { db.rollback(); throw error } finally { db.autoCommit = true }
}

fun Database.coverContentType(key: String): String? = connect { db -> db.prepareStatement("select content_type from cover_cache where cache_key=?").use { it.setString(1, key); it.executeQuery().use { rs -> if (rs.next()) rs.getString(1) else null } } }

/**
 * 我们以前替没有封面的本地书生成的假封面（按书名哈希抽五种饱和渐变，一书架下去就是彩虹）。
 * 只认「书架引用着 + 登记为 SVG」这一批：EPUB 自带的真封面是 jpeg/png，不会进来。
 * 是不是我们画的那张由调用方按文件内容判定，这里只负责把候选捞出来。
 */
fun Database.generatedLocalCoverKeys(): List<String> = connect { db ->
    db.prepareStatement("""select cover_key from book_shelf
        where cover_key is not null
          and cover_key in (select cache_key from cover_cache where content_type = 'image/svg+xml')""").use { query ->
        query.executeQuery().use { rs -> buildList { while (rs.next()) add(rs.getString(1)) } }
    }
}

/** 摘掉一张封面：书架引用与缓存登记一起清，界面才会回落到主题化的文字占位。 */
fun Database.forgetCover(key: String) = write { db ->
    db.prepareStatement("update book_shelf set cover_key = null where cover_key = ?").use { it.setString(1, key); it.executeUpdate() }
    db.prepareStatement("delete from cover_cache where cache_key = ?").use { it.setString(1, key); it.executeUpdate() }
}

private fun java.sql.ResultSet.toShelf(): BookshelfItem {
    val altJson = getString(15)
    val altSources = if (!altJson.isNullOrBlank()) {
        runCatching { Json.decodeFromString<List<SearchResult>>(altJson) }.getOrDefault(emptyList())
    } else emptyList()
    return BookshelfItem(
        sourceId = getString(1),
        bookUrl = getString(2),
        name = getString(3),
        author = getString(4),
        tocUrl = getString(5),
        coverKey = getString(6),
        chapterIndex = getObject(7) as? Int,
        scrollPosition = getObject(8) as? Double,
        lastReadAt = getLong(9),
        // 第 17 列：book_toc_cache 的 MAX(updated_at)；无目录缓存行时 SQL 为 NULL，getLong 归 0（DTO 的“无数据”哨兵）。
        tocUpdatedAt = getLong(17),
        cachedChapters = getInt(10),
        totalChapters = getInt(11),
        cacheState = getString(12),
        cacheError = getString(13),
        completed = getInt(14) != 0,
        alternateSources = altSources,
        groupId = getLong(16),
        // 第 18 列：这本本地书实际是用哪条目录规则切的（`builtin` 或规则 id；在线书为 null）
        tocRule = getString(18),
        // 第 19 列：自定义排序位，null = 没参与过自定义排序
        sortOrder = getObject(19) as? Int,
        // 第 20 列：书源 `bookSourceType`（json_extract 自 source.payload；本地书无源行 → 0）
        sourceType = getInt(20),
    )
}

internal fun Database.getBookshelf(db: Connection, sourceId: String, bookUrl: String): BookshelfItem? = db.prepareStatement(SHELF_SELECT + " where s.source_id=? and s.book_url=?").use { it.setString(1, sourceId); it.setString(2, bookUrl); it.executeQuery().use { rs -> if (rs.next()) rs.toShelf() else null } }
