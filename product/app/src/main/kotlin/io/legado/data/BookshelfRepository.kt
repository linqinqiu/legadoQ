package io.legado.data

import io.legado.cache.BookCacheService
import io.legado.cache.CachedCover
import io.legado.cache.CoverCache
// 封面解析住在 `io.legado.cache`（与 CoverCache 同类关注点），路由、仓库、测试共用同一份实现。
import io.legado.cache.tryCacheCover
import io.legado.cache.tryFindCachedCover
import io.legado.localbook.LocalBookParser
import io.legado.model.*
import io.legado.model.CachedChaptersInfo
import java.nio.file.Path

/**
 * Bookshelf Repository - 书架业务组合层
 * 
 * 职责:
 * 1. 跨表业务查询组合
 * 2. 复杂业务逻辑封装
 * 3. 事务边界控制
 * 
 * 设计原则:
 * - DAO 只做单表 CRUD
 * - Repository 负责多表关联和业务规则
 * - Route 层只负责解析入参和返回结果
 */
class BookshelfRepository(
    private val database: Database,
    private val bookCache: BookCacheService,
    private val coverCache: CoverCache,
    private val localBooksDirectory: Path,
) {
    
    // ==================== 列表查询 ====================
    
    /**
     * 获取书架列表（带缓存状态和阅读进度）
     */
    fun listBooks(): List<BookshelfItem> = database.listBookshelf()
    
    /**
     * 根据分组 ID 筛选书籍
     */
    fun listBooksByGroup(groupId: Long?): List<BookshelfItem> {
        return if (groupId == null) {
            database.listBookshelf()
        } else {
            database.connect { db ->
                db.prepareStatement("""
                    ${SHELF_SELECT.replace("order by s.last_read_at desc", "")}
                    where s.group_id = ?
                    order by s.last_read_at desc
                """).use { stmt ->
                    stmt.setLong(1, groupId)
                    stmt.executeQuery().use { rs ->
                        buildList { while (rs.next()) add(rs.toShelf()) }
                    }
                }
            }
        }
    }
    
    // ==================== 单本操作 ====================
    
    /**
     * 添加或更新书籍到书架
     */
    fun addOrUpdateBook(request: BookshelfWriteRequest): BookshelfItem {
        validateBookRequest(request)
        
        val immediateCover = tryFindCachedCover(coverCache, request.coverUrl, request.alternateSources)
        val item = database.saveBookshelf(request, immediateCover)

        // 加入离线缓存队列
        bookCache.enqueue(CachedBookRequest(request.sourceId, request.bookUrl, request.tocUrl))
        
        return item
    }
    
    /**
     * 从书架移除书籍
     */
    fun removeBook(sourceId: String, bookUrl: String): Boolean {
        validateBookIdentifier(sourceId, bookUrl)
        
        // 取消缓存任务
        bookCache.cancel(sourceId, bookUrl)
        
        // 删除本地书文件
        deleteLocalBookFile(sourceId, bookUrl)
        
        // 删除书架记录及相关数据
        val orphanCover = database.removeBookshelf(sourceId, bookUrl)
        
        // 清理废弃封面
        orphanCover?.let { coverCache.delete(it) }
        
        return true
    }
    
    /**
     * 获取单本书的完整信息
     */
    fun getBook(sourceId: String, bookUrl: String): BookshelfItem? {
        validateBookIdentifier(sourceId, bookUrl)
        return database.shelfBook(sourceId, bookUrl)
    }
    
    // ==================== 批量操作 ====================
    
    /**
     * 批量删除书籍。
     *
     * **不要在外面再包一层 `database.write { autoCommit = false … }`。**
     * 池里只有一条写连接，`removeBookshelf` 自己就是一个 `write {}`，它退出时会把
     * `autoCommit` 复位成 true —— 外层再 `commit()` 就抛 `database in auto-commit mode`。
     * 于是整批会被判成「失败」：每本书其实已经各自提交了，返回的却是 `deleted=0` + error。
     * 这里按 DAO 的实际粒度逐本删，失败的书进 `failedBooks`，不再假装有整批事务。
     */
    fun batchDeleteBooks(books: List<BookIdentifier>): BatchDeleteResult {
        require(books.isNotEmpty()) { "书籍列表不能为空" }

        var deletedCount = 0
        val failedBooks = mutableListOf<BookIdentifier>()

        try {
            for (book in books) {
                if (book.sourceId.isBlank() || book.bookUrl.isBlank()) continue

                // 判据必须是「删之前它在不在架上」，不能拿 removeBookshelf 的返回值：
                // 它回的是「顺手回收掉的孤儿封面」，没封面的书回 null。
                val existed = database.shelfBook(book.sourceId, book.bookUrl) != null
                if (!existed) {
                    failedBooks.add(book)
                    continue
                }

                bookCache.cancel(book.sourceId, book.bookUrl)
                deleteLocalBookFile(book.sourceId, book.bookUrl)

                val orphanCover = database.removeBookshelf(book.sourceId, book.bookUrl)
                orphanCover?.let { coverCache.delete(it) }
                deletedCount++
            }

            return BatchDeleteResult(
                deleted = deletedCount,
                total = books.size,
                failed = failedBooks.size,
                failedBooks = failedBooks.take(10) // 只返回前 10 个失败案例
            )
        } catch (e: Exception) {
            return BatchDeleteResult(
                deleted = deletedCount,
                total = books.size,
                failed = failedBooks.size,
                error = e.message ?: "未知错误"
            )
        }
    }
    
    /**
     * 批量移动书籍到指定分组。
     *
     * 同 [batchDeleteBooks]：`assignBookGroup` 自己带事务，外层再包一层只会让 commit 抛错。
     * `null` 表示「移出所有分组」，DAO 用 0 表示未分组。
     */
    fun batchMoveToGroup(books: List<BookIdentifier>, groupId: Long?): BatchMoveResult {
        require(books.isNotEmpty()) { "书籍列表不能为空" }

        var updatedCount = 0
        val failedBooks = mutableListOf<BookIdentifier>()

        try {
            for (book in books) {
                if (book.sourceId.isBlank() || book.bookUrl.isBlank()) continue

                val updated = database.assignBookGroup(book.sourceId, book.bookUrl, groupId ?: 0L)
                if (updated != null) updatedCount++
                else failedBooks.add(book)
            }

            return BatchMoveResult(
                moved = updatedCount,
                total = books.size,
                failed = failedBooks.size,
                failedBooks = failedBooks.take(10)
            )
        } catch (e: Exception) {
            return BatchMoveResult(
                moved = updatedCount,
                total = books.size,
                failed = failedBooks.size,
                error = e.message ?: "未知错误"
            )
        }
    }
    
    /**
     * 批量标记阅读状态
     */
    fun batchMarkAsRead(books: List<BookIdentifier>, isRead: Boolean): BatchMarkResult {
        require(books.isNotEmpty()) { "书籍列表不能为空" }
        
        var markedCount = 0
        
        books.forEach { book ->
            if (book.sourceId.isNotBlank() && book.bookUrl.isNotBlank()) {
                val result = database.setBookshelfCompleted(book.sourceId, book.bookUrl, isRead)
                if (result != null) markedCount++
            }
        }
        
        return BatchMarkResult(marked = markedCount, total = books.size)
    }
    
    // ==================== 分组管理 ====================
    
    /**
     * 获取所有分组（含每组的书籍数）
     */
    fun listGroups(): List<BookGroup> = database.listBookGroups()
    
    /**
     * 创建分组
     */
    fun createGroup(name: String): BookGroup {
        val trimmedName = name.trim()
        require(trimmedName.isNotEmpty()) { "分组名不能为空" }
        require(trimmedName.length <= 24) { "分组名最长 24 字" }
        
        return database.createBookGroup(trimmedName)
    }
    
    /**
     * 删除分组（不删除书中的书）
     */
    fun deleteGroup(groupId: Long): Boolean {
        require(groupId != 0L) { "不能删除未分组" }
        return database.deleteBookGroup(groupId)
    }
    
    /**
     * 移动书籍到分组
     */
    fun moveBookToGroup(sourceId: String, bookUrl: String, groupId: Long?): BookshelfItem? {
        validateBookIdentifier(sourceId, bookUrl)
        return if (groupId != null && !groupExists(groupId)) {
            null
        } else {
            // null = 移出所有分组，DAO 以 0 表示未分组
            database.assignBookGroup(sourceId, bookUrl, groupId ?: 0L)
        }
    }
    
    // ==================== 缓存管理 ====================
    
    /**
     * 启用离线缓存
     */
    fun enableOfflineCache(request: BookCacheRangeRequest): CacheQueueStatus {
        val book = database.shelfBook(request.sourceId, request.bookUrl)
            ?: throw IllegalArgumentException("书籍不在书架中")
        
        bookCache.enqueue(CachedBookRequest(
            book.sourceId,
            book.bookUrl,
            book.tocUrl,
            request.startIndex,
            request.endIndex,
            request.count
        ))
        
        return CacheQueueStatus(status = "queued")
    }
    
    /**
     * 禁用离线缓存
     */
    fun disableOfflineCache(sourceId: String, bookUrl: String, clearData: Boolean = false) {
        bookCache.cancel(sourceId, bookUrl)
        if (clearData) {
            database.clearBookCacheContent(sourceId, bookUrl)
        }
    }
    
    /**
     * 获取已缓存章节信息
     */
    fun getCachedChapters(sourceId: String, bookUrl: String): CachedChaptersInfo {
        val cachedRows = database.cachedChapterWordCounts(sourceId, bookUrl)
        val cachedUrls = cachedRows.map { it.first }
        val total = database.getTocCache(sourceId, bookUrl)?.size ?: 0
        
        return CachedChaptersInfo(
            sourceId = sourceId,
            bookUrl = bookUrl,
            cachedChapterUrls = cachedUrls,
            cachedCount = cachedUrls.size,
            totalChapters = total,
            cachedWordCounts = cachedRows.map { it.second }
        )
    }
    
    // ==================== 状态管理 ====================
    
    /**
     * 设置书籍为已读/未读
     */
    fun setCompleted(sourceId: String, bookUrl: String, completed: Boolean): BookshelfItem? {
        validateBookIdentifier(sourceId, bookUrl)
        return database.setBookshelfCompleted(sourceId, bookUrl, completed)
    }
    
    /**
     * 更新书籍基本信息
     */
    fun updateBookInfo(request: BookshelfInfoUpdateRequest): BookshelfItem? {
        validateBookIdentifier(request.sourceId, request.bookUrl)
        require(request.name.isNotBlank()) { "书名不能为空" }
        
        val cover = request.coverUrl?.takeIf { it.isNotBlank() }?.let { url ->
            runCatching { coverCache.cache(url) }.getOrNull()
        }
        
        return database.updateBookshelfInfo(request, cover)
    }
    
    // ==================== 换源支持 ====================
    
    /**
     * 书籍换源（替换整本书）。
     *
     * @param request 新源那一本书的写入请求（它自己也可能带备用源）
     * @param extraAlternateSources 外层换源请求里的备用源。与 [request] 内的备用源**合并**——
     *   两者是不同来源：外层是用户这次换源额外指定的，内层是书名搜索时就带着的。
     *   只合并其中一份会丢掉另一份的封面候选。
     */
    fun switchSource(
        oldSourceId: String,
        oldBookUrl: String,
        request: BookshelfWriteRequest,
        extraAlternateSources: List<SearchResult> = emptyList(),
    ): SwitchSourceResult {
        val altList = extraAlternateSources + request.alternateSources.orEmpty()

        // 取消旧源缓存
        bookCache.cancel(oldSourceId, oldBookUrl)

        // 查找新封面
        val cover = tryCacheCover(coverCache, request.coverUrl, altList, referer = request.sourceId)

        // 执行换源
        val (item, orphanCover) = database.switchBookshelf(oldSourceId, oldBookUrl, request, cover, extraAlternateSources)
        
        // 清理废弃封面
        orphanCover?.let { coverCache.delete(it) }
        
        // 加入新源缓存队列
        bookCache.enqueue(CachedBookRequest(request.sourceId, request.bookUrl, request.tocUrl))
        
        return SwitchSourceResult(
            book = item,
            alternateSources = altList,
            coverKey = cover?.key
        )
    }
    
    // ==================== 本地书导入 ====================
    
    /**
     * 批量导入本地书。
     *
     * 入参是**传输无关的** [LocalBookUpload]（文件名 + 字节），不是 Ktor 的 `PartData.FileItem`：
     * 路由层负责把 multipart 拆开、把字节读完，这里只做解析与落库。
     * 这样这个函数能在纯单测里直接调，不必先造一个真的 multipart part。
     */
    suspend fun importLocalBooks(uploads: List<LocalBookUpload>, tocRule: String?): LocalBookImportResponse {
        // 「本地」这一组分一次就够，不要每本书查一次库。
        val localGroupId = findOrCreateLocalGroup()

        val results = mutableListOf<LocalBookImportItem>()
        var importedCount = 0
        var failedCount = 0

        uploads.forEach { upload ->
            val originalFilename = upload.filename.ifBlank { "book.txt" }
            val bytes = upload.bytes
            if (bytes.isNotEmpty()) {
                try {
                    val bookId = java.util.UUID.randomUUID().toString().replace("-", "")
                    val parsed = LocalBookParser.parse(originalFilename, bytes, tocRule, bookId)
                    
                    val ext = if (originalFilename.contains('.')) "." + originalFilename.substringAfterLast('.') else ".txt"
                    saveLocalBookFile(bookId, ext, bytes)
                    
                    val coverKey = parsed.coverBytes?.let { coverCache.saveCoverBytes(it, parsed.coverContentType ?: "image/jpeg") }
                    
                    val item = database.importLocalBook(bookId, parsed, coverKey, localGroupId)
                    
                    importedCount++
                    results.add(LocalBookImportItem(
                        filename = originalFilename,
                        success = true,
                        bookUrl = item.bookUrl,
                        name = item.name,
                        author = item.author,
                        totalChapters = item.totalChapters
                    ))
                } catch (error: Throwable) {
                    failedCount++
                    results.add(LocalBookImportItem(
                        filename = originalFilename,
                        success = false,
                        error = error.message ?: "解析失败"
                    ))
                }
            }
        }

        return LocalBookImportResponse(
            total = results.size,
            imported = importedCount,
            failed = failedCount,
            results = results
        )
    }
    
    // ==================== 辅助方法 ====================
    
    /**
     * 验证书籍标识有效性
     */
    private fun validateBookIdentifier(sourceId: String, bookUrl: String) {
        require(sourceId.isNotBlank()) { "来源 ID 不能为空" }
        require(bookUrl.isNotBlank()) { "书籍 URL 不能为空" }
    }
    
    /**
     * 验证书项请求完整性
     */
    private fun validateBookRequest(request: BookshelfWriteRequest) {
        require(request.sourceId.isNotBlank()) { "来源 ID 不能为空" }
        require(request.bookUrl.isNotBlank()) { "书籍 URL 不能为空" }
        require(request.name.isNotBlank()) { "书名不能为空" }
        require(request.tocUrl.isNotBlank()) { "目录 URL 不能为空" }
    }
    
    /**
     * 「本地」分组的 id，没有就建一个。
     *
     * 本地书统一归到这一组：一次导入十几本，混在线书里就再也找不着了。
     * `createBookGroup` 是按名字找、没有才建，所以重复导入不会堆出第二个「本地」。
     */
    private fun findOrCreateLocalGroup(): Long = database.createBookGroup(LOCAL_GROUP_NAME).id

    /**
     * 删除本地书文件
     */
    private fun deleteLocalBookFile(sourceId: String, bookUrl: String) {
        if (sourceId == LocalBookParser.LOC_BOOK_SOURCE_ID) {
            val bookId = bookUrl.removePrefix("local://").substringBefore('/')
            if (bookId.isNotBlank()) {
                runCatching {
                    if (java.nio.file.Files.exists(localBooksDirectory)) {
                        java.nio.file.Files.list(localBooksDirectory).use { stream ->
                            stream.filter { it.fileName.toString().startsWith(bookId) }
                                .forEach { java.nio.file.Files.deleteIfExists(it) }
                        }
                    }
                }
            }
        }
    }
    
    /**
     * 保存本地书文件
     */
    private fun saveLocalBookFile(bookId: String, ext: String, bytes: ByteArray) {
        java.nio.file.Files.createDirectories(localBooksDirectory)
        java.nio.file.Files.write(localBooksDirectory.resolve("$bookId$ext"), bytes)
    }
    
    /**
     * 查找或创建「本地」分组
     */
    fun getOrCreateLocalGroupId(): Long {
        return database.connect { db ->
            val group = db.prepareStatement("select group_id from book_group where name = '本地' collate nocase limit 1").use {
                it.executeQuery().use { rs -> if (rs.next()) rs.getLong(1) else null }
            }
            
            if (group != null) group
            else database.createBookGroup("本地").id
        }
    }
    
    /**
     * 检查分组是否存在
     */
    private fun groupExists(groupId: Long): Boolean {
        return database.connect { db ->
            db.prepareStatement("select 1 from book_group where group_id=?").use {
                it.setLong(1, groupId)
                it.executeQuery().next()
            }
        }
    }
    
    
    // ==================== 查询扩展 ====================
    
    /**
     * 按阅读时间排序（最近读的在前）
     */
    fun getMostRecentlyRead(): BookshelfItem? {
        return database.connect { db ->
            db.prepareStatement(SHELF_SELECT + " order by s.last_read_at desc limit 1").use {
                it.executeQuery().use { rs -> if (rs.next()) rs.toShelf() else null }
            }
        }
    }
    
    /**
     * 查找正在阅读的书籍
     */
    fun getReadingBooks(): List<BookshelfItem> {
        return database.connect { db ->
            db.prepareStatement(SHELF_SELECT + """
                where p.chapter_index is not null 
                  and p.chapter_index >= 0
                order by s.last_read_at desc
            """).use {
                it.executeQuery().use { rs ->
                    buildList { while (rs.next()) add(rs.toShelf()) }
                }
            }
        }
    }
    
    /**
     * 查找未完成的书籍
     */
    fun getIncompleteBooks(): List<BookshelfItem> {
        return database.listBookshelf().filter { !it.completed }
    }

    private companion object {
        /** 本地书统一归到这一组（与旧实现里 `createBookGroup("本地")` 的取值一致）。 */
        const val LOCAL_GROUP_NAME = "本地"
    }
}
