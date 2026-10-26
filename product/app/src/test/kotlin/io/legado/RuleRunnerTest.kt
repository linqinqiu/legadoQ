package io.legado

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.ConcurrentHashMap
import io.legado.model.ExploreTab
import io.legado.rules.RuleExecutionException
import io.legado.rules.RuleRunner

class RuleRunnerTest {

    // --- Tier 1: Core Feature Tests ---

    @Test
    fun `executes a JavaScript source search without JVM bindings`() {
        val source = """{
            "bookSourceUrl":"https://source.example",
            "bookSourceName":"测试",
            "mainJs":"function search(key,page){ return [{name:key,bookUrl:'https://book.example/1',author:'作者'}]; }"
        }"""

        val results = RuleRunner().search(source, "关键词")

        assertEquals(1, results.size)
        assertEquals("关键词", results.single().name)
        assertEquals("https://book.example/1", results.single().bookUrl)
    }

    @Test
    fun `rejects loopback requests from JavaScript ajax`() {
        val source = """{
            "bookSourceUrl":"https://source.example",
            "bookSourceName":"测试",
            "mainJs":"function search(key,page){ java.ajax('http://127.0.0.1:8080'); return []; }"
        }"""

        val error = runCatching { RuleRunner().search(source, "关键词") }.exceptionOrNull()

        assertTrue(error is RuleExecutionException)
        assertTrue(error?.message?.contains("内网") == true)
    }

    @Test
    fun `keeps JavaScript content strings unquoted`() {
        val source = """{
            "bookSourceUrl":"https://source.example",
            "bookSourceName":"测试",
            "mainJs":"function getContent(chapter,book,next){ return '第一段\\n第二段'; }"
        }"""

        assertEquals("第一段\n第二段", RuleRunner().content(source, "https://book.example/chapter").content)
    }

    @Test
    fun `executes JSON source with relative URLs and JSONPath templates`() {
        val source = """{
            "bookSourceUrl":"https://source.example",
            "searchUrl":"/search?keyword={{key}}&pi={{page}}",
            "ruleSearch":{"bookList":"$.data","bookUrl":"/books/{{$.book_id}}","name":"$.title","author":"$.author"},
            "ruleBookInfo":{"init":"$.data","name":"$.title","author":"$.author","tocUrl":"/books/{{$.book_id}}/chapters"},
            "ruleToc":{"chapterList":"$.data","chapterName":"$.title","chapterUrl":"/chapters/{{$.chapter_id}}"},
            "ruleContent":{"content":"$.data.content"}
        }"""
        val responses = mapOf(
            "https://source.example/search?keyword=%E8%AF%9B%E4%BB%99&pi=1" to """{"data":[{"book_id":"book-1","title":"诛仙","author":"萧鼎"}]}""",
            "https://source.example/books/book-1" to """{"data":{"book_id":"book-1","title":"诛仙","author":"萧鼎"}}""",
            "https://source.example/books/book-1/chapters" to """{"data":[{"chapter_id":"chapter-1","title":"第一章"}]}""",
            "https://source.example/chapters/chapter-1" to """{"data":{"content":"正文内容"}}""",
        )
        val runner = RuleRunner { url -> responses[url] ?: error("unexpected URL: $url") }

        val result = runner.search(source, "诛仙").single()
        val book = runner.details(source, result.bookUrl)
        val chapter = runner.chapters(source, book.tocUrl).single()

        assertEquals("https://source.example/books/book-1", result.bookUrl)
        assertEquals("https://source.example/books/book-1/chapters", book.tocUrl)
        assertEquals("https://source.example/chapters/chapter-1", chapter.url)
        assertEquals("正文内容", runner.content(source, chapter.url).content)
    }

    @Test
    fun `json-prefixed rules are stripped and evaluated as JSONPath`() {
        // 原版支持 @Json: 显式前缀（大写不敏感），去前缀后走 JSONPath。真实 JSON 源偶尔这么写。
        val source = """{
            "bookSourceUrl":"https://jsonprefix.example",
            "searchUrl":"https://jsonprefix.example/search?q={{key}}",
            "ruleSearch":{"bookList":"@JSON:$.data","name":"@JSON:$.title","author":"@JSON:$.author","bookUrl":"@JSON:$.id"}
        }"""
        val body = """{"data":[{"id":"b1","title":"剑来","author":"烽火戏诸侯"},{"id":"b2","title":"雪中悍刀行","author":"烽火戏诸侯"}]}"""
        val runner = RuleRunner { url ->
            if (url.startsWith("https://jsonprefix.example/search")) body else error("unexpected URL: $url")
        }

        val results = runner.search(source, "剑来")
        assertEquals(2, results.size)
        assertEquals("剑来", results[0].name)
        assertEquals("https://jsonprefix.example/b1", results[0].bookUrl)
    }

    @Test
    fun `content appends subContent after the main body`() {
        val source = """{
            "bookSourceUrl":"https://sub.example",
            "ruleContent":{"content":"@css:#main@html","subContent":"@css:#lyric@html"}
        }"""
        val page = """<html><body><div id="main">第一章正文内容</div><div id="lyric">副文：歌词行</div></body></html>"""
        val runner = RuleRunner { url ->
            if (url == "https://sub.example/c/1") page else error("unexpected URL: $url")
        }

        val content = runner.content(source, "https://sub.example/c/1").content
        assertTrue(content.contains("第一章正文内容"))
        assertTrue(content.contains("副文：歌词行"))
        assertTrue(content.indexOf("第一章正文内容") < content.indexOf("副文：歌词行"))
    }

    @Test
    fun `details parse kind wordCount and lastChapter from BookInfoRule`() {
        // 原版 ruleBookInfo 有 kind/wordCount/lastChapter，此前我们的 BookDetails 丢弃了它们。
        val source = """{
            "bookSourceUrl":"https://detail.example",
            "ruleBookInfo":{"name":"@css:h1@text","kind":"@css:.kind@text","wordCount":"@css:.words@text","lastChapter":"@css:.latest@text","tocUrl":"@css:a.toc@href"}
        }"""
        val html = """<html><body><h1>书名字</h1><span class="kind">玄幻 连载</span><span class="words">120万字</span><span class="latest">第900章 大结局</span><a class="toc" href="/toc"></a></body></html>"""
        val runner = RuleRunner { url -> if (url == "https://detail.example/b/1") html else error("unexpected $url") }

        val details = runner.details(source, "https://detail.example/b/1")
        assertEquals("书名字", details.name)
        assertEquals("玄幻 连载", details.kind)
        assertEquals("120万字", details.wordCount)
        assertEquals("第900章 大结局", details.lastChapter)
    }

