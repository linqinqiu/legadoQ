package io.legado

import io.legado.rules.RuleRunner
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 详情阶段 `@put` 的变量必须传到目录阶段。
 *
 * 上游把变量表挂在书这一级的 `RuleData` 上（`model/analyzeRule/RuleData.kt`），
 * 所以「详情 put、目录 get」天然合法。我们原来只在详情结束时回灌**搜索阶段**的变量：
 *
 *     rememberRuleData(tocUrl, recallRuleData(bookUrl))   // 缺 root.snapshotVariables()
 *
 * 漫画源正是这个形态（`ruleBookInfo.name` 里 put cid，`ruleToc.chapterUrl` 里 get cid），
 * 变量丢了就拼出 `comic_id=&chapter_id=…`，上游回 422，界面只看到「上游返回 HTTP 422」。
 *
 * 用 responseFetcher 注入假响应，不碰网络。
 */
class RuleVariableHandoffTest {

    private val bookPayload = """{"name":"测试书","id":100,"chapters":[{"title":"第一章","url":"/c1"}]}"""

    private val source = """
        {
          "bookSourceUrl":"https://handoff.example",
          "bookSourceName":"变量传递测试",
          "ruleBookInfo":{ "name":"$.name@put:{cid:$.id}" },
          "ruleToc":{ "chapterList":"$.chapters", "chapterName":"$.title",
                      "chapterUrl":"https://c.example/ch?cid=@get:{cid}&path={{$.url}}" }
        }
    """.trimIndent()

    /** 任何地址都回同一份 JSON：详情与目录读的是同一个 bookUrl。 */
    private fun runner() = RuleRunner({ _ -> bookPayload })

    @Test
    fun `详情阶段 put 的变量在目录阶段能 get 到`() {
        val runner = runner()
        val bookUrl = "https://handoff.example/book/1"
        val details = runner.details(source, bookUrl)
        assertEquals("测试书", details.name)

        val chapters = runner.chapters(source, details.tocUrl)
        assertEquals(1, chapters.size)
        assertTrue(
            "目录 URL 里应带上详情阶段 put 的 cid，实际：${chapters[0].url}",
            chapters[0].url.contains("cid=100"),
        )
        assertTrue("章内路径也要能取到：${chapters[0].url}", chapters[0].url.contains("path=/c1"))
    }

    @Test
    fun `搜索阶段 put 的变量仍然能传到目录（不回归）`() {
        // 这条守住原来的能力：搜索 @put → 目录 @get
        val searchable = """
            {
              "bookSourceUrl":"https://handoff.example",
              "bookSourceName":"搜索变量测试",
              "searchUrl":"https://handoff.example/search?key={{key}}",
              "ruleSearch":{ "bookList":"$.list", "name":"$.name", "bookUrl":"$.url@put:{bid:$.id}" },
              "ruleToc":{ "chapterList":"$.chapters", "chapterName":"$.title",
                          "chapterUrl":"https://c.example/ch?bid=@get:{bid}" }
            }
        """.trimIndent()
        val runner = RuleRunner({ url ->
            when {
                url.contains("/search") -> """{"list":[{"name":"书","url":"/b/1","id":42}]}"""
                else -> """{"chapters":[{"title":"第一章","url":"/c1"}]}"""
            }
        })
        runner.search(searchable, "测试")
        val chapters = runner.chapters(searchable, "https://handoff.example/b/1")
        assertEquals(1, chapters.size)
        assertTrue("搜索阶段 put 的 bid 应仍在：${chapters[0].url}", chapters[0].url.contains("bid=42"))
    }
}
