package io.legado

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import io.legado.http.localAssetType
import io.legado.localbook.LocalBookParser
import io.legado.localbook.ParsedBook
import io.legado.localbook.TocRules

/**
 * 本地书的图片（用户 2026-10-02：「重点研究本地阅读功能…支持图片」）。
 *
 * 原来 EPUB 正文是 `doc.body()?.text()` 出来的 —— `<img>` 整个消失，所以"有图也看不见"；
 * TXT 里的 `<img …>` 更糟：既不清掉也不显示，用户看到的是一行标签字面文本。
 * 现在两边都换成 `![图片](地址)` 占位行，走前端已有的那条渲染链路。
 */
class LocalBookImageTest {

    private fun zip(vararg files: Pair<String, ByteArray>): ByteArray {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { zos ->
            for ((name, bytes) in files) {
                zos.putNextEntry(ZipEntry(name))
                zos.write(bytes)
                zos.closeEntry()
            }
        }
        return out.toByteArray()
    }

    private fun text(value: String) = value.toByteArray(StandardCharsets.UTF_8)

    /** 只有文件头几个字节是真的：路由按魔数判类型，测试也得给真魔数（外加填充，判型有最小尺寸下限）。 */
    private fun png() = byteArrayOf(
        0x89.toByte(), 'P'.code.toByte(), 'N'.code.toByte(), 'G'.code.toByte(),
        0x0D, 0x0A, 0x1A, 0x0A,
    ) + ByteArray(48)
    private fun gif() = "GIF89a".toByteArray(StandardCharsets.US_ASCII) + ByteArray(48)
    private fun jpeg() = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte()) + ByteArray(48)

    private fun epub(bookId: String): ParsedBook = LocalBookParser.parseEpub(
        "图文书.epub",
        zip(
            "mimetype" to "application/epub+zip".toByteArray(),
            "META-INF/container.xml" to text(
                """<?xml version="1.0"?><container><rootfiles>""" +
                    """<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>""" +
                    """</rootfiles></container>""",
            ),
            "OEBPS/content.opf" to text(
                """<?xml version="1.0"?><package><metadata>""" +
                    """<dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">图文书</dc:title>""" +
                    """</metadata><manifest><item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/></manifest>""" +
                    """<spine><itemref idref="c1"/></spine></package>""",
            ),
            // 三种写法都要对：相对上级、同目录子文件夹、远程绝对地址；再加一条 data: 内联图（该丢）
            "OEBPS/text/ch1.xhtml" to text(
                """<html><body><h1>第一章 起</h1><p>前文</p>""" +
                    """<p><img src="../images/p1.png"/></p>""" +
                    """<p><img src="pic/p2.gif"/></p>""" +
                    """<p><img src="https://cdn.example.com/x.jpg"/></p>""" +
                    """<p><img src="data:image/png;base64,AAAA"/></p><p>后文</p></body></html>""",
            ),
            "OEBPS/images/p1.png" to png(),
            "OEBPS/text/pic/p2.gif" to gif(),
        ),
        bookId,
    )

    @Test
    fun `epub inline images become placeholder lines instead of vanishing`() {
        val chapters = epub("abc123def4567890").chapters
        assertEquals(1, chapters.size)
        val content = chapters.first().content
        assertTrue("包内资源要指回取图路由：$content", content.contains("/api/books/local/asset?bookId=abc123def4567890&path="))
        assertTrue("相对上级要按当前那篇 XHTML 解析", content.contains("![图片](/api/books/local/asset?bookId=abc123def4567890&path=OEBPS%2Fimages%2Fp1.png)"))
        assertTrue("同目录子文件夹", content.contains("path=OEBPS%2Ftext%2Fpic%2Fp2.gif"))
        assertTrue("远程绝对地址原样保留", content.contains("![图片](https://cdn.example.com/x.jpg)"))
        assertEquals("三张图，不多不少（data: 那张该丢）", 3, Regex("!\\[图片]\\(").findAll(content).count())
        // 占位必须**独占一行**：前端认的是整行 `![图片](…)`，被并进句子里就等于没有图。
        // （jsoup 的 text() 会把换行压成空格，这一条就是钉住那个坑的。）
        assertTrue("占位行要独立成行，实际内容：$content",
            content.lineSequence().count { it.trim().startsWith("![图片](") } == 3)
        assertFalse("不该留下任何标签字面文本", content.contains("<img"))
        assertFalse("data: 内联图不进正文缓存", content.contains("data:image"))
        assertTrue("正文本身不能被弄丢", content.contains("前文") && content.contains("后文"))
    }

    @Test
    fun `without a book id we drop inline assets instead of emitting a url that must 404`() {
        val content = epub("").chapters.first().content
        assertFalse("没有 bookId 就不该生成一个必然取不到的地址", content.contains("/api/books/local/asset"))
        assertTrue("远程图与正文都还在", content.contains("![图片](https://cdn.example.com/x.jpg)") && content.contains("前文"))
    }

    @Test
    fun `txt img tags become placeholders when absolute and disappear otherwise`() {
        val parsed = LocalBookParser.parseTxt(
            "图文.txt",
            text(
                "第一章 起\n看图 <img src=\"https://cdn.example.com/a.png\"> 完\n" +
                    "本地相对 <img src=\"images/b.png\"> 不该留\n",
            ),
            TocRules.BUILTIN,
        )
        val content = parsed.chapters.joinToString("\n") { chapter -> chapter.content }
        assertTrue(content.contains("![图片](https://cdn.example.com/a.png)"))
        assertFalse("相对路径没有基准可解析，整段去掉而不是留个坏地址", content.contains("images/b.png"))
        assertFalse(content.contains("<img"))
    }

    @Test
    fun `asset type is decided by magic bytes first and refuses everything unknown`() {
        // 这一条测的是路由侧的判型：同源回出去的字节，类型猜错就是让浏览器按错的解释渲染
        assertEquals("名字与内容不符时魔数说了算", "image/gif", localAssetType("evil.svg", gif()))
        assertNull(
            "内容真是 svg 就不回（同源 svg 能带脚本）",
            localAssetType("icon.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"alert(1)\"></svg>".toByteArray()),
        )
        assertEquals("image/png", localAssetType("cover.png", png()))
        assertEquals("image/jpeg", localAssetType("x.dat", jpeg()))
        assertNull("扩展名与魔数都对不上就不回", localAssetType("page.html", "<html><body>hi</body></html>".toByteArray()))
        assertNull("垃圾字节不回", localAssetType("nope", ByteArray(48) { 7 }))
        assertNull("再小的东西不可能是能显示的图片", localAssetType("x.png", ByteArray(4)))
    }
}
