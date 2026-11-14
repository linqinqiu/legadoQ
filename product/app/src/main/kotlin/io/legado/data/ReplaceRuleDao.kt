package io.legado.data

import io.legado.content.ContentProcessor
import io.legado.model.ReplaceRule
import io.legado.model.ReplaceRuleImportResponse

/**
 * `Database` 的净化规则增删改查、开关、导入导出面（0.8.2 结构重排从 `Database.kt` 逐字拆出）。
 * 写成同包扩展函数：调用点 `database.foo()` 与成员写法逐字一致；连接、`connect`/`write`（internal）、
 * 建表与迁移留在 `Database.kt`。跨包调用这些面需 `import io.legado.data.<方法>`（顶层扩展不是成员）。
 */
fun Database.listReplaceRules(query: String? = null, group: String? = null, scope: String? = null): List<ReplaceRule> = connect { db ->
    val conditions = mutableListOf<String>()
    val params = mutableListOf<String>()
    if (!query.isNullOrBlank()) {
        conditions.add("(name like ? or pattern like ? or replacement like ?)")
        val q = "%${query.trim()}%"
        params.add(q); params.add(q); params.add(q)
    }
    if (!group.isNullOrBlank()) {
        conditions.add("group_name = ?")
        params.add(group.trim())
    }
    if (!scope.isNullOrBlank()) {
        conditions.add("scope like ?")
        params.add("%${scope.trim()}%")
    }
    val whereClause = if (conditions.isEmpty()) "" else "where " + conditions.joinToString(" and ")
    val sql = "select id, name, group_name, pattern, replacement, is_regex, scope, exclude_scope, scope_title, scope_content, is_enabled, sort_order, timeout_ms, created_at, updated_at from replace_rule $whereClause order by sort_order asc, created_at asc"
    db.prepareStatement(sql).use { stmt ->
        params.forEachIndexed { i, p -> stmt.setString(i + 1, p) }
        stmt.executeQuery().use { rs ->
            val list = mutableListOf<ReplaceRule>()
            while (rs.next()) {
                list.add(rs.toReplaceRule())
            }
            list
        }
    }
}

fun Database.getReplaceRule(id: String): ReplaceRule? = connect { db ->
    db.prepareStatement("select id, name, group_name, pattern, replacement, is_regex, scope, exclude_scope, scope_title, scope_content, is_enabled, sort_order, timeout_ms, created_at, updated_at from replace_rule where id = ?").use { stmt ->
        stmt.setString(1, id)
        stmt.executeQuery().use { rs -> if (rs.next()) rs.toReplaceRule() else null }
    }
}

fun Database.saveReplaceRule(rule: ReplaceRule): ReplaceRule = write { db ->
    val now = System.currentTimeMillis()
    val ruleId = rule.id.ifBlank { System.currentTimeMillis().toString() + "_" + java.util.UUID.randomUUID().toString().take(6) }
    val existing = db.prepareStatement("select created_at from replace_rule where id = ?").use { stmt ->
        stmt.setString(1, ruleId)
        stmt.executeQuery().use { if (it.next()) it.getLong(1) else null }
    }
    val createdAt = existing ?: (if (rule.createdAt > 0) rule.createdAt else now)
    db.prepareStatement("""
        insert into replace_rule(id, name, group_name, pattern, replacement, is_regex, scope, exclude_scope, scope_title, scope_content, is_enabled, sort_order, timeout_ms, created_at, updated_at)
        values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          name = excluded.name,
          group_name = excluded.group_name,
          pattern = excluded.pattern,
          replacement = excluded.replacement,
          is_regex = excluded.is_regex,
          scope = excluded.scope,
          exclude_scope = excluded.exclude_scope,
          scope_title = excluded.scope_title,
          scope_content = excluded.scope_content,
          is_enabled = excluded.is_enabled,
          sort_order = excluded.sort_order,
          timeout_ms = excluded.timeout_ms,
          updated_at = excluded.updated_at
    """.trimIndent()).use { stmt ->
        stmt.setString(1, ruleId)
        stmt.setString(2, rule.name.ifBlank { rule.pattern })
        stmt.setString(3, rule.group)
        stmt.setString(4, rule.pattern)
        stmt.setString(5, rule.replacement)
        stmt.setInt(6, if (rule.isRegex) 1 else 0)
        stmt.setString(7, rule.scope)
        stmt.setString(8, rule.excludeScope)
        stmt.setInt(9, if (rule.scopeTitle) 1 else 0)
        stmt.setInt(10, if (rule.scopeContent) 1 else 0)
        stmt.setInt(11, if (rule.isEnabled) 1 else 0)
        stmt.setInt(12, rule.order)
        stmt.setLong(13, if (rule.timeoutMillisecond > 0) rule.timeoutMillisecond else 3000L)
        stmt.setLong(14, createdAt)
        stmt.setLong(15, now)
        stmt.executeUpdate()
    }
    rule.copy(id = ruleId, createdAt = createdAt, updatedAt = now)
}

