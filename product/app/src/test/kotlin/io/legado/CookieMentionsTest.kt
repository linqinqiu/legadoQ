package io.legado

import io.legado.data.Database
import io.legado.data.batchUpdateSources
import io.legado.data.cookieBucketMentions
import io.legado.data.cookieBucketMentionsNow
import io.legado.data.deleteSource
import io.legado.data.saveSource
import io.legado.source.SourceCodec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Test
import java.nio.file.Files

/**
 * 凭据管理里「N 个书源提到」这句提示的统计与缓存。
 *
 * 为什么要缓存：一次全量统计要扫 5,598 本书源、24 MB payload，实测 0.6~1 秒（冷启动更久）；
 * 每次打开凭据管理都现算，界面就卡在那里。缓存策略是「旧值先发、后台重算」，
 * 这里盯三件事：数得对、没写入时复用不重扫、写入后旧值不阻塞且重算能得到新数
 * （含删一本换一本等长地址的情况）。落盘与重启复用见 [CookieMentionsPersistenceTest]。
 */
class CookieMentionsTest {

    private fun tempDatabase() =
        Database(Files.createTempFile("legado-cookie-mentions", ".sqlite").toString()).also { it.initialize() }

    private fun sourceJson(url: String, extra: String = "") =
        """{"bookSourceUrl":"$url","ruleToc":{"chapterList":"$.data","chapterName":"$.title","chapterUrl":"$.url"},"ruleContent":{"content":"$.content"}$extra}"""

    @Test
    fun `按注册域累加，同一本书源里的子域只算一次`() {
        val db = tempDatabase()
        try {
            // 同一本书源里 www 与 m 子域都指向 a.example：归到同一个桶，且只计一次。
            db.saveSource(
                SourceCodec.parse(sourceJson("https://www.a.example", ""","ruleSearch":{"bookList":"https://m.a.example/list"}""")),
                null,
            )
            // 第二本书源也访问 a.example（CDN），再顺带访问 b.example。
            db.saveSource(
                SourceCodec.parse(sourceJson("https://b.example", ""","ruleExplore":{"bookList":"https://cdn.a.example/x"}""")),
                null,
            )

            val counts = db.cookieBucketMentions()
            assertEquals("两本书源都用到 a.example", 2, counts["a.example"])
            assertEquals(1, counts["b.example"])
            assertEquals("子域不该单独成桶", null, counts["m.a.example"])
        } finally { db.close() }
    }

    @Test
    fun `书源没改就复用上次的结果，不会每次重扫`() {
        val db = tempDatabase()
        try {
            val first = db.saveSource(SourceCodec.parse(sourceJson("https://a.example")), null)
            val counts = db.cookieBucketMentions()
            assertEquals(1, counts["a.example"])

            // 同一个实例 = 直接走了缓存；重扫过一次的话会是新的 HashMap。
            assertSame("书源没动过就不该重算", counts, db.cookieBucketMentions())

            // 书源一改（哪怕只是改分组）就失效：宁可多扫一次，也不能留一个过期的数。
            // 真正的重算由后台线程提前做，打开凭据管理时多半已经算完（见 MentionsWarmer）。
            db.batchUpdateSources(listOf(first.id), "set_group", "整理过的分组")
            assertEquals("改完还是这个数", 1, db.cookieBucketMentions()["a.example"])
        } finally { db.close() }
    }

    @Test
    fun `书源改了先照发旧值，重算之后才是新数`() {
        val db = tempDatabase()
        try {
            val a = db.saveSource(SourceCodec.parse(sourceJson("https://a.example")), null)
            val b = db.saveSource(SourceCodec.parse(sourceJson("https://b.example")), null)
            val before = db.cookieBucketMentions()
            assertEquals(1, before["a.example"])

            db.deleteSource(b.id)
            // 删完立刻打开面板：不能让人等一次全库扫描，先发旧值（后台正在重算）。
            assertEquals("书源刚改完时先发旧值", before, db.cookieBucketMentions())

            // 重算之后才是真话。
            val refreshed = db.cookieBucketMentionsNow()
            assertNotSame("重算的结果必须是新对象", before, refreshed)
            assertEquals("b 被删了，不该还在", null, refreshed["b.example"])
            assertEquals(1, refreshed["a.example"])

            // 删一本、换一本**等长**地址的书源。按"表指纹"判断有没有改的那版实现会把它当成
            // 「没改过」而一直停在旧数上；这里必须给出换过之后的结果。
            db.deleteSource(a.id)
            db.saveSource(SourceCodec.parse(sourceJson("https://c.example")), null)
            val afterSwap = db.cookieBucketMentionsNow()
            assertEquals(null, afterSwap["a.example"])
            assertEquals(1, afterSwap["c.example"])
        } finally { db.close() }
    }
}
