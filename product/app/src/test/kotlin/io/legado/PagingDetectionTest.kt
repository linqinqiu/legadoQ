package io.legado

import io.legado.rules.RuleRunner
import io.legado.rules.supportsPaging
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「这一栏能不能翻页」的判定表（`rules/PagingRule.kt`）。
 *
 * 正反两组用例是照上游 `AnalyzeUrl.supportsPageSelection` 的语义自己列的（读它的判据，不抄它的代码）：
 * 认不认的关键在 `page` 是不是**自由变量** —— 属性访问、形参遮蔽、局部声明、字符串里的都不算。
 * 判错的代价是看得见的：给不吃页码的栏目挂一颗「下一页」，用户每点一次就是一次白发请求
 * （本机 25,290 条静态栏目地址里有 4,368 条不含任何翻页写法）。
 */
class PagingDetectionTest {

    @Test
    fun `表达式与脚本里引用自由变量 page 的，认`() {
        listOf(
            "https://example.test/list?page={{page}}",
            "https://example.test/list?page={{ page }}",
            "https://example.test/list?offset={{(page - 1) * 20}}",
            "@js: 'https://example.test/list?page=' + page",
            "<js>'https://example.test/list?page=' + page</js>",
            "https://example.test/list<1,2,3>",
            "/dsyq/<,index_{{page}}.html>",
        ).forEach { rule -> assertTrue(rule, supportsPaging(rule)) }
    }

    @Test
    fun `判定绝不执行书源代码`() {
        // 上游同一条纪律：喂一段会抛的脚本，只要它引用了 page 就该回 true —— 回 false 说明我们真去执行了。
        assertTrue(supportsPaging("@js: throw new Error('must not execute'); page"))
        assertTrue(supportsPaging("https://example.test/{{java.get('remote') + page}}"))
    }

    @Test
    fun `字面量 字符串 属性与被遮蔽的局部变量 都不认`() {
        listOf(
            "https://example.test/list?page=1",
            "https://example.test/{{'page'}}",
            "@js: /* page */ 'https://example.test/list'",
            "@js: 'https://example.test/page'",
            "https://example.test/{{book.page}}",
            "https://example.test/{{({page: 1}).page}}",
            "https://example.test/{{(function(page) { return page; })(1)}}",
            "@js: var page = 1; 'https://example.test/list?page=' + page",
            "https://example.test/list<a>",
            "",
        ).forEach { rule -> assertFalse(rule, supportsPaging(rule)) }
        assertFalse("null 也当成不支持", supportsPaging(null))
    }

    @Test
    fun `反向对照：把自由变量换成属性访问必须翻成不支持`() {
        // 同一条规则只改一处：`{{page}}` → `{{opts.page}}`。两条断言一起才证明这条判据有分辨力。
        assertTrue(supportsPaging("https://example.test/list?page={{page}}"))
        assertFalse(supportsPaging("https://example.test/list?page={{opts.page}}"))
    }

    @Test
    fun `栏目清单逐条带着这一栏吃不吃页码的旗标`() {
        // 判定要长在 parseExploreTabs 里：界面拿到的是"这一栏"的答案，不是一句全局猜测。
        val source = """{"bookSourceUrl":"https://agg.example","exploreUrl":"玄幻::/list?page={{page}}&&完结::/done&&月度::/rank<,p{{page}}>"}"""
        val tabs = RuleRunner().exploreTabs(source)
        assertEquals(3, tabs.size)
        assertEquals(listOf("玄幻", "完结", "月度"), tabs.map { it.title })
        assertEquals(listOf(true, false, true), tabs.map { it.supportsPaging })
    }
}
