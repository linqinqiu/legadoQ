package io.legado

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import io.legado.source.SourceCodec

class SourceCodecTest {
    @Test
    fun `parses Android compatible source fields`() {
        val source = SourceCodec.parse(
            """{"bookSourceUrl":"https://example.com","bookSourceName":"示例","bookSourceGroup":"测试","enabled":false,"mainJs":"function search(){}"}"""
        )

        assertEquals("https://example.com", source.id)
        assertEquals("示例", source.name)
        assertEquals("测试", source.group)
        assertFalse(source.enabled)
        assertTrue(source.isJs)
    }

    @Test
    fun `rejects missing or empty source URLs`() {
        val result = SourceCodec.validate("""{"bookSourceName":"无URL"}""")
        assertFalse(result.valid)
        assertTrue(result.errors.single().contains("缺少 bookSourceUrl"))

        val emptyResult = SourceCodec.validate("""{"bookSourceUrl":"   "}""")
        assertFalse(emptyResult.valid)
        assertTrue(emptyResult.errors.single().contains("不能为空"))
    }

    @Test
    fun `parses custom ID source URLs like Chinese names`() {
        val source = SourceCodec.parse("""{"bookSourceUrl":"大灰狼融合VIP5.0","bookSourceName":"🍅大灰狼聚合5.8.20(vip完全版)","bookSourceGroup":"大灰狼聚合"}""")
        assertEquals("大灰狼融合VIP5.0", source.id)
        assertEquals("🍅大灰狼聚合5.8.20(vip完全版)", source.name)
        assertEquals("大灰狼聚合", source.group)
        assertTrue(source.enabled)
    }

    @Test
    fun `strips legado annotations from book source urls`() {
        val legacy = SourceCodec.parse("""{"bookSourceUrl":"https://cn.ttkan.co/##@遇知","bookSourceName":"天天看书","searchUrl":"/novel/search?q={{key}}"}""")
        assertEquals("https://cn.ttkan.co/", legacy.id)
        assertTrue(legacy.json.contains(""""bookSourceUrl":"https://cn.ttkan.co/""""))

        val hash = SourceCodec.parse("""{"bookSourceUrl":"https://www.linovel.net#yc1101","searchUrl":"/search/?kw={{key}}"}""")
        assertEquals("https://www.linovel.net", hash.id)
    }

    @Test
    fun `handles UTF-8 BOM and whitespace in url and names`() {
        val bomSource = "\uFEFF  {\"bookSourceUrl\":\"  https://example.org/ \",\"bookSourceName\":\"  BOM源  \"}  "
        val parsed = SourceCodec.parse(bomSource)
        assertEquals("https://example.org/", parsed.id)
        assertEquals("BOM源", parsed.name)
        assertTrue(parsed.enabled)
    }

    @Test
    fun `supports alternative field names like sourceUrl and enable`() {
        val source = SourceCodec.parse("""{"sourceUrl":"https://legacy.example.com","sourceName":"旧版书源","sourceGroup":"旧版","enable":"0"}""")
        assertEquals("https://legacy.example.com", source.id)
        assertEquals("旧版书源", source.name)
        assertEquals("旧版", source.group)
        assertFalse(source.enabled)
    }

    @Test
    fun `auto converts protocol relative urls`() {
        val protoRelative = SourceCodec.parse("""{"bookSourceUrl":"//relative.example.com","bookSourceName":"相对协议"}""")
        assertEquals("https://relative.example.com", protoRelative.id)
    }

    @Test
    fun `parses real-world complex shareBookSource JSON`() {
        // 内联一份真实形态的聚合书源样例（自定义中文标识 + emoji 名 + loginUrl），
        // 不再依赖开发者本机的下载文件，保证在任何机器 / CI 上都真正执行断言。
        val sample = """
            [{"bookSourceUrl":"大灰狼融合VIP5.0",
              "bookSourceName":"🍅大灰狼聚合5.8.20(vip完全版)",
              "bookSourceGroup":"大灰狼聚合",
              "bookSourceComment":"聚合书源",
              "loginUrl":"https://example.com/login",
              "searchUrl":"https://example.com/search?q={{key}}",
              "enabled":true}]
        """.trimIndent()
        val list = kotlinx.serialization.json.Json.parseToJsonElement(sample) as kotlinx.serialization.json.JsonArray
        val parsed = SourceCodec.parse(list[0].toString())
        assertEquals("大灰狼融合VIP5.0", parsed.id)
        assertEquals("🍅大灰狼聚合5.8.20(vip完全版)", parsed.name)
        assertEquals("大灰狼聚合", parsed.group)
        assertTrue(parsed.hasLogin)
    }
}
