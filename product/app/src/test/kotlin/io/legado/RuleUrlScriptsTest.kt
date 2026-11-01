package io.legado

import io.legado.data.getSourceVariable
import io.legado.rules.RuleRunner
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 书源**地址规则**里的几类方言（对照上游 `AnalyzeUrl` / `SharedJsScope`）：
 *
 * 1. 地址尾部挂 `@js:`（猫耳有声那类：前半个地址是普通文本，后半段脚本用 `result` 接着算）；
 * 2. `{{cookie.removeCookie(...)}}` 这类副作用占位符必须替换成**空串**（上游返回 Unit）；
 * 3. jsLib 写成 `{"名称":"https://…/jsLib.js"}` 的远端脚本映射，要下载后求值；
 * 4. 相对章节地址带 `,{"webView":"true"}` 参数尾巴，仍要拼成绝对地址。
 *
 * 全部用 `RuleRunner { url -> … }` 注入假响应，不碰网络。
 */
class RuleUrlScriptsTest {

    private val searchHtml = """
        <html><body>
            <div class="item"><a class="n" href="/b/1">书名</a></div>
        </body></html>
    """.trimIndent()

    private fun json(text: String): String = JsonPrimitive(text).toString()

    @Test
    fun `地址末尾的 @js 段落通过 result 接手前面的地址`() {
        val source = """
            {
              "bookSourceUrl":"https://example.com",
              "bookSourceName":"尾部脚本",
              "searchUrl": ${json("https://example.com/search?s={{key}}&page={{page}}\n@js:java.put('k', key); java.put('p', page); result")},
              "ruleSearch":{
                "bookList":"class.item",
                "name":"class.n@text@js:result + '|' + java.put('mark', '尾部')",
                "bookUrl":"class.n@href"
              }
            }
        """.trimIndent()

        var requested: String? = null
        val runner = RuleRunner { url -> requested = url; searchHtml }
        val results = runner.search(source, "关键词")

        assertEquals(1, results.size)
        assertEquals(
            "尾部脚本的结果应作为地址，{{key}}/{{page}} 仍要展开：$requested",
            "https://example.com/search?s=%E5%85%B3%E9%94%AE%E8%AF%8D&page=1",
            requested,
        )
        // 字段脚本里拿不到 URL 阶段的 key 绑定（上游同样只在地址分析时注入），用字面量验证 put 的返回值参与拼接
        assertEquals("书名|尾部", results[0].name)
    }

    @Test
    fun `副作用占位符 cookie removeCookie 不再把 true 拼进地址`() {
        val source = """
            {
              "bookSourceUrl":"https://example.com",
              "bookSourceName":"副作用前缀",
              "searchUrl": ${json("{{cookie.removeCookie(source.getKey())}} /search/{{key}}")},
              "ruleSearch":{"bookList":"class.item","name":"class.n@text","bookUrl":"class.n@href"}
            }
        """.trimIndent()

        var requested: String? = null
        val runner = RuleRunner { url -> requested = url; searchHtml }
        runner.search(source, "词")

        assertEquals("https://example.com/search/%E8%AF%8D", requested)
    }

    @Test
    fun `jsLib 是远端脚本映射时下载后求值，登录脚本不参与普通规则`() {
        // 登录脚本只在登录流程里执行（上游 `BaseSource.login()` / loginUi / 登录按钮）。
        // 以前这里每次规则求值都预跑 loginUrl 的 JS，qyyuapi 系脚本顶部 `put($$$)` 一报错，
        // 整源搜索就直接失败。这里把「登录脚本一跑就炸」钉成判据：搜索必须照常完成。
        val libJs = "function 包装(v){ return '【' + v + '】'; } function 构造搜索地址(){ return 'https://example.com'; }"
        val source = """
            {
              "bookSourceUrl":"https://example.com",
              "bookSourceName":"远端脚本库",
              "jsLib": ${json("""{"lib":"https://cdn.example/lib.js"}""")},
              "loginUrl": "throw new Error('登录脚本不该在搜索时执行');",
              "searchUrl": "{{构造搜索地址()}}/search?k={{key}}",
              "ruleSearch":{
                "bookList":"class.item",
                "name":"class.n@text@js:包装(result)",
                "bookUrl":"class.n@href"
              }
            }
        """.trimIndent()

        val fetched = mutableListOf<String>()
        val runner = RuleRunner { url ->
            fetched += url
            if (url == "https://cdn.example/lib.js") libJs else searchHtml
        }
        val results = runner.search(source, "x")

        assertEquals(1, results.size)
        assertEquals("jsLib 里的工具函数对字段脚本可见：${results[0].name}", "【书名】", results[0].name)
        assertTrue("jsLib 的远端地址要被下载：$fetched", fetched.contains("https://cdn.example/lib.js"))
        assertTrue("相对搜索地址要按书源地址解析：$fetched", fetched.any { it.startsWith("https://example.com/search") })
    }

