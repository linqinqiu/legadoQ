package io.legado.model

import kotlinx.serialization.Serializable

@Serializable data class ApiError(val code: String, val message: String)

/**
 * 探活兼报版本：界面右上角显示的版本号就来自这里，保证"跑着的 == 构建的 == 界面说的"。
 *
 * `ui` 与 `startedAtMs` 是给"改了看不到"这类部署漂移准备的自证字段：版本号相同但包是旧的时，
 * 光看 `version` 分不出来，而 bundle 文件名带内容哈希、启动时刻只会随重启变。
 * 两者都带默认值 —— 序列化不写默认值，所以老客户端看到的形状与从前一致。
 */
@Serializable
data class HealthStatus(
    val title: String,
    val version: String,
    val status: String,
    val ui: String = "",
    val startedAtMs: Long = 0L,
)

@Serializable data class SourceSummary(
    val id: String,
    val name: String,
    val url: String,
    val group: String? = null,
    val enabled: Boolean,
    val isJsSource: Boolean,
    val hasLogin: Boolean = false,
    val updatedAt: Long,
    val version: Long,
    /** 自定义排序位（1 起）；null = 没拖过，按名称排在有序段之后。 */
    val sortOrder: Int? = null,
)

@Serializable
data class FlexChildStyle(
    val layout_flexGrow: Float = 0f,
    val layout_flexShrink: Float = 1f,
    val layout_alignSelf: String = "auto",
    val layout_flexBasisPercent: Float = -1f,
    val layout_wrapBefore: Boolean = false,
    val layout_justifySelf: String = "auto",
)

@Serializable
data class SourceLoginUiItem(
    val name: String = "",
    val type: String = "text",
    val action: String? = null,
    val chars: List<String?>? = null,
    val default: String? = null,
    val viewName: String? = null,
    val style: FlexChildStyle? = null,
    val key: String? = null,
    val hint: String? = null,
    val value: String? = null,
    val options: List<String>? = null,
    val countdown: Int? = null,
)

@Serializable
data class SourceLoginUiResponse(
    val sourceId: String,
    val sourceName: String,
    val hasLogin: Boolean,
    val loginUi: List<SourceLoginUiItem>,
    val loginUrl: String? = null,
    val loginInfo: Map<String, String> = emptyMap(),
    val loginHeader: String? = null,
    val sourceVariable: String? = null,
    /** `loginUrl` 不是网址而是整段登录 JS（聚合源普遍如此），界面要按这个改文案与动作。 */
    val loginIsScript: Boolean = false,
    /**
     * 这本书源有没有「能替你打开」的登录入口：网址型 / 相对路径型 `loginUrl`，
     * 或 `loginUrl`、`jsLib` 里那套 `login()` + `java.startBrowserAwait`。
     * 界面据此决定「保存并登录」是开真浏览器，还是只保存输入。
     */
    val loginCanOpenBrowser: Boolean = false,
    /** 这份书源实际会带凭据去访问的域名，登录页那个排最前（粘贴 Cookie 要能选对地方）。 */
    val cookieDomains: List<String> = emptyList(),
)

@Serializable
data class SourceLoginInfoUpdateRequest(
    val loginInfo: Map<String, String> = emptyMap(),
    val loginHeader: String? = null,
    val sourceVariable: String? = null,
)

@Serializable
data class SourceLoginActionRequest(
    val action: String,
    val loginData: Map<String, String> = emptyMap(),
    val isLongClick: Boolean = false,
    /** 内置浏览器那一轮已经关掉：让 startBrowserAwait 改为服务端自己抓页面 */
    val browserCompleted: Boolean = false,
)

/** 删掉某个域名下的 Cookie 后，把剩下的罐子概况一起回给界面，省一次往返。 */
@Serializable
data class SourceCookieRemoveResponse(
    val ok: Boolean,
    val removed: Boolean,
    val count: Int,
    val domains: List<String> = emptyList(),
)

