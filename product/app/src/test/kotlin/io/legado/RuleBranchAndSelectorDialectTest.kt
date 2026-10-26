package io.legado

import io.legado.rules.RuleRunner
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 列表规则里的 `&&` / `%%` 组合，以及 `tag.` / `id.` / `children` 选择器方言。
 *
 * 这两件事原来都不支持，症状是**整源 0 条**而不是报错：
 * ① `&&` 只切了 `||`，整串被当 CSS 选择器 → `SelectorParseException`（极速漫画实测）；
 * ② 列表规则只把各段用空格拼成 CSS，`@tag.li` 被当成标签名 → 一条都选不出来
 *    （本机 11,280 条非 JS 列表规则里 2,164 条带 `tag.`、1,063 条带 `id.`）。
 *
 * 依据上游 `RuleAnalyzer.splitRule("&&","||","%%")` 与 `AnalyzeByJSoup.ElementsSingle`。
 * 每条都带反向对照：把语义改回旧行为时判据必须变红。
 */
class RuleBranchAndSelectorDialectTest {

    private val searchHtml = """
        <html><body>
          <div class="banner_detail_form"><p class="title"><a href="/top/">置顶推荐</a></p></div>
          <ul class="mh-list col7">
            <li><div class="mh-item"><h2 class="title"><a href="/manhua1/">漫画一</a></h2></div></li>
            <li><div class="mh-item"><h2 class="title"><a href="/manhua2/">漫画二</a></h2></div></li>
          </ul>
        </body></html>
    """.trimIndent()

    private fun sourceWithBookList(bookList: String, bookUrl: String = "class.title@tag.a@href"): String = """
        {
          "bookSourceUrl": "https://dialect.example",
          "searchUrl": "/search?k={{key}}",
          "ruleSearch": {
            "bookList": "$bookList",
            "name": "class.title@tag.a@text",
            "bookUrl": "$bookUrl"
          }
        }
    """.trimIndent()

    private fun search(source: String) = RuleRunner { searchHtml }.search(source, "漫画")

    @Test
    fun `list rule with double ampersand unions both branches instead of being parsed as css`() {
        // 极速漫画的真实写法：两个选择器都要取，结果并集
        val results = search(sourceWithBookList("class.banner_detail_form&&class.mh-list@tag.li"))

        assertEquals(listOf("置顶推荐", "漫画一", "漫画二"), results.map { it.name })
    }

    @Test
    fun `single branch with the same selector still works`() {
        // 反向对照：把 && 拆掉只留一支，必须只剩一支的结果（证明上面的并集不是把整页都捞进来）
        val results = search(sourceWithBookList("class.mh-list@tag.li"))

        assertEquals(listOf("漫画一", "漫画二"), results.map { it.name })
    }

    @Test
    fun `double ampersand over a json path list also unions`() {
        val json = """{"data":[{"t":"甲","u":"/a"}],"extra":[{"t":"乙","u":"/b"}]}"""
        val source = """
            {
              "bookSourceUrl": "https://json.example",
              "searchUrl": "/s?k={{key}}",
              "ruleSearch": {"bookList":"$.data[*]&&$.extra[*]","name":"$.t","bookUrl":"$.u"}
            }
        """.trimIndent()

        val results = RuleRunner { json }.search(source, "甲")

        assertEquals(listOf("甲", "乙"), results.map { it.name })
    }

    @Test
    fun `double percent interleaves branches by position`() {
        // 上游 getStringList 的 %% 分支：以第一支的行数为准逐行交错（两卷目录排回阅读顺序）
        val html = """
            <html><body>
              <div class="v1"><a href="/c/1">1</a><a href="/c/2">2</a></div>
              <div class="v2"><a href="/c/3">3</a><a href="/c/4">4</a></div>
            </body></html>
        """.trimIndent()
        val source = """
            {
              "bookSourceUrl": "https://pct.example",
              "ruleToc": {
                "chapterList": "class.v1@tag.a%%class.v2@tag.a",
                "chapterName": "text",
                "chapterUrl": "href"
              }
            }
        """.trimIndent()

        val chapters = RuleRunner { html }.chapters(source, "https://pct.example/toc")

        assertEquals(listOf("1", "3", "2", "4"), chapters.map { it.title })
    }

