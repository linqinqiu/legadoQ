package io.legado.model

import kotlinx.serialization.Serializable

@Serializable data class BookRequest(val sourceId: String, val bookUrl: String)
@Serializable data class BookDetails(
    val sourceId: String,
    val name: String,
    val author: String? = null,
    val intro: String? = null,
    val coverUrl: String? = null,
    val tocUrl: String,
    val kind: String? = null,
    val wordCount: String? = null,
    val lastChapter: String? = null,
    /** 书源的 `bookSourceType`：0 文本 / 1 音频 / 2 图片(漫画) / 3 文件 / 4 视频。 */
    val sourceType: Int = 0,
    /** 书源 `ruleContent.imageStyle`：`FULL` 表示正文图片铺满阅读区；缺省为普通版心宽度。 */
    val imageStyle: String? = null,
)
@Serializable data class Chapter(val index: Int, val title: String, val url: String, val isVolume: Boolean = false)
@Serializable data class ContentRequest(
    val sourceId: String,
    val chapterUrl: String = "",
    val bookUrl: String? = null,
    /**
     * 强制回源重取并覆盖缓存。用户手动「刷新本章正文」时才带 ——
     * 平时阅读命中缓存就直接回，省一次站点请求；这里必须能表达"我不要缓存"。
     */
    val force: Boolean = false,
)
/** 批量刷新正文：只接受明确列出的章节地址，不在这里重取整本目录。 */
@Serializable data class ContentRefreshRequest(
    val sourceId: String,
    val bookUrl: String,
    val chapterUrls: List<String> = emptyList(),
)
@Serializable data class ContentRefreshFailure(val chapterUrl: String, val message: String)
@Serializable data class ContentRefreshResult(
    val refreshed: List<String> = emptyList(),
    val failed: List<ContentRefreshFailure> = emptyList(),
    /** 超过单次上限没处理的数量；前端按批再发，不把一次请求拖成整本爬取。 */
    val remaining: Int = 0,
)
@Serializable data class ChapterContent(
    val title: String? = null,
    val content: String,
    /**
     * 非文本章节（音频/EPUB 直链）的媒体地址。书源正文 JS 给 `yp_url` 赋值时填这个；
     * 前端据此渲染播放器，而不是把地址当正文排出来。
     */
    val mediaUrl: String? = null,
)
@Serializable data class ReadingProgress(
    val sourceId: String,
    val bookUrl: String,
    val chapterUrl: String,
    val chapterIndex: Int,
    val scrollPosition: Double = 0.0,
    /**
     * 逻辑位置模型（P1-T1）：章节内绝对字符偏移（0 起）。
     * 取代 `scrollPosition` 作为阅读恢复的唯一坐标；字号/分页都据此二段定位到当前行。
     *
     * `null` = 本次请求没有提交逻辑位置。落库时用 coalesce 保留旧值：
     * 旧标签页/旧客户端只传 scrollPosition 时，不能把别的客户端存下的语义位置清零。
     * 0 仍是有效值（章首），会正常覆盖。
     */
    val charOffset: Int? = null,
    /** 段落锚点：稳定定位用的段落标识（如段落索引或段首哈希），内容重排后辅助回退。可空。 */
    val paragraphAnchor: String? = null,
    /** 逻辑位置编码版本，便于后续格式迁移。 */
    val positionVersion: Int = 1,
    /** 保存时刻的章节内容校验值（前端提供，如内容哈希）。内容漂移时用于判断 charOffset 是否失效。 */
    val positionChecksum: String? = null,
    val updatedAt: Long = 0,
)
/**
 * 阅读记录（PROPOSAL-019 D）。粒度「一天 · 一本书」一行，秒数只累加 ——
 * 不是为了留审计流水，而是为了「今天读了多久 / 这本书累计读了多久」这类时间轴。
 * `day` 是**本地日**（服务端与使用者同一台机器，用服务端本地日期即可）。
 */
