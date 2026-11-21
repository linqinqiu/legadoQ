package io.legado.rules

import io.legado.model.SearchResult
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * 搜书是用户打开 app 的第一个动作，也是书源之后最基础的内容闭环。
 * [SearchFlow.search] 是单源搜书的编排：给定一本书源 JSON + 关键词，串起「取页面 → 解析列表」。
 * 它最基础的契约是「配置缺失时抛**明确**异常」（坏书源被精确拒绝，而不是静默返回空或报看不懂的错），
 * 以及「配置完整时把解析结果交出去」。这里把这条编排钉死。
 */
class SearchFlowTest {

    private class StubHost : SearchFlow.Host {
        override fun isJsSource(source: JsonObject): Boolean = false
        override fun jsSourceSearch(source: JsonObject, keyword: String): List<SearchResult> = emptyList()
        override fun <T> inSourceContext(source: JsonObject, sourceUrl: String?, block: () -> T): T = block()
        override fun fetchSearchPage(source: JsonObject, sourceUrl: String, rawSearchUrl: String, keyword: String): String = "<html></html>"
        override fun parseSearchItems(body: String, rule: JsonObject, sourceUrl: String, sourceType: Int): List<SearchResult> =
            listOf(SearchResult(sourceId = "stub", name = "书1", bookUrl = "http://x/1"))
        override fun describeResponse(body: String): String = ""
        override fun sourceType(source: JsonObject): Int = 0
    }

    private fun source(vararg pairs: Pair<String, String>): String = buildJsonObject {
        for ((k, v) in pairs) put(k, v)
    }.toString()

    @Test
    fun `缺少 searchUrl 抛明确异常`() {
        try {
            SearchFlow(StubHost()).search(source("bookSourceUrl" to "https://x.com"), "关键词")
            fail("应抛 RuleExecutionException")
        } catch (e: RuleExecutionException) {
            assertTrue("异常应点名 searchUrl，实际：${e.message}", "searchUrl" in (e.message ?: ""))
        }
    }

    @Test
    fun `缺少 bookSourceUrl 抛明确异常`() {
        try {
            SearchFlow(StubHost()).search(source("searchUrl" to "https://x.com/s?q="), "关键词")
            fail("应抛 RuleExecutionException")
        } catch (e: RuleExecutionException) {
            assertTrue("异常应点名 bookSourceUrl，实际：${e.message}", "bookSourceUrl" in (e.message ?: ""))
        }
    }

    @Test
    fun `缺少 ruleSearch 抛明确异常`() {
        try {
            SearchFlow(StubHost()).search(
                source("bookSourceUrl" to "https://x.com", "searchUrl" to "https://x.com/s?q="),
                "关键词",
            )
            fail("应抛 RuleExecutionException")
        } catch (e: RuleExecutionException) {
            assertTrue("异常应点名 ruleSearch，实际：${e.message}", "ruleSearch" in (e.message ?: ""))
        }
    }

    @Test
    fun `配置完整时返回解析结果`() {
        val src = buildJsonObject {
            put("bookSourceUrl", "https://x.com")
            put("searchUrl", "https://x.com/s?q=")
            put("ruleSearch", buildJsonObject { put("bookList", "x") })
        }.toString()
        val (results, _) = SearchFlow(StubHost()).search(src, "关键词")
        assertEquals(1, results.size)
        assertEquals("书1", results[0].name)
    }
}
