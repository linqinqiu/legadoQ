package io.legado.data.db

import java.nio.file.Files
import java.nio.file.Path
import java.sql.Connection
import java.sql.DriverManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * 库版本号与有序迁移的判据（P0-3）。
 *
 * 迁移这段代码一年只跑一次、坏了也常常表现为「看着正常」，所以这里按**五类库**逐个钉：
 * 全新库、已是最新版、旧库逐级升级、迁移中途失败、万级数据量。另加一条「库比程序新」的
 * 拒绝启动。全部不经过 `Database`（迁移只吃一个 `Connection`），与 `MigrationTest` 同风格。
 */
class SchemaVersionTest {

    private class Fixture(val connection: Connection, val directory: Path) : AutoCloseable {
        override fun close() {
            runCatching { connection.close() }
            directory.toFile().deleteRecursively()
        }
    }

    private fun fixture(name: String): Fixture {
        val directory = Files.createTempDirectory(name)
        val connection = DriverManager.getConnection("jdbc:sqlite:${directory.resolve("legado.sqlite")}")
        return Fixture(connection, directory)
    }

    private fun Connection.exec(sql: String) = createStatement().use { it.executeUpdate(sql) }

    /** 模拟 `Database.transaction {}`：进来关自动提交，抛错整批回滚，退出复位。 */
    private fun <T> Connection.inTransaction(block: () -> T): T {
        autoCommit = false
        return try {
            val result = block()
            commit()
            result
        } catch (error: Throwable) {
            runCatching { rollback() }
            throw error
        } finally {
            runCatching { autoCommit = true }
        }
    }

    private fun Connection.columns(table: String): Set<String> =
        createStatement().use { st ->
            st.executeQuery("pragma table_info($table)").use { rs ->
                buildSet { while (rs.next()) add(rs.getString("name")) }
            }
        }

    private fun Connection.countOf(table: String): Long =
        createStatement().use { st -> st.executeQuery("select count(*) from $table").use { if (it.next()) it.getLong(1) else 0L } }

    private val positionColumns = listOf("scroll_position", "char_offset", "paragraph_anchor", "position_version", "position_checksum")

    // ==================== 类 1：全新库 ====================

    @Test
    fun `全新库从 v0 升到基线版本，补列齐全且可重入`() {
        val fixture = fixture("legado-schema-fresh")
        try {
            val db = fixture.connection
            Schema.createTables(db)
            assertEquals("刚建完表的库还没有版本号", 0, SchemaVersion.current(db))

            val version = db.inTransaction { SchemaVersion.migrate(db) }

            assertEquals(SchemaVersion.BASELINE, version)
            assertEquals("版本号要落盘", SchemaVersion.BASELINE, SchemaVersion.current(db))
            val columns = db.columns("reading_progress")
            positionColumns.forEach { assertTrue("全新库补完列应有 $it", it in columns) }

            // 再跑一次是纯空转：版本已到位就不该再执行任何步骤
            var touched = 0
            val noop = db.inTransaction {
                SchemaVersion.migrate(db, SchemaVersion.TARGET, mapOf(SchemaVersion.BASELINE to { _: Connection -> touched++ }))
            }
            assertEquals(SchemaVersion.BASELINE, noop)
            assertEquals("已是最新版时不得重跑迁移动作", 0, touched)
        } finally {
            fixture.close()
        }
    }

    // ==================== 类 2：已是最新版的库 ====================

    @Test
    fun `已是最新版的库零动作，数据不动`() {
        val fixture = fixture("legado-schema-current")
        try {
            val db = fixture.connection
            db.exec("create table reading_progress(source_id text, book_url text, chapter_url text)")
            db.exec("insert into reading_progress(source_id,book_url,chapter_url) values('s','b','c')")
            db.exec("pragma user_version = ${SchemaVersion.BASELINE}")

            var touched = 0
            val version = db.inTransaction {
                SchemaVersion.migrate(db, SchemaVersion.TARGET, mapOf(SchemaVersion.BASELINE to { _: Connection -> touched++ }))
            }

            assertEquals(SchemaVersion.BASELINE, version)
            assertEquals("已是当前版就不该再跑基线迁移", 0, touched)
            assertEquals("数据原样保留", 1L, db.countOf("reading_progress"))
            assertEquals("缺列不会被偷偷补（那属于版本号说错了，不是迁移该兜的事）", 3, db.columns("reading_progress").size)
        } finally {
            fixture.close()
        }
    }

