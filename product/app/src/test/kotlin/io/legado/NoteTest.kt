package io.legado

import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import io.legado.data.Database
import io.legado.data.addNote
import io.legado.data.deleteNote
import io.legado.data.listNotes
import io.legado.data.removeBookshelf
import io.legado.data.updateNote
import io.legado.model.BookNoteWrite
import java.nio.file.Files
import java.nio.file.Path
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 笔记 / 划线（PROPOSAL-019 E）。
 *
 * 契约：按书读、增、改备注、删；偏移是**章节内字符偏移**（不是像素 / 列号）。
 * 这里钉：增删改查走通、按章排序、改备注只动 `note`、删书连带删笔记。
 */
class NoteTest {
    private fun tempDb(): String = Files.createTempFile("legado-note", ".sqlite").toString()

    @Test
    fun `增删改查走通，按章、按章内位置排序`() {
        val path = tempDb()
        try {
            val db = Database(path)
            db.initialize()
            val second = db.addNote(BookNoteWrite("src", "book", "书甲", "ch2", 2, 5, 9, "第二处"))
            db.addNote(BookNoteWrite("src", "book", "书甲", "ch1", 1, 30, 40, "靠后"))
            db.addNote(BookNoteWrite("src", "book", "书甲", "ch1", 1, 2, 6, "靠前"))
            val notes = db.listNotes("src", "book")
            assertEquals(3, notes.size)
            assertEquals(listOf("靠前", "靠后", "第二处"), notes.map { it.excerpt })
            assertEquals("第 1 章的那两条应排在前", 1, notes[0].chapterIndex)
            // 改备注只动 note
            assertTrue(db.updateNote(second.id, "补一句"))
            assertEquals("补一句", db.listNotes("src", "book").first { it.id == second.id }.note)
            // 删
            assertTrue(db.deleteNote(second.id))
            assertEquals(2, db.listNotes("src", "book").size)
            assertFalse("删过的不该还能删", db.deleteNote(second.id))
            db.close()
        } finally {
            cleanup(path)
        }
    }

    @Test
    fun `删书连带删掉这本书的笔记`() {
        val path = tempDb()
        try {
            val db = Database(path)
            db.initialize()
            db.addNote(BookNoteWrite("src", "book", "书甲", "ch1", 1, 0, 3, "摘录"))
            db.removeBookshelf("src", "book")
            assertEquals(0, db.listNotes("src", "book").size)
            db.close()
        } finally {
            cleanup(path)
        }
    }

    @Test
    fun `路由契约：POST 建、GET 读、PUT 改、DELETE 删`() = testApplication {
        val config = ServerConfig(
            host = "127.0.0.1",
            port = 8080,
            databasePath = Files.createTempFile("legado-note-http", ".sqlite").toString(),
            coverCacheDirectory = Files.createTempDirectory("legado-note-http-covers"),
            homeDirectory = Files.createTempDirectory("legado-note-http-home"),
        )
        application { legadoApplication(config) }
        val client = createClient { }

        val created = client.post("/api/notes") {
            contentType(ContentType.Application.Json)
            setBody("""{"sourceId":"src","bookUrl":"book","bookName":"契约书","chapterUrl":"ch1","chapterIndex":1,"startOffset":3,"endOffset":8,"excerpt":"五个字的摘录","note":"我的备注"}""")
        }
        assertEquals(HttpStatusCode.OK, created.status)
        val id = Regex("\"id\":(\\d+)").find(created.bodyAsText())?.groupValues?.get(1) ?: ""
        assertTrue("应返回新建的 id：${created.bodyAsText()}", id.isNotEmpty())

        val read = client.get("/api/notes?sourceId=src&bookUrl=book")
        assertTrue("读回应带摘录：${read.bodyAsText()}", read.bodyAsText().contains("五个字的摘录"))

        val updated = client.put("/api/notes/$id") {
            contentType(ContentType.Application.Json)
            setBody("""{"note":"改过的备注"}""")
        }
        assertEquals(HttpStatusCode.NoContent, updated.status)
        assertTrue(client.get("/api/notes?sourceId=src&bookUrl=book").bodyAsText().contains("改过的备注"))

        assertEquals(HttpStatusCode.NoContent, client.delete("/api/notes/$id").status)
        assertTrue("删完列表应为空", client.get("/api/notes?sourceId=src&bookUrl=book").bodyAsText().trim() == "[]")

        // 非法入参：end < start 要 400
        val bad = client.post("/api/notes") {
            contentType(ContentType.Application.Json)
            setBody("""{"sourceId":"src","bookUrl":"book","startOffset":9,"endOffset":2,"excerpt":"x"}""")
        }
        assertEquals(HttpStatusCode.BadRequest, bad.status)
    }
    /**
     * 关掉库之后立刻删文件，在 Windows 上偶尔会被杀软 / 索引器占着（「另一个程序正在使用此文件」）。
     * 判据是断言，不是"临时文件删没删掉"，所以重试几次、删不掉就算了（系统临时目录自己会清）。
     */
    private fun cleanup(path: String) {
        repeat(3) {
            if (runCatching { Files.deleteIfExists(Path.of(path)) }.getOrNull() == true) return
            Thread.sleep(150)
        }
        runCatching { Files.deleteIfExists(Path.of("$path-wal")) }
        runCatching { Files.deleteIfExists(Path.of("$path-shm")) }
    }
}