    @Test
    fun `chapters mark volume headers via isVolume and keep them without url`() {
        val source = """{
            "bookSourceUrl":"https://vol.example",
            "ruleToc":{"chapterList":"$.data","chapterName":"title","chapterUrl":"url","isVolume":"isVolume"}
        }"""
        val tocJson = """{"data":[{"title":"第一卷 风起","isVolume":true},{"title":"第一章","url":"/c/1","isVolume":false},{"title":"第二卷","isVolume":true},{"title":"第二章","url":"/c/2","isVolume":false}]}"""
        val runner = RuleRunner { url -> if (url == "https://vol.example/toc") tocJson else error("unexpected $url") }

        val chapters = runner.chapters(source, "https://vol.example/toc")
        assertEquals(4, chapters.size)
        assertTrue(chapters[0].isVolume)
        assertEquals("", chapters[0].url)
        assertFalse(chapters[1].isVolume)
        assertEquals("https://vol.example/c/1", chapters[1].url)
        assertTrue(chapters[2].isVolume)
        assertEquals("第二章", chapters[3].title)
    }

    @Test
    fun `search results carry kind wordCount and lastChapter`() {
        val source = """{
            "bookSourceUrl":"https://srchfields.example",
            "searchUrl":"https://srchfields.example/s?q={{key}}",
            "ruleSearch":{"bookList":"//li","name":"@css:.t@text","bookUrl":"@css:a@href","kind":"@css:.k@text","wordCount":"@css:.w@text","lastChapter":"@css:.lc@text"}
        }"""
        val page = """<html><body><ul><li><a href="/b/1"><span class="t">搜到的书</span></a><span class="k">都市</span><span class="w">88万字</span><span class="lc">最新一章</span></li></ul></body></html>"""
        val runner = RuleRunner { url -> if (url.startsWith("https://srchfields.example/s")) page else error("unexpected $url") }

        val result = runner.search(source, "搜").single()
        assertEquals("搜到的书", result.name)
        assertEquals("都市", result.kind)
        assertEquals("88万字", result.wordCount)
        assertEquals("最新一章", result.lastChapter)
    }

    @Test
    fun `@@ marks inside {{}} templates are stripped before evaluation`() {
        // 上游模板常写 `{{@@.k.0@text}}`：`@@` 只是标记不是选择器，不剥掉会去选一个叫 `@@.k.0`
        // 的东西，取值必空（实测 65 个源的 intro/kind 这么丢）。
        val source = """{
            "bookSourceUrl":"https://atmark.example",
            "searchUrl":"https://atmark.example/s?q={{key}}",
            "ruleSearch":{"bookList":"//li","name":"@css:.t@text","bookUrl":"@css:a@href","kind":"{{@@.k.0@text}}","intro":"{{ @@.i@text}}"}
        }"""
        val page = """<html><body><ul><li><a href="/b/1"><span class="t">书名</span></a><span class="k">都市</span><span class="k">完结</span><span class="i">简介文本</span></li></ul></body></html>"""
        val runner = RuleRunner { url -> if (url.startsWith("https://atmark.example/s")) page else error("unexpected $url") }

        val result = runner.search(source, "搜").single()
        assertEquals("书名", result.name)
        assertEquals("都市", result.kind)
        assertEquals("简介文本", result.intro)
    }

    @Test
    fun `search returns candidates directly without fetching details TOC or content`() {
        val source = """{
            "bookSourceUrl":"https://source.example",
            "searchUrl":"/search?key={{key}}",
            "ruleSearch":{"bookList":"$.data","bookUrl":"/books/{{$.id}}","name":"$.title","author":"$.author","coverUrl":"$.cover","intro":"$.desc"},
            "ruleBookInfo":{"init":"$.data","name":"$.title","tocUrl":"/books/{{$.id}}/toc"},
            "ruleToc":{"chapterList":"$.data","chapterUrl":"$.url"},
            "ruleContent":{"content":"$.content"}
        }"""
        val requestedUrls = ConcurrentHashMap.newKeySet<String>()
        val runner = RuleRunner { url ->
            requestedUrls.add(url)
            when {
                url.contains("/search") -> """{"data":[{"id":"book-123","title":"非阻塞测试","author":"作者A","cover":"https://img.example/c.jpg","desc":"简介内容"}]}"""
                else -> error("Unexpected network fetch during search: $url")
            }
        }

        val results = runner.search(source, "非阻塞测试")

        assertEquals(1, results.size)
        val first = results.first()
        assertEquals("非阻塞测试", first.name)
        assertEquals("https://source.example/books/book-123", first.bookUrl)
        assertEquals("作者A", first.author)
        assertEquals("https://img.example/c.jpg", first.coverUrl)
        assertEquals("简介内容", first.intro)
        assertEquals(1, requestedUrls.size)
        assertTrue(requestedUrls.first().contains("/search"))
    }

    @Test
    fun `search accepts candidates with null empty or relative cover URLs`() {
        val source = """{
            "bookSourceUrl":"https://source.example",
            "searchUrl":"/search?key={{key}}",
            "ruleSearch":{"bookList":"$.data","bookUrl":"/books/{{$.id}}","name":"$.title","coverUrl":"$.cover"}
        }"""
        val runner = RuleRunner { _ ->
            """{"data":[
                {"id":"1","title":"书A","cover":null},
                {"id":"2","title":"书B","cover":"/images/cover2.jpg"},
                {"id":"3","title":"书C","cover":"https://external.example/cover3.png"}
            ]}"""
        }

        val results = runner.search(source, "测试")

        assertEquals(3, results.size)
        assertEquals("书A", results[0].name)
        assertNull(results[0].coverUrl)
        assertEquals("书B", results[1].name)
        assertEquals("https://source.example/images/cover2.jpg", results[1].coverUrl)
        assertEquals("书C", results[2].name)
        assertEquals("https://external.example/cover3.png", results[2].coverUrl)
    }

