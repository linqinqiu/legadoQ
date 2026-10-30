package io.legado

import io.legado.rules.RuleRunner
import org.junit.Assert.assertEquals
import org.junit.Test
import java.nio.charset.Charset

/**
 * 远程响应文本的字符集判定（上游 `BookSource.getCharset` 的口径）。
 *
 * 为什么要单独立一份判据：这一层出错**不抛异常**，只把整页变成「绗16章」这类乱码，
 * 然后一路脏进书名、章节标题、正文与书架（实测食在广州 www.gzmeal.com 就是这样）。
 * 光看接口返回是 200、规则也取到了值，没人会怀疑解码。
 */
class ResponseCharsetTest {
    private val runner = RuleRunner { url -> error("这条判据不走网络：$url") }
    private val utf8 = Charsets.UTF_8
    private val gbk: Charset = Charset.forName("GBK")

    @Test
    fun `页面自报的 meta 字符集用来解码`() {
        val html = """<html><head><meta http-equiv="Content-Type" content="text/html; charset=gbk"></head><body>第16章</body></html>"""
        val page = html.toByteArray(gbk)

        assertEquals(gbk, runner.resolveBodyCharset(page, null, "text/html"))
    }

    @Test
    fun `html5 的 meta charset 写法也认`() {
        val page = """<html><head><meta charset="gb2312">""".toByteArray(gbk)

        assertEquals(Charset.forName("GB2312"), runner.resolveBodyCharset(page, null, null))
    }

    @Test
    fun `源声明的字符集优先于一切`() {
        // 书源在 `searchUrl` 尾巴的选项里写了 `"charset":"gbk"`，作者的话最该先听。
        val page = """<html><head><meta charset="utf-8">""".toByteArray(gbk)

        assertEquals(gbk, runner.resolveBodyCharset(page, gbk, "text/html; charset=utf-8"))
    }

    @Test
    fun `响应头排在页面自报之后`() {
        // 服务器默认值（`charset=iso-8859-1`）与页面真实编码常年不一致；
        // 让 meta 赢，才不会出现「响应头说 Latin-1、页面是 GBK」那一类整页乱码。
        val page = """<html><head><meta charset="gbk">""".toByteArray(gbk)

        assertEquals(gbk, runner.resolveBodyCharset(page, null, "text/html; charset=iso-8859-1"))
    }

    @Test
    fun `没有 meta 时才用响应头`() {
        val page = """<html><body>正文</body></html>""".toByteArray(Charset.forName("GB2312"))

        assertEquals(Charset.forName("GB2312"), runner.resolveBodyCharset(page, null, "text/html; charset=gb2312"))
    }

    @Test
    fun `什么都没写时按 UTF-8`() {
        val page = """<html><body>剑来</body></html>""".toByteArray(utf8)

        assertEquals(utf8, runner.resolveBodyCharset(page, null, "text/html"))
    }

    @Test
    fun `正文里出现的 charset 字样不会被误判成声明`() {
        // 正则限定在 `<meta` 起头的那个标签里：JS 字符串、注释里写 `charset` 不算声明。
        val page = """<html><body><script>var t = "charset=gbk";</script></body></html>""".toByteArray(utf8)

        assertEquals(utf8, runner.resolveBodyCharset(page, null, null))
    }

    @Test
    fun `JSON 接口里的 HTML 片段不算编码声明`() {
        // 音频 / 漫画接口常把一段 HTML 塞在字段里回出来，那里头的 `<meta charset=…>` 是**数据**。
        // 嗅探只对标记文档做（第一个非空白字符是 `<`），否则整份接口会被按错的字符集解 ——
        // 而且解得动、不报错，只在界面上留下满屏乱码。
        val json = """{"html":"<meta charset=\"gbk\"><div>剑来</div>"}""".toByteArray(utf8)

        assertEquals(utf8, runner.resolveBodyCharset(json, null, "application/json"))
    }
}
