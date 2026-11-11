package io.legado.rules

import io.legado.model.RssArticle
import org.jsoup.Jsoup
import org.jsoup.nodes.Element
import org.jsoup.parser.Parser

/**
 * 标准 RSS/Atom feed 直解（S0/C-01，2026-11-12）：订阅源没配 `ruleArticles` 时的兜底列目。
 *
 * RSS 语义照上游 `model/rss/RssParserDefault.kt`：item 边界、title/link/pubDate，
 * 图片依次取 media:thumbnail@url / enclosure(type 含 image/)@url / description 首张 img /
 * content:encoded 首张 img；标题为空的条目不列。Atom entry 是**扩展**（上游默认解析器只认
 * RSS item）：link[rel=alternate]（缺省取第一条 link）@href、published/updated 作日期、
 * summary/content 作摘要。
 *
 * 分工：本文件只做纯抽取（Jsoup xmlParser，与 EPUB 解析同一套，无新依赖）；
 * link/image 的绝对化由调用方 `RuleRunner.rssArticles` 复用 `absolute()` 完成，与规则路径同一口径。
 *
 * 返回 null = 不是可识别的 feed（调用方继续报"没有列表规则"）；
 * 返回空表 = 是 feed 但一条条目都没有（合法状态，界面显示空而不是报错）。
 */
internal object RssFeedParser {

    private val IMG_TAG = Regex("<img\\s[^>]*>", RegexOption.IGNORE_CASE)
    private val IMG_SRC = Regex("src\\s*=\\s*[\"']([^\"']+)[\"']", RegexOption.IGNORE_CASE)

    fun parse(body: String, sourceUrl: String): List<RssArticle>? {
        val doc = try {
            Jsoup.parse(body, "", Parser.xmlParser())
        } catch (error: Exception) {
            return null
        }
        val root = doc.children().firstOrNull() ?: return null
        return when (root.tagName().lowercase()) {
            "rss" -> doc.getElementsByTag("item").mapNotNull { rssItem(it, sourceUrl) }
            "feed" -> doc.getElementsByTag("entry").mapNotNull { atomEntry(it, sourceUrl) }
            else -> null
        }
    }

    private fun rssItem(item: Element, sourceUrl: String): RssArticle? {
        val title = item.textOf("title") ?: return null
        val description = item.textOf("description")
        val content = item.textOf("content:encoded")
        val link = item.textOf("link").orEmpty()
        val summary = description ?: content
        // 与规则路径同一道门槛：链接和摘要都没有的条目，点进去必然是空白页，不如不列
        if (link.isBlank() && summary.isNullOrBlank()) return null
        val image = item.getElementsByTag("media:thumbnail").firstOrNull()
            ?.attr("url")?.takeIf { it.isNotBlank() }
            ?: item.getElementsByTag("enclosure").firstOrNull { it.attr("type").contains("image/") }
                ?.attr("url")?.takeIf { it.isNotBlank() }
            ?: firstImage(description) ?: firstImage(content)
        return RssArticle(
            origin = sourceUrl,
            title = title,
            link = link,
            pubDate = item.textOf("pubDate") ?: item.textOf("dc:date") ?: item.textOf("date"),
            description = summary,
            image = image,
        )
    }

    private fun atomEntry(entry: Element, sourceUrl: String): RssArticle? {
        val title = entry.textOf("title") ?: return null
        val links = entry.getElementsByTag("link")
        val link = (links.firstOrNull { it.attr("rel") == "alternate" } ?: links.firstOrNull())
            ?.attr("href").orEmpty().trim()
        val summary = entry.textOf("summary")
        val content = entry.textOf("content")
        val description = summary ?: content
        if (link.isBlank() && description.isNullOrBlank()) return null
        return RssArticle(
            origin = sourceUrl,
            title = title,
            link = link,
            pubDate = entry.textOf("published") ?: entry.textOf("updated"),
            description = description,
            image = firstImage(content) ?: firstImage(summary),
        )
    }

    private fun Element.textOf(tag: String): String? =
        getElementsByTag(tag).firstOrNull()?.text()?.trim()?.takeIf { it.isNotEmpty() }

    /** 从 HTML 片段里抓第一张 img 的 src（上游 getImageUrl 同语义；单双引号都认）。 */
    private fun firstImage(html: String?): String? {
        if (html.isNullOrBlank()) return null
        val tag = IMG_TAG.find(html)?.value ?: return null
        return IMG_SRC.find(tag)?.groupValues?.get(1)?.trim()?.takeIf { it.isNotEmpty() }
    }
}