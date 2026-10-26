package io.legado.reading

import io.legado.data.Database
import io.legado.data.addNote
import io.legado.data.addReadingLog
import io.legado.data.cachedChapterUrls
import io.legado.data.deleteNote
import io.legado.data.getProgress
import io.legado.data.listNotes
import io.legado.data.listReadingLog
import io.legado.data.saveProgress
import io.legado.data.searchBookContent
import io.legado.data.tocChapters
import io.legado.data.updateNote
import io.legado.model.BookNote
import io.legado.model.BookNoteWrite
import io.legado.model.BookSearchHit
import io.legado.model.ReadingLogEntry
import io.legado.model.ReadingLogRequest
import io.legado.model.ReadingProgress

/**
 * 阅读域收口（P1-T4）：把进度 / 阅读记录 / 笔记划线（含书签）/ 本书检索的读写统一到这里。
 *
 * 设计边界（与 `io.legado.data.ReadingDao.kt` 顶部约定对齐）：
 * - DAO 只做表级 CRUD，写成 `Database` 的扩展函数；本 Repository 是把这些扩展函数**组合 / 暴露**
 *   成域方法的地方，不重复任何 SQL，也不直接拼 SQL —— Route / Service 一律走 Repository。
 * - 章节窗口（P2 的全局页索引 + 滑动窗口）先留 stub（见 [chapterWindow]），实现待 P2 落地，
 *   避免现在就编一版会被 P2 推翻的窗口逻辑。
 */
class ReadingRepository(private val database: Database) {

    /** 释放底层连接：Repository 持有 `Database`，调用方（含测试）用完应 close，否则 Windows 上临时库文件无法删除。 */
    fun close() = database.close()

    // —— 阅读进度（逻辑位置：章节 + 字符偏移 + 段落锚点）——
    fun getProgress(sourceId: String, bookUrl: String): ReadingProgress? =
        database.getProgress(sourceId, bookUrl)

    fun saveProgress(progress: ReadingProgress): ReadingProgress =
        database.saveProgress(progress)

    // —— 阅读记录（按天累加停留秒数，只增不改）——
    fun addReadingLog(request: ReadingLogRequest): ReadingLogEntry =
        database.addReadingLog(request)

    fun listReadingLog(days: Int): List<ReadingLogEntry> =
        database.listReadingLog(days)

    // —— 笔记 / 划线 / 书签（章节内字符偏移锚定）——
    fun listNotes(sourceId: String, bookUrl: String): List<BookNote> =
        database.listNotes(sourceId, bookUrl)

    fun addNote(write: BookNoteWrite): BookNote =
        database.addNote(write)

    fun updateNote(id: Long, note: String): Boolean =
        database.updateNote(id, note)

    fun deleteNote(id: Long): Boolean =
        database.deleteNote(id)

    // —— 本书正文检索（仅已缓存章节）——
    fun searchBookContent(sourceId: String, bookUrl: String, query: String): List<BookSearchHit> =
        database.searchBookContent(sourceId, bookUrl, query)

    /**
     * 章节窗口（P2-T1）：当前章 ±N 章的章节摘要，供全局页索引 / 跨章翻页消费。
     *
     * 窗口按**章号区间**切，不是按目录数组下标切：目录里除了正文章还有卷分组行
     * （`Chapter.isVolume`），两者共用同一套 index，按下标切会把卷头算进"前后各一章"里。
     * 区间天然夹在目录两端，所以第一章要"前一章"时不会绕回书尾。
     *
     * `cached` 来自正文缓存表，是"这一章能不能离线读"的唯一判据；`anchor` 见 [ChapterWindowEntry]。
     *
     * 没有目录缓存（这本书从没取过目录）返回空列表 —— 窗口没有可描述的对象，
     * 不该编一串假章节出来。
     */
    fun chapterWindow(
        sourceId: String,
        bookUrl: String,
        chapterIndex: Int,
        before: Int = 1,
        after: Int = 1,
    ): List<ChapterWindowEntry> {
        if (chapterIndex < 0 || before < 0 || after < 0) return emptyList()
        val chapters = database.tocChapters(sourceId, bookUrl) ?: return emptyList()
        if (chapters.isEmpty()) return emptyList()
        val cached = database.cachedChapterUrls(sourceId, bookUrl)
        val from = chapterIndex - before
        val to = chapterIndex + after
        return chapters
            .filter { it.index in from..to }
            .map { chapter ->
                ChapterWindowEntry(
                    chapterIndex = chapter.index,
                    title = chapter.title,
                    cached = chapter.url in cached,
                )
            }
    }
}

/**
 * 章节窗口摘要。
 * [chapterIndex] 章节序号；[title] 章名；[cached] 正文是否已离线缓存；
 * [anchor] 首字符逻辑锚点 —— **目前恒为 null**：`paragraphAnchor` 这一列前端还没有生成规则
 * （只透传、不产出），后端不自己发明一种编码去填它。等 P3 批注锚点落地、锚点格式定下来再填，
 * 那时窗口只需把这里接上，契约不变。
 */
data class ChapterWindowEntry(
    val chapterIndex: Int,
    val title: String,
    val cached: Boolean,
    val anchor: String? = null,
)