@Serializable
data class SourceLoginActionResult(
    val success: Boolean,
    val toastMessages: List<String> = emptyList(),
    val openUrl: String? = null,
    val copyText: String? = null,
    val updatedLoginInfo: Map<String, String>? = null,
    val updatedLoginHeader: String? = null,
    val updatedVariable: String? = null,
    val reRenderUi: Boolean = false,
    val error: String? = null,
)

@Serializable
data class SourceLoginCheckResult(
    val loggedIn: Boolean,
    val message: String? = null,
    /** 是否已捕获到任意凭据（Cookie / 登录头 / 登录信息）。有凭据 ≠ 已登录。 */
    val hasCredential: Boolean = false,
    /** 是否经书源 loginCheckJs 主动验证通过。无 loginCheckJs 时恒为 false（无法验证）。 */
    val verified: Boolean = false,
)

@Serializable
data class SourceLoginHeaderUpdateRequest(
    val loginHeader: String?,
)

@Serializable
data class SourceLoginCookieUpdateRequest(
    val cookie: String,
    val url: String? = null,
)

@Serializable
data class SourceLoginCookieResponse(
    val ok: Boolean,
    val message: String? = null,
    val count: Int = 0,
)

@Serializable
data class SourceBrowserSessionResponse(
    val token: String,
    val startUrl: String,
    val expiresInSeconds: Int,
    /** true 表示入口是书源脚本生成的内置页面，由服务端托管，startUrl 为空 */
    val inlineOnly: Boolean = false,
)

@Serializable
data class SourceBrowserSessionRequest(
    val url: String? = null,
)

@Serializable
data class SourceBrowserInlineRequest(
    val token: String,
    val url: String,
)

@Serializable
data class SourceBrowserInlineResponse(
    val key: String,
)

@Serializable
data class SourceBrowserCookieResponse(
    val count: Int,
    val domains: List<String>,
    val cookies: Map<String, String>,
)

/** 全局凭据表里的一桶：注册域 + 它上面的 Cookie 键名（不含值，值不进列表接口）。 */
data class CookieBucket(
    val domain: String,
    val keys: List<String>,
)

@Serializable
data class GlobalCookieEntry(
    val domain: String,
    val keys: List<String>,
    /** 有多少本书源的配置里**写到过**这个域（粗筛，不等于"会访问"）。 */
    val mentionedBy: Int,
)

@Serializable
data class GlobalCookieListResponse(
    val count: Int,
    val cookies: List<GlobalCookieEntry>,
)

/**
 * 某个地址所属注册域上**有没有**凭据 —— 发现页拿它把"这一栏要登录"和"站点真的返回空"分开。
 * 只回答有/无：上游没有任何"是否已登录"的判定机制（`loginCheckJs` 只是响应改写器），
 * 所以这里也不能说得比"有凭据/没凭据"更肯定。
 */
@Serializable
data class SourceCredentialStatus(
    val domain: String,
    val has: Boolean,
)

/** 「重取这一张」的成功回执：新落盘的键与类型。前端拿到后把图片地址上的代次换掉，浏览器才会真去重新请求。 */
@Serializable
data class RefreshedImage(
    val key: String,
    val contentType: String,
)

@Serializable
data class ExternalLoginStatus(
    /** 我们拉起来的那个真浏览器还在不在。 */
    val opened: Boolean,
    val browser: String = "",
    val port: Int = 0,
    val pid: Long = 0,
    /** 这本书源会带凭据去访问的域（按登录优先级排序）。 */
    val hosts: List<String> = emptyList(),
    /** 浏览器里**已经出现**这些域的 Cookie —— 也就是"登录已经发生过"的事实依据。 */
    val seen: List<String> = emptyList(),
    /** 本轮真正写进凭据表的域。 */
    val stored: List<String> = emptyList(),
    /** 该书源当前能带出去的凭据桶数量。 */
    val count: Int = 0,
)

