package io.legado.model

import kotlinx.serialization.Serializable

/** 备份导入结果统计（供页面提示使用）。 */
@Serializable
data class BackupImportSummary(
    val sources: Int,
    val sourcesUpdated: Int,
    val rules: Int,
    val rulesUpdated: Int,
    val books: Int,
    val booksUpdated: Int,
    /** 备份里有、但用户在本机删过而跳过的书数：导入是合并，不把删除决定盖掉。 */
    val booksSkippedDeleted: Int = 0,
    val progress: Int,
    /** 从包内 `cookies.json` 恢复并合并进书源的凭据条数（按 书源×域名 计）。 */
    val cookies: Int = 0,
    /** 为什么没恢复成（缺密码 / 密码不对 / 域名匹配不到书源），如实回报不静默。 */
    val cookiesNote: String? = null,
    /** 包内 `rssSources.json`（手机「订阅」页的 RSS 源）恢复条数，按 sourceUrl 新增。 */
    val rssSources: Int = 0,
    val rssSourcesUpdated: Int = 0,
    /** 包内 `bookGroup.json` 里落到本机分组表的数量（同名只留一个，手机号已换成本机号）。 */
    val bookGroups: Int = 0,
    /** 备份包里有、但服务端当前承接不了的条目名（TTS/字典/主题…），如实回报而不是静默丢弃。 */
    val skippedSections: List<String> = emptyList(),
    /** 包内条目读得出来但落不了库的原因（某一条书源/RSS 本身坏了）。以前只停在 ImportResponse 里，界面看不见。 */
    val errors: List<String> = emptyList(),
    /** 没有原生归宿、但已原样收进数据目录的个性化条目（书签/字典/阅读样式/朗读引擎…）。 */
    val keptSections: List<KeptBackupEntry> = emptyList(),
)

/** 备份包里被原样收下的一条个性化内容。appliable 为真时前端可以把它映射到自己的阅读设置上。 */
@Serializable
data class KeptBackupEntry(
    val name: String,
    /** 中文条目名（书签 / 阅读样式 / 朗读引擎…），直接来自条目名，不猜内容。 */
    val label: String,
    val bytes: Long,
    val items: Int,
    val appliable: Boolean,
    val updatedAt: Long,
)

/** 备份包 `bookshelf.json` 中的一条书架记录（含阅读进度），仅用于导入。 */
data class BackupShelfEntry(
    val sourceId: String,
    val bookUrl: String,
    val name: String,
    val author: String?,
    val tocUrl: String,
    val coverUrl: String?,
    val completed: Boolean,
    val chapterIndex: Int,
    /** 章内字符偏移（上游 `Book.durChapterPos`，0 起）。0 是有效值（章首），不能当成"没带"。 */
    val chapterPos: Int = 0,
    val readAt: Long,
    /** 手机那侧的分组号（`Book.groupId`）。落库前要经 `importBookGroups` 的映射换成本机号。 */
    val phoneGroupId: Long = 0,
    /** 映射后的本机组号，0 = 未分组。 */
    val groupId: Long = 0,
)

/**
 * 书架与阅读进度导入统计。
 *
 * [skippedDeleted] 是从备份里**跳过**的条目数：这些书用户在本机删过（见 `book_shelf_tombstone`），
 * 导入是合并、不复活它们。以前这个数混在 imported 里，界面读起来像"新增"，用户会以为删除没生效。
 */
data class LibraryImportResult(val imported: Int, val updated: Int, val progress: Int, val skippedDeleted: Int = 0)


/** 本地图书导入批量响应 */
@Serializable
data class LocalBookImportResponse(
    val total: Int,
    val imported: Int,
    val failed: Int,
    val results: List<LocalBookImportItem> = emptyList(),
)
