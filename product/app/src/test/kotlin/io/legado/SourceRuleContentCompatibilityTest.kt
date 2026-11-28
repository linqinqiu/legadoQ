package io.legado

import io.legado.rules.RuleRunner
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import java.net.URLDecoder

class SourceRuleContentCompatibilityTest {

    @Test
    fun `legacy rule content keeps its Javascript JSON representation`() {
        var asked = ""
        val runner = RuleRunner { url ->
            asked = url
            "<html><body><div class=\"it\"><a href=\"/b/1\">剑来</a></div></body></html>"
        }
        val source = """{
            "bookSourceUrl":"http://cm.example",
            "bookSourceName":"正文规则兼容性",
            "searchUrl":"@js:'http://cm.example/search?rule=' + encodeURIComponent(JSON.stringify({ruleContent: source.ruleContent}))",
            "ruleSearch":{"bookList":".it","name":"tag.a@text","bookUrl":"tag.a@href"},
            "ruleContent":{
                "content":"body@text",
                "subContent":"\"quoted\"\n中文",
                "title":"",
                "nextContentUrl":"a.next@href",
                "sourceRegex":"正文",
                "replaceRegex":"##广告",
                "imageStyle":"FULL",
                "payAction":"purchase()",
                "callBackJs":"callback()"
            }
        }"""

        runner.search(source, "剑")

        val encoded = asked.substringAfter("rule=", "")
        val payload = URLDecoder.decode(encoded, Charsets.UTF_8.name())
        val actual = Json.parseToJsonElement(payload).jsonObject["ruleContent"]?.jsonPrimitive?.content
        assertEquals(
            "ContentRule(content=body@text, subContent=\"quoted\"\n中文, title=, " +
                "nextContentUrl=a.next@href, webJs=null, sourceRegex=正文, " +
                "replaceRegex=##广告, imageStyle=FULL, imageDecode=null, " +
                "payAction=purchase(), callBackJs=callback())",
            actual,
        )
    }

    @Test
    fun `configured batch fields stay in the legacy representation and remain readable`() {
        val settings = listOf(
            "" to null,
            null to 0,
            "@js:batch()" to null,
            null to 4,
            "@js:batch()" to 4,
        )
        for ((batch, size) in settings) {
            val ruleContent = buildString {
                append('{')
                append("\"content\":\"body@text\",")
                append("\"subContent\":\"\\\"quoted\\\"\\n中文\",")
                append("\"title\":\"\",")
                append("\"nextContentUrl\":\"a.next@href\",")
                append("\"sourceRegex\":\"正文\",")
                append("\"replaceRegex\":\"##广告\",")
                append("\"imageStyle\":\"FULL\",")
                append("\"payAction\":\"purchase()\",")
                append("\"callBackJs\":\"callback()\"")
                if (batch != null) append(",\"contentBatch\":${Json.encodeToString(batch)}")
                if (size != null) append(",\"maxBatchSize\":$size")
                append('}')
            }
            val source = """{
                "bookSourceUrl":"http://cm.example",
                "bookSourceName":"正文规则兼容性",
                "searchUrl":"@js:'http://cm.example/search?rule=' + encodeURIComponent(JSON.stringify({ruleContent: source.ruleContent})) + '&fields=' + encodeURIComponent(JSON.stringify([source.ruleContent.content, source.ruleContent.contentBatch, source.ruleContent.maxBatchSize]))",
                "ruleSearch":{"bookList":".it","name":"tag.a@text","bookUrl":"tag.a@href"},
                "ruleContent":$ruleContent
            }"""
            var asked = ""
            val runner = RuleRunner { url ->
                asked = url
                "<html><body><div class=\"it\"><a href=\"/b/1\">剑来</a></div></body></html>"
            }

            runner.search(source, "剑")

            val query = asked.substringAfter('?')
            val payload = URLDecoder.decode(query.substringAfter("rule=").substringBefore("&"), Charsets.UTF_8.name())
            val actual = Json.parseToJsonElement(payload).jsonObject["ruleContent"]?.jsonPrimitive?.content
            val expected = "ContentRule(content=body@text, subContent=\"quoted\"\n中文, title=, " +
                "nextContentUrl=a.next@href, webJs=null, sourceRegex=正文, " +
                "replaceRegex=##广告, imageStyle=FULL, imageDecode=null, " +
                "payAction=purchase(), callBackJs=callback(), " +
                "contentBatch=$batch, maxBatchSize=$size)"
            assertEquals("batch=$batch, size=$size", expected, actual)

            val fields = URLDecoder.decode(query.substringAfter("fields="), Charsets.UTF_8.name())
            assertEquals(
                "batch=$batch, size=$size",
                """["body@text",${batch?.let { Json.encodeToString(it) } ?: "null"},${size ?: "null"}]""",
                fields,
            )
        }
    }
}
