package io.legado.data

import io.legado.model.ImportResponse
import io.legado.model.SourceRecord
import io.legado.model.SourceSummary
import io.legado.source.ParsedSource
import io.legado.source.SourceCodec
import kotlinx.serialization.json.Json

/**
 * `Database` 的书源清单与投影、读存删、批量整理、整批导入与导出面（0.8.2 结构重排从 `Database.kt` 逐字拆出）。
 * 写成同包扩展函数：调用点 `database.foo()` 与成员写法逐字一致；连接、`connect`/`write`（internal）、
 * 建表与迁移留在 `Database.kt`。跨包调用这些面需 `import io.legado.data.<方法>`（顶层扩展不是成员）。
 */
fun Database.listSources(query: String?): List<SourceSummary> {
    check(!isClosed) { "Database is closed" }
    if (!query.isNullOrBlank()) return listSourcesFromDb(query)
    sourceSummariesCache?.let { return it }
    return listSourcesFromDb(null).also { sourceSummariesCache = it }
}

private fun Database.listSourcesFromDb(query: String?): List<SourceSummary> = connect { db ->
    val sql = if (query.isNullOrBlank()) {
        "select id, name, source_url, source_group, enabled, is_js, updated_at, version, has_login, sort_order from source order by sort_order is null, sort_order, name collate nocase"
    } else {
        "select id, name, source_url, source_group, enabled, is_js, updated_at, version, has_login, sort_order from source where name like ? or source_url like ? order by sort_order is null, sort_order, name collate nocase"
    }
    db.prepareStatement(sql).use { statement ->
        if (!query.isNullOrBlank()) { statement.setString(1, "%$query%"); statement.setString(2, "%$query%") }
        statement.executeQuery().use { rs ->
            buildList {
                while (rs.next()) {
                    add(
                        SourceSummary(
                            id = rs.getString(1),
                            name = rs.getString(2),
                            url = rs.getString(3),
                            group = rs.getString(4),
                            enabled = rs.getInt(5) == 1,
                            isJsSource = rs.getInt(6) == 1,
                            hasLogin = rs.getInt(9) == 1,
                            updatedAt = rs.getLong(7),
                            version = rs.getLong(8),
                            // 第 10 列：null = 没参与过自定义排序（不是 0，也不是"排在最前"）
                            sortOrder = rs.getObject(10) as? Int,
                        )
                    )
                }
            }
        }
    }
}

/** 自定义排序：按给定的顺序写 `sort_order`（1 起），只写点到的那些；不在库里的 id 跳过。 */
fun Database.reorderSources(ids: List<String>): Int = write { db ->
    db.autoCommit = false
    try {
        var written = 0
        db.prepareStatement("update source set sort_order=? where id=?").use { statement ->
            ids.forEachIndexed { index, id ->
                statement.setInt(1, index + 1)
                statement.setString(2, id)
                written += statement.executeUpdate()
            }
        }
        db.commit()
        written
    } catch (error: Exception) {
        runCatching { db.rollback() }
        throw error
    } finally {
        db.autoCommit = true
    }
}

fun Database.clearSourceOrder(): Int = write { db ->
    db.prepareStatement("update source set sort_order=null where sort_order is not null").use { it.executeUpdate() }
}

fun Database.getSource(id: String): SourceRecord? = connect { db -> db.prepareStatement("select id, payload, version, updated_at from source where id = ?").use {
    it.setString(1, id); it.executeQuery().use { rs -> if (rs.next()) SourceRecord(rs.getString(1), rs.getString(2), rs.getLong(3), rs.getLong(4)) else null }
} }

/**
 * 配了「发现」页（exploreUrl 非空）的启用书源，供发现页做书源筛选。
 *
 * 以前是"把全部启用源连 payload 一起捞回 Kotlin、再逐个 Json.parseToJsonElement 判 exploreUrl"——
 * 5,574 个源每个都整份解析一遍，实测这一步要 2.6 秒（发现页第一屏就卡在这儿）。
 * 改成让 SQLite 在 C 层筛：json_type/json_extract 走内置 JSON1，payload 根本不落到 Kotlin 侧，
 * 只把命中的那两千来行取回来。`json_valid` 兜底非法 JSON（等价于旧写法里 runCatching 跳过）。
 */
fun Database.listExploreSources(): List<SourceSummary> {
    check(!isClosed) { "Database is closed" }
    exploreSourcesCache?.let { return it }
    return listExploreSourcesFromDb().also { exploreSourcesCache = it }
}

