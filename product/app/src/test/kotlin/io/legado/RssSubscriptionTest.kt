package io.legado

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import io.legado.rules.RuleExecutionException
import io.legado.rules.RuleRunner
import io.legado.source.SourceCodec

/**
 * RSS 订阅引擎：字段映射与栏目解析按上游 `model/rss/RssParserByRule.kt` 与
 * `help/source/RssSourceExtensions.kt` 对齐。抓取用 `responseFetcher` 替身，不打真网络
 * （SSRF 校验在 `fetchUrl` 里，与书源同一条路径，由 NetworkSecurityTest 覆盖）。
 */
class RssSubscriptionTest {
    private val listBody = """
        <html><body>
          <div class="card"><a href="/post/1">第一帖</a><span class="date">2026-09-28</span><img src="/img/1.png"><p class="desc">第一条的摘要</p></div>
          <div class="card"><a href="/post/2">第二帖</a><span class="date">2026-09-27</span></div>
          <div class="card"><strong>没有链接也没有摘要的卡片</strong></div>
          <div class="card"><a href="/post/4"> </a></div>
        </body></html>
    """.trimIndent()

    private fun probe(fields: String) = """{"sourceUrl":"https://rss-engine.example","sourceName":"引擎探针",$fields}"""

    @Test
    fun `maps rss list rules onto articles and drops unusable rows`() {
        val runner = RuleRunner { listBody }

        val articles = runner.rssArticles(
            probe(
                "\"ruleArticles\":\"div.card\",\"ruleTitle\":\"a@text\",\"ruleLink\":\"a@href\"," +
                    "\"rulePubDate\":\"span.date@text\",\"ruleImage\":\"img@src\",\"ruleDescription\":\"p.desc@text\""
            ),
            "https://rss-engine.example/feed",
        )

        // 第三张卡片取不到链接也取不到摘要、第四张标题是空白 → 都不该进列表
        assertEquals(2, articles.size)
        val first = articles.first()
        assertEquals("第一帖", first.title)
        assertEquals("2026-09-28", first.pubDate)
        assertEquals("第一条的摘要", first.description)
        // 链接按栏目页归一，图片按上游第 125 行用 sourceUrl 归一
        assertEquals("https://rss-engine.example/post/1", first.link)
        assertEquals("https://rss-engine.example/img/1.png", first.image)
        assertEquals("https://rss-engine.example", first.origin)
        assertEquals("第二帖", articles[1].title)
        assertNull(articles[1].description)
    }

    @Test
    fun `leading minus on ruleArticles reverses the list like upstream`() {
        val runner = RuleRunner { listBody }

        val articles = runner.rssArticles(
            probe("\"ruleArticles\":\"-.card\",\"ruleTitle\":\"a@text\",\"ruleLink\":\"a@href\""),
            "https://rss-engine.example/feed",
        )

        assertEquals(listOf("第二帖", "第一帖"), articles.map { it.title })
    }

    @Test
    fun `a source without ruleArticles and with a non-feed body says so instead of returning an empty list`() {
        // S0/C-01 后：无规则先试标准 RSS/Atom 直解；listBody 是 HTML 不是 feed，所以仍要报错说清。
        val runner = RuleRunner { listBody }

        val error = runCatching {
            runner.rssArticles(probe("\"ruleTitle\":\"a@text\""), "https://rss-engine.example/feed")
        }.exceptionOrNull()

        assertTrue(error is RuleExecutionException)
        assertTrue(error?.message?.contains("ruleArticles") == true)
    }

    @Test
    fun `standard RSS feed without ruleArticles lists items directly (S0 C-01)`() {
        val feed = """<?xml version="1.0"?><rss version="2.0"><channel>
            <item><title>订阅帖</title><link>/post/9</link><pubDate>2026-11-10</pubDate>
            <description>&lt;img src="/img/9.png"&gt;摘要</description></item>
        </channel></rss>"""
        val runner = RuleRunner { feed }

        val articles = runner.rssArticles(probe("\"enabled\":true"), "https://rss-engine.example/feed")

        assertEquals(1, articles.size)
        assertEquals("订阅帖", articles[0].title)
        // 链接按栏目页归一、图片按 sourceUrl 归一——与规则路径同一口径
        assertEquals("https://rss-engine.example/post/9", articles[0].link)
        assertEquals("https://rss-engine.example/img/9.png", articles[0].image)
        assertEquals("2026-11-10", articles[0].pubDate)
        assertEquals("https://rss-engine.example", articles[0].origin)
    }

