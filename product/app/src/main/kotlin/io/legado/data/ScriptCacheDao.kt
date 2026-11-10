package io.legado.data

import io.legado.port.ScriptCacheValue

/**
 * 书源脚本 `cache` 全局的持久层（上游 `CacheManager` 的等价物）。
 *
 * 只存字符串：上游 `CacheManager.put` 对非字节数组的值也是先 `value.toString()` 再落盘，
 * 脚本真正要缓存结构化数据时会自己 `JSON.stringify`（蓝批那套 `putInCacheObject` 就是）。
 * 键按书源隔离，见 `Database` 里 `script_cache` 表的注释。
 */

/**
 * 值与过期时刻一起返回。
 *
 * 为什么不是只给 `String?`：调用方要把这条回填进内存层，而内存层是拿 deadline 判过期的。
 * 只回填 value 会把它写成「永不过期」——「缓存 5 分钟」在常驻服务里变成永久命中，
 * 与 `ScriptCache` 注释里写的语义正好相反（读一次盘之后就不再认过期了）。
 */
fun Database.getScriptCacheEntry(
    sourceId: String,
    key: String,
    now: Long = System.currentTimeMillis(),
): ScriptCacheValue? = connect { db ->
    db.prepareStatement("select value, deadline from script_cache where source_id = ? and key = ?").use { stmt ->
        stmt.setString(1, sourceId)
        stmt.setString(2, key)
        stmt.executeQuery().use { rs ->
            if (!rs.next()) {
                null
            } else {
                val deadline = rs.getLong(2)
                // 过期就当作没有：不在这里删行，读路径保持只读（连接来自读池）。
                if (deadline > 0 && deadline <= now) null else ScriptCacheValue(rs.getString(1), deadline)
            }
        }
    }
}

fun Database.getScriptCache(sourceId: String, key: String, now: Long = System.currentTimeMillis()): String? =
    getScriptCacheEntry(sourceId, key, now)?.value

fun Database.putScriptCache(sourceId: String, key: String, value: String, deadline: Long): Boolean =
    write { db ->
        db.prepareStatement(
            """
            insert into script_cache(source_id, key, value, deadline, updated_at) values(?, ?, ?, ?, ?)
            on conflict(source_id, key) do update set
              value = excluded.value, deadline = excluded.deadline, updated_at = excluded.updated_at
            """.trimIndent(),
        ).use { stmt ->
            stmt.setString(1, sourceId)
            stmt.setString(2, key)
            stmt.setString(3, value)
            stmt.setLong(4, deadline)
            stmt.setLong(5, System.currentTimeMillis())
            stmt.executeUpdate() > 0
        }
    }

fun Database.deleteScriptCache(sourceId: String, key: String): Boolean = write { db ->
    db.prepareStatement("delete from script_cache where source_id = ? and key = ?").use { stmt ->
        stmt.setString(1, sourceId)
        stmt.setString(2, key)
        stmt.executeUpdate() > 0
    }
}
