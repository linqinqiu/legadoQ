package io.legado.data.db

import io.legado.AppConfig
import io.legado.data.Database
import kotlin.concurrent.withLock
import org.sqlite.SQLiteConfig
import java.nio.file.Files
import java.nio.file.Path
import java.sql.Connection

/**
 * 连接池：从 `Database.kt` 拆出。
 *
 * 职责：建立读连接池、写连接、WAL 配置、连接健康检查（`select 1`）。
 * `Database` 只持有该实例，不再直接管理连接生命周期细节。
 */
class ConnectionPool(private val path: String, private val maxPoolSize: Int) {

    private val writeLock = java.util.concurrent.locks.ReentrantLock()
    private val readPool = java.util.concurrent.ConcurrentLinkedQueue<Connection>()
    @Volatile internal var isClosed = false
    private var _writeConnection: Connection? = null
    private val allConnections = java.util.concurrent.ConcurrentHashMap.newKeySet<Connection>()

    private val sqliteConfig = SQLiteConfig().apply {
        setJournalMode(SQLiteConfig.JournalMode.WAL)
        setSynchronous(SQLiteConfig.SynchronousMode.NORMAL)
        setBusyTimeout(10000)
        enforceForeignKeys(true)
    }

    init {
        Files.createDirectories(Path.of(path).toAbsolutePath().parent)
    }

    private fun createConnection(): Connection =
        sqliteConfig.createConnection("jdbc:sqlite:$path").also { allConnections.add(it) }

    /** 取出读连接：先从池里复用，池空则新建；失效连接直接丢弃并重建。 */
    fun borrowRead(): Connection {
        var connection = readPool.poll()?.takeIf { !it.isClosed } ?: createConnection()
        // 轻量健康检查：失效连接不回池，直接丢弃。
        if (!isConnectionAlive(connection)) {
            runCatching { connection.close() }
            connection = createConnection()
        }
        return connection
    }

    /** 归还读连接：池未满则放回，否则关闭。 */
    fun releaseRead(connection: Connection) {
        if (!isClosed && !connection.isClosed && readPool.size < maxPoolSize) {
            readPool.offer(connection)
        } else {
            runCatching { connection.close() }
        }
    }

    /** 写连接：全局单写，复用同一连接。 */
    fun writeConnection(): Connection {
        var conn = _writeConnection
        if (conn == null || conn.isClosed) {
            conn = createConnection()
            _writeConnection = conn
        }
        return conn
    }

    /** 在写连接上执行 block（单写，全局锁）。 */
    fun <T> useWrite(block: (Connection) -> T): T =
        writeLock.withLock {
            check(!isClosed) { "ConnectionPool is closed" }
            block(writeConnection())
        }

    /** 关闭所有连接。 */
    fun close() {
        if (isClosed) return
        isClosed = true
        writeLock.withLock {
            _writeConnection?.let { runCatching { it.close() } }
            _writeConnection = null
        }
        while (true) {
            val conn = readPool.poll() ?: break
            runCatching { conn.close() }
        }
        for (conn in allConnections) runCatching { conn.close() }
        allConnections.clear()
    }

    /** 轻量健康检查：执行 `select 1`，失败视为连接已失效。 */
    private fun isConnectionAlive(conn: Connection): Boolean {
        return runCatching {
            conn.createStatement().use { it.executeQuery("select 1").use { it.next() } }
        }.getOrDefault(false)
    }

    companion object {
        /** 默认最大读连接池大小，由 `AppConfig.dbPoolSize` 决定。 */
        fun default(path: String): ConnectionPool =
            ConnectionPool(path, AppConfig.dbPoolSize)
    }
}