data class SourceLoginStateRecord(
    val sourceId: String,
    val loginInfo: Map<String, String>,
    val loginHeader: String?,
    val sourceVariable: String?,
    val sourceKv: Map<String, String>,
    val cookieJar: Map<String, String>,
    val updatedAt: Long,
)

@Serializable data class SourceRecord(
    val id: String,
    val json: String,
    val version: Long,
    val updatedAt: Long,
)

@Serializable data class SourceWriteRequest(val json: String, val version: Long? = null)
@Serializable data class SourceValidateRequest(val json: String? = null)
@Serializable data class ImportRequest(val sources: List<String>, val overwrite: Boolean = true)
@Serializable data class ImportResponse(val imported: Int, val updated: Int = 0, val skipped: Int, val errors: List<String>)
@Serializable data class SubscriptionWriteRequest(val url: String, val enabled: Boolean = true)
@Serializable data class SourceSubscription(
    val id: Long,
    val url: String,
    val enabled: Boolean,
    val createdAt: Long,
    val updatedAt: Long,
    val lastSuccessAt: Long? = null,
    val lastAttemptAt: Long? = null,
    val lastError: String? = null,
    val lastImported: Int = 0,
    val contentHash: String? = null,
)
@Serializable data class ValidateResponse(val valid: Boolean, val errors: List<String>, val warnings: List<String>)
@Serializable data class DebugRequest(val keyword: String = "测试")
@Serializable data class SearchRequest(val keyword: String, val sourceIds: List<String>? = null)
@Serializable data class ExploreTab(val title: String, val url: String, val supportsPaging: Boolean = true)
@Serializable data class ExploreRequest(val sourceId: String, val url: String, val page: Int = 1)

/**
 * RSS 订阅源（手机「订阅」页那些源），字段名以上游 `data/entities/RssSource.kt` 为准：
 * 名称是 `sourceName` 而不是书源的 `bookSourceName`，主键是 `sourceUrl`。
 */
@Serializable data class RssSourceSummary(
    val sourceUrl: String,
    val name: String,
    val group: String? = null,
    val icon: String? = null,
    val enabled: Boolean,
    /** `ruleArticles` 有没有配：没配的源服务端解析不了，界面要能说清楚而不是报错。 */
    val hasListRule: Boolean,
    val updatedAt: Long,
)
@Serializable data class RssArticle(
    val origin: String,
    val title: String,
    val link: String = "",
    val pubDate: String? = null,
    val description: String? = null,
    val image: String? = null,
)
@Serializable data class RssArticlesRequest(val sourceUrl: String, val url: String, val page: Int = 1)
@Serializable data class RssContentRequest(val sourceUrl: String, val link: String)
@Serializable data class RssSourceEnabledRequest(val sourceUrl: String, val enabled: Boolean)
@Serializable data class SearchStreamEvent(
    val type: String,
    val totalSources: Int = 0,
    val completedSources: Int = 0,
    val matchedSources: Int = 0,
    val emptySources: Int = 0,
    val failedSources: Int = 0,
    val resultCount: Int = 0,
    val results: List<SearchResult> = emptyList(),
    val message: String? = null,
)
@Serializable data class SearchResult(
    val sourceId: String,
    val name: String,
    val author: String? = null,
    val bookUrl: String,
    val coverUrl: String? = null,
    val intro: String? = null,
    val kind: String? = null,
    val wordCount: String? = null,
    val lastChapter: String? = null,
    /** 书源的 `bookSourceType`：0 文本 / 1 音频 / 2 图片(漫画) / 3 文件 / 4 视频。 */
    val sourceType: Int = 0,
)
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
@Serializable data class ContentRequest(val sourceId: String, val chapterUrl: String = "", val bookUrl: String? = null)
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
     * 逻辑位置模型（P1-T1）：章节内绝对字符偏移（0 基）。
     * 取代 `scrollPosition` 成为阅读恢复的唯一真相；改字号/翻页后据此二分定位当前位置。
     * 老客户端不报此字段时为 0，不影响旧流程。
     */
    val charOffset: Int = 0,
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
 * 回「哪一章 + 命中处前后截一段」。只覆盖已离线缓存的章节（没缓存的搜不到）。
 */
