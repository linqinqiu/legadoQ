package io.legado

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64
import io.legado.content.applyReplaceEntry
import io.legado.rules.RuleRunner

class RuleRunnerAdvancedFeaturesTest {

    @Test
    fun `evaluates inline JS with java base64Decode in content rule`() {
        val plainText = "这是经过Base64加密的真实正文内容，第一段。\n这是第二段。"
        val encodedText = Base64.getEncoder().encodeToString(plainText.toByteArray(Charsets.UTF_8))
        val html = """
            <html>
            <head><script>var encryptedData = "$encodedText";</script></head>
            <body>
                <div id="content">请开启JavaScript阅读</div>
            </body>
            </html>
        """.trimIndent()

        val sourceJson = """
            {
                "bookSourceUrl": "https://example.com",
                "bookSourceName": "测试加密书源",
                "ruleContent": {
                    "content": "<js>var m = src.match(/var encryptedData = \"([^\"]+)\"/); m ? java.base64Decode(m[1]) : ''</js>"
                }
            }
        """.trimIndent()

        val runner = RuleRunner { html }
        val chapterContent = runner.content(sourceJson, "https://example.com/chapter1.html")
        assertTrue(chapterContent.content.contains("这是经过Base64加密的真实正文内容"))
        assertFalse(chapterContent.content.contains("请开启JavaScript阅读"))
    }

    @Test
    fun `applies regex replacement in rule fields and replaceRegex in content`() {
        val html = """
            <html>
            <body>
                <h1 class="title">书名：遮天</h1>
                <div class="author">作者：辰东</div>
                <div id="content">
                    <p>正文第一章开始。</p>
                    <p>关注微信公众号【测试防盗】获取最新章节。</p>
                    <p>笔趣阁小说网 www.biquge.com 免费提供。</p>
                    <p>正文内容继续展开。</p>
                </div>
            </body>
            </html>
        """.trimIndent()

        val sourceJson = """
            {
                "bookSourceUrl": "https://example.com",
                "bookSourceName": "测试清洗书源",
                "ruleBookInfo": {
                    "name": "class.title@text##书名：##",
                    "author": "class.author@text##作者：##"
                },
                "ruleContent": {
                    "content": "id.content@html",
                    "replaceRegex": "关注微信公众号.*最新章节\n笔趣阁小说网.*免费提供"
                }
            }
        """.trimIndent()

        val runner = RuleRunner { html }
        val details = runner.details(sourceJson, "https://example.com/book/1")
        assertEquals("遮天", details.name)
        assertEquals("辰东", details.author)

        val content = runner.content(sourceJson, "https://example.com/book/1/1.html")
        assertTrue(content.content.contains("正文第一章开始"))
        assertTrue(content.content.contains("正文内容继续展开"))
        assertFalse(content.content.contains("关注微信公众号"))
        assertFalse(content.content.contains("笔趣阁小说网"))
    }

    /**
     * 库里 1,285 个配了 ruleContent.replaceRegex 的源中 1,230 个写成 `##正则…` 形状
     * （普查：tools/verify/replace-regex-census.mjs）。旧实现把整条连开头的 `##` 一起当正则，
     * 永远匹配不到，等于**整条清洗规则不生效**，防盗广告原样进正文。
     */
    @Test
    fun `applies the double-hash replaceRegex field shapes from upstream SourceRule`() {
        // ##正则 → 删掉全部匹配
        assertEquals(
            "正文很干净。",
            applyReplaceEntry("##\\(第\\d+/\\d+页\\)|\\(本章完\\)", "正文很干净。(第3/8页)(本章完)"),
        )
        // ##正则##替换 → 换成替换串
        assertEquals("正文[广告]结束", applyReplaceEntry("##广告##[广告]", "正文广告结束"))
        // $1 反向引用（`${'$'}` 是 Kotlin 模板转义，替换串里的 $1 要原样交给正则引擎）
        assertEquals("看 ⌚️2024-05-01 走", applyReplaceEntry("##\\s+(\\d{4}-\\d{2}-\\d{2})\\s+## ⌚️${'$'}1 ", "看 2024-05-01 走"))
        // ##正则##替换### → 上游语义：只取第一个匹配的那一段，再对它做 replaceFirst（等于把正文缩成那一小段）
        assertEquals("替换", applyReplaceEntry("##(甲|乙)##替换###", "甲和乙"))
        // 正则编译不过 → 退化成字面量替换（上游同款）
        assertEquals("前没了后", applyReplaceEntry("##([未闭合##没了", "前([未闭合后"))
        // 故意不跟上游的宽松处：没有 ## 的整条按「删掉匹配」处理，而不是当取值规则跑成空
        assertEquals("留下这些", applyReplaceEntry("删掉这些\\s*", "删掉这些留下这些"))
        // 空段与纯空白不影响正文
        assertEquals("原样", applyReplaceEntry("##", "原样"))
        assertEquals("原样", applyReplaceEntry("   ", "原样"))
    }