    @Test
    fun `远端搜索脚本自取登录地址时裸 put 把默认变量写回`() {
        // qyyuapi 系 searchUrl.js 的第一行是 `eval(String(source.loginUrl))`，
        // loginUrl.js 在没有变量时走 catch 分支 `put($$$)` 落默认设置。这三件事缺一个整源就搜不动：
        // ① `source.loginUrl` 原文要能读到；② 裸 `put(对象)` 要写回书源变量；③ 普通规则求值不能预跑登录脚本。
        val db = io.legado.data.Database(java.nio.file.Files.createTempFile("qyyuapi-", ".sqlite").toString())
            .apply { initialize() }
        try {
            val libJs = "function 站点(){ return JSON.parse(source.getVariable()).url; }"
            val loginJs = "if (!String(source.getVariable())) { put({url:'https://site.example'}); }"
            val source = """
                {
                  "bookSourceUrl":"https://qyyuapi.example",
                  "bookSourceName":"脚本自取",
                  "jsLib": ${json(libJs)},
                  "loginUrl": ${json(loginJs)},
                  "searchUrl": "<js>eval(String(source.loginUrl)); result = 站点() + '/search?k=' + key;</js>",
                  "ruleSearch":{"bookList":"class.item","name":"class.n@text","bookUrl":"class.n@href"}
                }
            """.trimIndent()

            var requested: String? = null
            val runner = RuleRunner({ url -> requested = url; searchHtml }, db)
            val results = runner.search(source, "abc")

            assertEquals(1, results.size)
            assertEquals(
                "searchUrl 自取登录脚本后要能拿到 put 写下的默认 url：$requested",
                "https://site.example/search?k=abc",
                requested,
            )
            assertEquals(
                "裸 put(对象) 要序列化后写回 source.variable（上游 putVariable 同一份存储）",
                """{"url":"https://site.example"}""",
                db.getSourceVariable("https://qyyuapi.example"),
            )
        } finally {
            db.close()
        }
    }

    @Test
    fun `带中文路径的 Reload 地址不能把非 ASCII 塞进 Referer`() {
        val scriptUrl = "https://qyyuapi.com/sy/js/再漫画/jsLib.js"
        val composed = io.legado.rules.reloadFetchUrl(scriptUrl)
        val runner = RuleRunner { "" }
        val (bareUrl, options) = runner.splitUrlOptions(composed)

        assertEquals("地址本身保持原样，路径里的中文交给 HTTP 层编码", scriptUrl, bareUrl)
        val headers = options?.headers.orEmpty()
        val referer = headers.entries.firstOrNull { it.key.equals("Referer", ignoreCase = true) }?.value
        assertTrue("Referer 里必须带上脚本地址：$headers", referer?.contains("%E5%86%8D%E6%BC%AB%E7%94%BB") == true)
        headers.values.forEach { value ->
            assertTrue(
                "JDK HttpClient 只收可打印 ASCII，否则发请求前就抛 invalid header value：$value",
                value.all { it.code in 0x20..0x7e },
            )
        }
        // 真正的判据：按这组头构造请求不抛异常（旧实现这里抛 invalid header value）
        runner.buildRequest(java.net.URI(scriptUrl), options, null, null, null)
    }

    @Test
    fun `书源请求头里的中文会被编码而不是让请求直接失败`() {
        val runner = RuleRunner { "" }
        val options = RuleRunner.UrlOptions(headers = mapOf("Referer" to "https://example.com/再漫画/"))
        val request = runner.buildRequest(java.net.URI("https://example.com/x"), options, null, null, null)

        assertEquals(
            "非 ASCII 要按 UTF-8 百分号编码后再发出：${request.headers().firstValue("referer")}",
            "https://example.com/%E5%86%8D%E6%BC%AB%E7%94%BB/",
            request.headers().firstValue("referer").orElse(""),
        )
    }

    @Test
    fun `相对章节地址带参数尾巴时也要拼成绝对地址`() {
        val chapterUrl = """/vchannels/406827/programs/19167943,{ "webView": "true" }"""
        val tocPayload = """{"chapters":[{"title":"第一章","url":${json(chapterUrl)}}]}"""
        val source = """
            {
              "bookSourceUrl":"https://audio.example",
              "bookSourceName":"尾部参数",
              "ruleToc":{"chapterList":"$.chapters","chapterName":"$.title","chapterUrl":"$.url"}
            }
        """.trimIndent()

        val runner = RuleRunner { tocPayload }
        val chapters = runner.chapters(source, "https://audio.example/toc")

        assertEquals(1, chapters.size)
        assertEquals(
            "相对地址要补全，参数尾巴要原样留着：${chapters[0].url}",
            """https://audio.example/vchannels/406827/programs/19167943,{ "webView": "true" }""",
            chapters[0].url,
        )
    }
}
