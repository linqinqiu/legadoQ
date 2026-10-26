package io.legado

import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import io.legado.data.Database
import io.legado.data.addReadingLog
import io.legado.data.listReadingLog
import io.legado.model.ReadingLogRequest
import java.nio.file.Files
import java.nio.file.Path
import java.sql.DriverManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 阅读记录（PROPOSAL-019 D）。
 *
 * 契约就两条：**只增不改**（POST 累加、GET 读，没有编辑/删除单条的入口），
 * 粒度是「一天 · 一本书」一行。这里钉三件事：同一天同一本书的秒数真的累加、
 * 不同书分开记、`days` 之外的旧记录不返回。
 */
class ReadingLogTest {
    private fun tempDb(): String = Files.createTempFile("legado-reading-log", ".sqlite").toString()

    @Test
    fun `同一天同一本书的停留累加成一行的秒数，章节取最远那一章`() {
        val path = tempDb()
        try {
            val db = Database(path)
            db.initialize()
            db.addReadingLog(ReadingLogRequest("src", "book", "书甲", 3, 20))
            db.addReadingLog(ReadingLogRequest("src", "book", "书甲", 5, 25))
            val rows = db.listReadingLog(30)
            assertEquals("一天一本书只应有一行", 1, rows.size)
            assertEquals("秒数要累加", 45L, rows[0].seconds)
            assertEquals("章节号取当天读到的最远那一章", 5, rows[0].chapterIndex)
            assertEquals("书甲", rows[0].bookName)
            db.close()
        } finally {
            cleanup(path)
        }
    }

    @Test
    fun `不同书分开记，同一天里按秒数倒序`() {
        val path = tempDb()
        try {
            val db = Database(path)
            db.initialize()
            db.addReadingLog(ReadingLogRequest("src", "bookA", "甲", 0, 10))
            db.addReadingLog(ReadingLogRequest("src", "bookB", "乙", 0, 60))
            val rows = db.listReadingLog(30)
            assertEquals(2, rows.size)
            assertEquals("读得久的排前面", "乙", rows[0].bookName)
            db.close()
        } finally {
            cleanup(path)
        }
    }

    @Test
    fun `days 之外的旧记录不返回`() {
        val path = tempDb()
        try {
            val db = Database(path)
            db.initialize()
            db.addReadingLog(ReadingLogRequest("src", "book", "今天的", 0, 30))
            // 直接塞一条 40 天前的（公开接口不提供改日期，正是"只增不改"的意思）
            val oldDay = java.time.LocalDate.now().minusDays(40).toString()
            DriverManager.getConnection("jdbc:sqlite:$path").use { raw ->
                raw.prepareStatement("insert into reading_log(day,source_id,book_url,book_name,chapter_index,seconds,updated_at) values(?,?,?,?,?,?,?)").use {
                    it.setString(1, oldDay); it.setString(2, "src"); it.setString(3, "oldBook"); it.setString(4, "很久以前")
                    it.setInt(5, 1); it.setInt(6, 99); it.setLong(7, System.currentTimeMillis()); it.executeUpdate()
                }
            }
            assertEquals("7 天内只有今天那条", 1, db.listReadingLog(7).size)
            assertEquals("放宽到 60 天，旧的也在", 2, db.listReadingLog(60).size)
            db.close()
        } finally {
            cleanup(path)
        }
    }

    @Test
    fun `路由契约：POST 累加、GET 读回`() = testApplication {
        val config = ServerConfig(
            host = "127.0.0.1",
            port = 8080,
            databasePath = Files.createTempFile("legado-reading-log-http", ".sqlite").toString(),
            coverCacheDirectory = Files.createTempDirectory("legado-reading-log-http-covers"),
            homeDirectory = Files.createTempDirectory("legado-reading-log-http-home"),
        )
        application { legadoApplication(config) }
        val client = createClient { }

        // 写操作不带 Origin = 本机界面，放行（Guard 的口径，见 SameOriginGuardTest）
        for (seconds in listOf(15, 45)) {
            val post = client.post("/api/reading-log") {
                contentType(ContentType.Application.Json)
                setBody("""{"sourceId":"src","bookUrl":"book","bookName":"契约书","chapterIndex":2,"seconds":$seconds}""")
            }
            assertEquals(HttpStatusCode.OK, post.status)
        }
        val read = client.get("/api/reading-log?days=7")
        assertEquals(HttpStatusCode.OK, read.status)
        val body = read.bodyAsText()
        assertTrue("应有累加后的 60 秒：$body", body.contains("\"seconds\":60"))
        assertTrue("书名要带上：$body", body.contains("契约书"))

        // 非法入参（负数秒）要 400，别把脏数据写进时间轴
        val bad = client.post("/api/reading-log") {
            contentType(ContentType.Application.Json)
            setBody("""{"sourceId":"src","bookUrl":"book","seconds":-5}""")
        }
        assertEquals(HttpStatusCode.BadRequest, bad.status)
    }
    /**
     * 关掉库之后立刻删文件，在 Windows 上偶尔会被杀软 / 索引器占着（「另一个程序正在使用此文件」）。
     * 判据是断言，不是临时文件删没删掉，所以重试几次、删不掉就算了（系统临时目录自己会清）。
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