    @Test
    fun `Atom feed without ruleArticles lists entries (S0 C-01 extension)`() {
        val feed = """<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
            <entry><title>Atom 帖</title><link rel="alternate" href="/post/a"/>
            <published>2026-11-11T00:00:00Z</published><summary>摘要</summary></entry>
        </feed>"""
        val runner = RuleRunner { feed }

        val articles = runner.rssArticles(probe("\"enabled\":true"), "https://rss-engine.example/feed")

        assertEquals(1, articles.size)
        assertEquals("Atom 帖", articles[0].title)
        assertEquals("https://rss-engine.example/post/a", articles[0].link)
        assertEquals("2026-11-11T00:00:00Z", articles[0].pubDate)
    }

    @Test
    fun `empty feed channel returns an empty list instead of an error`() {
        val runner = RuleRunner { """<rss version="2.0"><channel><title>空栏目</title></channel></rss>""" }

        val articles = runner.rssArticles(probe("\"enabled\":true"), "https://rss-engine.example/feed")

        assertTrue(articles.isEmpty())
    }

    @Test
    fun `sort url tabs parse the same dialect as explore url and fall back to the source url`() {
        val runner = RuleRunner { listBody }

        val plain = runner.rssTabs(
            probe("\"sortUrl\":\"国内::https://rss-engine.example/cn&#国际::https://rss-engine.example/intl\"")
        )
        assertEquals(listOf("国内", "国际"), plain.map { it.title })
        assertEquals("https://rss-engine.example/intl", plain[1].url)

        // 没配 sortUrl 的源：上游直接拿 sourceUrl 当唯一栏目页，界面因此不会出现空页签条
        val fallback = runner.rssTabs(probe("\"ruleArticles\":\"div.card\""))
        assertEquals(1, fallback.size)
        assertEquals("引擎探针", fallback.single().title)
        assertEquals("https://rss-engine.example", fallback.single().url)
    }

    @Test
    fun `rss content reads the flat ruleContent string`() {
        val runner = RuleRunner { """<html><body><div id="art"><p>甲段</p><p>乙段</p></div><script>var x=1</script></body></html>""" }

        val content = runner.rssContent(probe("\"ruleContent\":\"#art@html\""), "https://rss-engine.example/post/1")

        assertEquals("甲段\n\n乙段", content.content)
    }

    @Test
    fun `rss content without ruleContent tells the caller to open the original page`() {
        val runner = RuleRunner { "<html><body><p>anything</p></body></html>" }

        val error = runCatching {
            runner.rssContent(probe("\"ruleArticles\":\"div.card\""), "https://rss-engine.example/post/1")
        }.exceptionOrNull()

        assertTrue(error is RuleExecutionException)
        assertTrue(error?.message?.contains("ruleContent") == true)
    }

    @Test
    fun `parsing an rss source keeps rss field names and rejects a missing primary key`() {
        val parsed = SourceCodec.parseRss(
            """{"sourceUrl":"//rss-case.example/feed","sourceName":"协议省略探针","sourceGroup":"资讯","enabled":0,"ruleArticles":"div.card"}"""
        )

        assertEquals("https://rss-case.example/feed", parsed.sourceUrl)
        assertEquals("协议省略探针", parsed.name)
        assertEquals("资讯", parsed.group)
        // `enabled` 写成 0/1 的老备份也要认，缺省才算启用
        assertTrue(!parsed.enabled)
        assertTrue(parsed.hasListRule)
        assertTrue(!SourceCodec.parseRss("""{"sourceUrl":"https://x.example","sourceName":"没有列表规则的源"}""").hasListRule)

        assertEquals(
            "缺少 sourceUrl",
            runCatching { SourceCodec.parseRss("""{"sourceName":"缺主键"}""") }.exceptionOrNull()?.message,
        )
    }
}
