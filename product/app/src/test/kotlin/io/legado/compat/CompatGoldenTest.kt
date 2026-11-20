package io.legado.compat

import io.legado.model.SourceLoginUiItem
import io.legado.rules.RuleRunner
import io.legado.rules.checkLoginStatus
import io.legado.rules.executeLoginAction
import io.legado.rules.executeLoginUiActionV2
import io.legado.rules.loginUiVersion
import io.legado.rules.parseLoginUi
import io.legado.rules.renderLoginUiV2
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * compat 金标准回归：固定输入 → 固定输出，锁住规则引擎六条链路当前行为。
 *
 * 骨架依据：`21` §4（S-1 采纳 L1–L4 分层断言）、`09` §2.2（8 条链路各 ≥1 样本）。
 * 本类覆盖现有 6 类 golden（search/details/chapters/content/rss/login×2）；
 * 补充样本（xpath / regex-allinone / js-list / putget-lifecycle / toc-paging / image-decode，见 `14` §5）
 * 在阶段 2 后续提交中逐个加入，每加一个 case 不改任何规则实现。
 *
 * 冻结口径（同原 GoldenRuleTest）：`expected.json` 是人工确认的期望，不是自动录制的当前输出；
 * 改引擎后本测试必须**先绿**才允许提交（08 D-5）。
 */
class CompatGoldenTest {

    private val h = CompatHarness

    @Test
    fun `search 链路：CSS 列表与字段提取（L2 结构化字段）`() {
        val dir = "rule-golden/search-css"
        val source = h.fixture("$dir/source.json")
        val page = h.fixture("$dir/page.html")
        val expected = h.expected("$dir/expected.json")

        val requested = mutableListOf<String>()
        val runner = RuleRunner({ url -> requested += url; page })

        val actual = runner.search(source, "测试")

        h.assertRequestedSingle("search", "https://golden.example/search?q=", requested)
        val items = expected.getValue("items").jsonArray
        assertEquals("条数应与金标准一致", expected.getValue("count").jsonPrimitive.int, actual.size)
        assertEquals("expected 自身条数应一致", items.size, actual.size)
        items.forEachIndexed { i, el ->
            val item = el.jsonObject
            h.assertFieldEquals("search", i, "name", item.getValue("name").jsonPrimitive.content, actual[i].name)
            h.assertFieldEquals("search", i, "author", item.getValue("author").jsonPrimitive.content, actual[i].author)
            h.assertFieldEquals("search", i, "bookUrl", item.getValue("bookUrl").jsonPrimitive.content, actual[i].bookUrl)
        }
    }

    @Test
    fun `details+toc 链路：JSON 规则与字段提取（L2）`() {
        val dir = "rule-golden/details-toc-json"
        val source = h.fixture("$dir/source.json")
        val expected = h.expected("$dir/expected.json")
        val routes = mapOf(
            "https://golden.example/book/1" to h.fixture("$dir/book.json"),
            "https://golden.example/toc/1" to h.fixture("$dir/toc.json"),
        )
        val runner = RuleRunner({ url -> routes[url] ?: error("未预期请求：$url") })

        val details = runner.details(source, "https://golden.example/book/1")
        assertEquals("详情书名", expected.getValue("name").jsonPrimitive.content, details.name)
        assertEquals("详情作者", expected.getValue("author").jsonPrimitive.content, details.author)
        assertEquals("目录地址", expected.getValue("tocUrl").jsonPrimitive.content, details.tocUrl)

        val chapters = runner.chapters(source, details.tocUrl)
        val expectedChapters = expected.getValue("chapters").jsonArray
        assertEquals("章数应与金标准一致", expectedChapters.size, chapters.size)
        expectedChapters.forEachIndexed { i, el ->
            val item = el.jsonObject
            assertEquals("第 ${i + 1} 章标题", item.getValue("title").jsonPrimitive.content, chapters[i].title)
            assertEquals("第 ${i + 1} 章地址", item.getValue("url").jsonPrimitive.content, chapters[i].url)
        }
    }

    @Test
    fun `content 链路：CSS 正文不丢段落（L1 逐字符 + 中粒度 contains）`() {
        val dir = "rule-golden/content-css"
        val source = h.fixture("$dir/source.json")
        val page = h.fixture("$dir/page.html")
        val runner = RuleRunner({ _ -> page })

        val result = runner.content(source, "https://golden.example/c/1")

        // 中粒度：段落不丢、标签不残留（现有 golden 口径，见 GoldenRuleTest）
        listOf("第一段正文", "第二段正文", "第三段正文").forEach { p ->
            assertTrue("正文应包含「$p」，实际：${result.content}", result.content.contains(p))
        }
        assertFalse("正文不应残留 HTML 标签，实际：${result.content}", result.content.contains("<p>"))
        // L1 逐字符：若有 expected.txt 则整段 equals（当前 content-css 暂无，留作 14 §5 补充样本 #1 的接入点）
    }