fun Database.deleteReplaceRule(id: String): Boolean = write { db ->
    db.prepareStatement("delete from replace_rule where id = ?").use { stmt ->
        stmt.setString(1, id)
        stmt.executeUpdate() > 0
    }
}

fun Database.deleteReplaceRules(ids: List<String>): Int = write { db ->
    if (ids.isEmpty()) return@write 0
    val placeholders = ids.joinToString(",") { "?" }
    db.prepareStatement("delete from replace_rule where id in ($placeholders)").use { stmt ->
        ids.forEachIndexed { idx, id -> stmt.setString(idx + 1, id) }
        stmt.executeUpdate()
    }
}

fun Database.toggleReplaceRules(ids: List<String>, enabled: Boolean): Int = write { db ->
    if (ids.isEmpty()) return@write 0
    val placeholders = ids.joinToString(",") { "?" }
    val now = System.currentTimeMillis()
    db.prepareStatement("update replace_rule set is_enabled = ?, updated_at = ? where id in ($placeholders)").use { stmt ->
        stmt.setInt(1, if (enabled) 1 else 0)
        stmt.setLong(2, now)
        ids.forEachIndexed { idx, id -> stmt.setString(idx + 3, id) }
        stmt.executeUpdate()
    }
}

fun Database.getEnabledReplaceRules(): List<ReplaceRule> = connect { db ->
    db.prepareStatement("select id, name, group_name, pattern, replacement, is_regex, scope, exclude_scope, scope_title, scope_content, is_enabled, sort_order, timeout_ms, created_at, updated_at from replace_rule where is_enabled = 1 order by sort_order asc, created_at asc").use { stmt ->
        stmt.executeQuery().use { rs ->
            val list = mutableListOf<ReplaceRule>()
            while (rs.next()) list.add(rs.toReplaceRule())
            list
        }
    }
}

fun Database.getEnabledReplaceRulesForScope(bookName: String?, sourceUrl: String?, sourceName: String? = null): List<ReplaceRule> {
    val allEnabled = getEnabledReplaceRules()
    return allEnabled.filter { ContentProcessor.matchesScope(it, bookName, sourceUrl, sourceName) }
}

fun Database.importReplaceRules(rules: List<ReplaceRule>): ReplaceRuleImportResponse =
    transaction { importReplaceRulesOn(it, rules) }

/**
 * [importReplaceRules] 的**事务内实现**：只落库、不开事务，供整批导入（备份恢复）在同一笔事务里调用。
 *
 * 与改动前的区别：以前这里是 `write {}` + 逐条自动提交，中途失败会留下「导入了一半」的规则；
 * 现在整批一个事务，失败即整批回滚。
 */
internal fun Database.importReplaceRulesOn(db: java.sql.Connection, rules: List<ReplaceRule>): ReplaceRuleImportResponse {
    val now = System.currentTimeMillis()
    var imported = 0
    var updated = 0
    var skipped = 0

    for (rule in rules) {
        if (rule.pattern.isBlank()) {
            skipped++
            continue
        }
        val ruleId = rule.id.ifBlank { resolveLegacyRuleId(db, rule) }
        val existing = db.prepareStatement("select 1 from replace_rule where id = ?").use { stmt ->
            stmt.setString(1, ruleId)
            stmt.executeQuery().use { it.next() }
        }
        db.prepareStatement("""
            insert into replace_rule(id, name, group_name, pattern, replacement, is_regex, scope, exclude_scope, scope_title, scope_content, is_enabled, sort_order, timeout_ms, created_at, updated_at)
            values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(id) do update set
              name = excluded.name,
              group_name = excluded.group_name,
              pattern = excluded.pattern,
              replacement = excluded.replacement,
              is_regex = excluded.is_regex,
              scope = excluded.scope,
              exclude_scope = excluded.exclude_scope,
              scope_title = excluded.scope_title,
              scope_content = excluded.scope_content,
              is_enabled = excluded.is_enabled,
              sort_order = excluded.sort_order,
              timeout_ms = excluded.timeout_ms,
              updated_at = excluded.updated_at
        """.trimIndent()).use { stmt ->
            stmt.setString(1, ruleId)
            stmt.setString(2, rule.name.ifBlank { rule.pattern })
            stmt.setString(3, rule.group)
            stmt.setString(4, rule.pattern)
            stmt.setString(5, rule.replacement)
            stmt.setInt(6, if (rule.isRegex) 1 else 0)
            stmt.setString(7, rule.scope)
            stmt.setString(8, rule.excludeScope)
            stmt.setInt(9, if (rule.scopeTitle) 1 else 0)
            stmt.setInt(10, if (rule.scopeContent) 1 else 0)
            stmt.setInt(11, if (rule.isEnabled) 1 else 0)
            stmt.setInt(12, rule.order)
            stmt.setLong(13, if (rule.timeoutMillisecond > 0) rule.timeoutMillisecond else 3000L)
            stmt.setLong(14, if (rule.createdAt > 0) rule.createdAt else now)
            stmt.setLong(15, now)
            stmt.executeUpdate()
        }
        if (existing) updated++ else imported++
    }
    return ReplaceRuleImportResponse(imported, updated, skipped, rules.size)
}

