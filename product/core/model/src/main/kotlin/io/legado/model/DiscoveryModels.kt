package io.legado.model

import kotlinx.serialization.Serializable

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
/**
 * 段评内容协议（S0/C-03，对齐 gedoor `detailContentRule` 的键：text/img/audio/time/likeCount/replyCount/replyToName）。
 * 规则结果按 JSON 解析；非 JSON 时整段回落 [text]。只读，不含任何写操作字段。
 */
@Serializable data class ReviewContent(
    val text: String = "",
    val img: String? = null,
    val audio: String? = null,
    val time: String? = null,
    val likeCount: Int = 0,
    val replyCount: Int = 0,
    val replyToName: String? = null,
)
/** 段评详情层的一条只读段评（统计层徽章/回复层不在第一刀范围）。 */
@Serializable data class ChapterReview(
    val id: String = "",
    val avatar: String? = null,
    val name: String? = null,
    val badge: String? = null,
    val content: ReviewContent = ReviewContent(),
)
@Serializable data class ReviewsRequest(val sourceId: String, val url: String, val page: Int = 1)
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
