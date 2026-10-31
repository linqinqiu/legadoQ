package io.legado

import io.legado.rules.RuleRunner
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 藏在 `bookSourceComment` 里的脚本必须能 eval 出来。
 *
 * 社区书源有一大片是这么写的：把真正的取参逻辑塞进源注释，规则里只留一句
 * `eval(String(source.bookSourceComment))`。实测启用库里有 **69 处**脚本读
 * `source.bookSourceComment`，其中 **43 处**注释里确实是可执行代码
 * （繁星小说、♨️满孟小说、🗂🙈顶通漫画、狸猫故事、猫眼看书（优++）…）。
 *
 * 我们建执行上下文时只填了 `sourceId/jsLib/database`，`sourceComment` 一直是 null
 * —— 于是那句 eval 拿到空串，变量没赋值，脚本下一步就报
 * `ReferenceError: “sign” 未定义 (rule.js#3)`：报错把一个"我们没把注释递进去"
 * 的问题，说成了一个"源自己写错变量"的问题。
 */
class SourceCommentEvalTest {
    private val searchable = """{
        "bookSourceUrl":"http://cm.example",
        "bookSourceName":"藏脚本在注释里的源",
        "bookSourceComment":"uuid = java.randomUUID().toUpperCase(); sign = java.md5Encode('query=' + key).toUpperCase();",
        "searchUrl":"@js:\nParams = 'query=' + key; eval(String(source.bookSourceComment)); 'http://cm.example/search?sign=' + sign + '&uuid=' + uuid",
        "ruleSearch":{"bookList":".it","name":"tag.a@text","bookUrl":"tag.a@href"}
    }"""

    @Test
    fun `注释里的脚本能读到 key 并算出签名`() {
        var asked = ""
        val runner = RuleRunner { url ->
            asked = url
            "<html><body><div class=\"it\"><a href=\"/b/1\">剑来</a></div></body></html>"
        }

        val results = runner.search(searchable, "剑")

        assertEquals(listOf("剑来"), results.map { it.name })
        val signature = Regex("sign=([0-9A-F]{32})").find(asked)?.groupValues?.get(1)
        assertTrue("searchUrl 应该带上注释里算出的 MD5 签名，实际地址：$asked", signature != null)
        assertTrue("uuid 也必须由注释里的脚本填上：$asked", asked.contains("uuid=") && !asked.endsWith("uuid="))
    }

    @Test
    fun `源名也一起递给脚本`() {
        // `source.bookSourceName` 与 comment 在同一个上下文里，一起漏过：漏了以后脚本里的提示与分支会走空
        val name = "藏脚本在注释里的源"
        val source = """{
            "bookSourceUrl":"http://cm.example",
            "bookSourceName":"$name",
            "searchUrl":"@js:'http://cm.example/s?name=' + String(source.bookSourceName).length",
            "ruleSearch":{"bookList":".it","name":"tag.a@text","bookUrl":"tag.a@href"}
        }"""
        var asked = ""
        val runner = RuleRunner { url ->
            asked = url
            "<html><body><div class=\"it\"><a href=\"/b/1\">剑来</a></div></body></html>"
        }

        runner.search(source, "剑")

        assertTrue("source.bookSourceName 应该是书源名，实际地址：$asked", asked.endsWith("name=${name.length}"))
    }
}
