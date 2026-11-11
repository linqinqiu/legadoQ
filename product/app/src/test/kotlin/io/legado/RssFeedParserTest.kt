package io.legado

import io.legado.rules.RssFeedParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 标准 RSS/Atom 直解（S0/C-01）的解析器判据。
 * RSS 语义对照上游 `model/rss/RssParserDefault.kt`（legado-with-MD3 参考克隆）：
 * item 边界、title/link/pubDate、media:thumbnail → enclosure(image/) → description 首图 →
 * content:encoded 首图的取图优先级、标题为空不列。Atom 为本项目扩展（上游默认解析器只认 RSS item）。
 * 链接/图片的绝对化不在这里判——那是 RuleRunner.rssArticles 复用 absolute() 的职责（端到端判据在 RssSubscriptionTest）。
 */
class RssFeedParserTest {

    private val rss = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>示例 feed</title>
  <item>
    <title>第一 &amp; 头条</title>
    <link>/post/1</link>
    <pubDate>Mon, 10 Nov 2026 08:00:00 GMT</pubDate>
    <description>&lt;p&gt;摘要一&lt;/p&gt;&lt;img src="/img/1.png"&gt;</description>
    <media:thumbnail url="/thumb/1.jpg"/>
  </item>
  <item>
    <title>第二</title>
    <link>https://other.example/post/2</link>
    <enclosure url="/enc/2.jpg" type="image/jpeg" length="123"/>
    <description>纯文本摘要</description>
  </item>
  <item>
    <title>第三</title>
    <link>/post/3</link>
    <content:encoded><![CDATA[<p>全文</p><img src='/img/3.png'>]]></content:encoded>
  </item>
  <item><title>   </title><link>/post/4</link></item>
  <item><link>/post/5</link><description>没有标题</description></item>
</channel></rss>"""

    @Test
    fun `RSS 条目按上游优先级取图，实体解码，空标题不列`() {
        val items = RssFeedParser.parse(rss, "https://feed.example")!!
        assertEquals(3, items.size)
        assertEquals("第一 & 头条", items[0].title)
        assertEquals("/post/1", items[0].link)
        assertEquals("Mon, 10 Nov 2026 08:00:00 GMT", items[0].pubDate)
        // media:thumbnail 优先于 description 里的 img
        assertEquals("/thumb/1.jpg", items[0].image)
        // enclosure 的 type 含 image/ 才取
        assertEquals("/enc/2.jpg", items[1].image)
        // 无 description 时 content:encoded 顶摘要，单引号 img 也认
        assertTrue(items[2].description!!.contains("全文"))
        assertEquals("/img/3.png", items[2].image)
        // 空标题 / 无标题 / 无链接无摘要的都不列
        assertTrue(items.none { it.link == "/post/4" || it.link == "/post/5" })
        assertEquals("https://feed.example", items[0].origin)
    }

    @Test
    fun `description 首图兜底：没有 thumbnail 也没有 enclosure`() {
        val feed = """<rss version="2.0"><channel><item>
            <title>兜底</title><link>/p</link>
            <description>&lt;img src="/only/img.png"&gt;文字</description>
        </item></channel></rss>"""
        val items = RssFeedParser.parse(feed, "https://feed.example")!!
        assertEquals("/only/img.png", items.single().image)
    }

    @Test
    fun `Atom 取 alternate 链接与 published，缺省回落第一条 link 与 updated`() {
        val atom = """<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom feed</title>
  <entry>
    <title>条目一</title>
    <link rel="self" href="/self/1"/>
    <link rel="alternate" href="/post/1"/>
    <published>2026-11-10T08:00:00Z</published>
    <summary>摘要</summary>
  </entry>
  <entry>
    <title>条目二</title>
    <link href="/post/2"/>
    <updated>2026-11-09T08:00:00Z</updated>
    <content type="html">&lt;img src="/img/2.png"&gt;正文</content>
  </entry>
</feed>"""
        val items = RssFeedParser.parse(atom, "https://atom.example")!!
        assertEquals(2, items.size)
        assertEquals("/post/1", items[0].link)
        assertEquals("2026-11-10T08:00:00Z", items[0].pubDate)
        assertEquals("摘要", items[0].description)
        assertEquals("/post/2", items[1].link)
        assertEquals("2026-11-09T08:00:00Z", items[1].pubDate)
        assertEquals("/img/2.png", items[1].image)
    }

    @Test
    fun `不是 feed 的返回 null，让调用方继续报没有列表规则`() {
        assertNull(RssFeedParser.parse("<html><body><p>你好</p></body></html>", "https://x.example"))
        assertNull(RssFeedParser.parse("纯文本，不是 XML", "https://x.example"))
        assertNull(RssFeedParser.parse("", "https://x.example"))
    }

    @Test
    fun `空 channel 是合法 feed：返回空表而不是 null`() {
        val items = RssFeedParser.parse(
            """<rss version="2.0"><channel><title>空栏目</title></channel></rss>""",
            "https://x.example",
        )
        assertNotNull(items)
        assertTrue(items!!.isEmpty())
    }
}