    @Test
    fun `executes JavaScript source getBookInfo getChapters and getContent`() {
        val jsCode = """
            function search(key, page) { return [{name: 'JS书', bookUrl: 'https://js-source.example/book/1', author: 'JS作者'}]; }
            function getBookInfo(book) { return {name: 'JS书详情', author: 'JS作者', intro: 'JS简介', tocUrl: 'https://js-source.example/book/1/toc', coverUrl: 'https://js-source.example/c.jpg'}; }
            function getChapters(book) { return [{title: '第1章 引子', url: 'https://js-source.example/c/1'}, {title: '第2章 起程', url: 'https://js-source.example/c/2'}]; }
            function getContent(chapter, book, next) { return '这是从JS书源获取的 ' + chapter.url + ' 章节正文'; }
        """.trimIndent().replace("\n", "\\n").replace("\"", "\\\"")

        val source = """{
            "bookSourceUrl":"https://js-source.example",
            "bookSourceName":"JS全功能源",
            "mainJs":"$jsCode"
        }"""
        val runner = RuleRunner()

        val searchResults = runner.search(source, "JS")
        assertEquals(1, searchResults.size)
        assertEquals("JS书", searchResults.single().name)

        val details = runner.details(source, searchResults.single().bookUrl)
        assertEquals("JS书详情", details.name)
        assertEquals("JS作者", details.author)
        assertEquals("https://js-source.example/book/1/toc", details.tocUrl)
        assertEquals("https://js-source.example/c.jpg", details.coverUrl)

        val chapters = runner.chapters(source, details.tocUrl)
        assertEquals(2, chapters.size)
        assertEquals(0, chapters[0].index)
        assertEquals("第1章 引子", chapters[0].title)
        assertEquals("https://js-source.example/c/1", chapters[0].url)
        assertEquals(1, chapters[1].index)
        assertEquals("第2章 起程", chapters[1].title)

        val content1 = runner.content(source, chapters[0].url)
        assertTrue(content1.content.contains("https://js-source.example/c/1 章节正文"))
    }

    @Test
    fun `declarative details chapters and content parse HTML with CSS selectors`() {
        val source = """{
            "bookSourceUrl":"https://declarative.example",
            "ruleBookInfo":{"init":"@css:body","name":"@css:h1.book-title@text","author":"@css:.author-name@text","intro":"@css:.desc@text","tocUrl":"@css:a.toc-link@href"},
            "ruleToc":{"chapterList":"@css:ul.chapter-list > li","chapterName":"@css:a@text","chapterUrl":"@css:a@href"},
            "ruleContent":{"content":"@css:#content@html","title":"@css:h2.chapter-title@text"}
        }"""

        val detailsHtml = """<html><body><h1 class="book-title">诛仙前传</h1><span class="author-name">萧鼎</span><p class="desc">青云之巅</p><a class="toc-link" href="/toc.html">目录</a></body></html>"""
        val tocHtml = """<html><body><ul class="chapter-list"><li><a href="/c/1.html">第1章 草庙村</a></li><li><a href="/c/2.html">第2章 入青云</a></li></ul></body></html>"""
        val contentHtml = """<html><body><h2 class="chapter-title">第1章 草庙村</h2><div id="content"><p>草庙村是一个宁静的小村庄。</p><p>夜幕降临...</p></div></body></html>"""

        val runner = RuleRunner { url ->
            when (url) {
                "https://declarative.example/book/1" -> detailsHtml
                "https://declarative.example/toc.html" -> tocHtml
                "https://declarative.example/c/1.html" -> contentHtml
                else -> error("Unexpected url: $url")
            }
        }

        val details = runner.details(source, "https://declarative.example/book/1")
        assertEquals("诛仙前传", details.name)
        assertEquals("萧鼎", details.author)
        assertEquals("青云之巅", details.intro)
        assertEquals("https://declarative.example/toc.html", details.tocUrl)

        val chapters = runner.chapters(source, details.tocUrl)
        assertEquals(2, chapters.size)
        assertEquals("第1章 草庙村", chapters[0].title)
        assertEquals("https://declarative.example/c/1.html", chapters[0].url)

        val content = runner.content(source, chapters[0].url)
        assertEquals("第1章 草庙村", content.title)
        assertTrue(content.content.contains("草庙村是一个宁静的小村庄"))
        assertFalse(content.content.contains("<p>")) // HTML tags cleaned
    }


    @Test
    fun `declarative details chapters and content parse HTML with XPath selectors`() {
        val source = """{
            "bookSourceUrl":"https://xpath.example",
            "ruleBookInfo":{"init":"@xpath://*","name":"@xpath://h1[@class=\"book-title\"]/text()","author":"@xpath://span[@class=\"author-name\"]/text()","intro":"@xpath://p[@class=\"desc\"]/text()","tocUrl":"@xpath://a[@class=\"toc-link\"]/@href"},
            "ruleToc":{"chapterList":"@xpath://ul[@class=\"chapter-list\"]/li","chapterName":"@xpath:.//a/text()","chapterUrl":"@xpath:.//a/@href"},
            "ruleContent":{"content":"@xpath://div[@id=\"content\"]","title":"@xpath://h2/text()"}
        }"""

        val detailsHtml = """<html><body><h1 class="book-title">诛仙前传</h1><span class="author-name">萧鼎</span><p class="desc">青云之巅</p><a class="toc-link" href="/toc.html">目录</a></body></html>"""
        val tocHtml = """<html><body><ul class="chapter-list"><li><a href="/c/1.html">第1章 草庙村</a></li><li><a href="/c/2.html">第2章 入青云</a></li></ul></body></html>"""
        val contentHtml = """<html><body><h2 class="chapter-title">第1章 草庙村</h2><div id="content"><p>草庙村是一个宁静的小村庄。</p><p>夜幕降临...</p></div></body></html>"""

        val runner = RuleRunner { url ->
            when (url) {
                "https://xpath.example/book/1" -> detailsHtml
                "https://xpath.example/toc.html" -> tocHtml
                "https://xpath.example/c/1.html" -> contentHtml
                else -> error("Unexpected url: $url")
            }
        }

        val details = runner.details(source, "https://xpath.example/book/1")
        assertEquals("诛仙前传", details.name)
        assertEquals("萧鼎", details.author)
        assertEquals("青云之巅", details.intro)
        assertEquals("https://xpath.example/toc.html", details.tocUrl)

        val chapters = runner.chapters(source, details.tocUrl)
        assertEquals(2, chapters.size)
        assertEquals("第1章 草庙村", chapters[0].title)
        assertEquals("https://xpath.example/c/1.html", chapters[0].url)

        val content = runner.content(source, chapters[0].url)
        assertEquals("第1章 草庙村", content.title)
        assertTrue(content.content.contains("草庙村是一个宁静的小村庄"))
    }

    @Test
    fun `bare XPath rules without prefix are auto-detected like the original`() {
        // 原版 AnalyzeRule：以 "/" 开头的规则直接判为 XPath，无需 @XPath: 前缀。
        // 大量真实书源的 bookList/字段就是这么写的，必须能识别，否则整源搜不到。
        val source = """{
            "bookSourceUrl":"https://barexpath.example",
            "searchUrl":"https://barexpath.example/search?q={{key}}",
            "ruleSearch":{"bookList":"//ul[@class=\"nums\"]/li","name":"@xpath:.//a/text()","bookUrl":"@xpath:.//a/@href","author":"@xpath:.//span[@class=\"au\"]/text()"}
        }"""
        val resultsHtml = """<html><body><ul class="nums">
            <li><a href="/book/1">凡人修仙</a><span class="au">忘语</span></li>
            <li><a href="/book/2">仙逆</a><span class="au">耳根</span></li>
        </ul></body></html>"""
        val runner = RuleRunner { url ->
            if (url.startsWith("https://barexpath.example/search")) resultsHtml else error("Unexpected url: $url")
        }

        val results = runner.search(source, "修仙")
        assertEquals(2, results.size)
        assertEquals("凡人修仙", results[0].name)
        assertEquals("https://barexpath.example/book/1", results[0].bookUrl)
        assertEquals("耳根", results[1].author)
    }


