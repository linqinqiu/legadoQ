package io.legado.data.db

import java.nio.file.Files
import java.nio.file.Path
import java.sql.Connection
import java.sql.DriverManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 旧库升级的判据。
 *
 * 迁移是最容易「一年只跑一次、坏了也没人知道」的一段代码：老用户升级时它要么补上列、
 * 要么静默什么都不做，而两种结果在界面上都可能表现为「一切正常」。
 *
 * 这里不经过 `Database`，直接造一张**旧形状**的表，跑迁移，再查结果 —— 迁移本来就只吃
 * 一个 `Connection`，没必要为了测它起整个应用。
 */
class MigrationTest {

    private class Fixture(val connection: Connection, val directory: Path) : AutoCloseable {
        override fun close() {
            runCatching { connection.close() }
            directory.toFile().deleteRecursively()
        }
    }

    private fun fixture(name: String): Fixture {
        val directory = Files.createTempDirectory(name)
        val connection = DriverManager.getConnection("jdbc:sqlite:${directory.resolve("legacy.sqlite")}")
        return Fixture(connection, directory)
    }

    private fun Connection.exec(sql: String) = createStatement().use { it.executeUpdate(sql) }

    private fun Connection.columns(table: String): Set<String> =
        createStatement().use { st ->
            st.executeQuery("pragma table_info($table)").use { rs ->
                buildSet { while (rs.next()) add(rs.getString("name")) }
            }
        }

    private fun Connection.longOf(sql: String): Long? =
        createStatement().use { st -> st.executeQuery(sql).use { if (it.next()) it.getLong(1) else null } }

    private fun Connection.stringOf(sql: String): String? =
        createStatement().use { st -> st.executeQuery(sql).use { if (it.next()) it.getString(1) else null } }

    // ==================== 补列 ====================

