package io.legado

import io.legado.data.Database
import io.legado.data.importBookGroupsOn
import io.legado.data.importLibraryOn
import io.legado.model.BackupShelfEntry
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 事务基础设施（P0-1 2a）：`Database.transaction {}` 必须可嵌套，且**只有最外层**提交。
 *
 * 这条不是学术问题：备份导入是六步串起来的，六个步骤以前各自 `autoCommit = false …
 * commit() … finally autoCommit = true`。直接在外面套一层 `write { autoCommit = false }`
 * 会被第一个内层的 `finally` 当场提交掉 —— 0.2.35 的批量删书事故就是这么来的
 * （整批判失败、其实每本都已各自提交）。这里用数据把「不许提前提交」钉死。
 */
class TransactionTest {

    private fun tempDb() = Files.createTempFile("legado-tx", ".sqlite").toString()

    private fun cleanup(path: String) {
        repeat(3) {
            if (runCatching { Files.deleteIfExists(java.nio.file.Path.of(path)) }.getOrNull() == true) return
            Thread.sleep(150)
        }
        runCatching { Files.deleteIfExists(java.nio.file.Path.of("$path-wal")) }
        runCatching { Files.deleteIfExists(java.nio.file.Path.of("$path-shm")) }
    }

    private fun Database.insertGroup(id: Long, name: String) {
        transaction { db ->
            db.prepareStatement("insert into book_group(group_id, name, sort_order, created_at) values(?,?,?,?)").use {
                it.setLong(1, id); it.setString(2, name); it.setInt(3, id.toInt()); it.setLong(4, System.currentTimeMillis())
                it.executeUpdate()
            }
        }
    }

    private fun Database.groupNames(): List<String> =
        connect { db ->
            db.prepareStatement("select name from book_group order by group_id").use { stmt ->
                stmt.executeQuery().use { rs -> buildList { while (rs.next()) add(rs.getString(1)) } }
            }
        }

    @Test
    fun `内层失败只回滚内层 外层照常提交`() {
        val path = tempDb()
        val database = Database(path).apply { initialize() }
        try {
            database.transaction { _ ->
                database.insertGroup(1, "外层")
                runCatching {
                    database.transaction { _ ->
                        database.insertGroup(2, "内层")
                        error("内层失败")
                    }
                }
            }
            assertEquals("内层回滚后不该留下它的组，外层必须还在", listOf("外层"), database.groupNames())
        } finally {
            database.close()
            cleanup(path)
        }
    }

    @Test
    fun `外层失败整批回滚 内层不会提前提交`() {
        val path = tempDb()
        val database = Database(path).apply { initialize() }
        try {
            runCatching {
                database.transaction { _ ->
                    database.insertGroup(1, "第一步")
                    database.transaction { _ -> database.insertGroup(2, "第二步") }
                    error("第三步失败")
                }
            }
            assertTrue("外层失败必须整批回滚，不能留下任何一步：${database.groupNames()}", database.groupNames().isEmpty())
        } finally {
            database.close()
            cleanup(path)
        }
    }

    @Test
    fun `公开导入函数在同一笔事务里被调用时不会提前提交`() {
        val path = tempDb()
        val database = Database(path).apply { initialize() }
        try {
            // 复现 0.2.35 事故的形状：事务里调一个"自己管事务"的导入函数，随后抛错。
            runCatching {
                database.transaction { db ->
                    database.importBookGroupsOn(db, listOf(7L to "备份分组"))
                    database.importLibraryOn(
                        db,
                        listOf(
                            BackupShelfEntry(
                                sourceId = "s1",
                                bookUrl = "https://example.com/b1",
                                name = "书一",
                                author = null,
                                tocUrl = "",
                                coverUrl = null,
                                completed = false,
                                chapterIndex = 0,
                                readAt = 0,
                            ),
                        ),
                    )
                    error("后续步骤失败")
                }
            }
            assertTrue("导入函数不许自己提交：${database.groupNames()}", database.groupNames().isEmpty())
            val books = database.connect { db ->
                db.prepareStatement("select count(*) from book_shelf").use { it.executeQuery().use { rs -> rs.next(); rs.getInt(1) } }
            }
            assertEquals("书架也必须一起回滚", 0, books)
        } finally {
            database.close()
            cleanup(path)
        }
    }
}