private fun Database.listExploreSourcesFromDb(): List<SourceSummary> = connect { db ->
    db.prepareStatement(
        """
        select id, name, source_url, source_group, enabled, is_js, updated_at, version, has_login
        from source
        where enabled = 1
          and json_valid(payload)
          and json_type(payload, '$.exploreUrl') = 'text'
          and trim(json_extract(payload, '$.exploreUrl')) <> ''
        order by name collate nocase
        """.trimIndent()
    ).use { statement ->
        statement.executeQuery().use { rs ->
            buildList { while (rs.next()) add(rs.toSummary()) }
        }
    }
}

fun Database.listSearchSourceRecords(sourceIds: List<String>?): List<SourceRecord> = connect { db ->
    val ids = sourceIds?.distinct()?.takeIf { it.isNotEmpty() }
    val sql = if (ids == null) {
        "select id, payload, version, updated_at from source where enabled = 1 order by name collate nocase"
    } else {
        "select id, payload, version, updated_at from source where enabled = 1 and id in (${ids.joinToString(",") { "?" }}) order by name collate nocase"
    }
    db.prepareStatement(sql).use { statement ->
        ids?.forEachIndexed { index, id -> statement.setString(index + 1, id) }
        statement.executeQuery().use { rs -> buildList { while (rs.next()) add(SourceRecord(rs.getString(1), rs.getString(2), rs.getLong(3), rs.getLong(4))) } }
    }
}

/**
 * 体检用：一次性把目标书源的完整记录取回来（id -> SourceRecord），别在并发闸门里逐个查库（N+1）。
 * ids 为 null 时取全部启用源；给了 ids 就按 id 取（**含停用源** —— 体检允许点名停用的那批）。
 */
fun Database.listSourceRecords(ids: List<String>?): Map<String, SourceRecord> = connect { db ->
    val distinctIds = ids?.distinct()?.takeIf { it.isNotEmpty() }
    val sql = if (distinctIds == null) {
        "select id, payload, version, updated_at from source where enabled = 1"
    } else {
        "select id, payload, version, updated_at from source where id in (${distinctIds.joinToString(",") { "?" }})"
    }
    db.prepareStatement(sql).use { statement ->
        distinctIds?.forEachIndexed { index, id -> statement.setString(index + 1, id) }
        statement.executeQuery().use { rs ->
            buildMap {
                while (rs.next()) {
                    put(rs.getString(1), SourceRecord(rs.getString(1), rs.getString(2), rs.getLong(3), rs.getLong(4)))
                }
            }
        }
    }
}

fun Database.saveSource(parsed: ParsedSource, expectedVersion: Long?): SourceRecord = write { db ->
    db.autoCommit = false
    try {
        val current = db.prepareStatement("select version from source where id = ?").use { it.setString(1, parsed.id); it.executeQuery().use { rs -> if (rs.next()) rs.getLong(1) else null } }
        if (expectedVersion != null && current != expectedVersion) throw VersionConflict()
        val version = (current ?: 0) + 1; val now = System.currentTimeMillis()
        db.prepareStatement("""insert into source(id,name,source_url,source_group,enabled,is_js,payload,version,updated_at,has_login)
            values(?,?,?,?,?,?,?,?,?,?) on conflict(id) do update set name=excluded.name,source_url=excluded.source_url,source_group=excluded.source_group,enabled=excluded.enabled,is_js=excluded.is_js,payload=excluded.payload,version=excluded.version,updated_at=excluded.updated_at,has_login=excluded.has_login""").use {
            it.setString(1, parsed.id); it.setString(2, parsed.name); it.setString(3, parsed.url); it.setString(4, parsed.group); it.setInt(5, if (parsed.enabled) 1 else 0); it.setInt(6, if (parsed.isJs) 1 else 0); it.setString(7, parsed.json); it.setLong(8, version); it.setLong(9, now); it.setInt(10, if (parsed.hasLogin) 1 else 0); it.executeUpdate()
        }
        db.commit(); invalidateSourceCaches()
        SourceRecord(parsed.id, parsed.json, version, now)
    } catch (error: Throwable) { db.rollback(); throw error } finally { db.autoCommit = true }
}

/** 删书源要连它的凭据一起删：`source_login_state` 里是登录头与 Cookie 罐，
 *  留着就是一个已经不再信任的站点的有效凭据。批量删除早就这么做了，单删漏了。 */