@Serializable data class BookSearchHit(
    val chapterUrl: String,
    val chapterIndex: Int,
    val title: String,
    val snippet: String,
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
    /** 自定义排序位（1 起）；null = 这本书没参与过自定义排序，界面上排在有序段之后、按最后阅读排。 */
    val sortOrder: Int? = null,
    /** 书源的 `bookSourceType`：0 文本 / 1 音频 / 2 图片(漫画) / 3 文件 / 4 视频。 */
    val sourceType: Int = 0,
)

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
@Serializable data class BookIdentifier(val sourceId: String, val bookUrl: String)
/** 自定义排序：整段可见清单按新顺序回传，服务端按位置写 `book_shelf.sort_order`。 */
@Serializable data class ShelfOrderRequest(val books: List<BookIdentifier>)
@Serializable data class ShelfOrderResult(val updated: Int)
/** 书源自定义排序：屏幕上这一列按新顺序回传，服务端按位置写 `source.sort_order`。 */
@Serializable data class SourceOrderRequest(val ids: List<String>)

/** 「关于」页顶部那三样：名字、版本、发布仓库。版本只有一个来源（清单），界面不许写死。 */
@Serializable data class AboutInfo(val title: String, val version: String, val repository: String)

/**
 * 服务自身：当前绑在哪、界面里那个「服务端口」现在显示什么。
 * `port` 是**这次运行**实际用的端口 —— 改了 port.txt 也不会变，要重启才生效。
 */
@Serializable data class ServerInfo(val host: String, val port: Int)

/** 界面里改端口：只写安装根的 `port.txt`，不碰正在跑的这个进程。 */
@Serializable data class ServerPortRequest(val port: Int)

@Serializable data class ServerPortResult(val port: Int, val restartRequired: Boolean)

/**
 * 「关于 → 检查更新」的结果。`status`：`latest` / `available` / `not_found` / `unreachable` / `not_configured`。
 *
 * `latest` 那一组是**版本号发布**（标签形如 `v0.6.26`），拿来判"有没有更新"；
 * `rolling*` 那一组是 CI 的**滚动构建**（标签不是版本号，如 `latest`），只报发布时间与链接、不判新旧。
 */
@Serializable data class UpdateCheckResult(
    val current: String,
    val latest: String? = null,
    val url: String? = null,
    val publishedAt: String? = null,
    val repository: String,
    val status: String,
    val message: String? = null,
    val rollingTag: String? = null,
    val rollingUrl: String? = null,
    val rollingPublishedAt: String? = null,
)

@Serializable
data class TtsVoice(
    val id: String,
    val name: String,
    val lang: String,
    val gender: String,
    val localeName: String,
    val engine: String = "edge",
    val description: String? = null,
)

@Serializable
data class TtsSpeakRequest(
    val text: String,
    val voice: String = "zh-CN-XiaoxiaoNeural",
    val rate: Int = 0,
    val pitch: Int = 0,
    val engine: String = "edge",
    val customUrl: String? = null,
    val customHeader: String? = null,
    val customMethod: String? = null,
    val customBody: String? = null,
)

@Serializable
data class TtsSessionInfo(
    val sessionId: String,
    val audioUrl: String,
    val eventsUrl: String,
)

@Serializable
data class TtsSessionChunkRequest(
    val chunkId: String,
    val text: String,
    val chapterIndex: Int = -1,
    val paragraphIndex: Int = -1,
    val engine: String = "edge",
    val voice: String = "zh-CN-XiaoxiaoNeural",
    val rate: Int = 0,
    val pitch: Int = 0,
    val customUrl: String? = null,
    val customHeader: String? = null,
    val customMethod: String? = null,
    val customBody: String? = null,
)