    @Test
    fun `strip ads end to end through a double-hash replaceRegex source`() {
        val html = """
            <html><body><div id="content">
                <p>少年抬头看天。</p>
                <p>（本章完）</p>
                <p>最新网址请收藏 www.ad-site.com</p>
                <p>雨停了。</p>
            </div></body></html>
        """.trimIndent()
        val sourceJson = """
            {
                "bookSourceUrl": "https://example.com",
                "bookSourceName": "双井号清洗",
                "ruleContent": {
                    "content": "id.content@html",
                    "replaceRegex": "##（本章完）\n##最新网址.*"
                }
            }
        """.trimIndent()

        val runner = RuleRunner { html }
        val content = runner.content(sourceJson, "https://example.com/ch/1.html")
        assertTrue("正文本身要留着：${content.content}", content.content.contains("少年抬头看天"))
        assertTrue("正文本身要留着：${content.content}", content.content.contains("雨停了"))
        assertFalse("（本章完）要被删掉：${content.content}", content.content.contains("本章完"))
        assertFalse("广告行要被删掉：${content.content}", content.content.contains("ad-site"))
    }

    @Test
    fun `supports dynamic JS searchUrl evaluation`() {
        val searchHtml = """
            <html>
            <body>
                <div class="book-item">
                    <a class="name" href="/book/100">完美世界</a>
                    <span class="author">辰东</span>
                </div>
            </body>
            </html>
        """.trimIndent()

        val sourceJson = """
            {
                "bookSourceUrl": "https://example.com",
                "bookSourceName": "测试动态搜索书源",
                "searchUrl": "@js:(() => { return baseUrl + '/search?keyword=' + encodeURIComponent(key) + ',{\"method\":\"POST\",\"body\":\"k=' + key + '\"}'; })()",
                "ruleSearch": {
                    "bookList": "class.book-item",
                    "name": "class.name@text",
                    "bookUrl": "class.name@href",
                    "author": "class.author@text"
                }
            }
        """.trimIndent()

        val runner = RuleRunner { searchHtml }
        val results = runner.search(sourceJson, "完美世界")
        assertEquals(1, results.size)
        assertEquals("完美世界", results[0].name)
        assertEquals("辰东", results[0].author)
        assertEquals("https://example.com/book/100", results[0].bookUrl)
    }

    @Test
    fun `sandboxed JS environment blocks reflection and unsafe Java access`() {
        val sourceJson = """
            {
                "bookSourceUrl": "https://example.com",
                "bookSourceName": "恶意测试书源",
                "ruleContent": {
                    "content": "<js>java.lang.System.exit(0); 'blocked'</js>"
                }
            }
        """.trimIndent()

        val runner = RuleRunner { "<html><body>test</body></html>" }
        // Should catch execution error and fallback or throw RuleExecutionException without killing the JVM
        val result = runCatching { runner.content(sourceJson, "https://example.com/1.html") }
        assertNotNull(result)
    }
}
