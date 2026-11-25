package io.legado.data.core

import java.io.Closeable
import java.sql.Connection

class DatabaseEngine(
    val dbPath: String,
    maxPoolSize: Int,
    private val snapshotKeep: Int,
    private val snapshotMinIntervalMs: Long,
) : Closeable {

    private val pool = ConnectionPool(dbPath, maxPoolSize)
    private val transactionDepth = ThreadLocal.withInitial { 0 }
    @Volatile private var closed = false

    fun <T> read(block: (Connection) -> T): T {
        check(!closed) { "Database is closed" }
        val connection = pool.borrowRead()
        return try {
            block(connection).also { pool.releaseRead(connection) }
        } catch (error: Throwable) {
            pool.releaseRead(connection)
            throw error
        }
    }

    fun <T> write(block: (Connection) -> T): T = pool.useWrite(block)

    /** 内层事务用 SAVEPOINT，只有最外层提交或回滚。 */
    fun <T> transaction(block: (Connection) -> T): T = write { db ->
        val depth = transactionDepth.get()
        val savepoint = if (depth == 0) {
            db.autoCommit = false
            null
        } else {
            db.setSavepoint("legado_tx_$depth")
        }
        transactionDepth.set(depth + 1)
        try {
            val result = block(db)
            if (savepoint != null) db.releaseSavepoint(savepoint)
            if (depth == 0) db.commit()
            result
        } catch (error: Throwable) {
            runCatching { if (savepoint != null) db.rollback(savepoint) else db.rollback() }
            throw error
        } finally {
            transactionDepth.set(depth)
            if (depth == 0) runCatching { db.autoCommit = true }
        }
    }

    fun initialize(migrate: (Connection) -> Unit) {
        write { db ->
            Schema.createTables(db)
            maybeSnapshot(db)
        }
        transaction(migrate)
    }

    private fun maybeSnapshot(db: Connection) {
        if (snapshotKeep <= 0) return
        val dir = DbSnapshot.backupsDirOf(dbPath)
        val latest = DbSnapshot.latestSnapshotTs(dir)
        if (snapshotMinIntervalMs > 0L && latest != null &&
            System.currentTimeMillis() - latest < snapshotMinIntervalMs
        ) return
        DbSnapshot.run(db, dbPath, snapshotKeep)
    }

    fun reclaimFreePages() {
        write { db ->
            val pageCount = runCatching {
                db.createStatement().use { statement ->
                    statement.executeQuery("pragma page_count").use { if (it.next()) it.getLong(1) else 0L }
                }
            }.getOrNull() ?: return@write
            val freePages = runCatching {
                db.createStatement().use { statement ->
                    statement.executeQuery("pragma freelist_count").use { if (it.next()) it.getLong(1) else 0L }
                }
            }.getOrNull() ?: return@write
            if (pageCount <= 0 || freePages <= 0) return@write
            val ratio = freePages.toDouble() / pageCount
            if (ratio < 0.25) return@write

            val before = pageCount
            runCatching {
                db.createStatement().use { it.execute("VACUUM") }
                db.createStatement().use { it.execute("pragma optimize") }
            }.onSuccess {
                val after = runCatching {
                    db.createStatement().use { statement ->
                        statement.executeQuery("pragma page_count").use { if (it.next()) it.getLong(1) else before }
                    }
                }.getOrDefault(before)
                System.err.println(
                    "数据库碎片回收：空闲页 $freePages/$pageCount（${(ratio * 100).toInt()}%）" +
                        "已 VACUUM，${before} → $after 页",
                )
            }.onFailure { error ->
                System.err.println(
                    "数据库碎片回收失败（空闲页 $freePages/$pageCount，${(ratio * 100).toInt()}%）：" +
                        "${error.javaClass.simpleName}: ${error.message} —— 不影响功能，只是文件没缩回去",
                )
            }
        }
    }

    override fun close() {
        if (closed) return
        closed = true
        pool.close()
    }
}