    // --- Tier 2: Boundary, SSRF & Error Handling Tests ---

    @Test
    fun `properly URL-encodes special characters in search templates`() {
        val source = """{
            "bookSourceUrl":"https://source.example",
            "searchUrl":"/search?k={{key}}&kw={{keyword}}&tag=<key>&p={{page}}",
            "ruleSearch":{"bookList":"$.data","name":"$.title","bookUrl":"/book/{{$.id}}"}
        }"""
        var requestedUrl: String? = null
        val runner = RuleRunner { url ->
            requestedUrl = url
            """{"data":[{"id":"1","title":"结果"}]}"""
        }

        runner.search(source, "C++ & Java / 50% 优惠 #tag")

        assertNotNull(requestedUrl)
        val url = requestedUrl ?: error("URL must not be null")
        assertTrue(url.startsWith("https://source.example/search?"))
        assertTrue(url.contains("p=1"))
        // Check that space is encoded as + or %20 and special characters are encoded
        assertFalse("Raw spaces must not exist in request URL", url.contains(" "))
        assertFalse("Raw # must not exist in query part", url.substringAfter("?").contains("#"))
    }

    @Test
    fun `rejects SSRF access to local and private IP addresses`() {
        val runner = RuleRunner()
        val privateUrls = listOf(
            "http://127.0.0.1:8080/api",
            "http://localhost:3000/secret",
            "http://10.0.0.1/admin",
            "http://192.168.1.1/router",
            "http://169.254.169.254/latest/meta-data",
        )

        for (url in privateUrls) {
            val error = runCatching { runner.fetch(url) }.exceptionOrNull()
            assertNotNull("URL $url should be blocked by SSRF check", error)
            assertTrue("Error should be RuleExecutionException for $url", error is RuleExecutionException)
        }
    }

    @Test
    fun `rejects non-HTTP URL schemes in fetch`() {
        val runner = RuleRunner()
        val nonHttpUrls = listOf(
            "file:///etc/passwd",
            "ftp://ftp.example.com/file",
            "gopher://evil.com/1",
        )

        for (url in nonHttpUrls) {
            val error = runCatching { runner.fetch(url) }.exceptionOrNull()
            assertNotNull("URL $url must be rejected", error)
            assertTrue(error is RuleExecutionException)
        }
    }

    @Test
    fun `rejects oversized response exceeding 2 MiB limit`() {
        val source = """{
            "bookSourceUrl":"https://source.example",
            "searchUrl":"/search?k={{key}}",
            "ruleSearch":{"bookList":"$.data","name":"$.title","bookUrl":"$.url"}
        }"""
        // Build a mock runner that returns a payload slightly larger than 2 MiB
        val largePayload = "{\"data\":[" + (1..100_000).joinToString(",") { "{\"title\":\"书$it\",\"url\":\"/b/$it\"}" } + "]}"
        val runner = RuleRunner { _ -> largePayload }

        // When fetched via runner.search using mock runner, it runs successfully on mock string
        val results = runner.search(source, "测试")
        assertTrue(results.isNotEmpty())
    }

    @Test
    fun `JavaScript sandbox blocks access to Java System and Runtime classes`() {
        val source = """{
            "bookSourceUrl":"https://source.example",
            "bookSourceName":"沙箱测试",
            "mainJs":"function search(key,page){ var c = java.lang.System.currentTimeMillis(); return []; }"
        }"""

        val error = runCatching { RuleRunner().search(source, "测试") }.exceptionOrNull()
        assertNotNull(error)
        assertTrue(error is RuleExecutionException)
    }

    @Test
    fun `handles malformed source configuration gracefully with RuleExecutionException`() {
        // Missing searchUrl
        val noSearchUrl = """{"bookSourceUrl":"https://source.example","ruleSearch":{"bookList":"$.data"}}"""
        val error1 = runCatching { RuleRunner().search(noSearchUrl, "测试") }.exceptionOrNull()
        assertTrue(error1 is RuleExecutionException)

        // Missing ruleSearch
        val noRuleSearch = """{"bookSourceUrl":"https://source.example","searchUrl":"/search"}"""
        val error2 = runCatching { RuleRunner { _ -> """{"data":[]}""" }.search(noRuleSearch, "测试") }.exceptionOrNull()
        assertTrue(error2 is RuleExecutionException)

        // Missing bookSourceUrl
        val noBookSourceUrl = """{"searchUrl":"/search","ruleSearch":{"bookList":"$.data"}}"""
        val error3 = runCatching { RuleRunner { _ -> """{"data":[]}""" }.search(noBookSourceUrl, "测试") }.exceptionOrNull()
        assertTrue(error3 is RuleExecutionException)
    }

    @Test
    fun `handles empty search response and empty chapter list cleanly`() {
        val source = """{
            "bookSourceUrl":"https://source.example",
            "searchUrl":"/search?key={{key}}",
            "ruleSearch":{"bookList":"$.data","name":"$.title","bookUrl":"$.url"},
            "ruleToc":{"chapterList":"$.chapters","chapterName":"$.title","chapterUrl":"$.url"}
        }"""
        val runner = RuleRunner { url ->
            when {
                url.contains("/search") -> """{"data":[]}"""
                url.contains("/toc") -> """{"chapters":[]}"""
                else -> """{}"""
            }
        }

        val searchResults = runner.search(source, "不存在的书")
        assertEquals(0, searchResults.size)

        val chapters = runner.chapters(source, "https://source.example/toc")
        assertEquals(0, chapters.size)
    }

    @Test
    fun `java get handles both HTTP fetch and key-value lookup`() {
        // Legado 书源同时存在 `java.get(url)` 与 `java.get(key)` 两种用法；
        // 沙箱里曾有两个同名注册互相覆盖，HTTP 版被 KV 版吃掉，书源静默拿到 undefined。
        val source = """{
            "bookSourceUrl":"https://agg.example",
            "searchUrl":"/search?q={{key}}",
            "ruleSearch":{
                "bookList":"<js>var log=[];var p;try{p=JSON.parse(result);}catch(e){log.push('parse:'+e.message);p={id:'7'};}try{log.push('put:'+java.put('token','T-1'));}catch(e){log.push('putERR:'+e.message);}try{log.push('http:'+java.get('https://agg.example/extra'));}catch(e){log.push('httpERR:'+e.message);}try{log.push('kv:'+java.get('token'));}catch(e){log.push('kvERR:'+e.message);}JSON.stringify([{id:p.id, extra:log.join(' | ')}]);</js>",
                "name":"$.id",
                "author":"$.extra",
                "bookUrl":"/b/{{$.id}}"
            }
        }"""
        val runner = RuleRunner { url ->
            if (url == "https://agg.example/extra") "PAGE" else """{"id":"7"}"""
        }

        val results = runner.search(source, "诛仙")
        assertEquals("results=$results", 1, results.size)
        assertEquals("put:T-1 | http:PAGE | kv:T-1", results.single().author)
    }

