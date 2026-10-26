package io.legado

import org.junit.Assert.assertEquals
import org.junit.Test
import io.legado.rules.JsExecutionContext
import io.legado.rules.JsSandbox

/**
 * `book` / `chapter` 桥对象。上游把真实的 Book / BookChapter 对象交给 Rhino，
 * 书源 JS 里 `book.origin`、`chapter.title` 随手就用；我们以前只建了桥、
 * 除登录流程外从没填过值，而且 `origin`、`putVariable` 这两个成员压根不存在。
 */
class BookBridgeTest {

    private val sandbox = JsSandbox()

    private fun context() = JsExecutionContext(
        sourceId = "https://origin.example",
        bookUrl = "https://origin.example/book/42",
        bookName = "上下文测试书",
        bookAuthor = "某作者",
        bookTocUrl = "https://origin.example/book/42/chapters",
        chapterUrl = "https://origin.example/read/7.html",
        chapterIndex = 7,
        chapterTitle = "第7章 试读",
    )

    private fun eval(script: String, execContext: JsExecutionContext? = context()) =
        sandbox.eval(script, emptyMap(), execContext)

    @Test
    fun `book bridge carries the reading context into rules`() {
        val out = eval(
            """[book.origin, book.name, book.author, book.bookUrl, book.tocUrl, book.durChapterTitle, (book.durChapterIndex == 7)].join('|')"""
        )
        assertEquals(
            "https://origin.example|上下文测试书|某作者|https://origin.example/book/42|https://origin.example/book/42/chapters|第7章 试读|true",
            out,
        )
    }

    @Test
    fun `chapter bridge carries index title and url`() {
        val out = eval("""[chapter.title, chapter.url, (chapter.index == 7)].join('|')""")
        assertEquals("第7章 试读|https://origin.example/read/7.html|true", out)
    }

    @Test
    fun `putVariable works under both upstream and alias spelling`() {
        // 上游 Book 实现 RuleDataInterface，方法名是 putVariable；库里 54 个源这么写，
        // 我们只有 setVariable 时它们直接 TypeError。
        val out = eval("""book.putVariable('sid','S9'); book.setVariable('other','O1'); [book.getVariable('sid'), book.getVariable('other')].join(',')""")
        assertEquals("S9,O1", out)
    }

    @Test
    fun `missing context yields empty strings instead of a crash`() {
        val out = eval("""[book.origin, book.name, chapter.title].join('|')""", JsExecutionContext())
        assertEquals("||", out)
    }
}
