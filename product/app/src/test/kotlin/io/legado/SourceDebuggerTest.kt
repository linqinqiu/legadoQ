package io.legado

import io.legado.rules.RuleRunner
import io.legado.source.DebugStep
import io.legado.source.SourceDebugger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 书源调试面板（`/api/sources/{id}/debug` 的那条 SSE 流）的判据。
 *
 * 这个面板存在的理由是「源挂了但不知道挂在哪一步」，所以判据都盯着**它到底说清楚了没有**：
 * 失败要有真实耗时（不然「秒挂」和「等满超时」长得一样）、没配详情名称规则不该判失败
 * （那是上游的正常形态，不是源坏了）、0 条命中要带出上游自己写的那句话
 * （不然「要登录」「被拦截」「规则没匹配上」在界面上全是同一句"一条都没有"）。
 */
class SourceDebuggerTest {

    private fun flow(
        sourceJson: String,
        keyword: String = "剑",
        bookUrl: String? = null,
        chapterIndex: Int = 0,
        fetch: (String) -> String,
    ): List<DebugStep> {
        val steps = mutableListOf<DebugStep>()
        SourceDebugger(RuleRunner(fetch)).flow(sourceJson, keyword, bookUrl, chapterIndex) { steps += it }
        return steps
    }

    private fun List<DebugStep>.stage(name: String): DebugStep =
        firstOrNull { it.stage == name } ?: error("缺少「$name」阶段，实际有 ${map { it.stage }}")

    @Test
    fun `失败的阶段也带真实耗时`() {
        // 列表规则写坏 → 搜索阶段失败。以前失败分支一律显示 0 ms：
        // 用户对着一个等满 20 秒超时的死源，看到的是「失败 | 0 ms」，分不清是秒挂还是慢到超时。
        val source = """{
            "bookSourceUrl":"https://slowfail.example",
            "bookSourceName":"慢失败",
            "searchUrl":"https://slowfail.example/s?q={{key}}",
            "ruleSearch":{"bookList":"class.item[[","name":"a@text","bookUrl":"a@href"}
        }"""
        val steps = flow(source) {
            Thread.sleep(40)
            "<html><body><div class=\"item\"><a href=\"/b/1\">剑来</a></div></body></html>"
        }

        val search = steps.stage("搜索")
        assertFalse("写坏的列表规则应判失败", search.ok)
        assertTrue("失败阶段应带真实耗时，实际 ${search.elapsedMs} ms", search.elapsedMs >= 30)
    }

    @Test
    fun `详情阶段沿用搜索标题且不误判失败`() {
        // 视频/音频/漫画源普遍**不配** ruleBookInfo.name（本机 783 个启用源没有可用的 ruleBookInfo 规则、
        // 189 个连这个键都没有）。上游此时沿用搜索结果里的标题、只补配了规则的字段；
        // 以前一律报《未命名书籍》并判 FAIL，把「这源没有详情规则」说成「详情阶段挂了」。
        val source = """{
            "bookSourceUrl":"https://nodetail.example",
            "bookSourceName":"无详情规则",
            "searchUrl":"https://nodetail.example/s?q={{key}}",
            "ruleSearch":{"bookList":"class.item","name":"a@text","bookUrl":"a@href"},
            "ruleBookInfo":{},
            "ruleToc":{"chapterList":"class.chapter","chapterName":"a@text","chapterUrl":"a@href"},
            "ruleContent":{"content":"id.content@html"}
        }"""
        val steps = flow(source) { url ->
            when {
                url.startsWith("https://nodetail.example/s") ->
                    """<html><body><div class="item"><a href="/b/1">剑来</a></div></body></html>"""
                url == "https://nodetail.example/b/1" ->
                    """<html><body><ul><li class="chapter"><a href="/c/1">第一章 起风</a></li></ul>""" +
                        """<div id="content">正文在这里。</div></body></html>"""
                url == "https://nodetail.example/c/1" ->
                    """<html><body><div id="content">第一章的正文。</div></body></html>"""
                else -> error("unexpected $url")
            }
        }

        val details = steps.stage("详情")
        assertTrue("未配 name 规则不该判失败：${details.detail}", details.ok)
        assertEquals("《剑来》", details.label)
        assertTrue(details.detail.contains("标题沿用搜索结果"))
        assertEquals("1 章", steps.stage("目录").label)
    }