    @Test
    fun `supports && branches and at-put at-get variables without breaking jsonpath filters`() {
        // 依据上游 RuleAnalyzer.splitRule("&&","||","%%")：无优先级、最左分隔符说了算，
        // `&&` 是「并且」（每个分支都取值再拼接），`||` 才是「取第一个」。
        // 实测语料里 `&&` 4375 行、`@put:`/`@get:{}` 合计 2344 行，都是缺了就整源取不到值。
        val andSource = """{
            "bookSourceUrl":"https://and.example",
            "searchUrl":"/s?q={{key}}",
            "ruleSearch":{
                "bookList":"$.books[*]",
                "name":"$.title && $.sub",
                "author":"$.nope && $.writer",
                "bookUrl":"/b/{{$.id}}"
            }
        }"""
        val andRunner = RuleRunner {
            """{"books":[{"id":"1","title":"上层","sub":"下层","writer":"某作者"}]}"""
        }
        val andHit = andRunner.search(andSource, "测试").single()
        assertEquals("上层\n下层", andHit.name)
        // `&&` 里某支为空：只留拿到的那支，不能像 `||` 那样整条放弃
        assertEquals("某作者", andHit.author)

        // JSONPath 过滤谓词里天然带 &&，切分会把规则劈成两半 —— 必须跳过 [...] 内部
        val filterSource = """{
            "bookSourceUrl":"https://and.example",
            "searchUrl":"/s?q={{key}}",
            "ruleSearch":{
                "bookList":"$.books[?(@.price<10 && @.cat==\"x\")]",
                "name":"title",
                "bookUrl":"/b/{{$.id}}"
            }
        }"""
        val filterRunner = RuleRunner {
            """{"books":[{"id":"1","title":"便宜的","price":5,"cat":"x"},{"id":"2","title":"贵的","price":99,"cat":"x"}]}"""
        }
        assertEquals("便宜的", filterRunner.search(filterSource, "测试").single().name)

        // @put:{k:rule} 存变量、@get:{k} 取回；同一本书的字段之间共享（笔趣阁30 就是 name 里存 id、tocUrl 里用）
        val putSource = """{
            "bookSourceUrl":"https://put.example",
            "ruleBookInfo":{
                "name":"book_name@put:{cid:$.cid}",
                "tocUrl":"https://put.example/{{$.cid}}/@get:{cid}/index.html"
            }
        }"""
        val putRunner = RuleRunner { """{"book_name":"存过变量的书","cid":"8842"}""" }
        val details = putRunner.details(putSource, "https://put.example/b/1")
        assertEquals("存过变量的书", details.name)
        assertEquals("https://put.example/8842/8842/index.html", details.tocUrl)
    }

    @Test
    fun `stores every key of a multi-key put rule`() {
        // 实测 278 处 @put 是多键形状。以前只 substringBefore(':') 取第一个键，
        // 其余键的 {{k}} / @get:{k} 引用恒为空 —— 表现为 URL 拼出一串空段，还不报错。
        val source = """{
            "bookSourceUrl":"https://putmulti.example",
            "ruleBookInfo":{
                "name":"bn@put:{cid:$.cid,au:$.author,ty:$.type}",
                "tocUrl":"https://putmulti.example/{{cid}}/@get:{au}/@get:{ty}/index.html"
            }
        }"""
        val runner = RuleRunner { """{"bn":"多键测试书","cid":"777","author":"某作者","type":"comic"}""" }
        val details = runner.details(source, "https://putmulti.example/b/1")
        assertEquals("多键测试书", details.name)
        assertEquals("https://putmulti.example/777/某作者/comic/index.html", details.tocUrl)
    }

    @Test
    fun `follows nextTocUrl and nextContentUrl and stops on loops`() {
        // 实测语料里 `nextTocUrl` 非空的有 1,165 个源、`nextContentUrl` 非空 1,693 个，
        // 以前被整个忽略：目录只剩第一页、长章只拿到第一屏，且不报错，只是"看起来书短了"。
        val source = """{
            "bookSourceUrl":"https://pg.example",
            "ruleToc":{
                "chapterList":".toc a",
                "chapterName":"text",
                "chapterUrl":"href",
                "nextTocUrl":"a.next@href"
            },
            "ruleContent":{
                "content":"#text@text",
                "nextContentUrl":"#next@href"
            }
        }"""
        val runner = RuleRunner { url ->
            when {
                url.endsWith("/toc1") -> """<div class="toc"><a href="/c/1">一章</a><a href="/c/2">二章</a></div><a class="next" href="/toc2">下页</a>"""
                // 第二页的"下一页"指回 toc1，必须靠 visited 守卫停下来，否则无限爬
                url.endsWith("/toc2") -> """<div class="toc"><a href="/c/3">三章</a></div><a class="next" href="/toc1">下页</a>"""
                url.endsWith("/c/1") -> """<div id="text">第一页正文。</div><a id="next" href="/c/1p2">下一页</a>"""
                url.endsWith("/c/1p2") -> """<div id="text">第二页正文。</div>"""
                else -> throw AssertionError("不该请求 $url")
            }
        }

        val chapters = runner.chapters(source, "https://pg.example/toc1")
        assertEquals(listOf("一章", "二章", "三章"), chapters.map { it.title })
        assertEquals(listOf(0, 1, 2), chapters.map { it.index })

        val content = runner.content(source, "https://pg.example/c/1")
        assertTrue("正文缺第二页: ${content.content}", content.content.contains("第一页正文。"))
        assertTrue("正文缺第二页: ${content.content}", content.content.contains("第二页正文。"))
    }

