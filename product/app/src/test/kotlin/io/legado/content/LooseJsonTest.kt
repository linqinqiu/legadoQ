package io.legado.content

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 书源规则里的 JS 对象字面量常常是「非规范 JSON」（单引号键值、裸标识符键、全角引号、
 * 尾随逗号、行内注释）。[LooseJson.toStrict] 是服务端把这些都规范化成严格 JSON 的唯一入口，
 * 也是「最基础内容」（书源参数解析）的容错地基。它零单测，这里把最基础的规范化语义钉死。
 */
class LooseJsonTest {

    @Test
    fun `裸标识符键被加上双引号`() {
        val result = LooseJson.toStrict("{webView: true}")!!
        assertTrue("输出应含带引号的键", "\"webView\"" in result)
        assertFalse("裸键不应残留", result.contains("webView:"))
        assertTrue("字面量 true 保留", "true" in result)
    }

    @Test
    fun `单引号键值被规范成双引号`() {
        val result = LooseJson.toStrict("{'method':'POST','body':'kw'}")!!
        assertTrue("单引号键应变双引号", "\"method\"" in result)
        assertTrue("单引号值应变双引号", "\"POST\"" in result)
        assertTrue("多字段逗号保留", "\"body\"" in result)
    }

    @Test
    fun `尾随逗号被吃掉`() {
        val result = LooseJson.toStrict("{\"a\":1,}")!!
        assertFalse("不应以逗号结尾", result.trim().endsWith(","))
        assertTrue("键值保留", "\"a\"" in result)
    }

    @Test
    fun `行内与块注释被去除`() {
        // 行尾注释吃到换行为止，所以 } 必须写在下一行，否则连闭合括号一起被吃掉
        val result = LooseJson.toStrict("{/* 注释 */ \"a\":1 // 行尾\n}")!!
        assertFalse("块注释应去除", "注释" in result)
        assertFalse("行尾注释应去除", "//" in result)
        assertTrue("键值保留", "\"a\"" in result)
    }

    @Test
    fun `全角引号被规范成半角`() {
        val result = LooseJson.toStrict("{“a”:“中文值”}")!!
        assertTrue("全角键应变半角", "\"a\"" in result)
        assertTrue("全角值应变半角", "\"中文值\"" in result)
        assertFalse("全角引号不应残留", "“" in result || "”" in result)
    }

    @Test
    fun `占位符原样保留交给后续渲染`() {
        val result = LooseJson.toStrict("{'url':'x={{key}}'}")!!
        assertTrue("占位符不应被求值", "{{key}}" in result)
    }

    @Test
    fun `空串与超长串返回 null`() {
        assertNull("空串", LooseJson.toStrict(""))
        assertNull("纯空白", LooseJson.toStrict("   "))
        // 长度上限是 8,192：合法 JSON 但超长也必须拒绝，避免把整页正文当参数解析
        val tooLong = "{\"a\":\"" + "x".repeat(9_000) + "\"}"
        assertNull("超长合法 JSON", LooseJson.toStrict(tooLong))
    }

    @Test
    fun `undefined 被当作 null`() {
        val result = LooseJson.toStrict("{a: undefined}")!!
        assertTrue("undefined 规范成 null", "\"a\":null" in result || "\"a\": null" in result)
    }
}