@Serializable data class ReadingLogEntry(
    val day: String,
    val sourceId: String,
    val bookUrl: String,
    val bookName: String = "",
    val chapterIndex: Int = 0,
    val seconds: Long = 0,
    val updatedAt: Long = 0,
)
/** 前端上报一段停留（节流后按段上报，不是每秒一条）。 */
@Serializable data class ReadingLogRequest(
    val sourceId: String,
    val bookUrl: String,
    val bookName: String = "",
    val chapterIndex: Int = 0,
    val seconds: Int,
)
/**
 * 笔记 / 划线（PROPOSAL-019 E）。偏移是**章节内字符偏移**，不是像素 / 列号 ——
 * 字号、字体、分栏一改位置就跳。`excerpt` 同时留一份选中原文：偏移算错还能靠它找回，导出也可读。
 */
@Serializable data class BookNote(
    val id: Long = 0,
    val sourceId: String,
    val bookUrl: String,
    val bookName: String = "",
    val chapterUrl: String = "",
    val chapterIndex: Int = 0,
    val startOffset: Int,
    val endOffset: Int,
    val excerpt: String,
    val note: String = "",
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    /** 书签：只标位置、不写想法（与「划线/笔记」区分）。前端从 GET /api/notes 里按此字段筛出书签。 */
    val bookmark: Boolean = false,
    /** 段落锚点（逻辑位置模型 P1-T1）：重排后辅助回退。可空。 */
    val paragraphAnchor: String? = null,
    /** 逻辑位置编码版本。 */
    val positionVersion: Int = 1,
    /** 保存时刻的章节内容校验值，用于锚点失效检测与模糊重定位。 */
    val positionChecksum: String? = null,
)
@Serializable data class BookNoteWrite(
    val sourceId: String,
    val bookUrl: String,
    val bookName: String = "",
    val chapterUrl: String = "",
    val chapterIndex: Int = 0,
    val startOffset: Int,
    val endOffset: Int,
    val excerpt: String,
    val note: String = "",
    val bookmark: Boolean = false,
    /** 段落锚点（逻辑位置模型 P1-T1）。可空。 */
    val paragraphAnchor: String? = null,
    /** 逻辑位置编码版本。 */
    val positionVersion: Int = 1,
    /** 保存时刻的章节内容校验值。 */
    val positionChecksum: String? = null,
)
/** 改备注（只改 `note` 这一栏；划线的位置与原文不动）。 */
@Serializable data class BookNoteUpdate(val note: String = "")
/**
 * 本书正文检索命中（搜索本书 feature）：在已缓存的章节正文里按关键词找，
 * 回「哪一章 + 命中处前后截一段 + 命中处的章内字符偏移」。
 * 偏移是给「跳到那一段并高亮」用的：只有章号的话，跳过去还得自己找。
 * 只覆盖已离线缓存的章节（没缓存的搜不到）。
 */
@Serializable data class BookSearchHit(
    val chapterUrl: String,
    val chapterIndex: Int,
    val title: String,
    val snippet: String,
    /** 关键词在**这一章正文**里的字符偏移；正文与缓存不一致（AI 覆盖）时可能偏。 */
    val offset: Int,
)
/**
 * AI 闭环（阅读器 AI 闭环 feature，2026-10）：一本书某一章被 AI 净化/润色后的「覆盖正文」。
 * 读者选中/整章交给 AI，AI 返回干净正文，落这张表；`GET/POST /api/books/content` 读到覆盖就回它，
 * 正文实时重载（所见即所得）。`kind` 区分 `ai_clean`（净化）/ `ai_rewrite`（润色）。
 */
