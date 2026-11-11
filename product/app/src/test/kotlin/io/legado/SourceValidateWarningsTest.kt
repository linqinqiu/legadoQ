package io.legado

import io.legado.model.ValidateResponse
import io.legado.source.SourceCodec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 书源校验的「已知不兼容写法」静态告警（SourceCodec.validate 的 warnings）。
 * 走真实 validate()，断言的是"该报的报了、不该报的（js 段里带逗号）没误报、干净源空告警"，
 * 而不是内部私有扫描函数——因为对外契约就是 validate 返回里那串 warnings。
 */
class SourceValidateWarningsTest {

    private fun validate(json: String): ValidateResponse = SourceCodec.validate(json)

    @Test
    fun `干净源不产生任何告警`() {
        // 真实可用的源都带规则；只有地址没有规则的属于"只剩元数据"，会命中下面那条告警。
        val r = validate(
            """{"bookSourceUrl":"https://d","bookSourceName":"n","searchUrl":"https://d/s?kw={{key}}&page={{page}}",
               "ruleSearch":{"bookList":"$.data","name":"$.title","bookUrl":"$.url"},
               "ruleToc":{"chapterList":"$.chapters","chapterName":"$.t","chapterUrl":"$.u"},
               "ruleContent":{"content":"$.content"}}"""
        )
        assertTrue(r.valid)
        assertEquals(emptyList<String>(), r.warnings)
    }

    @Test
    fun `只剩元数据、一条规则都没有的源会明确告警`() {
        // 兄弟包备份里真实存在这种条目：本机库 5,600 条里 556 条，且大多带 weight。
        // 导入不报错、列表里也看得见，但搜索/目录/正文一步都跑不出来。
        val r = validate(
            """{"bookSourceUrl":"http://www.lwxstxt.com","bookSourceName":"乐文小说⑪","bookSourceType":0,
               "customOrder":1986,"weight":443,"enabled":true,"enabledCookieJar":true}"""
        )
        assertTrue(r.valid)
        assertTrue("要说清是规则缺失，不是解析失败", r.warnings.any { it.contains("没有任何规则字段") })
    }

    @Test
    fun `规则对象是空壳也按没有规则算`() {
        val r = validate("""{"bookSourceUrl":"https://d","ruleSearch":{},"ruleToc":{"chapterList":""}}""")
        assertTrue(r.valid)
        assertTrue(r.warnings.any { it.contains("没有任何规则字段") })
    }

    @Test
    fun `上游式分页占位已支持，不再产生误导告警`() {
        // S0/C-02（2026-11-12）：<页1,页2,…> 语义已对齐上游（renderUrl → selectPageSegments，
        // PagingSegmentTest / PagingDetectionTest 钉住）。导入时再说"不解析它"就是谎报军情。
        val r = validate("""{"bookSourceUrl":"https://d","searchUrl":"https://d/s?kw={{key}}&page=<(1,2,3)>"}""")
        assertTrue(r.valid)
        assertFalse("分页占位已支持，不该再告警", r.warnings.any { it.contains("分页占位") })
    }

    @Test
    fun `段评字段有值会告警`() {
        val r = validate("""{"bookSourceUrl":"https://d","searchUrl":"https://d/s","ruleReview":{"enabled":true,"reviewSummaryUrl":"$.data"}}""")
        assertTrue(r.valid)
        assertTrue(r.warnings.any { it.contains("段评") })
    }

    @Test
    fun `顶层既无搜索地址又无发现地址会告警没有入口`() {
        val r = validate("""{"bookSourceUrl":"https://d","bookSourceName":"n"}""")
        assertTrue(r.valid)
        assertTrue(r.warnings.any { it.contains("没有可用入口") })
    }

    @Test
    fun `标记 webView 会告警需真浏览器`() {
        val r = validate("""{"bookSourceUrl":"https://d","searchUrl":"https://d/s","webView":true}""")
        assertTrue(r.valid)
        assertTrue(r.warnings.any { it.contains("webView") })
    }

    @Test
    fun `非法书源仍返回 valid=false 且不带告警噪音`() {
        val r = validate("""{"bookSourceName":"缺地址的源"}""")
        assertFalse(r.valid)
        assertTrue(r.errors.isNotEmpty())
        assertEquals(emptyList<String>(), r.warnings)
    }
}