fun Database.deleteSource(id: String): Boolean = write { db ->
    db.autoCommit = false
    try {
        val removed = db.prepareStatement("delete from source where id = ?").use { stmt ->
            stmt.setString(1, id)
            stmt.executeUpdate() == 1
        }
        db.prepareStatement("delete from source_login_state where source_id = ?").use { stmt ->
            stmt.setString(1, id)
            stmt.executeUpdate()
        }
        db.commit()
        // 删除也是写入路径（第 239 行的规矩）：不失效的话，删除后 sourceSummariesCache
        // 还是旧清单 —— 界面上"删了还显示"，E2E 场景 5 的 95 断言逮到的就是它。
        invalidateSourceCaches()
        removed
    } catch (error: Exception) {
        runCatching { db.rollback() }
        throw error
    } finally {
        db.autoCommit = true
    }
}

fun Database.batchUpdateSources(ids: List<String>, action: String, group: String? = null): Int {
    val distinctIds = ids.filter { it.isNotBlank() }.distinct()
    if (distinctIds.isEmpty()) return 0
    val now = System.currentTimeMillis()
    var affectedTotal = 0
    write { db ->
        db.autoCommit = false
        try {
            distinctIds.chunked(200).forEach { chunk ->
                val placeholders = chunk.joinToString(",") { "?" }
                when (action) {
                    "enable" -> {
                        val sql = "update source set enabled = 1, updated_at = ? where id in ($placeholders)"
                        db.prepareStatement(sql).use { stmt ->
                            stmt.setLong(1, now)
                            chunk.forEachIndexed { i, id -> stmt.setString(i + 2, id) }
                            affectedTotal += stmt.executeUpdate()
                        }
                    }
                    "disable" -> {
                        val sql = "update source set enabled = 0, updated_at = ? where id in ($placeholders)"
                        db.prepareStatement(sql).use { stmt ->
                            stmt.setLong(1, now)
                            chunk.forEachIndexed { i, id -> stmt.setString(i + 2, id) }
                            affectedTotal += stmt.executeUpdate()
                        }
                    }
                    "set_group" -> {
                        val targetGroup = group?.trim()?.takeIf { it.isNotBlank() }
                        val sql = "update source set source_group = ?, updated_at = ? where id in ($placeholders)"
                        db.prepareStatement(sql).use { stmt ->
                            stmt.setString(1, targetGroup)
                            stmt.setLong(2, now)
                            chunk.forEachIndexed { i, id -> stmt.setString(i + 3, id) }
                            affectedTotal += stmt.executeUpdate()
                        }
                    }
                    // 追加一个标签，而不是覆盖整串：`bookSourceGroup` 是书源作者/用户自己写的分类，
                    // 体检结论只能"再加一档"，冲掉原标签等于用一次探测否掉整库的原始信息。
                    "tag_group" -> {
                        val tag = group?.trim()?.takeIf { it.isNotBlank() }
                            ?: throw IllegalArgumentException("tag_group 需要提供一个标签")
                        val sql = """
                            update source
                               set source_group = case
                                    when source_group is null or trim(source_group) = '' then ?
                                    when (' ' || replace(replace(source_group, ',', ' '), '，', ' ') || ' ') like ('% ' || ? || ' %') then source_group
                                    else trim(source_group) || ' ' || ?
                                 end,
                               updated_at = ?
                             where id in ($placeholders)
                        """.trimIndent()
                        db.prepareStatement(sql).use { stmt ->
                            stmt.setString(1, tag)
                            stmt.setString(2, tag)
                            stmt.setString(3, tag)
                            stmt.setLong(4, now)
                            chunk.forEachIndexed { i, id -> stmt.setString(i + 5, id) }
                            affectedTotal += stmt.executeUpdate()
                        }
                    }
                    // 撤销：只摘掉我们打过的那个标签，其余标签原样留着
                    "untag_group" -> {
                        val tag = group?.trim()?.takeIf { it.isNotBlank() }
                            ?: throw IllegalArgumentException("untag_group 需要提供一个标签")
                        val sql = """
                            update source
                               set source_group = trim(replace(replace(' ' || coalesce(source_group, '') || ' ', ' ' || ? || ' ', ' '), '  ', ' ')),
                                   updated_at = ?
                             where id in ($placeholders)
                        """.trimIndent()
                        db.prepareStatement(sql).use { stmt ->
                            stmt.setString(1, tag)
                            stmt.setLong(2, now)
                            chunk.forEachIndexed { i, id -> stmt.setString(i + 3, id) }
                            affectedTotal += stmt.executeUpdate()
                        }
                    }
                    "delete" -> {
                        val delSql = "delete from source where id in ($placeholders)"
                        db.prepareStatement(delSql).use { stmt ->
                            chunk.forEachIndexed { i, id -> stmt.setString(i + 1, id) }
                            affectedTotal += stmt.executeUpdate()
                        }
                        val delLoginSql = "delete from source_login_state where source_id in ($placeholders)"
                        db.prepareStatement(delLoginSql).use { stmt ->
                            chunk.forEachIndexed { i, id -> stmt.setString(i + 1, id) }
                            stmt.executeUpdate()
                        }
                    }
                    else -> throw IllegalArgumentException("不支持的批量操作: $action")
                }
            }
            db.commit()
        } catch (error: Throwable) {
            db.rollback()
            throw error
        } finally {
            db.autoCommit = true
        }
    }
    invalidateSourceCaches()
    return affectedTotal
}

