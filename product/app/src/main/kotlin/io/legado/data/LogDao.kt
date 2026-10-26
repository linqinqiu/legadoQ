package io.legado.data

import io.legado.ops.LogEntry
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * `Database` 的结构化日志入库、重复计数、查询与裁剪面（0.8.2 结构重排从 `Database.kt` 逐字拆出）。
 * 写成同包扩展函数：调用点 `database.foo()` 与成员写法逐字一致；连接、`connect`/`write`（internal）、
 * 建表与迁移留在 `Database.kt`。跨包调用这些面需 `import io.legado.data.<方法>`（顶层扩展不是成员）。
 */
/** 日志保留上限：只留最近这么多条，超出即从最旧的一头裁掉，防止表无限增长。 */
private val LOG_RETENTION = 5000

/**
 * 单条堆栈的字符上限。
 *
 * 按**行数**保留 5000 条对纯文本日志够用，但这条日志带堆栈：本机实测 5000 行里
 * `message` 只占 0.06 MB、`context` 0.68 MB，而 `stack_trace` 独占 8.15 MB（约 90%），
 * 单条最长 4 KB。也就是说「留 5000 条」实际等于「留最多 20 MB 堆栈」。
 *
 * 堆栈的价值在前十几帧（谁抛的、谁调的），后面基本是框架递归和重复的 Caused by。
 * 截到 2000 字符仍能定位问题，同时把最坏情况压到 5000 × 2000 ≈ 10 MB 字符量级以内。
 */
private const val MAX_STACK_TRACE_CHARS = 2000

/**
 * 写一条日志入库；context 以 JSON 存，读回时再还原成 Map。裁剪在同一次写事务里做，避免额外一趟。
 *
 * 返回 rowid，给 [bumpLogRepeat] 用 —— 同类日志在合并窗口里不再插新行，
 * 而是把这一行的 `repeat_count` 加上去。没有 id 就没法合并，只能要么刷屏要么丢信息。
 */
fun Database.insertLog(entry: LogEntry, ts: Long): Long = write { db ->
    val ctx = if (entry.context.isEmpty()) null else runCatching { Json.encodeToString(entry.context) }.getOrNull()
    // 堆栈只留前面一段：完整堆栈的尾部是框架递归与重复的 Caused by，对定位没有增量信息。
    val stack = entry.stackTrace?.takeIf { it.isNotBlank() }?.let { raw ->
        if (raw.length <= MAX_STACK_TRACE_CHARS) raw
        else raw.take(MAX_STACK_TRACE_CHARS) + "\n…（已截断，原文 ${raw.length} 字符）"
    }
    db.prepareStatement(
        "insert into log_entry(ts,category,level,message,context,stack_trace,repeat_count) values(?,?,?,?,?,?,?)",
        java.sql.Statement.RETURN_GENERATED_KEYS,
    ).use {
        it.setLong(1, ts); it.setString(2, entry.category); it.setString(3, entry.level); it.setString(4, entry.message)
        it.setString(5, ctx); it.setString(6, stack); it.setInt(7, entry.count.coerceAtLeast(1))
        it.executeUpdate()
        it.generatedKeys.use { keys -> if (keys.next()) keys.getLong(1) else 0L }
    }.also {
        db.prepareStatement("delete from log_entry where id <= (select max(id)-? from log_entry)").use { drop ->
            drop.setInt(1, LOG_RETENTION); drop.executeUpdate()
        }
    }
}

/** 同类日志再来一条：不插新行，把计数抬上去（界面上那行会自己变成「×N」）。 */
fun Database.bumpLogRepeat(id: Long, count: Int) = write { db ->
    db.prepareStatement("update log_entry set repeat_count=? where id=?").use {
        it.setInt(1, count); it.setLong(2, id); it.executeUpdate()
    }
}

/** 按类别/等级过滤，倒序取最近 limit 条。category/level 传 null 表示不限。 */
fun Database.queryLogs(category: String?, level: String?, limit: Int): List<LogEntry> = connect { db ->
    val clauses = mutableListOf<String>()
    if (category != null) clauses.add("category=?")
    if (level != null) clauses.add("level=?")
    val where = if (clauses.isEmpty()) "" else " where " + clauses.joinToString(" and ")
    val sql = "select id,ts,category,level,message,context,stack_trace,repeat_count from log_entry$where order by id desc limit ?"
    db.prepareStatement(sql).use { stmt ->
        var i = 1
        if (category != null) stmt.setString(i++, category)
        if (level != null) stmt.setString(i++, level)
        stmt.setInt(i, limit)
        stmt.executeQuery().use { rs ->
            buildList {
                while (rs.next()) {
                    val ctx: Map<String, String> = rs.getString(6)?.takeIf { it.isNotBlank() }
                        ?.let { raw -> runCatching { Json.decodeFromString<Map<String, String>>(raw) }.getOrDefault(emptyMap()) }
                        ?: emptyMap()
                    val stamp = java.time.Instant.ofEpochMilli(rs.getLong(2))
                        .atZone(java.time.ZoneId.systemDefault()).toLocalDateTime()
                        .format(java.time.format.DateTimeFormatter.ISO_LOCAL_DATE_TIME)
                    add(LogEntry(id = rs.getLong(1), timestamp = stamp, category = rs.getString(3), level = rs.getString(4), message = rs.getString(5), context = ctx, stackTrace = rs.getString(7), count = rs.getInt(8).coerceAtLeast(1)))
                }
            }
        }
    }
}

fun Database.clearLogEntries(): Int = write { db -> db.prepareStatement("delete from log_entry").use { it.executeUpdate() } }

/**
 * 只建 log_entry 一张表（幂等）。
 * LogService 在 Application 里比 database.initialize() 更早启动，若不自建表，
 * 「服务器启动」这条 SYSTEM 日志会因表不存在而落库失败——而那正是运维最想看到的一条。
 */
fun Database.ensureLogTable() = write { db ->
    db.createStatement().use {
        it.executeUpdate("""create table if not exists log_entry (
              id integer primary key autoincrement, ts integer not null,
              category text not null, level text not null, message text not null,
              context text, stack_trace text, repeat_count integer not null default 1
            )""")
        it.executeUpdate("create index if not exists idx_log_entry_ts on log_entry(ts desc)")
        it.executeUpdate("create index if not exists idx_log_entry_category on log_entry(category)")
    }
    // 老库（这一列之前不存在）补列。SQLite 的 ADD COLUMN 不幂等，撞 "duplicate column name" 就是已经有了。
    runCatching { db.createStatement().use { it.executeUpdate("alter table log_entry add column repeat_count integer not null default 1") } }
}
