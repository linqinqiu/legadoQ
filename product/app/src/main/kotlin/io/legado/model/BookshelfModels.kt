package io.legado.model

import kotlinx.serialization.Serializable

/** 书架分组（上游 `data/entities/BookGroup.kt`）。`bookCount` 由查询侧带出，不落库。 */
@Serializable data class BookGroup(val id: Long, val name: String, val bookCount: Int = 0)

/**
 * 「阅读设置 → 本地书目录」下拉里的一项。
 * `key` 直接就是服务端认的值（`auto` / `builtin` / 规则 id），
 * 前端不需要知道那两个特殊值怎么来的 —— 否则两边各写一份哨兵字符串迟早漂移。
 */
/**
 * 一条可选的分章规则。
 *
 * `selectable`（出现在选择清单里）与 `enable`（参与"自动"打分）**是两件事**：
 * 曾经 options 只发 `enable` 的那 12 条，于是另外 12 条既看不见也选不了，
 * 而解析层 `byId` 走的是全表 —— 一个旗标兼两职就是把功能做没的那类分配错误。
 */
@Serializable data class TocRuleOption(
    val key: String,
    val label: String,
    val example: String = "",
    val builtIn: Boolean = false,
    /** 这条规则的正则原文：不写出来，用户没法判断它适不适合自己的书。 */
    val rule: String = "",
    /** 参与"自动"打分。关掉它不等于不能手动选。 */
    val enable: Boolean = true,
    /** 正则编不出来（备份里带来的坏规则）：界面上要标出来，而不是悄悄不出现。 */
    val broken: Boolean = false,
    /** 只有自建的规则能删（随包那 26 条不可删，界面上按它决定摆不摆删除键）。 */
    val removable: Boolean = false,
)
@Serializable data class TocRuleList(
    val options: List<TocRuleOption>,
    /** 界面上要能说出"本机启用几条、其中几条是从手机备份收下来的"，不然"套用过没有"只能靠猜。 */
    val enabled: Int = 0,
    val total: Int = 0,
    val fromBackup: Int = 0,
    /** 本机改动还在不在（套用过备份就是"在"）——界面上「恢复随包那份」按它出现。 */
    val overridden: Boolean = false,
)
@Serializable data class TocRuleToggleRequest(val key: String, val enable: Boolean)
@Serializable data class TocRuleToggleResult(val id: Int, val name: String, val enable: Boolean)

/** 新建/修改一条分章规则。`key` 省略或不是数字 = 新建（id 由服务端分配）。 */
@Serializable data class TocRuleSaveRequest(
    val key: String? = null,
    val name: String,
    val rule: String,
    val example: String? = null,
    val enable: Boolean = true,
)
@Serializable data class TocRuleSaveResult(val id: Int, val name: String, val rule: String, val enable: Boolean, val total: Int)
@Serializable data class TocRuleDeleteResult(val removed: Boolean, val total: Int)

/** 撤掉本机改动的回报（这里不许回 `Map<String, Any>`：Ktor 的序列化直接 500，第一版就栽在这一点上）。 */
@Serializable data class TocRuleResetResult(val cleared: Boolean, val total: Int)

/** 套用备份里那份规则表的结果（计数都是条目数，界面上直接说人话）。 */
@Serializable data class TocRuleApplyResult(
    val matched: Int = 0,
    val flipped: Int = 0,
    val added: Int = 0,
    val unusable: Int = 0,
    val total: Int = 0,
)
@Serializable data class LocalBookReparseRequest(val sourceId: String, val bookUrl: String, val ruleKey: String)
/** 重切目录的结果。`tocRuleUsed` 是**实际生效**的那条，可能与请求里选的不同。 */
@Serializable data class LocalBookReparseResult(
    val success: Boolean,
    val name: String = "",
    val totalChapters: Int = 0,
    val tocRuleUsed: String = "",
    val ruleLabel: String = "",
    val fellBack: Boolean = false,
    val error: String? = null,
)
@Serializable data class BookGroupCreateRequest(val name: String)
@Serializable data class BookGroupAssignRequest(val sourceId: String, val bookUrl: String, val groupId: Long)

/** 批量操作请求模型 */
@Serializable data class BatchDeleteRequest(val books: List<BookIdentifier>)
@Serializable data class BatchMoveGroupRequest(val books: List<BookIdentifier>, val groupId: Long?)
@Serializable data class BatchMarkReadRequest(val books: List<BookIdentifier>, val isRead: Boolean)

@Serializable data class BatchDeleteResult(
    // 字段名就是 API 的 JSON 键，前端 `reader.ts` 与 `ShelfPage.tsx` 直接读 `result.deleted`
    //（`已删除 ${result.deleted} 本书`）。改名等于把界面显示成「已删除 undefined 本书」，
    // 所以这里以既有契约为准，不按内部命名习惯改成 `deletedCount`。
    val deleted: Int,
    val total: Int,
    val failed: Int = 0,
    val error: String? = null,
    val failedBooks: List<BookIdentifier> = emptyList(),
)

@Serializable data class BatchMoveResult(
    val moved: Int,
    val total: Int,
    val failed: Int = 0,
    val error: String? = null,
    val failedBooks: List<BookIdentifier> = emptyList(),
)

@Serializable data class BatchMarkResult(
    val marked: Int,
    val total: Int,
    val failed: Int = 0,
    val error: String? = null,
    val failedBooks: List<BookIdentifier> = emptyList(),
)

@Serializable data class LocalBookImportItem(
    val filename: String,
    val success: Boolean,
    val bookUrl: String? = null,
    val name: String? = null,
    val author: String? = null,
    val totalChapters: Int = 0,
    val error: String? = null
)

/**
 * 本地书导入的**传输无关**入参：只带文件名与字节。
 *
 * 刻意不用 `io.ktor.http.content.PartData` —— 那是传输层类型（multipart 的一个 part），
 * 让它进 `BookshelfRepository` 等于把 HTTP 细节漏进数据层，并且把 Repository 钉死在 Ktor 上：
 * 换个传输方式、或想单测导入逻辑，都得先造一个假的 multipart part。
 *
 * 由路由层负责把 multipart 拆成这个类型，字节的读取与释放仍在路由层完成。
 */
class LocalBookUpload(val filename: String, val bytes: ByteArray)

@Serializable
data class SwitchSourceResult(
    val book: BookshelfItem,
    val alternateSources: List<SearchResult>,
    val coverKey: String? = null
)

@Serializable
data class CachedChaptersInfo(
    val sourceId: String,
    val bookUrl: String,
    val cachedChapterUrls: List<String>,
    val cachedCount: Int,
    val totalChapters: Int,
    val cachedWordCounts: List<Int>
)

@Serializable
data class CacheQueueStatus(
    val status: String = "queued"
)

@Serializable data class BookIdentifier(val sourceId: String, val bookUrl: String)
/** 自定义排序落库的结果：写进去 / 清掉了几行。 */
@Serializable data class OrderResult(val updated: Int)
/** 书源自定义排序：屏幕上这一列按新顺序回传，服务端按位置写 `source.sort_order`。 */
@Serializable data class SourceOrderRequest(val ids: List<String>)
