package io.legado.data

import io.legado.model.SourceLoginStateRecord
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * `Database` 的书源登录态（填写项、请求头、变量、KV）读写与清理面（0.8.2 结构重排从 `Database.kt` 逐字拆出）。
 * 写成同包扩展函数：调用点 `database.foo()` 与成员写法逐字一致；连接、`connect`/`write`（internal）、
 * 建表与迁移留在 `Database.kt`。跨包调用这些面需 `import io.legado.data.<方法>`（顶层扩展不是成员）。
 */
fun Database.getSourceLoginState(sourceId: String): SourceLoginStateRecord? = connect { db ->
    db.prepareStatement("select source_id, login_info, login_header, source_variable, source_kv, cookie_jar, updated_at from source_login_state where source_id = ?").use { stmt ->
        stmt.setString(1, sourceId)
        stmt.executeQuery().use { rs ->
            if (rs.next()) {
                val loginInfo = rs.getString(2)?.takeIf { it.isNotBlank() }?.let { raw ->
                    runCatching { Json.decodeFromString<Map<String, String>>(raw) }.getOrDefault(emptyMap())
                } ?: emptyMap()
                val loginHeader = rs.getString(3)
                val sourceVariable = rs.getString(4)
                val sourceKv = rs.getString(5)?.takeIf { it.isNotBlank() }?.let { raw ->
                    runCatching { Json.decodeFromString<Map<String, String>>(raw) }.getOrDefault(emptyMap())
                } ?: emptyMap()
                val cookieJar = rs.getString(6)?.takeIf { it.isNotBlank() }?.let { raw ->
                    runCatching { Json.decodeFromString<Map<String, String>>(raw) }.getOrDefault(emptyMap())
                } ?: emptyMap()
                val updatedAt = rs.getLong(7)
                SourceLoginStateRecord(
                    sourceId = rs.getString(1),
                    loginInfo = loginInfo,
                    loginHeader = loginHeader,
                    sourceVariable = sourceVariable,
                    sourceKv = sourceKv,
                    cookieJar = cookieJar,
                    updatedAt = updatedAt,
                )
            } else null
        }
    }
}

fun Database.saveSourceLoginInfo(sourceId: String, loginInfo: Map<String, String>): Boolean = write { db ->
    val now = System.currentTimeMillis()
    val infoJson = Json.encodeToString(loginInfo)
    db.prepareStatement("""
        insert into source_login_state(source_id, login_info, updated_at) values(?, ?, ?)
        on conflict(source_id) do update set login_info=excluded.login_info, updated_at=excluded.updated_at
    """).use { stmt ->
        stmt.setString(1, sourceId)
        stmt.setString(2, infoJson)
        stmt.setLong(3, now)
        stmt.executeUpdate() > 0
    }
}

fun Database.saveSourceLoginHeader(sourceId: String, header: String?): Boolean = write { db ->
    val now = System.currentTimeMillis()
    db.prepareStatement("""
        insert into source_login_state(source_id, login_header, updated_at) values(?, ?, ?)
        on conflict(source_id) do update set login_header=excluded.login_header, updated_at=excluded.updated_at
    """).use { stmt ->
        stmt.setString(1, sourceId)
        stmt.setString(2, header)
        stmt.setLong(3, now)
        stmt.executeUpdate() > 0
    }
}

fun Database.removeSourceLoginHeader(sourceId: String): Boolean = write { db ->
    val now = System.currentTimeMillis()
    db.prepareStatement("""
        update source_login_state set login_header = null, updated_at = ? where source_id = ?
    """).use { stmt ->
        stmt.setLong(1, now)
        stmt.setString(2, sourceId)
        stmt.executeUpdate() > 0
    }
}

fun Database.removeSourceLoginInfo(sourceId: String): Boolean = write { db ->
    val now = System.currentTimeMillis()
    db.prepareStatement("""
        update source_login_state set login_info = null, updated_at = ? where source_id = ?
    """).use { stmt ->
        stmt.setLong(1, now)
        stmt.setString(2, sourceId)
        stmt.executeUpdate() > 0
    }
}

fun Database.saveSourceVariable(sourceId: String, variable: String?): Boolean = write { db ->
    val now = System.currentTimeMillis()
    db.prepareStatement("""
        insert into source_login_state(source_id, source_variable, updated_at) values(?, ?, ?)
        on conflict(source_id) do update set source_variable=excluded.source_variable, updated_at=excluded.updated_at
    """).use { stmt ->
        stmt.setString(1, sourceId)
        stmt.setString(2, variable)
        stmt.setLong(3, now)
        stmt.executeUpdate() > 0
    }
}

fun Database.getSourceVariable(sourceId: String): String? = connect { db ->
    db.prepareStatement("select source_variable from source_login_state where source_id = ?").use { stmt ->
        stmt.setString(1, sourceId)
        stmt.executeQuery().use { rs -> if (rs.next()) rs.getString(1) else null }
    }
}

fun Database.saveSourceKv(sourceId: String, key: String, value: String?): Boolean = write { db ->
    val now = System.currentTimeMillis()
    val state = getSourceLoginState(sourceId)
    val currentKv = state?.sourceKv?.toMutableMap() ?: mutableMapOf()
    if (value != null) {
        currentKv[key] = value
    } else {
        currentKv.remove(key)
    }
    val kvJson = Json.encodeToString(currentKv)
    db.prepareStatement("""
        insert into source_login_state(source_id, source_kv, updated_at) values(?, ?, ?)
        on conflict(source_id) do update set source_kv=excluded.source_kv, updated_at=excluded.updated_at
    """).use { stmt ->
        stmt.setString(1, sourceId)
        stmt.setString(2, kvJson)
        stmt.setLong(3, now)
        stmt.executeUpdate() > 0
    }
}

fun Database.getSourceKv(sourceId: String, key: String): String? = connect { db ->
    db.prepareStatement("select source_kv from source_login_state where source_id = ?").use { stmt ->
        stmt.setString(1, sourceId)
        stmt.executeQuery().use { rs ->
            if (rs.next()) {
                val kvJson = rs.getString(1) ?: return@use null
                runCatching { Json.decodeFromString<Map<String, String>>(kvJson)[key] }.getOrNull()
            } else null
        }
    }
}

fun Database.clearSourceLoginState(sourceId: String): Boolean = write { db ->
    db.prepareStatement("delete from source_login_state where source_id = ?").use { stmt ->
        stmt.setString(1, sourceId)
        stmt.executeUpdate() > 0
    }
}
