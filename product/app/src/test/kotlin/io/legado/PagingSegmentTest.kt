package io.legado

import io.legado.rules.RuleRunner
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Legado 的 `<页1,页2,…>` 翻页段（`RuleRunner.renderUrl` → `selectPageSegments`）。
 *
 * 依据是量出来的：本机 25,290 条静态栏目地址里有 **2,644 条（10.5%）** 用这个写法，
 * 而我们以前只替 `<key>`，尖括号原样留在网址里 ⇒ 过不了 URI 解析，**那一栏第 1 页就 502**。
 * 当场演过：`饭饭小说 · 都市言情::/dsyq/<,index_{{page}}.html>` →
 * 「URL 格式无效或包含未解析变量: /dsyq/<,index_1.html>」。
 */
class PagingSegmentTest {

    /** 跑一次发现分栏，把服务端真去取的那个地址拿回来。 */
    private fun exploredAt(urlTemplate: String, page: Int): String {
        var requested = ""
        val runner = RuleRunner { url ->
            requested = url
            """{"books":[{"name":"某书","id":"1"}]}"""
        }
        val books = runner.explore(
            """{"bookSourceUrl":"https://ff.example","ruleSearch":{"bookList":"$.books[*]","name":"$.name","bookUrl":"https://ff.example/b/{{$.id}}"}}""",
            urlTemplate,
            page,
        )
        assertEquals("取不到书就没法判断网址对不对", 1, books.size)
        return requested
    }

    @Test
    fun `第一段是空串时第 1 页就是那一栏的首页`() {
        assertEquals("https://ff.example/dsyq/", exploredAt("/dsyq/<,index_{{page}}.html>", 1))
    }

    @Test
    fun `第 N 页取第 N 段，页码同时喂给段里的 page 变量`() {
        assertEquals("https://ff.example/dsyq/index_2.html", exploredAt("/dsyq/<,index_{{page}}.html>", 2))
        assertEquals("https://ff.example/dsyq/index_5.html", exploredAt("/dsyq/<,index_{{page}}.html>", 5))
    }

    @Test
    fun `段数不够时取最后一条，不越界也不留尖括号`() {
        val url = exploredAt("/list<a,b>", 7)
        assertEquals("https://ff.example/listb", url)
        assertFalse("翻页段没被展开：$url", url.contains('<'))
    }

    @Test
    fun `逗号段的空白会被裁掉`() {
        // 段里两条各自带空格：` /l< , b >/` 第 2 页取 " b " → 裁成 "b"，拼出 /lb（不是 "/l b"，也不是 "/lb "）
        assertEquals("https://ff.example/lb", exploredAt("/l< , b >", 2))
    }

    @Test
    fun `反向对照：key 与 page 的既有写法不许被这次改动带坏`() {
        // `<key>` 与 {{page}} 都发生在翻页段**之前**：段展开只该管剩下的 `<…>`。
        var requested = ""
        val runner = RuleRunner { url -> requested = url; """{"books":[{"name":"某书","id":"9"}]}""" }
        runner.search(
            """{"bookSourceUrl":"https://ff.example","searchUrl":"https://ff.example/s/<key>?p={{page}}&x=<a,b>",""" +
                """"ruleSearch":{"bookList":"$.books[*]","name":"$.name","bookUrl":"https://ff.example/b/{{$.id}}"}}""",
            "斗破 苍穹",
        )
        assertEquals("https://ff.example/s/%E6%96%97%E7%A0%B4+%E8%8B%8D%E7%A9%B9?p=1&x=a", requested)
    }

    @Test
    fun `搜索也带页码：那 50 份用逗号段写 searchUrl 的源不该再是 502`() {
        var error: String? = null
        val runner = RuleRunner { url ->
            assertTrue("搜索地址里还剩尖括号：$url", !url.contains('<'))
            """{"books":[{"name":"某书","id":"1"}]}"""
        }
        runCatching {
            runner.search(
                """{"bookSourceUrl":"https://ff.example","searchUrl":"https://ff.example/q<,p{{page}}>",""" +
                    """"ruleSearch":{"bookList":"$.books[*]","name":"$.name","bookUrl":"https://ff.example/b/{{$.id}}"}}""",
                "某关键词",
            )
        }.onFailure { error = it.message }
        assertEquals("搜索那条逗号段还是没展开：$error", null, error)
    }
}