    // ==================== 类 3：旧库逐级升级 ====================

    @Test
    fun `旧库按注册表逐级升级，每级都落一次版本号`() {
        val fixture = fixture("legado-schema-steps")
        try {
            val db = fixture.connection
            db.exec("create table demo(id integer primary key, name text)")
            db.exec("insert into demo(name) values('x')")

            val plan: Map<Int, (Connection) -> Unit> = mapOf(
                1 to { c -> c.exec("alter table demo add column level_one text") },
                2 to { c -> c.exec("alter table demo add column level_two text") },
                3 to { c -> c.exec("alter table demo add column level_three text") },
            )

            val version = db.inTransaction { SchemaVersion.migrate(db, target = 3, plan = plan) }

            assertEquals(3, version)
            assertEquals("最终版本号要落在库里", 3, SchemaVersion.current(db))
            val columns = db.columns("demo")
            listOf("level_one", "level_two", "level_three").forEach { assertTrue("缺 $it", it in columns) }
            assertEquals("迁移不该动数据", 1L, db.countOf("demo"))
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `注册表缺步骤时明确报错，不静默跳过`() {
        val fixture = fixture("legado-schema-missing-step")
        try {
            val db = fixture.connection
            db.exec("pragma user_version = 1")
            val error = runCatching {
                db.inTransaction { SchemaVersion.migrate(db, target = 3, plan = mapOf(2 to { _: Connection -> })) }
            }.exceptionOrNull()
            assertNotNull("缺 3 号步骤必须抛错", error)
            assertTrue("错误信息要说清缺哪一步：${error?.message}", error?.message.orEmpty().contains("v2 → v3"))
            assertEquals("失败后版本停在原处", 1, SchemaVersion.current(db))
        } finally {
            fixture.close()
        }
    }

    // ==================== 类 4：迁移中途失败 ====================

    @Test
    fun `中途失败整批回滚，版本不变且可原地重试`() {
        val fixture = fixture("legado-schema-failure")
        try {
            val db = fixture.connection
            db.exec("create table demo(id integer primary key, name text)")
            val boom = IllegalStateException("模拟第 2 步炸了")
            val failing: Map<Int, (Connection) -> Unit> = mapOf(
                1 to { c -> c.exec("alter table demo add column step_one text") },
                2 to { _ -> throw boom },
            )

            val error = runCatching { db.inTransaction { SchemaVersion.migrate(db, target = 2, plan = failing) } }.exceptionOrNull()

            assertNotNull(error)
            assertEquals("真因要能传上来", "模拟第 2 步炸了", error?.message)
            assertFalse("第 1 步的列必须随事务一起回滚", "step_one" in db.columns("demo"))
            assertEquals("版本号不得前进", 0, SchemaVersion.current(db))

            // 修好后重试能跑通：说明库没被留在半死状态
            val retried = db.inTransaction {
                SchemaVersion.migrate(
                    db,
                    target = 2,
                    plan = mapOf(
                        1 to { c -> c.exec("alter table demo add column step_one text") },
                        2 to { c -> c.exec("alter table demo add column step_two text") },
                    ),
                )
            }
            assertEquals(2, retried)
            assertTrue("step_one" in db.columns("demo"))
            assertTrue("step_two" in db.columns("demo"))
        } finally {
            fixture.close()
        }
    }

    // ==================== 类 5：万级数据量 ====================

    /**
     * 造一份「历史形状」的库：六段基线补列各自要读的表都在，但都缺后来补的那些列。
     * 真实的旧库也是这个形状（`createTables` 会 `create table if not exists`，不会改动已存在的表）。
     */
    private fun Connection.createLegacyShape() {
        exec("create table reading_progress(source_id text not null, book_url text not null, chapter_url text, chapter_index integer, updated_at integer)")
        exec("create table book_shelf(source_id text not null, book_url text not null, name text, author text, toc_url text, cover_key text, last_read_at integer)")
        exec("create table source(id text primary key, name text, payload text, version integer, updated_at integer)")
        exec("create table source_login_state(source_id text primary key, cookie_jar text)")
        exec("create table cookie(url text primary key, cookie text not null, updated_at integer not null)")
        exec("create table book_note(id integer primary key autoincrement, source_id text, book_url text, chapter_url text, excerpt text, note text)")
        exec("create table book_content_cache(source_id text, book_url text, chapter_url text, content text, primary key(source_id,book_url,chapter_url))")
        exec("create table book_toc_cache(source_id text, toc_url text, chapters_json text, updated_at integer, primary key(source_id,toc_url))")
    }

    @Test
    fun `万级数据的旧库照常升级，行数不丢`() {
        val fixture = fixture("legado-schema-bigdata")
        try {
            val db = fixture.connection
            db.createLegacyShape()
            db.autoCommit = false
            db.prepareStatement("insert into reading_progress(source_id,book_url,chapter_url,chapter_index,updated_at) values(?,?,?,?,?)").use { st ->
                repeat(10_000) { i ->
                    st.setString(1, "s${i % 50}")
                    st.setString(2, "https://b.test/${i % 200}")
                    st.setString(3, "https://b.test/c$i")
                    st.setInt(4, i)
                    st.setLong(5, i.toLong())
                    st.addBatch()
                }
                st.executeBatch()
            }
            db.commit()
            db.autoCommit = true

            val version = db.inTransaction { SchemaVersion.migrate(db) }

            assertEquals(SchemaVersion.BASELINE, version)
            assertEquals("万级行数不能在迁移里丢", 10_000L, db.countOf("reading_progress"))
            assertTrue("基线列要补齐", positionColumns.all { it in db.columns("reading_progress") })
        } finally {
            fixture.close()
        }
    }

    // ==================== 库比程序新 ====================

    @Test
    fun `库版本高于程序时拒绝启动`() {
        val fixture = fixture("legado-schema-ahead")
        try {
            val db = fixture.connection
            db.exec("create table demo(id integer primary key)")
            db.exec("pragma user_version = ${SchemaVersion.TARGET + 5}")
            val error = runCatching { db.inTransaction { SchemaVersion.migrate(db) } }.exceptionOrNull()
            assertNotNull("程序被降级时必须拒绝启动", error)
            assertTrue("要说清版本关系：${error?.message}", error?.message.orEmpty().contains("高于程序支持"))
            assertEquals("拒绝启动不该改版本号", SchemaVersion.TARGET + 5, SchemaVersion.current(db))
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `基线迁移一步就把六段历史补列跑完`() {
        val fixture = fixture("legado-schema-baseline-shape")
        try {
            val db = fixture.connection
            Schema.createTables(db)
            db.exec("pragma user_version = 0")
            db.inTransaction { SchemaVersion.migrate(db) }

            // 抽样覆盖六段各自的目标形状
            assertTrue("reading_progress", positionColumns.all { it in db.columns("reading_progress") })
            assertTrue("book_shelf", "group_id" in db.columns("book_shelf") && "toc_rule" in db.columns("book_shelf"))
            assertTrue("source", "has_login" in db.columns("source") && "has_rules" in db.columns("source"))
            assertTrue("book_note", "bookmark" in db.columns("book_note") && "position_checksum" in db.columns("book_note"))
            assertTrue("book_content_cache", "chapter_index" in db.columns("book_content_cache"))
            assertTrue("cookie 表存在（旧 cookie_jar 折叠的落点）", runCatching { db.countOf("cookie") }.isSuccess)
        } catch (error: Throwable) {
            fail("基线迁移跑不动：${error.message}")
        } finally {
            fixture.close()
        }
    }
}