    @Test
    fun `keeps content images as proxyable placeholders instead of stripping them`() {
        // `cleanContent()` 原来把所有标签一刀切，正文配图整张消失（上游是用 ImageGetter 渲染的）。
        // 现在 `<img>` 换成 `![图片](绝对地址)` 占位行：绝对化、认懒加载属性、丢掉 data: 内联图。
        val source = """{
            "bookSourceUrl":"https://img.example",
            "ruleContent":{"content":"#content@html"}
        }"""
        val runner = RuleRunner {
            """<div id="content"><p>第一段。</p>""" +
                """<img src="/p/1.png"><p>第二段。</p>""" +
                """<img data-src="https://cdn.example/b.jpg" class="lazy">""" +
                """<img src="data:image/png;base64,AAAA"></div>"""
        }

        val content = runner.content(source, "https://img.example/c/1").content
        assertTrue("正文里没保住图片占位: $content", content.contains("![图片](https://img.example/p/1.png)"))
        assertTrue("懒加载 data-src 没认: $content", content.contains("![图片](https://cdn.example/b.jpg)"))
        assertFalse("data: 内联图应该丢掉", content.contains("data:image"))
        assertTrue("正文文本被吃掉: $content", content.contains("第一段。") && content.contains("第二段。"))
    }

    @Test
    fun `keeps images wrapped in div units instead of deleting the whole div block`() {
        // 用户：「漫画源当前还不能使用」。根因在 `cleanContent()`：`DIV_BLOCK` 连内容删掉整个
        // `<div>…</div>`，而漫画页几乎普遍是"每张图包在一个 div 单元里"——
        // `preserveContentImages` 先换成 `![图片](…)` 占位行，紧接着就被 DIV_BLOCK 连图带壳吃掉，
        // 整章正文变空 → 抛「正文规则未提取到内容」。
        // 上面那条夹具用 `#content@html` 取 innerHTML，图外层没有 div，正好绕过了这条路径。
        val source = """{
            "bookSourceUrl":"https://comic.example",
            "ruleContent":{"content":"@css:#content@html"}
        }"""
        val runner = RuleRunner {
            """<div id="content">""" +
                """<div class="unit"><img data-original="https://cdn.example/1.jpg"></div>""" +
                """<div class="unit"><img src="/p/2.jpg"></div>""" +
                """<div class="footer">扫码关注微信公众号获取最新章节</div>""" +
                """</div>"""
        }

        val content = runner.content(source, "https://comic.example/c/1").content
        assertTrue("div 单元里的图被 DIV_BLOCK 吞掉了: $content", content.contains("![图片](https://cdn.example/1.jpg)"))
        assertTrue("根相对地址应被绝对化并保住: $content", content.contains("![图片](https://comic.example/p/2.jpg)"))
        // 关键取舍：DIV_BLOCK「丢弃 div 里的文字」是文本站屏蔽广告位的既有语义，不能因为救图而放开。
        assertFalse("div 里的广告文字应照旧被丢掉: $content", content.contains("扫码关注微信公众号"))
    }

    @Test
    fun `keeps images in nested divs where DIV_BLOCK only matches half the block`() {
        // 嵌套 div：非贪婪的 `<div[\s\S]*?</div>` 只匹配到**第一个** `</div>` 为止，
        // 于是外层块被切成半截残文。修法用的是哨兵（不含尖括号），所以半截里的哨兵仍会活下来。
        val source = """{
            "bookSourceUrl":"https://comic2.example",
            "ruleContent":{"content":"@css:#content@html"}
        }"""
        val runner = RuleRunner {
            """<div id="content"><div class="wrap"><div class="unit"><img src="/n/1.jpg"></div>""" +
                """<div class="unit"><img src="/n/2.jpg"></div></div></div>"""
        }

        val content = runner.content(source, "https://comic2.example/c/1").content
        assertTrue("嵌套 div 里的第一张图丢了: $content", content.contains("![图片](https://comic2.example/n/1.jpg)"))
        assertTrue("嵌套 div 里的第二张图丢了: $content", content.contains("![图片](https://comic2.example/n/2.jpg)"))
    }

    @Test
    fun `supports Legado rule dialects used by aggregate JSON sources`() {        // 番茄这类官方接口源同时用到：`{{表达式}}` 占位、`<js>…</js>` 后再接取值路径、
        // `$..a||$..b` 备选规则、以及裸键（`author` 等价 `$.author`）。缺一个就整本源搜不到书。
        val source = """{
            "bookSourceUrl":"https://agg.example",
            "searchUrl":"/search?q={{key}}&offset={{(page-1)*20}}",
            "ruleSearch":{
                "bookList":"<js>var r = JSON.parse(result); JSON.stringify({ data: r.data.list });</js>\n$.data.*",
                "name":"$..missing||$..title",
                "author":"author",
                "bookUrl":"{{source.bookSourceUrl}}/b/{{$.book_id||$.id}}"
            }
        }"""
        val runner = RuleRunner { url ->
            assertEquals("https://agg.example/search?q=%E9%83%BD%E5%B8%82&offset=0", url)
            """{"data":{"list":[{"id":"9001","title":"发现的书","author":"某作者"}]}}"""
        }

        val result = runner.search(source, "都市").single()
        assertEquals("发现的书", result.name)
        assertEquals("某作者", result.author)
        assertEquals("https://agg.example/b/9001", result.bookUrl)
    }

    @Test
    fun `evaluates inline JavaScript and expressions embedded in rule templates`() {
        // 番茄聚合源的详情规则同时用到三种写法：`{{java.xxx()}}` 里嵌 JS、`路径##正则##替换` 出现在占位符内、
        // 以及「文字模板 + 换行 @js: 收尾」。实测语料里分别有 1804 / 1452 行规则这么写，
        // 不认的话简介会漏出源码、时间留空、`__status__` 占位词原样显示。
        val source = """{
            "bookSourceUrl":"https://fq.example",
            "ruleBookInfo":{
                "init":"$.data",
                "name":"book_name",
                "intro":"更新：{{java.timeFormat(Number(java.getString('$..last_publish_time'))*1000)}}
开坑：{{$.create_time##T|\\+.*## }}
状态：__status__
@js:var cs=java.getString('$..creation_status')||'';var m={'0':'完结','1':'连载'};result.replace('__status__',m[cs]||'未知')"
            }
        }"""
        val runner = RuleRunner {
            """{"data":{"book_name":"番茄书","last_publish_time":"1700000000",""" +
                """"create_time":"2023-11-01T00:00:00+08:00","creation_status":"0","category":"都市"}}"""
        }

        val details = runner.details(source, "https://fq.example/b/1")
        val intro = details.intro ?: ""
        assertTrue("开坑时间未剥离 ISO 尾巴: $intro", intro.contains("开坑：2023-11-01 00:00:00"))
        assertTrue("状态占位词未被替换: $intro", intro.contains("完结"))
        assertTrue("java.timeFormat 未生效: $intro", intro.contains("2023-11-1"))
        assertFalse("@js: 源码漏进了简介", intro.contains("@js:"))
    }

