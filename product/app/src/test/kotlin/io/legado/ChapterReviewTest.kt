package io.legado

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import io.legado.rules.RuleExecutionException
import io.legado.rules.RuleRunner

/**
 * 段评详情层只读引擎（S0/C-03 第一刀）。语义对齐原版 gedoor 详情层：
 * detailListRule 取列表、逐项 id/avatar/name/badge/content，detailContentRule 是内容协议。
 * 抓取用 `RuleRunner { body }` 替身，不打真网络（SSRF 校验在 fetchUrl，由 NetworkSecurityTest 覆盖）。
 * 设计见 docs/research/研究-C03-段评只读设计-2026-11-12.md。
 */
class ChapterReviewTest {
    private fun probe(reviewFields: String) =
        """{"bookSourceUrl":"https://review-engine.example","bookSourceName":"段评探针","ruleReview":{$reviewFields}}"""

    private val plainRules =
        "\"detailListRule\":\"div.rv\",\"detailIdRule\":\"span.id@text\",\"detailAvatarRule\":\"img.av@src\"," +
            "\"detailNameRule\":\"span.nm@text\",\"detailContentRule\":\"p.ct@text\""

    @Test
    fun `maps detail rules onto reviews, drops blank content and normalizes avatar`() {
        val body = """
            <html><body>
              <div class="rv"><span class="id">r1</span><img class="av" src="/a/1.png"><span class="nm">甲</span><p class="ct">第一条段评</p></div>
              <div class="rv"><span class="id">r2</span><span class="nm">乙</span><p class="ct">第二条段评</p></div>
              <div class="rv"><span class="id">r3</span><span class="nm">丙</span><p class="ct">   </p></div>
            </body></html>
        """.trimIndent()
        val reviews = RuleRunner { body }.reviews(probe(plainRules), "https://review-engine.example/chapter/1/reviews")

        // 第三条 content 全空白 → 丢掉
        assertEquals(2, reviews.size)
        val first = reviews.first()
        assertEquals("r1", first.id)
        assertEquals("甲", first.name)
        assertEquals("第一条段评", first.content.text)
        // 头像按页地址归一
        assertEquals("https://review-engine.example/a/1.png", first.avatar)
        // 第二条没头像 → null，纯文本内容回落
        assertNull(reviews[1].avatar)
        assertEquals("第二条段评", reviews[1].content.text)
    }

    @Test
    fun `detailContentRule JSON protocol parses text time likeCount replyCount img`() {
        val body = """
            <html><body>
              <div class="rv"><span class="id">r1</span><span class="nm">甲</span><span class="payload">{"text":"协议好评","time":"2026-11-12","likeCount":3,"replyCount":1,"img":"/p/1.png"}</span></div>
            </body></html>
        """.trimIndent()
        val rules = "\"detailListRule\":\"div.rv\",\"detailIdRule\":\"span.id@text\",\"detailNameRule\":\"span.nm@text\",\"detailContentRule\":\"span.payload@text\""
        val review = RuleRunner { body }.reviews(probe(rules), "https://review-engine.example/reviews").single()

        assertEquals("协议好评", review.content.text)
        assertEquals("2026-11-12", review.content.time)
        assertEquals(3, review.content.likeCount)
        assertEquals(1, review.content.replyCount)
        assertEquals("/p/1.png", review.content.img)
    }

    @Test
    fun `non-JSON content falls back to plain text`() {
        val body = """
            <html><body>
              <div class="rv"><span class="id">r1</span><span class="payload">{这不是合法JSON</span></div>
            </body></html>
        """.trimIndent()
        val rules = "\"detailListRule\":\"div.rv\",\"detailContentRule\":\"span.payload@text\""
        val review = RuleRunner { body }.reviews(probe(rules), "https://review-engine.example/reviews").single()
        assertEquals("{这不是合法JSON", review.content.text)
        assertEquals(0, review.content.likeCount)
    }

    @Test
    fun `image-only review is kept even when text is blank`() {
        val body = """
            <html><body>
              <div class="rv"><span class="id">r1</span><span class="payload">{"img":"/p/2.png"}</span></div>
            </body></html>
        """.trimIndent()
        val rules = "\"detailListRule\":\"div.rv\",\"detailContentRule\":\"span.payload@text\""
        val review = RuleRunner { body }.reviews(probe(rules), "https://review-engine.example/reviews").single()
        assertEquals("", review.content.text)
        assertEquals("/p/2.png", review.content.img)
    }

    @Test
    fun `leading minus on detailListRule reverses the list`() {
        val body = """
            <html><body>
              <div class="rv"><span class="id">r1</span><p class="ct">一</p></div>
              <div class="rv"><span class="id">r2</span><p class="ct">二</p></div>
            </body></html>
        """.trimIndent()
        val rules = "\"detailListRule\":\"-div.rv\",\"detailIdRule\":\"span.id@text\",\"detailContentRule\":\"p.ct@text\""
        val reviews = RuleRunner { body }.reviews(probe(rules), "https://review-engine.example/reviews")
        assertEquals("r2", reviews.first().id)
        assertEquals("r1", reviews[1].id)
    }

    @Test
    fun `missing detailListRule says so instead of returning an empty list`() {
        val runner = RuleRunner { "<html><body></body></html>" }
        val error = runCatching {
            runner.reviews(probe("\"reviewDetailUrl\":\"https://review-engine.example/reviews\""), "https://review-engine.example/reviews")
        }.exceptionOrNull()
        assertTrue(error is RuleExecutionException)
        assertTrue(error?.message?.contains("detailListRule") == true)
    }

    @Test
    fun `source without ruleReview says it cannot parse reviews`() {
        val runner = RuleRunner { "<html><body></body></html>" }
        val error = runCatching {
            runner.reviews("""{"bookSourceUrl":"https://review-engine.example"}""", "https://review-engine.example/reviews")
        }.exceptionOrNull()
        assertTrue(error is RuleExecutionException)
        assertTrue(error?.message?.contains("detailListRule") == true)
    }
}