    @Test
    fun `整个源没有 ruleBookInfo 也能跑完目录`() {
        // 详情阶段是目录的必经一步（tocUrl 从这儿来），以前直接抛「该书源未配置 ruleBookInfo」，
        // 于是这 189 个源连目录都取不到，体检也只看到这句而不是它们真实的表现。
        val source = """{
            "bookSourceUrl":"https://noinfo.example",
            "bookSourceName":"没有详情键",
            "searchUrl":"https://noinfo.example/s?q={{key}}",
            "ruleSearch":{"bookList":"class.item","name":"a@text","bookUrl":"a@href"},
            "ruleToc":{"chapterList":"class.chapter","chapterName":"a@text","chapterUrl":"a@href"}
        }"""
        val steps = flow(source) { url ->
            when {
                url.startsWith("https://noinfo.example/s") ->
                    """<html><body><div class="item"><a href="/b/9">雪中悍刀行</a></div></body></html>"""
                url == "https://noinfo.example/b/9" ->
                    """<html><body><ul><li class="chapter"><a href="/c/1">第一章</a></li></ul></body></html>"""
                else -> error("unexpected $url")
            }
        }

        val details = steps.stage("详情")
        assertTrue("没有 ruleBookInfo 也不该整阶段失败：${details.detail}", details.ok)
        assertEquals("《雪中悍刀行》", details.label)
        assertEquals("1 章", steps.stage("目录").label)
    }

    @Test
    fun `搜索零命中时带出上游自己写的那句话`() {
        // 实测 m.lrts.me/ajax/searchBook 匿名搜索回 {"apiStatus":485,"msg":"你好，需要登录才能继续使用此功能"}。
        // 列表规则取到的是空数组（不报错），界面上只有一句"一条都没有" ——
        // 「这源要登录」和「站点真没这本书」分不开。
        val source = """{
            "bookSourceUrl":"https://needlogin.example",
            "bookSourceName":"要登录",
            "searchUrl":"https://needlogin.example/search?q={{key}}",
            "ruleSearch":{"bookList":"$.books","name":"$.name","bookUrl":"$.url"}
        }"""
        val steps = flow(source) { """{"apiStatus":485,"msg":"你好，需要登录才能继续使用此功能","books":[]}""" }

        val search = steps.stage("搜索")
        assertEquals("0 条命中", search.label)
        assertFalse(search.ok)
        assertTrue("应带出上游那句话：${search.detail}", search.detail.contains("需要登录才能继续使用此功能"))
    }

    @Test
    fun `搜索零命中且上游是拦截页时给出页面标题`() {
        // 反爬拦截页（优质资源 hdzyk 那种 JS cookie 校验页）回的是 200 + HTML，
        // 规则一条都匹配不上。给出 <title> 就能一眼看出是被拦了，而不是"这源没书"。
        val source = """{
            "bookSourceUrl":"https://blocked.example",
            "bookSourceName":"被拦截",
            "searchUrl":"https://blocked.example/s?q={{key}}",
            "ruleSearch":{"bookList":"class.item","name":"a@text","bookUrl":"a@href"}
        }"""
        val steps = flow(source) {
            """<html><head><title>安全验证 - 请开启 JavaScript</title></head><body><div id="v"></div></body></html>"""
        }

        val search = steps.stage("搜索")
        assertFalse(search.ok)
        assertTrue("应给出页面标题：${search.detail}", search.detail.contains("安全验证"))
    }
}