    @Test
    fun `reading_progress 补齐逻辑位置五列，重复跑不炸`() {
        val fixture = fixture("legado-migrate-progress")
        try {
            val db = fixture.connection
            db.exec("create table reading_progress(source_id text not null, book_url text not null, chapter_url text, chapter_index integer, updated_at integer)")

            Migration.migrateReadingProgress(db)
            val columns = db.columns("reading_progress")
            listOf("scroll_position", "char_offset", "paragraph_anchor", "position_version", "position_checksum")
                .forEach { assertTrue("缺列 $it", it in columns) }

            // 幂等：第二次不该再 alter 一遍（SQLite 会报 duplicate column）
            Migration.migrateReadingProgress(db)
            assertEquals(columns, db.columns("reading_progress"))
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `book_shelf 补齐五列`() {
        val fixture = fixture("legado-migrate-shelf")
        try {
            val db = fixture.connection
            db.exec("create table book_shelf(source_id text not null, book_url text not null, name text, author text, toc_url text, cover_key text, last_read_at integer)")
            Migration.migrateBookshelf(db)
            val columns = db.columns("book_shelf")
            listOf("completed", "alternate_sources", "group_id", "toc_rule", "sort_order")
                .forEach { assertTrue("缺列 $it", it in columns) }
            Migration.migrateBookshelf(db)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `book_note 补齐四列`() {
        val fixture = fixture("legado-migrate-note")
        try {
            val db = fixture.connection
            db.exec("create table book_note(id integer primary key autoincrement, source_id text, book_url text, chapter_url text, excerpt text, note text)")
            Migration.migrateBookNote(db)
            val columns = db.columns("book_note")
            listOf("bookmark", "paragraph_anchor", "position_version", "position_checksum")
                .forEach { assertTrue("缺列 $it", it in columns) }
            Migration.migrateBookNote(db)
        } finally {
            fixture.close()
        }
    }

    // ==================== source 表 ====================

    @Test
    fun `source 表按 payload 回填 has_login`() {
        val fixture = fixture("legado-migrate-haslogin")
        try {
            val db = fixture.connection
            db.exec("create table source(id text primary key, name text, payload text, version integer, updated_at integer)")
            db.exec("""insert into source(id,name,payload,version,updated_at) values('a','要登录','{"bookSourceUrl":"https://a.test","loginUrl":"https://a.test/login"}',1,0)""")
            db.exec("""insert into source(id,name,payload,version,updated_at) values('b','不登录','{"bookSourceUrl":"https://b.test"}',1,0)""")

            Migration.migrateSourceTable(db)

            assertTrue("要补 has_login 列", "has_login" in db.columns("source"))
            assertEquals(
                "payload 里带 loginUrl 的源应当被标成要登录",
                1L,
                db.longOf("select has_login from source where id = 'a'"),
            )
            assertEquals(
                "不带的仍是 0",
                0L,
                db.longOf("select has_login from source where id = 'b'"),
            )
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `source 表按规则回填 has_rules`() {
        val fixture = fixture("legado-migrate-hasrules")
        try {
            val db = fixture.connection
            db.exec("create table source(id text primary key, name text, payload text, version integer, updated_at integer)")
            db.exec("""insert into source(id,name,payload,version,updated_at) values('has','有规则','{"bookSourceUrl":"https://h.test","ruleSearch":{"bookList":"$.list"}}',1,0)""")
            db.exec("""insert into source(id,name,payload,version,updated_at) values('none','只剩元数据','{"bookSourceUrl":"https://n.test"}',1,0)""")

            Migration.migrateSourceTable(db)

            assertEquals(1L, db.longOf("select has_rules from source where id = 'has'"))
            assertEquals("一条规则都没有的源要被标成 0", 0L, db.longOf("select has_rules from source where id = 'none'"))
        } finally {
            fixture.close()
        }
    }

    // ==================== 旧 cookie_jar 折叠 ====================

    @Test
    fun `旧 cookie_jar 折进全局 cookie 表，同域合并后清空原列`() {
        val fixture = fixture("legado-migrate-cookiejar")
        try {
            val db = fixture.connection
            db.exec("create table source_login_state(source_id text primary key, cookie_jar text)")
            db.exec("create table cookie(url text primary key, cookie text not null, updated_at integer not null)")
            db.exec("""insert into source_login_state(source_id,cookie_jar) values('s1','{"https://a.test":"token=aaa"}')""")
            db.exec("""insert into source_login_state(source_id,cookie_jar) values('s2','{"https://a.test":"uid=123"}')""")

            Migration.migrateLegacyCookieJars(db)

            val merged = db.stringOf("select cookie from cookie where url = 'a.test'")
            assertTrue("两个源的 Cookie 要合并到同一个域桶：$merged", merged!!.contains("token=aaa") && merged.contains("uid=123"))
            assertEquals("折叠完要把旧列清空", 0L, db.longOf("select count(*) from source_login_state where cookie_jar is not null"))
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `cookie_jar 不是合法 JSON 时跳过，不炸整次迁移`() {
        val fixture = fixture("legado-migrate-cookiejar-bad")
        try {
            val db = fixture.connection
            db.exec("create table source_login_state(source_id text primary key, cookie_jar text)")
            db.exec("create table cookie(url text primary key, cookie text not null, updated_at integer not null)")
            db.exec("insert into source_login_state(source_id,cookie_jar) values('bad','{不是 json')")

            Migration.migrateLegacyCookieJars(db)

            assertNull("坏数据不该产生 Cookie 行", db.longOf("select count(*) from cookie")?.takeIf { it > 0 })
            assertEquals("坏行也要被清空，免得每次启动都重试", 0L, db.longOf("select count(*) from source_login_state where cookie_jar is not null"))
        } finally {
            fixture.close()
        }
    }

    // ==================== 正文缓存的章号回填 ====================

    @Test
    fun `正文缓存补 chapter_index 并按目录缓存回填`() {
        val fixture = fixture("legado-migrate-contentindex")
        try {
            val db = fixture.connection
            db.exec("create table book_content_cache(source_id text, book_url text, chapter_url text, content text, primary key(source_id,book_url,chapter_url))")
            db.exec("create table book_toc_cache(source_id text, toc_url text, chapters_json text, updated_at integer, primary key(source_id,toc_url))")
            // `readTocChapters` 在目录缓存没命中时会回落到书架上的 toc_url —— 旧库里这张表是存在的
            db.exec("create table book_shelf(source_id text, book_url text, toc_url text)")

            db.exec("""insert into book_shelf(source_id,book_url,toc_url) values('s','https://b.test','https://b.test/toc')""")
            db.exec("""insert into book_content_cache values('s','https://b.test','https://b.test/2','正文二')""")
            db.exec("""insert into book_content_cache values('s','https://b.test','https://b.test/1','正文一')""")
            db.exec(
                """insert into book_toc_cache values('s','https://b.test/toc',
                   '[{"index":0,"title":"一","url":"https://b.test/1"},{"index":1,"title":"二","url":"https://b.test/2"}]',0)""",
            )

            Migration.migrateBookContentCache(db)

            assertTrue("要补 chapter_index 列", "chapter_index" in db.columns("book_content_cache"))
            assertEquals(1L, db.longOf("select chapter_index from book_content_cache where chapter_url = 'https://b.test/2'"))
            assertEquals(0L, db.longOf("select chapter_index from book_content_cache where chapter_url = 'https://b.test/1'"))
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `已有 chapter_index 的库直接跳过，不去读目录`() {
        val fixture = fixture("legado-migrate-contentindex-noop")
        try {
            val db = fixture.connection
            db.exec("create table book_content_cache(source_id text, book_url text, chapter_url text, content text, chapter_index integer not null default 0)")
            db.exec("""insert into book_content_cache values('s','https://b.test','https://b.test/1','正文',7)""")

            Migration.migrateBookContentCache(db)

            assertEquals("已有列就不该动数据", 7L, db.longOf("select chapter_index from book_content_cache"))
        } finally {
            fixture.close()
        }
    }
}