    @Test
    fun `list rule resolves tag and id selector dialects`() {
        // 列表规则里的 tag./id. 段原来被当成标签名，整条规则一条都选不出来
        val html = """
            <html><body>
              <div id="alistbox">
                <ul><li><h2 class="title"><a href="/b/1">书一</a></h2></li>
                    <li><h2 class="title"><a href="/b/2">书二</a></h2></li></ul>
              </div>
            </body></html>
        """.trimIndent()
        val source = """
            {
              "bookSourceUrl": "https://tag.example",
              "searchUrl": "/s?k={{key}}",
              "ruleSearch": {"bookList":"id.alistbox@tag.li","name":"class.title@tag.a@text","bookUrl":"class.title@tag.a@href"}
            }
        """.trimIndent()

        val results = RuleRunner { html }.search(source, "书")

        assertEquals(listOf("书一", "书二"), results.map { it.name })
    }

    @Test
    fun `list rule resolves children dialect`() {
        val html = """<html><body><div class="BOX"><p><a href="/c/1">甲</a></p><p><a href="/c/2">乙</a></p></div></body></html>"""
        val source = """
            {
              "bookSourceUrl": "https://children.example",
              "ruleToc": {"chapterList":"class.BOX@children","chapterName":"tag.a@text","chapterUrl":"tag.a@href"}
            }
        """.trimIndent()

        val chapters = RuleRunner { html }.chapters(source, "https://children.example/toc")

        assertEquals(listOf("甲", "乙"), chapters.map { it.title })
    }

    @Test
    fun `segment level range index selects by position`() {
        // `class.book_tag.0:1:2` —— 索引写在段里（上游 findIndexSet 的另一种写法），真实语料有这种写法
        val html = """<html><body><div class="book-base"><a href="/b/1"></a><p class="book_tag">甲</p><p class="book_tag">乙</p><p class="book_tag">丙</p></div></body></html>"""
        val source = """
            {
              "bookSourceUrl": "https://rangespec.example",
              "searchUrl": "/s?k={{key}}",
              "ruleSearch": {"bookList":".book-base","name":"class.book_tag.0:1:2@text","bookUrl":"a.0@href"}
            }
        """.trimIndent()

        val results = RuleRunner { html }.search(source, "甲")

        // 0:1:2 → 起点 0、终点 1、步长 2 ⇒ 只取第 0 个
        assertEquals(listOf("甲"), results.map { it.name })
    }

    @Test
    fun `a broken field selector does not kill the whole search`() {
        // 字段规则写坏只该让该字段为空，不能把整条搜索结果连坐 —— 0.8.1 是这个行为，
        // 修列表规则时曾一度改成连坐，实测把豆花文学从 10 条打成 0 条。
        val source = """
            {
              "bookSourceUrl": "https://tolerant.example",
              "searchUrl": "/s?k={{key}}",
              "ruleSearch": {"bookList":"class.mh-list@tag.li","name":"class.title@tag.a@text","bookUrl":"class.title@tag.a@href","kind":"class.写坏了[[@text"}
            }
        """.trimIndent()

        val results = search(source)

        assertEquals(listOf("漫画一", "漫画二"), results.map { it.name })
        assertEquals(null, results.first().kind)
    }

    @Test
    fun `broken css in a single branch still fails loudly instead of returning everything`() {
        // 反向对照：真的写坏的规则不能被"宽容"成整页都算命中。
        // 症状必须仍是「报错并带上游那句话」，因为「规则写坏了」与「站点真没内容」是两件事。
        val error = runCatching { search(sourceWithBookList("class.mh-list@tag.li[[")) }.exceptionOrNull()

        assertNotNull("写坏的选择器应当报错，而不是静默返回空列表", error)
        assertTrue(
            "报错里应当能看出是选择器写坏了，实际是：${error?.message}",
            error?.message?.contains("SelectorParseException", ignoreCase = true) == true,
        )
    }
}
