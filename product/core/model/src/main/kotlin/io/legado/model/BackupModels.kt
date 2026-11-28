package io.legado.model

import kotlinx.serialization.Serializable

/** sections 统计包内可解析条目，libraryDiff 预测书架与进度的处理结果；预览不写数据库或文件。 */
@Serializable
data class BackupImportPreview(
    val sections: List<BackupSectionPreview>,
    val warnings: List<String> = emptyList(),
    val libraryPolicy: BackupLibraryPolicy? = null,
    val libraryDiff: BackupLibraryDiff? = null,
    val previewToken: String? = null,
)

/** 新确认流程显式选择策略；省略整个对象时维持旧客户端的导入语义。 */
@Serializable
data class BackupLibraryPolicy(val metadata: String = "keep_local", val progress: String = "newer") {
    fun validate() {
        require(metadata in setOf("keep_local", "overwrite")) { "未知的书架信息冲突策略" }
        require(progress in setOf("newer", "overwrite", "keep_local")) { "未知的阅读进度冲突策略" }
    }
}

/** 仅书架/进度的处理预测，更新数表示策略选中的已有记录；包内同键重复取最后一条，其余模块仍报告包内数量。 */
@Serializable
data class BackupLibraryDiff(
    val booksAdded: Int = 0,
    val booksUpdated: Int = 0,
    val booksKept: Int = 0,
    val skippedDeleted: Int = 0,
    val progressApplied: Int = 0,
    val progressKept: Int = 0,
    val progressUnknownTime: Int = 0,
    val duplicates: Int = 0,
)

@Serializable
data class BackupSectionPreview(
    val id: String,
    val label: String,
    val items: Int,
    val policy: String,
)

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
    /** 包内 `sourceSub.json`（书源订阅地址）落到本机订阅表的条数，只收 type=0（产物是书源）。 */
    val subscriptions: Int = 0,
    /** 备份包里有、但服务端当前承接不了的条目名（TTS/字典/主题…），如实回报而不是静默丢弃。 */
    val skippedSections: List<String> = emptyList(),
    /** 包内条目读得出来但落不了库的原因（某一条书源/RSS 本身坏了）。以前只停在 ImportResponse 里，界面看不见。 */
    val errors: List<String> = emptyList(),
    /** 没有原生归宿、但已原样收进数据目录的个性化条目（书签/字典/阅读样式/朗读引擎…）。 */
    val keptSections: List<KeptBackupEntry> = emptyList(),
    val libraryDiff: BackupLibraryDiff? = null,
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

/** 备份包 `sourceSub.json` 中的一条书源订阅地址（上游 RuleSub），仅用于导入。 */
data class BackupSubscriptionEntry(val url: String, val enabled: Boolean)

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
    /** 明确携带进度才能恢复首章 0；没有进度字段的书不能凭空生成进度。 */
    val hasProgress: Boolean = chapterIndex > 0,
)

/**
 * 书架与阅读进度导入统计。
 *
 * [skippedDeleted] 是从备份里**跳过**的条目数：这些书用户在本机删过（见 `book_shelf_tombstone`），
 * 导入是合并、不复活它们。以前这个数混在 imported 里，界面读起来像"新增"，用户会以为删除没生效。
 */
data class LibraryImportResult(
    val imported: Int, val updated: Int, val progress: Int, val skippedDeleted: Int = 0,
    val diff: BackupLibraryDiff? = null,
)


/** 本地图书导入批量响应 */
@Serializable
data class LocalBookImportResponse(
    val total: Int,
    val imported: Int,
    val failed: Int,
    val results: List<LocalBookImportItem> = emptyList(),
)

/** 一份快照的清单条目：字节数、sidecar 记录的 SHA-256、实测是否吻合（完整性判定）、创建时刻。 */
@Serializable
data class SnapshotInfo(
    val name: String,
    val bytes: Long,
    val sha256: String?,
    val verified: Boolean,
    val createdAt: Long,
)

/** 排定恢复的请求体：只要一个快照名。 */
@Serializable data class SnapshotRestoreRequest(val name: String)

/** 排定恢复的回包：只说"已排定、需重启"，不代表已改库。 */
@Serializable data class SnapshotRestoreScheduled(val scheduled: Boolean, val restartRequired: Boolean, val name: String)

/** Request-only credentials. Never persisted or returned by the server. */
@Serializable data class BackupWebDavRequest(val url: String, val username: String = "", val password: String = "", val name: String? = null)
@Serializable data class BackupWebDavEntry(val name: String, val bytes: Long? = null, val modified: String? = null)
@Serializable data class BackupWebDavUpload(val name: String, val bytes: Long, val sha256: String, val verified: Boolean)

@Serializable data class SourceVersionListRequest(val archive: String, val offset: Int = 0, val query: String = "")
@Serializable data class SourceVersionVariant(val index: Int, val name: String, val originalId: String, val winner: Boolean)
@Serializable data class SourceVersionGroup(val sourceId: String, val variants: List<SourceVersionVariant>)
@Serializable data class SourceVersionList(val total: Int, val offset: Int, val groups: List<SourceVersionGroup>)
@Serializable data class SourceVersionLink(val sourceId: String, val bookUrl: String)
@Serializable data class SourceVersionRequest(val archive: String, val index: Int, val relink: List<SourceVersionLink> = emptyList(), val previewToken: String? = null)
@Serializable data class SourceVersionAlias(val sourceId: String, val bookUrl: String, val name: String, val conflict: Boolean)
@Serializable data class SourceVersionPreview(
    val sourceId: String, val name: String, val sourceVersion: Long?, val affectedBooks: Int,
    val affectedBookNames: List<String>, val cacheEntries: Int, val aliases: List<SourceVersionAlias>,
    val previewToken: String, val warnings: List<String>,
)
@Serializable data class SourceVersionResult(val sourceId: String, val relinked: Int, val snapshot: String)
