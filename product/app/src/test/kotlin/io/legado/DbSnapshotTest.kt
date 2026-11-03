package io.legado

import io.legado.data.DbSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path
import java.sql.DriverManager

/**
 * 库文件级快照的单测：全部打在真 SQLite 连接上（xerial 驱动随 app 测试依赖在场），
 * 断言的是"快照能不能被独立打开、哈希对不对、超额有没有淘汰、到期判断准不准"，
 * 不是 mock —— 因为 VACUUM INTO 的行为本身就是要验的对象。
 */
class DbSnapshotTest {

    private fun seededDb(dir: Path): Pair<java.sql.Connection, String> {
        val dbPath = dir.resolve("legado.sqlite").toString()
        val conn = DriverManager.getConnection("jdbc:sqlite:$dbPath")
        conn.createStatement().use {
            it.execute("create table t(id integer primary key, v text)")
            it.execute("insert into t(v) values('hello')")
        }
        return conn to dbPath
    }

    @Test
    fun `快照产出可独立打开的库并写正确的 sha256 sidecar`() {
        val dir = Files.createTempDirectory("legado-snap")
        val (conn, dbPath) = seededDb(dir)
        val snap = DbSnapshot.run(conn, dbPath, keep = 5)
        assertNotNull(snap)
        val file = snap!!
        assertTrue(Files.isRegularFile(file))

        val sidecar = dir.resolve("backups").resolve("${file.fileName}.sha256")
        assertTrue(Files.exists(sidecar))
        val recorded = Files.readString(sidecar).substringBefore(" ").trim()
        assertEquals(DbSnapshot.sha256Of(file), recorded)

        // 快照能独立打开并读到那行数据 —— 这才叫可用的回滚副本
        DriverManager.getConnection("jdbc:sqlite:${file.toAbsolutePath()}").use { c ->
            c.createStatement().use { st ->
                st.executeQuery("select v from t").use { rs ->
                    assertTrue(rs.next())
                    assertEquals("hello", rs.getString(1))
                }
            }
        }
        conn.close()
    }

    @Test
    fun `保留 N 份，超额连同 sidecar 一起淘汰`() {
        val dir = Files.createTempDirectory("legado-snap-keep")
        val (conn, dbPath) = seededDb(dir)
        repeat(4) {
            DbSnapshot.run(conn, dbPath, keep = 2)
            Thread.sleep(6) // 保证时间戳互异（文件名即毫秒）
        }
        val backups = dir.resolve("backups")
        val snaps = Files.list(backups).use { s -> s.filter { it.fileName.toString().endsWith(".sqlite") }.toList() }
        val sidecars = Files.list(backups).use { s -> s.filter { it.fileName.toString().endsWith(".sha256") }.toList() }
        assertEquals(2L, snaps.size.toLong())
        assertEquals(2L, sidecars.size.toLong())
        conn.close()
    }

    @Test
    fun `keep 为 0 时关闭快照`() {
        val dir = Files.createTempDirectory("legado-snap-off")
        val (conn, dbPath) = seededDb(dir)
        assertNull(DbSnapshot.run(conn, dbPath, keep = 0))
        assertFalse(Files.exists(dir.resolve("backups")))
        conn.close()
    }

    @Test
    fun `latestSnapshotTs 认得最新一份、没有则空`() {
        val dir = Files.createTempDirectory("legado-snap-ts")
        val (conn, dbPath) = seededDb(dir)
        val backupsDir = DbSnapshot.backupsDirOf(dbPath)
        assertNull(DbSnapshot.latestSnapshotTs(backupsDir))
        val first = DbSnapshot.run(conn, dbPath, keep = 5)!!
        Thread.sleep(6)
        val second = DbSnapshot.run(conn, dbPath, keep = 5)!!
        val firstTs = first.fileName.toString().removePrefix("legado-").removeSuffix(".sqlite").toLong()
        val secondTs = second.fileName.toString().removePrefix("legado-").removeSuffix(".sqlite").toLong()
        val latest = DbSnapshot.latestSnapshotTs(backupsDir)
        assertNotNull(latest)
        assertEquals(secondTs, latest!!)
        assertTrue(latest > firstTs)
        conn.close()
    }

    @Test
    fun `list 列出快照并校验完整性，篡改后 verified 变 false`() {
        val dir = Files.createTempDirectory("legado-snap-list")
        val (conn, dbPath) = seededDb(dir)
        assertTrue(DbSnapshot.list(dbPath).isEmpty())
        val snap = DbSnapshot.run(conn, dbPath, keep = 5)!!
        val listed = DbSnapshot.list(dbPath)
        assertEquals(1, listed.size)
        assertEquals(snap.fileName.toString(), listed[0].name)
        assertTrue(listed[0].verified)
        assertTrue(listed[0].bytes > 0)
        // 篡改快照字节 → 重算哈希与 sidecar 不符 → verified=false
        val bytes = Files.readAllBytes(snap)
        bytes[bytes.size / 2] = (bytes[bytes.size / 2].toInt() xor 0xFF).toByte()
        Files.write(snap, bytes)
        assertFalse(DbSnapshot.list(dbPath).first { it.name == snap.fileName.toString() }.verified)
        conn.close()
    }

    @Test
    fun `排定并应用恢复：换回快照内容、留 pre-restore 副本、清标记`() {
        val dir = Files.createTempDirectory("legado-snap-restore")
        val (conn, dbPath) = seededDb(dir)   // 当前库有 hello
        val snap = DbSnapshot.run(conn, dbPath, keep = 5)!!   // 快照=hello 时刻
        conn.createStatement().use { it.execute("insert into t(v) values('after')") } // 现库多出 after
        conn.close()
        assertTrue(DbSnapshot.scheduleRestore(dbPath, snap.fileName.toString()))
        assertTrue(DbSnapshot.applyPendingRestore(dbPath))
        // 恢复后现库=快照内容（只有 hello，after 没了）
        DriverManager.getConnection("jdbc:sqlite:$dbPath").use { c ->
            c.createStatement().use { st ->
                st.executeQuery("select v from t").use { rs ->
                    val vs = buildList { while (rs.next()) add(rs.getString(1)) }
                    assertTrue("恢复应回到只有 hello，实得 $vs", vs == listOf("hello"))
                }
            }
        }
        val backups = dir.resolve("backups")
        assertTrue("应留下 pre-restore 安全副本", Files.list(backups).use { s -> s.anyMatch { it.fileName.toString().startsWith("pre-restore-") } })
        assertFalse("恢复后待恢复标记应清除", Files.exists(backups.resolve(".pending-restore")))
    }

    @Test
    fun `快照被篡改则拒绝排定恢复，不碰库`() {
        val dir = Files.createTempDirectory("legado-snap-restore-bad")
        val (conn, dbPath) = seededDb(dir)
        val snap = DbSnapshot.run(conn, dbPath, keep = 5)!!
        conn.close()
        val bytes = Files.readAllBytes(snap)
        bytes[bytes.size / 2] = (bytes[bytes.size / 2].toInt() xor 0xFF).toByte()
        Files.write(snap, bytes)   // 破坏快照 → verified=false
        assertFalse(DbSnapshot.scheduleRestore(dbPath, snap.fileName.toString()))
        assertFalse("拒绝时不应写待恢复标记", Files.exists(dir.resolve("backups/.pending-restore")))
    }
}