@Serializable
data class TtsSessionControlRequest(
    val action: String,
)

@Serializable
data class TtsSessionAck(
    val accepted: Boolean,
)

@Serializable
data class TtsSessionEvent(
    val type: String,
    val sessionId: String,
    val chunkId: String? = null,
    val chapterIndex: Int = -1,
    val paragraphIndex: Int = -1,
    val audioEndMs: Long? = null,
    val durationMs: Long? = null,
    val message: String? = null,
)

@Serializable
data class ReplaceRule(
    val id: String = "",
    val name: String = "",
    val group: String? = null,
    val pattern: String = "",
    val replacement: String = "",
    val isRegex: Boolean = true,
    val scope: String? = null,
    val excludeScope: String? = null,
    val scopeTitle: Boolean = false,
    val scopeContent: Boolean = true,
    val isEnabled: Boolean = true,
    val order: Int = 0,
    val timeoutMillisecond: Long = 3000L,
    val createdAt: Long = 0L,
    val updatedAt: Long = 0L,
)

@Serializable
data class ReplaceRuleToggleRequest(
    val ids: List<String>,
    val enabled: Boolean,
)

@Serializable
data class ReplaceRuleImportRequest(
    val rules: List<ReplaceRule>? = null,
    val url: String? = null,
)

@Serializable
data class ReplaceRuleImportResponse(
    val imported: Int,
    val updated: Int,
    val skipped: Int,
    val total: Int,
)

@Serializable
data class ReplaceRulePreviewRequest(
    val text: String,
    val rule: ReplaceRule? = null,
    val bookName: String? = null,
    val sourceUrl: String? = null,
)

@Serializable
data class ReplaceRulePreviewResponse(
    val originalText: String,
    val cleanedText: String,
    val changed: Boolean,
    val appliedRules: List<String> = emptyList(),
)

@Serializable
data class BatchSourceRequest(
    val action: String, // "enable", "disable", "delete", "set_group"
    val ids: List<String>,
    val group: String? = null,
)

@Serializable
data class BatchSourceResponse(
    val ok: Boolean,
    val affected: Int,
    val action: String,
    val message: String? = null,
)

@Serializable
data class SourceHealthCheckRequest(
    val ids: List<String>? = null,
    val timeoutMs: Long = 5000L,
    /** 体检用的搜索关键词；书源自带 checkKeyWord 时优先用源自己的。 */
    val keyword: String? = null,
)

@Serializable
data class SourceHealthCheckItem(
    val id: String,
    val name: String,
    val ok: Boolean,
    val latencyMs: Long,
    val statusCode: Int = 0,
    /** valid · slow · empty · blocked · needs_login · needs_webview · unreachable · tls · broken · invalid */
    val statusCategory: String,
    val error: String? = null,
)

@Serializable
data class SourceHealthCheckResponse(
    val total: Int,
    val successCount: Int,
    val slowCount: Int,
    val failedCount: Int,
    val durationMs: Long,
    val results: List<SourceHealthCheckItem>,
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
    val readAt: Long,
    /** 手机那侧的分组号（`Book.groupId`）。落库前要经 `importBookGroups` 的映射换成本机号。 */
    val phoneGroupId: Long = 0,
    /** 映射后的本机组号，0 = 未分组。 */
    val groupId: Long = 0,
)

/** 书架与阅读进度导入统计。 */
data class LibraryImportResult(val imported: Int, val updated: Int, val progress: Int)


/** 本地图书导入返回条目 */
@Serializable
data class LocalBookImportItem(
    val filename: String,
    val success: Boolean,
    val bookUrl: String? = null,
    val name: String? = null,
    val author: String? = null,
    val totalChapters: Int = 0,
    val error: String? = null,
)

/** 本地图书导入批量响应 */
@Serializable
data class LocalBookImportResponse(
    val total: Int,
    val imported: Int,
    val failed: Int,
    val results: List<LocalBookImportItem> = emptyList(),
)