    @Test
    fun `rss 链路：列表与字段提取（L2）`() {
        val dir = "rule-golden/rss-articles"
        val source = h.fixture("$dir/source.json")
        val page = h.fixture("$dir/page.html")
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
    fun `login v2 链路：两屏表单与命令（L2）`() {
        val dir = "rule-golden/login-v2-js"
        val source = h.fixture("$dir/source.json")
        val expected = h.expected("$dir/expected.json")
        val runner = RuleRunner { url -> error("登录链路不应发起请求：$url") }

        assertTrue("loginUrl 是整段 JS", runner.loginIsScript(source))
        assertEquals("应能打开登录入口", expected.getValue("canOpenBrowser").jsonPrimitive.content.toBoolean(), runner.loginCanOpenBrowser(source))
        assertEquals("登录脚本自报的浏览器地址", expected.getValue("browserStartUrl").jsonPrimitive.content, runner.loginBrowserStartUrl(source))
        assertEquals("协议版本", expected.getValue("uiVersion").jsonPrimitive.int, runner.loginUiVersion(source))

        val first = runner.renderLoginUiV2(source)
        assertNull("首屏不应报错，实际：${first.error}", first.error)
        assertLoginRows(expected.getValue("firstScreen").jsonArray, first.rows, "首屏")

        val missing = runner.executeLoginUiActionV2(source, "sendCode", "{}", emptyMap())
        assertEquals("手机号缺失的提示", expected.getValue("errorPhone").jsonPrimitive.content, missing.error["phone"])
        assertNull("校验失败不应产生下一屏", missing.state)

        val next = runner.executeLoginUiActionV2(source, "sendCode", "{}", mapOf("phone" to "13800000000"))
        val nextState = next.state
        assertTrue("填了手机号应换屏", nextState != null)
        val second = runner.renderLoginUiV2(source, nextState!!)
        assertNull("第二屏不应报错，实际：${second.error}", second.error)
        assertLoginRows(expected.getValue("secondScreen").jsonArray, second.rows, "第二屏")

        val wrong = runner.executeLoginUiActionV2(source, "submit", nextState, mapOf("code" to "0000"))
        assertEquals("验证码错误的提示", expected.getValue("errorCode").jsonPrimitive.content, wrong.error["code"])

        val done = runner.executeLoginUiActionV2(source, "submit", nextState, mapOf("code" to "1234"))
        assertTrue("提交应成功，实际：${done.message}", done.ok)
        assertTrue("应关闭浮层", done.close)
        assertEquals("未知命令只回报、不执行", expected.getValue("unknownKeys").jsonArray.map { it.jsonPrimitive.content }, done.unknownKeys)
        expected.getValue("loginInfo").jsonObject.forEach { (key, value) ->
            assertEquals("落库字段 $key", value.jsonPrimitive.content, done.updatedLoginInfo?.get(key))
        }

        val status = runner.checkLoginStatus(source)
        assertEquals("loginCheckJs 试判结果", expected.getValue("checkLoggedIn").jsonPrimitive.content.toBoolean(), status.loggedIn)
        assertTrue("有 loginCheckJs 时应标记为已校验", status.verified)
    }

    @Test
    fun `login v1 链路：静态表单与动作脚本（L2）`() {
        val dir = "rule-golden/login-v1-js"
        val source = h.fixture("$dir/source.json")
        val expected = h.expected("$dir/expected.json")
        val runner = RuleRunner { url -> error("登录链路不应发起请求：$url") }

        assertTrue("loginUrl 是整段 JS", runner.loginIsScript(source))
        assertEquals("协议版本", expected.getValue("uiVersion").jsonPrimitive.int, runner.loginUiVersion(source))
        assertLoginRows(expected.getValue("ui").jsonArray, runner.parseLoginUi(source), "v1 表单")

        val ok = runner.executeLoginAction(source, "login(true)", mapOf("user" to "admin", "pwd" to "123456"))
        assertTrue("登录应成功，实际错误：${ok.error}", ok.success)
        assertTrue("应有成功提示，实际：${ok.toastMessages}", ok.toastMessages.contains(expected.getValue("successToast").jsonPrimitive.content))
        expected.getValue("successLoginInfo").jsonObject.forEach { (key, value) ->
            assertEquals("upLoginData 的 $key", value.jsonPrimitive.content, ok.updatedLoginInfo?.get(key))
        }

        val bad = runner.executeLoginAction(source, "login(true)", mapOf("user" to "guest", "pwd" to "bad"))
        assertTrue("脚本没抛错就算执行完成，实际错误：${bad.error}", bad.success)
        assertTrue("应有失败提示，实际：${bad.toastMessages}", bad.toastMessages.contains(expected.getValue("failureToast").jsonPrimitive.content))
        assertEquals("失败时保留用户输入", "guest", bad.updatedLoginInfo?.get("user"))
    }

    private fun assertLoginRows(expected: JsonArray, actual: List<SourceLoginUiItem>, label: String) {
        assertEquals("$label 行数", expected.size, actual.size)
        expected.forEachIndexed { i, el ->
            val row = el.jsonObject
            val item = actual[i]
            assertEquals("$label 第 ${i + 1} 行 name", row.getValue("name").jsonPrimitive.content, item.name)
            assertEquals("$label 第 ${i + 1} 行 type", row.getValue("type").jsonPrimitive.content, item.type)
            row["key"]?.let { assertEquals("$label 第 ${i + 1} 行 key", it.jsonPrimitive.content, item.key) }
            row["action"]?.let { assertEquals("$label 第 ${i + 1} 行 action", it.jsonPrimitive.content, item.action) }
            row["hint"]?.let { assertEquals("$label 第 ${i + 1} 行 hint", it.jsonPrimitive.content, item.hint) }
            row["countdown"]?.let { assertEquals("$label 第 ${i + 1} 行 countdown", it.jsonPrimitive.int, item.countdown) }
        }
    }
}
