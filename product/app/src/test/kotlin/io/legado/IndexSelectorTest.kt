package io.legado

import org.junit.Assert.assertEquals
import org.junit.Test
import io.legado.rules.RuleRunner
import io.legado.rules.applyIndexTokens
import io.legado.rules.parseIndexSpec
import io.legado.rules.splitIndexSuffix

/**
 * Legado 索引型选择器（`!N` / `[N]` / 负索引 / 区间）。
 *
 * 关键差别：上游数的是**这条规则匹配到的列表**，CSS `:nth-child` 数的是同一父元素下的兄弟。
 * 匹配集跨两个父节点时两者结果不同 —— 下面的 DOM 就是照这个设计的：
 * `a.item!0` 应当去掉「一」（匹配集的第 0 个），而旧的 `:not(:nth-child(1))` 会去掉「三」
 * （它是 div.b 的第一个孩子），并且把「一」留下（span 占了第一个孩子的位置）。
 */
class IndexSelectorTest {

    private val html = """
        <html><body>
          <div class="a">
            <span class="head">标题行</span>
            <a class="item" href="/c/1">一</a>
            <a class="item" href="/c/2">二</a>
          </div>
          <div class="b">
            <a class="item" href="/c/3">三</a>
            <a class="item" href="/c/4">四</a>
          </div>
        </body></html>
    """.trimIndent()

    private fun chapterList(rule: String): List<String> {
        val source = """
            {
                "bookSourceUrl": "https://idx.example",
                "bookSourceName": "索引选择器测试",
                "ruleToc": { "chapterList": "$rule", "chapterName": "text", "chapterUrl": "href" }
            }
        """.trimIndent()
        return RuleRunner { _ -> html }.chapters(source, "https://idx.example/toc").map { it.title }
    }

    @Test
    fun `splits trailing index suffixes without touching attribute selectors`() {
        assertEquals("li.item" to listOf("!0"), splitIndexSuffix("li.item!0"))
        assertEquals("li.item" to listOf("1"), splitIndexSuffix("li.item[1]"))
        assertEquals("li.item" to listOf("-1"), splitIndexSuffix("li.item[-1]"))
        assertEquals("li.item" to listOf("1:4", "!0"), splitIndexSuffix("li.item[1:4]!0"))
        // 属性选择器不是索引，必须原样留给 CSS
        assertEquals("li[data-x=1]" to emptyList<String>(), splitIndexSuffix("li[data-x=1]"))
        assertEquals("ul > li" to emptyList<String>(), splitIndexSuffix("ul > li"))
    }

    @Test
    fun `parses single, list, negative and range index specs`() {
        assertEquals(listOf(2), parseIndexSpec("2", 5))
        assertEquals(listOf(4), parseIndexSpec("-1", 5))
        assertEquals(listOf(0, 2), parseIndexSpec("0,2", 5))
        assertEquals(listOf(1, 2, 3), parseIndexSpec("1:4", 5))
        assertEquals(listOf(0, 2, 4), parseIndexSpec("0:5:2", 5))
        assertEquals(listOf(3, 4), parseIndexSpec("-2:", 5))
        // 越界索引由应用侧丢弃（上游也是取列表时拿不到就跳过），解析层不裁剪
        assertEquals(listOf(9), parseIndexSpec("9", 5))
        assertEquals(emptyList<Int>(), applyIndexTokens(listOf("a", "b", "c"), listOf("9")))
    }

    @Test
    fun `exclusion drops the matched-list ordinal, not the sibling position`() {
        assertEquals(listOf("二", "三", "四"), chapterList("a.item!0"))
        assertEquals(listOf("一", "二", "四"), chapterList("a.item!2"))
        assertEquals(listOf("二", "四"), chapterList("a.item!0,2"))
    }

    @Test
    fun `bracket index picks by matched-list position and supports negatives`() {
        assertEquals(listOf("三"), chapterList("a.item[2]"))
        assertEquals(listOf("四"), chapterList("a.item[-1]"))
        assertEquals(listOf("一", "三"), chapterList("a.item[0,2]"))
        assertEquals(listOf("二", "三"), chapterList("a.item[1:3]"))
    }

    @Test
    fun `plain css selectors still pass through untouched`() {
        assertEquals(listOf("一", "二", "三", "四"), chapterList("a.item"))
        assertEquals(listOf("三", "四"), chapterList("div.b a"))
        assertEquals(listOf("一", "二"), chapterList("div.a a"))
    }
}