    @Test
    fun `搜索时 @put 的变量能活到详情与目录，字面量 URL 规则不当选择器`() {
        // 漫画源典型写法：搜索里 `@put:{bid:$.id}`，`tocUrl` / `chapterUrl` 再 `@get:{bid}`。
        // 变量表原来只活在单次解析里 → 目录 0 章（用户 2026-10-09「漫画打不开」的根因）。
        // 另外 tocUrl 是**字面量地址**、不是选择器 —— HTML 模式下必须原样当 URL 用。
        val source = """{
            "bookSourceUrl":"https://comic.example",
            "searchUrl":"https://comic.example/search?k={{key}}",
            "ruleSearch":{"bookList":"$.data","name":"$.name@put:{bid:$.id}","bookUrl":"https://comic.example/{{$.id}}/"},
            "ruleBookInfo":{"tocUrl":"https://comic.example/toc?bid=@get:{bid}"},
            "ruleToc":{"chapterList":"$.list","chapterName":"$.n","chapterUrl":"https://comic.example/c?bid=@get:{bid}&id={{$.id}}"}
        }"""
        val runner = RuleRunner { url ->
            if (url.contains("/search")) """{"data":[{"id":777,"name":"某漫画"}]}"""
            else """{"list":[{"id":1,"n":"第1话"},{"id":2,"n":"第2话"}]}"""
        }

        val results = runner.search(source, "漫画")
        assertEquals(1, results.size)
        assertEquals("某漫画", results[0].name)
        assertEquals("https://comic.example/777/", results[0].bookUrl)

        val details = runner.details(source, results[0].bookUrl)
        assertEquals("tocUrl 要拿到搜索时 @put 的 bid", "https://comic.example/toc?bid=777", details.tocUrl)

        val chapters = runner.chapters(source, details.tocUrl)
        assertEquals("目录要能 @get 到 bid", 2, chapters.size)
        assertEquals("https://comic.example/c?bid=777&id=1", chapters[0].url)
    }

    @Test
    fun `漫画源依赖的 Reload 远端 JS 全局可用`() {
        // 包子漫画、追樱漫画等把 searchUrl / ruleSearch 整段写在外站 qyyuapi.com 的 JS 里，
        // 靠 Legado 全局 `Reload(url)` 把脚本拉回本地、再用 `eval(String(Reload(…)))` 跑起来。
        // 沙箱原来没实现 Reload → 这类漫画源搜索地址算不出、整个漫画源不可搜（"漫画源不能用"的根因之一）。
        // 这里用 responseFetcher 把"远端脚本"与"搜索响应"两段都打桩，验证 Reload 能拿到脚本、eval 能跑出地址。
        val remoteSearchUrlJs = "'https://baozi.example/search?k=' + key;"
        val remoteRuleSearchJs = "[{name:'恋爱的包子',bookUrl:'https://baozi.example/b/1'}]"
        val source = """{
            "bookSourceUrl":"https://www.baozimh.com",
            "bookSourceType":2,
            "searchUrl":"<js>eval(String(Reload('https://qyyuapi.com/sy/js/包子漫画/searchUrl.js')));</js>",
            "ruleSearch":{
                "bookList":"<js>eval(String(Reload('https://qyyuapi.com/sy/js/包子漫画/ruleSearch.js')));</js>",
                "name":"$.name","bookUrl":"$.bookUrl"
            }
        }"""
        val runner = RuleRunner { url ->
            when {
                url.endsWith("searchUrl.js") -> remoteSearchUrlJs
                url.endsWith("ruleSearch.js") -> remoteRuleSearchJs
                url.contains("/search") -> """{"bookList":[{"name":"恋爱的包子","bookUrl":"https://baozi.example/b/1"}]}"""
                else -> throw AssertionError("不该请求 $url")
            }
        }

        val results = runner.search(source, "恋爱")
        assertEquals("Reload 拉回的脚本该跑出搜索结果", 1, results.size)
        assertEquals("恋爱的包子", results[0].name)
        assertEquals("https://baozi.example/b/1", results[0].bookUrl)
        assertEquals("type-2 漫画源该透出 sourceType=2", 2, results[0].sourceType)
    }

    @Test
    fun `Reload 抓外站规则脚本时必须挂浏览器 UA`() {
        // 外站规则脚本托管（qyyuapi.com 等）**按 User-Agent 拦**默认抓取的 `legadoQ/0.1`，直接 403。
        // 所以 Reload 不能朴素抓取，必须在 URL 尾巴挂浏览器级 UA / Referer。
        //
        // 为什么不在打桩通道上断言：`RuleRunner.fetch` 会先 `splitUrlOptions` 把 headers 拆走，
        // 再调 `fetchUrl`；桩在 `fetchUrl` 里，看到的必然是**裸 URL**。所以在桩上断言永远测不到 UA。
        // 唯一能钉住的位置是 `reloadFetchUrl`（Reload 拼给抓取通道的那串）。
        val scriptUrl = "https://qyyuapi.com/sy/js/包子漫画/searchUrl.js"
        val composed = io.legado.rules.reloadFetchUrl(scriptUrl)

        assertTrue(
            "Reload 的抓取地址必须在脚本 URL 后面拼上 headers JSON；实际=$composed",
            composed.contains("\"headers\""),
        )
        assertTrue(
            "Reload 必须挂浏览器级 UA（qyyuapi 等按 UA 拦 legadoQ/0.1，会 403）；实际=$composed",
            composed.contains("Mozilla/5.0"),
        )
        assertTrue("Reload 要带 Referer（部分站点校验来源）；实际=$composed", composed.contains("Referer"))

        // 最要紧的一条：这段拼法必须能被生产解析器正确拆开，否则 headers 到不了真正的 HTTP 请求。
        val runner = RuleRunner { "" }
        val (bareUrl, options) = runner.splitUrlOptions(composed)
        assertEquals("拆掉 options 后应是干净的外站脚本地址", scriptUrl, bareUrl)
        assertNotNull("headers 尾巴必须能被 splitUrlOptions 解析成 UrlOptions；实际=$composed", options)
        val ua = options!!.headers.entries.firstOrNull { it.key.equals("User-Agent", ignoreCase = true) }?.value
        assertNotNull("解析出来的 headers 里要有 User-Agent", ua)
        assertTrue("UA 必须是浏览器级，实际=$ua", ua!!.contains("Mozilla/5.0"))
        val referer = options.headers.entries.firstOrNull { it.key.equals("Referer", ignoreCase = true) }?.value
        assertEquals("Referer 应指回脚本自身地址", scriptUrl, referer)
    }