/**
 * 老格式备份里的替换规则经常没有 id（`id` 是空串）。以前每次导入都现生成
 * `时间戳_uuid`，同一份包导两次就多出一份重复规则 —— 备份重试会把规则表越导越乱。
 *
 * 两步定身份：先按内容（pattern + 是否正则 + 作用域 + 分组）找已有行，命中就沿用它的 id
 * （用户手建的规则也会被认出来，不会被顶成第二份）；没命中才用内容哈希派生稳定 id。
 * 哈希而不是随机：同一份包再导一次落在同一行上，走 `on conflict` 更新。
 */
private fun resolveLegacyRuleId(db: java.sql.Connection, rule: ReplaceRule): String {
    val existing = db.prepareStatement("""
        select id from replace_rule
        where pattern = ? and is_regex = ? and coalesce(scope, '') = ? and coalesce(group_name, '') = ?
        order by created_at asc limit 1
    """.trimIndent()).use { stmt ->
        stmt.setString(1, rule.pattern)
        stmt.setInt(2, if (rule.isRegex) 1 else 0)
        stmt.setString(3, rule.scope.orEmpty())
        stmt.setString(4, rule.group.orEmpty())
        stmt.executeQuery().use { rs -> if (rs.next()) rs.getString(1) else null }
    }
    if (existing != null) return existing
    val fingerprint = listOf(rule.pattern, rule.isRegex.toString(), rule.scope.orEmpty(), rule.group.orEmpty())
        .joinToString("\u0000")
    val digest = java.security.MessageDigest.getInstance("SHA-1").digest(fingerprint.toByteArray(Charsets.UTF_8))
    return "legacy_" + digest.joinToString("") { "%02x".format(it) }.take(16)
}

fun Database.exportReplaceRules(ids: List<String>? = null): List<ReplaceRule> = connect { db ->
    val sql = if (ids.isNullOrEmpty()) {
        "select id, name, group_name, pattern, replacement, is_regex, scope, exclude_scope, scope_title, scope_content, is_enabled, sort_order, timeout_ms, created_at, updated_at from replace_rule order by sort_order asc, created_at asc"
    } else {
        val placeholders = ids.joinToString(",") { "?" }
        "select id, name, group_name, pattern, replacement, is_regex, scope, exclude_scope, scope_title, scope_content, is_enabled, sort_order, timeout_ms, created_at, updated_at from replace_rule where id in ($placeholders) order by sort_order asc, created_at asc"
    }
    db.prepareStatement(sql).use { stmt ->
        ids?.forEachIndexed { idx, id -> stmt.setString(idx + 1, id) }
        stmt.executeQuery().use { rs ->
            val list = mutableListOf<ReplaceRule>()
            while (rs.next()) list.add(rs.toReplaceRule())
            list
        }
    }
}

private fun java.sql.ResultSet.toReplaceRule(): ReplaceRule = ReplaceRule(
    id = getString(1),
    name = getString(2),
    group = getString(3),
    pattern = getString(4),
    replacement = getString(5) ?: "",
    isRegex = getInt(6) != 0,
    scope = getString(7),
    excludeScope = getString(8),
    scopeTitle = getInt(9) != 0,
    scopeContent = getInt(10) != 0,
    isEnabled = getInt(11) != 0,
    order = getInt(12),
    timeoutMillisecond = getLong(13),
    createdAt = getLong(14),
    updatedAt = getLong(15),
)
