package io.legado

import io.legado.rules.bareJsonListPath
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * JSON 响应上的「裸键」列表规则。
 *
 * 判据来自真实音频源 5sing：接口回 `{"list":[…]}`、规则写 `bookList: list`。
 * 字段规则那边一直支持裸键（自动补 `$.`），列表这边没补 —— `list` 被当成 CSS 标签名，
 * 一个都选不中，整源搜索 0 条，界面只说"一条都没有"。
 */
class BareJsonListRuleTest {

    @Test
    fun `JSON 对象上的裸键列表补成 jsonpath`() {
        assertEquals("$.list", bareJsonListPath("""{"list":[{"songName":"x"}]}""", "list"))
        assertEquals("$.data.items", bareJsonListPath("""{"data":{"items":[]}}""", "data.items"))
    }

    @Test
    fun `JSON 数组开头也认`() {
        assertEquals("$.list", bareJsonListPath("""[{"list":[]}]""", "list"))
    }

    @Test
    fun `HTML 响应不动它，继续走 CSS`() {
        assertNull(bareJsonListPath("<html><body><ul class=\"list\"></ul></body></html>", "list"))
    }

    @Test
    fun `已经写了 jsonpath 前缀的不重复补`() {
        assertNull(bareJsonListPath("""{"list":[]}""", "$.list"))
    }

    @Test
    fun `JS 与带指令的规则不当作裸键`() {
        assertNull(bareJsonListPath("""{"list":[]}""", "<js>result=[]</js>"))
        assertNull(bareJsonListPath("""{"list":[]}""", "@js:[]"))
        assertNull(bareJsonListPath("""{"list":[]}""", "@json:$.list"))
        assertNull(bareJsonListPath("""{"list":[]}""", ".view_tit"))
    }

    @Test
    fun `空白与前后缩进不影响判断`() {
        assertEquals("$.list", bareJsonListPath("   \n\t{\"list\":[]}", "list"))
    }
}
