package io.legado

import io.legado.data.Database
import io.legado.data.cookieBucketMentions
import io.legado.data.cookieBucketMentionsNow
import io.legado.data.deleteSource
import io.legado.data.loadPersistedMentions
import io.legado.data.saveSource
import io.legado.source.SourceCodec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

/**
 * 凭据统计的落盘与重启复用。
 *
 * 冷启动那次全库扫描在忙起来的机器上要 3~13 秒；如果它还没跑到，第一下打开凭据管理就得干等。
 * 落盘之后，只要书源没变，启动只读一行 JSON。这里盯四件事：
 * 版本号确实跟着 source 表的增/改/删走、版本对得上时真的读的是落盘结果、
 * 书源改过之后落盘结果必须作废、以及「删一本换一本等长地址」这种表指纹会看走眼的情况。
 */
class CookieMentionsPersistenceTest {

    private fun tempPath(): Path = Files.createTempFile("legado-cookie-mentions-disk", ".sqlite")

    private fun open(path: Path) = Database(path.toString()).also { it.initialize() }

    private fun sourceJson(url: String) =
        """{"bookSourceUrl":"$url","ruleToc":{"chapterList":"$.data","chapterName":"$.title","chapterUrl":"$.url"},"ruleContent":{"content":"$.content"}}"""

    private fun save(db: Database, url: String) = db.saveSource(SourceCodec.parse(sourceJson(url)), null)

    @Test
    fun `书源的增改删都会让版本号前进`() {
        val path = tempPath()
        open(path).use { db ->
            val start = db.sourceRevision()
            val saved = save(db, "https://a.example")
            val afterInsert = db.sourceRevision()
            assertTrue("插入要算一次写", afterInsert > start)

            db.saveSource(SourceCodec.parse(sourceJson("https://a.example")), saved.version)
            val afterUpdate = db.sourceRevision()
            assertTrue("更新要算一次写", afterUpdate > afterInsert)

            db.deleteSource(saved.id)
            val afterDelete = db.sourceRevision()
            assertTrue("删除要算一次写", afterDelete > afterUpdate)
        }
    }

    @Test
    fun `书源没变时重开进程直接用落盘结果，不再扫全库`() {
        val path = tempPath()
        open(path).use { db ->
            save(db, "https://a.example")
            save(db, "https://b.example")
            assertEquals(1, db.cookieBucketMentionsNow()["a.example"])
        }

        open(path).use { db ->
            // 把落盘的 JSON 换成一个哨兵：第一次读要是真的去扫库，哨兵就不会出现。
            db.write { conn ->
                conn.prepareStatement("update app_meta set value = ? where key = 'cookie_mentions_json'").use {
                    it.setString(1, """{"sentinel.example":9}""")
                    it.executeUpdate()
                }
            }
            assertTrue("版本对得上就该用落盘结果", db.loadPersistedMentions())
            assertEquals(mapOf("sentinel.example" to 9), db.cookieBucketMentions())
        }
    }

    @Test
    fun `书源改过之后落盘结果作废，重开进程也要算新数`() {
        val path = tempPath()
        open(path).use { db ->
            save(db, "https://a.example")
            assertEquals(1, db.cookieBucketMentionsNow()["a.example"])
        }

        open(path).use { db ->
            save(db, "https://b.example")
            val counts = db.cookieBucketMentions()
            assertEquals("a 还在", 1, counts["a.example"])
            assertEquals("b 是这次改出来的", 1, counts["b.example"])
        }

        // 再开一次：这次落盘的已经是新数，不该又退回只有 a 的旧数。
        open(path).use { db ->
            val counts = db.cookieBucketMentions()
            assertEquals(1, counts["a.example"])
            assertEquals(1, counts["b.example"])
        }
    }

    @Test
    fun `删一本换一本等长地址，重启后也不能给出旧数`() {
        val path = tempPath()
        val staleId: String
        open(path).use { db ->
            staleId = save(db, "https://a.example").id
            assertEquals(1, db.cookieBucketMentionsNow()["a.example"])
        }

        open(path).use { db ->
            db.deleteSource(staleId)
            save(db, "https://c.example")
            // 这次先落盘（等价于上个进程算完就退），下次启动必须能发现书源已经换了。
            db.cookieBucketMentionsNow()
        }

        open(path).use { db ->
            val counts = db.cookieBucketMentions()
            assertEquals("换掉的那本不能再算", null, counts["a.example"])
            assertEquals("换上的那本要算", 1, counts["c.example"])
        }
    }
}
