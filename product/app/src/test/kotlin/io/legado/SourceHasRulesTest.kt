package io.legado

import io.legado.source.SourceCodec
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「这条源有没有规则」的判据（`SourceCodec.hasRules`）。
 *
 * 它现在被三处共用：导入/保存时写进 `source.has_rules` 列、校验接口的告警、
 * 前端列表的「无规则」筛选。定义漂一次，三处就一起错 —— 所以单独钉一遍。
 *
 * 背景：兄弟包的备份里真实存在"只剩元数据"的条目（本机库 5,600 条里 582 条），
 * 导入不报错、列表里也看得见，但搜索 / 目录 / 正文一步都跑不出来。
 */
class SourceHasRulesTest {

    @Test
    fun `只剩元数据的源没有规则`() {
        val payload = """{"bookSourceUrl":"http://www.lwxstxt.com","bookSourceName":"乐文小说⑪",
            "bookSourceType":0,"customOrder":1986,"weight":443,"enabled":true,"enabledCookieJar":true}"""
        assertFalse(SourceCodec.hasRules(payload))
    }

    @Test
    fun `规则对象存在但全是空串 也算没有规则`() {
        val payload = """{"bookSourceUrl":"https://d","ruleSearch":{},"ruleToc":{"chapterList":""},"ruleContent":{"content":"  "}}"""
        assertFalse(SourceCodec.hasRules(payload))
    }

    @Test
    fun `任意一个规则字段非空就算有规则`() {
        assertTrue(SourceCodec.hasRules("""{"bookSourceUrl":"https://d","ruleSearch":{"bookList":"$.data"}}"""))
        assertTrue(SourceCodec.hasRules("""{"bookSourceUrl":"https://d","ruleToc":{"chapterList":"dd a"}}"""))
        assertTrue(SourceCodec.hasRules("""{"bookSourceUrl":"https://d","ruleContent":{"content":"@js:1"}}"""))
        assertTrue(SourceCodec.hasRules("""{"bookSourceUrl":"https://d","ruleExplore":{"bookList":"$.d"}}"""))
        assertTrue(SourceCodec.hasRules("""{"bookSourceUrl":"https://d","ruleBookInfo":{"name":"h1"}}"""))
    }

    @Test
    fun `JSON 坏掉时按有规则处理，交给报错条去说`() {
        // 这不是"缺规则"，是另一种错误；在这里判成 false 会把两种问题混成一句提示。
        assertTrue(SourceCodec.hasRules("""{"bookSourceUrl":"""))
    }

    @Test
    fun `解析书源时这个标记会跟着走`() {
        assertFalse(SourceCodec.parse("""{"bookSourceUrl":"https://d","bookSourceName":"空壳"}""").hasRules)
        assertTrue(SourceCodec.parse("""{"bookSourceUrl":"https://d","ruleToc":{"chapterList":"a"}}""").hasRules)
    }
}