fun Database.importSources(rawSources: List<String>): ImportResponse {
    val errors = mutableListOf<String>()
    val unique = linkedMapOf<String, ParsedSource>()
    rawSources.forEachIndexed { index, raw ->
        try {
            val parsed = SourceCodec.parse(raw)
            unique[parsed.id] = parsed
        } catch (error: IllegalArgumentException) {
            errors += "第 ${index + 1} 项：${error.message}"
        }
    }
    var imported = 0
    var updated = 0
    write { db ->
        db.autoCommit = false
        try {
            db.prepareStatement("select version from source where id = ?").use { current ->
                // `enabled` 故意**不在** on conflict 的赋值列表里：已在库的书源保留本机的启用/停用选择。
                // 上游手机是单机恢复自己的状态，整体覆盖没问题；这台服务器与手机已经分叉 ——
                // 库里 4,876 源只启用 2 个是用户的策展，而手机备份里 7,278 个是 enabled=true，
                // 一旦覆盖就是一次批量启用事故（用户口径：「到时候我自行决定」）。新入库的源仍按包内值。
                db.prepareStatement("""insert into source(id,name,source_url,source_group,enabled,is_js,payload,version,updated_at,has_login)
                    values(?,?,?,?,?,?,?,?,?,?) on conflict(id) do update set name=excluded.name,source_url=excluded.source_url,source_group=excluded.source_group,is_js=excluded.is_js,payload=excluded.payload,version=excluded.version,updated_at=excluded.updated_at,has_login=excluded.has_login""").use { save ->
                    unique.values.forEach { parsed ->
                        current.setString(1, parsed.id)
                        val version = current.executeQuery().use { result -> if (result.next()) result.getLong(1) else null }
                        if (version == null) imported++ else updated++
                        save.setString(1, parsed.id); save.setString(2, parsed.name); save.setString(3, parsed.url); save.setString(4, parsed.group)
                        save.setInt(5, if (parsed.enabled) 1 else 0); save.setInt(6, if (parsed.isJs) 1 else 0); save.setString(7, parsed.json)
                        save.setLong(8, (version ?: 0) + 1); save.setLong(9, System.currentTimeMillis()); save.setInt(10, if (parsed.hasLogin) 1 else 0); save.addBatch()
                    }
                    save.executeBatch()
                }
            }
            db.commit()
        } catch (error: Throwable) { db.rollback(); throw error } finally { db.autoCommit = true }
    }
    invalidateSourceCaches()
    return ImportResponse(imported, updated, rawSources.size - unique.size, errors)
}

fun Database.exportSources(ids: List<String>?): List<String> = connect { db ->
    val sql = if (ids.isNullOrEmpty()) "select payload from source order by name collate nocase" else "select payload from source where id in (${ids.joinToString(",") { "?" }}) order by name collate nocase"
    db.prepareStatement(sql).use { statement -> ids?.forEachIndexed { index, id -> statement.setString(index + 1, id) }; statement.executeQuery().use { rs -> buildList { while (rs.next()) add(rs.getString(1)) } } }
}

private fun java.sql.ResultSet.toSummary() = SourceSummary(
    id = getString(1),
    name = getString(2),
    url = getString(3),
    group = getString(4),
    enabled = getInt(5) == 1,
    isJsSource = getInt(6) == 1,
    hasLogin = getInt(9) == 1,
    updatedAt = getLong(7),
    version = getLong(8),
)