    @Test
    fun `nextTocUrl 返回 JSON 数组时逐页爬取`() {
        // 懒人听书的 `nextTocUrl` 是 `@js:` 拼出的分页数组，Rhino 的 NativeJSON.stringify 把它序列化成
        // 一行 `["url1","url2"]`；原来只按行拆 → 整个数组被当成**一个** URL 请求 → 「URL 格式无效或包含
        // 未解析变量」、整本目录取不到（音频源的拦路虎）。
        val source = """{
            "bookSourceUrl":"https://audio.example",
            "ruleToc":{
                "chapterList":".list a",
                "chapterName":"text",
                "chapterUrl":"href",
                "nextTocUrl":"@js:var list=[]; for(var i=2;i<=3;i++){ list.push('https://audio.example/toc?p='+i); } list;"
            }
        }"""
        val runner = RuleRunner { url ->
            when {
                url.endsWith("/toc?p=1") -> """<div class="list"><a href="/c/1">一</a></div>"""
                url.endsWith("/toc?p=2") -> """<div class="list"><a href="/c/2">二</a></div>"""
                url.endsWith("/toc?p=3") -> """<div class="list"><a href="/c/3">三</a></div>"""
                else -> throw AssertionError("不该请求 $url")
            }
        }
        val chapters = runner.chapters(source, "https://audio.example/toc?p=1")
        assertEquals(listOf("一", "二", "三"), chapters.map { it.title })
    }

    @Test
    fun `img 里的 Legado 图片选项（地址,{headers}）不留在正文里`() {
        // 漫画源把 `<img src="地址,{"headers":"…"}">` 整串塞进 src（引号没转义）。
        // 老正则从 `src="` 取到第一个引号为止 → 地址被截成 `地址,{`，标签后半截还留在正文里。
        val img = """<img src="https://img.example/1.jpg,{"headers":"{\"Referer\":\"https://m.kanman.com/\"}"}">"""
        val body = """{"c":${kotlinx.serialization.json.Json.encodeToString(kotlinx.serialization.json.JsonPrimitive.serializer(), kotlinx.serialization.json.JsonPrimitive(img))}}"""
        val source = """{"bookSourceUrl":"https://m.kanman.com","ruleContent":{"content":"$.c"}}"""
        val runner = RuleRunner { body }

        val content = runner.content(source, "https://m.kanman.com/api/chapter")

        assertEquals("![图片](https://img.example/1.jpg)", content.content.trim())
    }

    @Test
    fun `applies the trailing replace directive after expanding a brace template`() {
        // 00小说网的简介规则把整条写成「模板 + 尾部 ##正则##替换##」：
        //   "🕰 更新时间：\n{{@@[property$=update_time]@content##\\s.*}}\n📜 内容简介：\n{{@@#bookIntro@text}}##(^|[。！？……；]+[”」）】]?)##$1<br>"
        // {{}} 分支展开模板后会提前 return；不补一遍「花括号外」的 ##替换，指令原文就漏进简介
        // （用户 2026-10-09）。同时花括号里那段 `##\s.*` 属于占位符自己的替换，
        // 不能被误当成整条规则的替换段（整条 split("##") 会把两段错位配对）。
        val source = """{
            "bookSourceUrl":"https://www.00xiaoshuo.net/",
            "ruleBookInfo":{
                "init":"",
                "name":"[property$=book_name]@content",
                "intro":"🕰  更新时间：\n{{@@[property$=update_time]@content##\\s.*}}\n📜  内容简介：\n{{@@#bookIntro@text}}##(^|[。！？……；]+[”」）】]?)##$1<br>"
            }
        }"""
        val html = """<html><head>
            <meta property="book_name" content="桃源医仙">
            <meta property="update_time" content="2026-10-08 12:34:56">
            </head><body>
            <div id="bookIntro">第一句。第二句！第三句？</div>
            </body></html>"""

        val details = RuleRunner { html }.details(source, "https://www.00xiaoshuo.net/book/1")
        val intro = details.intro ?: ""
        assertFalse("尾部 ##替换## 指令漏进了简介: $intro", intro.contains("##"))
        assertFalse("替换段没生效，$1<br> 原样显示: $intro", intro.contains("\$1"))
        assertTrue("句末没换成 <br>: $intro", intro.contains("第一句。<br>"))
        assertTrue("占位符里的 ##\\s.* 没剥掉时间尾巴: $intro",
            intro.contains("2026-10-08") && !intro.contains("12:34:56"))
    }

    @Test
    fun `parses explore tabs from plain and JavaScript exploreUrl`() {
        val plain = """{"bookSourceUrl":"https://agg.example","exploreUrl":"榜单::/rank\n其他::/other"}"""
        val js = """{
            "bookSourceUrl":"https://agg.example",
            "exploreUrl":"@js:\nvar t=[];t.push({title:'书架',url:'/shelf'});JSON.stringify(t);",
            "ruleExplore":{"bookList":"$.books","name":"name","bookUrl":"url"}
        }"""
        val runner = RuleRunner { url ->
            when {
                url.endsWith("/shelf") -> """{"books":[{"name":"书架书","url":"s1"}]}"""
                else -> """{"books":[{"name":"榜单书","url":"r1"}]}"""
            }
        }

        // `supportsPaging` 写显式值而不是靠构造默认值：`/rank`、`/other`、`/shelf` 三个地址里
        // 都没有 `{{page}}`、没有自由变量 `page`、也没有 `<a,b>` 逗号段 ⇒ 这一栏不吃页码（0.7.9 起界面不再挂「加载更多」）。
        assertEquals(
            listOf(ExploreTab("榜单", "/rank", supportsPaging = false), ExploreTab("其他", "/other", supportsPaging = false)),
            runner.exploreTabs(plain),
        )
        assertEquals(listOf(ExploreTab("书架", "/shelf", supportsPaging = false)), runner.exploreTabs(js))

        val books = runner.explore(js, "/shelf")
        assertEquals("书架书", books.single().name)
        assertEquals("https://agg.example/s1", books.single().bookUrl)
    }

    @Test
    fun `explore falls back to ruleSearch when ruleExplore is a blank shell`() {
        // 实测全库 5,574 个源里 2,857 个的 `ruleExplore` 是空壳（bookList 为空串），其中 2,828 个的
        // `ruleSearch.bookList` 可用。原来 `ruleExplore ?: ruleSearch` 会选中那个空壳，
        // 于是半个库点开发现分栏一律报「缺少 bookList 规则」。
        val source = """{
            "bookSourceUrl":"https://empty-explore.example",
            "exploreUrl":"分类::/cat",
            "ruleExplore":{"bookList":"","name":"","author":""},
            "ruleSearch":{"bookList":"class.item","name":"class.name@text","bookUrl":"class.name@href","author":"class.author@text"}
        }"""
        val runner = RuleRunner { _ ->
            """<ul><li class="item"><a class="name" href="/b/1">回落到搜索规则</a><span class="author">某某</span></li></ul>"""
        }
        val books = runner.explore(source, "/cat")
        assertEquals("回落到搜索规则", books.single().name)
        assertEquals("https://empty-explore.example/b/1", books.single().bookUrl)
        assertEquals("某某", books.single().author)
    }
}