@Serializable data class ContentProcess(
    val sourceId: String,
    val bookUrl: String,
    val chapterUrl: String,
    val kind: String,
    val original: String,
    val processed: String,
    val updatedAt: Long,
)
/** 写覆盖正文的请求体（落库用）。 */
@Serializable data class ContentProcessRequest(
    val sourceId: String,
    val bookUrl: String,
    val chapterUrl: String,
    val kind: String,
    val original: String,
    val processed: String,
)
@Serializable data class BookshelfWriteRequest(
    val sourceId: String,
    val bookUrl: String,
    val name: String,
    val author: String? = null,
    val tocUrl: String,
    val coverUrl: String? = null,
    val alternateSources: List<SearchResult>? = null,
)
@Serializable data class BookshelfSourceSwitchRequest(
    val oldSourceId: String,
    val oldBookUrl: String,
    val book: BookshelfWriteRequest,
    val alternateSources: List<SearchResult>? = null,
)
@Serializable data class BookshelfStatusRequest(val sourceId: String, val bookUrl: String, val completed: Boolean)
@Serializable data class BookshelfInfoUpdateRequest(
    val sourceId: String,
    val bookUrl: String,
    val name: String,
    val author: String? = null,
    val coverUrl: String? = null,
)
data class CachedBookRequest(
    val sourceId: String,
    val bookUrl: String,
    val tocUrl: String,
    val startIndex: Int? = null,
    val endIndex: Int? = null,
    val count: Int? = null,
)
@Serializable data class BookCacheRangeRequest(
    val sourceId: String,
    val bookUrl: String,
    val startIndex: Int? = null,
    val endIndex: Int? = null,
    val count: Int? = null,
)
@Serializable data class CachedChaptersResponse(
    val sourceId: String,
    val bookUrl: String,
    val cachedChapterUrls: List<String>,
    val cachedCount: Int,
    val totalChapters: Int = 0,
    /**
     * 已缓存章节的字数（`chapter_url` → 正文字符数）。
     *
     * 用户要的「当获取到内容的时候，把章节字数显示在右边」就靠这份数据：只有正文真的
     * 落库（服务端缓存或读正文时顺手缓存）的章节才有字数 —— 没内容就没有字数可说。
     * 用 `length(content)` 现算，不另存一列：`book_content_cache` 的行就是内容本身，
     * 加列要么得维护双写一致性、要么回填历史行，都不如直接量。
     * SQLite 的 `length()` 对 TEXT 返回**字符数**（不是字节），中文一章 2000 字就报 2000，
     * 与阅读器里看到的排版字数一致。
     *
     * 与 [cachedChapterUrls] 同序同长，调用方也可以按 url 建表查。
     */
    val cachedWordCounts: List<Int> = emptyList(),
)
@Serializable data class BookshelfItem(
    val sourceId: String,
    val bookUrl: String,
    val name: String,
    val author: String? = null,
    val tocUrl: String,
    val coverKey: String? = null,
    val chapterIndex: Int? = null,
    val scrollPosition: Double? = null,
    val lastReadAt: Long,
    /** 目录/内容上次刷新时间（epoch 毫秒），派生自 `book_toc_cache.updated_at`；0 = 尚无目录缓存记录。 */
    val tocUpdatedAt: Long = 0,
    val cachedChapters: Int = 0,
    val totalChapters: Int = 0,
    val cacheState: String = "idle",
    val cacheError: String? = null,
    val completed: Boolean = false,
    val alternateSources: List<SearchResult> = emptyList(),
    /** 书架分组，0 = 未分组（见 [BookGroup]）。 */
    val groupId: Long = 0,
    /**
     * 这本本地书实际用的目录规则（`builtin` 或 `txtTocRule.json` 里的 id）；在线书为 null。
     * 存"实际生效的那条"而不是"用户选的那条"：选了 A 却因切不出第二章回落到 B 时，
     * 界面必须能说清现在是 B。
     */
    val tocRule: String? = null,
    /** 书源的 `bookSourceType`：0 文本 / 1 音频 / 2 图片(漫画) / 3 文件 / 4 视频。 */
    val sourceType: Int = 0,
)
