package io.legado

import io.legado.model.SourceLoginUiItem
import io.legado.rules.RuleRunner
import io.legado.rules.loginUiVersion
import io.legado.rules.renderLoginUiV2
import io.legado.rules.executeLoginUiActionV2
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 金标准回归：用**离线 fixture** 锁住规则引擎当前的行为。
 *
 * 存在的理由：`RuleRunner` 有 21 个公开方法、跨搜索/详情/目录/正文/登录/JS 六条链路，
 * 而现有 947 项测试里没有一套「固定输入 → 固定输出」的语料。没有它，任何把
 * `RuleRunner` 拆成 Flow、或把解析交给 `RuleDispatcher` 的改动，都无法证明「没改坏」——
 * 「搜索少一条结果」「目录少一章」这类退化在断言条数的测试里是看不见的。
 *
 * 冻结口径（重要）：
 * - `expected.json` 是**人工确认过**的期望值，不是自动录制的当前输出；
 * - 当前实现有 bug 时，不要把 bug 冻进 expected —— 在 case 目录放 `knownBug.md`
 *   说明现象，并让该 case 暂时不进入断言；
 * - 修改规则引擎后，这个测试必须**先绿**，才允许提交。
 *
 * 新增 case：在 `app/src/test/resources/rule-golden/<flow>-<形态>/` 下放
 * `source.json` + 响应体 + `expected.json`，再在本类加一个对应的 `@Test`。
 */
class GoldenRuleTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun fixture(path: String): String =
        javaClass.classLoader.getResource(path)?.readText()
            ?: error("缺少 fixture：$path（应位于 app/src/test/resources/$path）")

    @Test
    fun `search CSS 列表与字段提取与金标准一致`() {
        val dir = "rule-golden/search-css"
        val source = fixture("$dir/source.json")
        val page = fixture("$dir/page.html")
        val expected = json.parseToJsonElement(fixture("$dir/expected.json")).jsonObject

        val requested = mutableListOf<String>()
        val runner = RuleRunner({ url -> requested += url; page })

        val actual = runner.search(source, "测试")

        assertEquals("搜索只应请求一次", 1, requested.size)
        assertTrue(
            "搜索地址应由 searchUrl 渲染而来，实际：${requested.single()}",
            requested.single().startsWith("https://golden.example/search?q="),
        )

        val items = expected.getValue("items").jsonArray
        assertEquals("条数应与金标准一致", expected.getValue("count").jsonPrimitive.int, actual.size)
        assertEquals("expected 自身条数应一致", items.size, actual.size)

        items.forEachIndexed { index, element ->
            val item = element.jsonObject
            val book = actual[index]
            assertEquals("第 ${index + 1} 本的书名", item.getValue("name").jsonPrimitive.content, book.name)
            assertEquals("第 ${index + 1} 本的作者", item.getValue("author").jsonPrimitive.content, book.author)
            assertEquals("第 ${index + 1} 本的详情地址", item.getValue("bookUrl").jsonPrimitive.content, book.bookUrl)
        }
    }

    @Test
    fun `details 与 toc 的 JSON 规则与金标准一致`() {
        val dir = "rule-golden/details-toc-json"
        val source = fixture("$dir/source.json")
        val expected = json.parseToJsonElement(fixture("$dir/expected.json")).jsonObject
        val routes = mapOf(
            "https://golden.example/book/1" to fixture("$dir/book.json"),
            "https://golden.example/toc/1" to fixture("$dir/toc.json"),
        )
        val runner = RuleRunner({ url -> routes[url] ?: error("未预期请求：$url") })

        val details = runner.details(source, "https://golden.example/book/1")
        assertEquals("详情书名", expected.getValue("name").jsonPrimitive.content, details.name)
        assertEquals("详情作者", expected.getValue("author").jsonPrimitive.content, details.author)
        assertEquals("目录地址", expected.getValue("tocUrl").jsonPrimitive.content, details.tocUrl)

        val chapters = runner.chapters(source, details.tocUrl)
        val expectedChapters = expected.getValue("chapters").jsonArray
        assertEquals("章数应与金标准一致", expectedChapters.size, chapters.size)
        expectedChapters.forEachIndexed { index, element ->
            val item = element.jsonObject
            assertEquals("第 ${index + 1} 章标题", item.getValue("title").jsonPrimitive.content, chapters[index].title)
            assertEquals("第 ${index + 1} 章地址", item.getValue("url").jsonPrimitive.content, chapters[index].url)
        }
    }

    @Test
    fun `content CSS 正文提取不丢段落`() {
        val dir = "rule-golden/content-css"
        val source = fixture("$dir/source.json")
        val page = fixture("$dir/page.html")
        val runner = RuleRunner({ _ -> page })

        val result = runner.content(source, "https://golden.example/c/1")

        listOf("第一段正文", "第二段正文", "第三段正文").forEach { paragraph ->
            assertTrue("正文应包含「$paragraph」，实际：${result.content}", result.content.contains(paragraph))
        }
        assertTrue("正文不应残留 HTML 标签，实际：${result.content}", !result.content.contains("<p>"))
    }

    @Test
    fun `rss 列表与字段提取与金标准一致`() {
        val dir = "rule-golden/rss-articles"
        val source = fixture("$dir/source.json")
        val page = fixture("$dir/page.html")
        val runner = RuleRunner({ _ -> page })

        val articles = runner.rssArticles(source, "https://golden.example/rss")

        assertEquals("文章条数", 2, articles.size)
        assertEquals("第一篇标题", "文章一", articles[0].title)
        assertEquals("第一篇链接", "https://golden.example/a/1", articles[0].link)
        assertEquals("第一篇日期", "2026-11-01", articles[0].pubDate)
        assertEquals("第二篇标题", "文章二", articles[1].title)
        assertEquals("第二篇链接", "https://golden.example/a/2", articles[1].link)
        assertEquals("第二篇日期", "2026-11-02", articles[1].pubDate)
    }

    @Test
    fun `login v2 的两屏表单与命令与金标准一致`() {
        val dir = "rule-golden/login-v2-js"
        val source = fixture("$dir/source.json")
        val expected = json.parseToJsonElement(fixture("$dir/expected.json")).jsonObject
        // 登录链路全程离线：脚本只调 java.startBrowserAwait 与本地 JS，不应抓任何页面。
        val runner = RuleRunner { url -> error("登录链路不应发起请求：$url") }

        assertTrue("loginUrl 是整段 JS", runner.loginIsScript(source))
        assertEquals(
            "应能打开登录入口",
            expected.getValue("canOpenBrowser").jsonPrimitive.content.toBoolean(),
            runner.loginCanOpenBrowser(source),
        )
        assertEquals(
            "登录脚本自报的浏览器地址",
            expected.getValue("browserStartUrl").jsonPrimitive.content,
            runner.loginBrowserStartUrl(source),
        )
        assertEquals("协议版本", expected.getValue("uiVersion").jsonPrimitive.int, runner.loginUiVersion(source))

        val first = runner.renderLoginUiV2(source)
        assertNull("首屏不应报错，实际：${first.error}", first.error)
        assertLoginRows(expected.getValue("firstScreen").jsonArray, first.rows, "首屏")

        // 必填校验失败：错误挂到字段上，不换屏
        val missing = runner.executeLoginUiActionV2(source, "sendCode", "{}", emptyMap())
        assertEquals(
            "手机号缺失的提示",
            expected.getValue("errorPhone").jsonPrimitive.content,
            missing.error["phone"],
        )
        assertNull("校验失败不应产生下一屏", missing.state)

        val next = runner.executeLoginUiActionV2(source, "sendCode", "{}", mapOf("phone" to "13800000000"))
        val nextState = next.state
        assertNotNull("填了手机号应换屏", nextState)
        val second = runner.renderLoginUiV2(source, nextState!!)
        assertNull("第二屏不应报错，实际：${second.error}", second.error)
        assertLoginRows(expected.getValue("secondScreen").jsonArray, second.rows, "第二屏")

        val wrong = runner.executeLoginUiActionV2(source, "submit", nextState, mapOf("code" to "0000"))
        assertEquals(
            "验证码错误的提示",
            expected.getValue("errorCode").jsonPrimitive.content,
            wrong.error["code"],
        )

        val done = runner.executeLoginUiActionV2(source, "submit", nextState, mapOf("code" to "1234"))
        assertTrue("提交应成功，实际：${done.message}", done.ok)
        assertTrue("应关闭浮层", done.close)
        assertEquals(
            "未知命令只回报、不执行",
            expected.getValue("unknownKeys").jsonArray.map { it.jsonPrimitive.content },
            done.unknownKeys,
        )
        expected.getValue("loginInfo").jsonObject.forEach { (key, value) ->
            assertEquals("落库字段 $key", value.jsonPrimitive.content, done.updatedLoginInfo?.get(key))
        }

        val status = runner.checkLoginStatus(source)
        assertEquals(
            "loginCheckJs 试判结果",
            expected.getValue("checkLoggedIn").jsonPrimitive.content.toBoolean(),
            status.loggedIn,
        )
        assertTrue("有 loginCheckJs 时应标记为已校验", status.verified)
    }

    @Test
    fun `login v1 的静态表单与动作脚本与金标准一致`() {
        val dir = "rule-golden/login-v1-js"
        val source = fixture("$dir/source.json")
        val expected = json.parseToJsonElement(fixture("$dir/expected.json")).jsonObject
        val runner = RuleRunner { url -> error("登录链路不应发起请求：$url") }

        assertTrue("loginUrl 是整段 JS", runner.loginIsScript(source))
        assertEquals("协议版本", expected.getValue("uiVersion").jsonPrimitive.int, runner.loginUiVersion(source))
        assertLoginRows(expected.getValue("ui").jsonArray, runner.parseLoginUi(source), "v1 表单")

        val ok = runner.executeLoginAction(source, "login(true)", mapOf("user" to "admin", "pwd" to "123456"))
        assertTrue("登录应成功，实际错误：${ok.error}", ok.success)
        assertTrue(
            "应有成功提示，实际：${ok.toastMessages}",
            ok.toastMessages.contains(expected.getValue("successToast").jsonPrimitive.content),
        )
        expected.getValue("successLoginInfo").jsonObject.forEach { (key, value) ->
            assertEquals("upLoginData 的 $key", value.jsonPrimitive.content, ok.updatedLoginInfo?.get(key))
        }

        val bad = runner.executeLoginAction(source, "login(true)", mapOf("user" to "guest", "pwd" to "bad"))
        assertTrue("脚本没抛错就算执行完成，实际错误：${bad.error}", bad.success)
        assertTrue(
            "应有失败提示，实际：${bad.toastMessages}",
            bad.toastMessages.contains(expected.getValue("failureToast").jsonPrimitive.content),
        )
        assertEquals("失败时保留用户输入", "guest", bad.updatedLoginInfo?.get("user"))
    }

    private fun assertLoginRows(expected: JsonArray, actual: List<SourceLoginUiItem>, label: String) {
        assertEquals("$label 行数", expected.size, actual.size)
        expected.forEachIndexed { index, element ->
            val row = element.jsonObject
            val item = actual[index]
            assertEquals("$label 第 ${index + 1} 行 name", row.getValue("name").jsonPrimitive.content, item.name)
            assertEquals("$label 第 ${index + 1} 行 type", row.getValue("type").jsonPrimitive.content, item.type)
            row["key"]?.let { assertEquals("$label 第 ${index + 1} 行 key", it.jsonPrimitive.content, item.key) }
            row["action"]?.let { assertEquals("$label 第 ${index + 1} 行 action", it.jsonPrimitive.content, item.action) }
            row["hint"]?.let { assertEquals("$label 第 ${index + 1} 行 hint", it.jsonPrimitive.content, item.hint) }
            row["countdown"]?.let { assertEquals("$label 第 ${index + 1} 行 countdown", it.jsonPrimitive.int, item.countdown) }
        }
    }
}
