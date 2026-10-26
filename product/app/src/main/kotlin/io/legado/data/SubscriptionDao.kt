package io.legado.data

import io.legado.model.ImportResponse
import io.legado.model.SourceSubscription
import io.legado.model.SubscriptionWriteRequest

/**
 * `Database` 的书源订阅地址的增删查与更新回执面（0.8.2 结构重排从 `Database.kt` 逐字拆出）。
 * 写成同包扩展函数：调用点 `database.foo()` 与成员写法逐字一致；连接、`connect`/`write`（internal）、
 * 建表与迁移留在 `Database.kt`。跨包调用这些面需 `import io.legado.data.<方法>`（顶层扩展不是成员）。
 */
fun Database.listSubscriptions(enabledOnly: Boolean = false): List<SourceSubscription> = connect { db ->
    val sql = "select * from source_subscription" + (if (enabledOnly) " where enabled=1" else "") + " order by id"
    db.prepareStatement(sql).use { statement -> statement.executeQuery().use { rs -> buildList { while (rs.next()) add(rs.toSubscription()) } } }
}

fun Database.saveSubscription(request: SubscriptionWriteRequest): SourceSubscription = write { db ->
    val now = System.currentTimeMillis()
    db.prepareStatement("""insert into source_subscription(url,enabled,created_at,updated_at) values(?,?,?,?)
        on conflict(url) do update set enabled=excluded.enabled,updated_at=excluded.updated_at""").use {
        it.setString(1, request.url); it.setInt(2, if (request.enabled) 1 else 0); it.setLong(3, now); it.setLong(4, now); it.executeUpdate()
    }
    db.prepareStatement("select * from source_subscription where url=?").use { it.setString(1, request.url); it.executeQuery().use { rs -> rs.next(); rs.toSubscription() } }
}

fun Database.getSubscription(id: Long): SourceSubscription? = connect { db -> db.prepareStatement("select * from source_subscription where id=?").use { it.setLong(1, id); it.executeQuery().use { rs -> if (rs.next()) rs.toSubscription() else null } } }

fun Database.deleteSubscription(id: Long): Boolean = write { db -> db.prepareStatement("delete from source_subscription where id=?").use { it.setLong(1, id); it.executeUpdate() == 1 } }

fun Database.recordSubscriptionSuccess(id: Long, response: ImportResponse, contentHash: String) = write { db ->
    val now = System.currentTimeMillis()
    db.prepareStatement("update source_subscription set last_success_at=?,last_attempt_at=?,last_error=null,last_imported=?,content_hash=?,updated_at=? where id=?").use {
        it.setLong(1, now); it.setLong(2, now); it.setInt(3, response.imported + response.updated); it.setString(4, contentHash); it.setLong(5, now); it.setLong(6, id); it.executeUpdate()
    }
}

fun Database.recordSubscriptionFailure(id: Long, message: String) = write { db ->
    val now = System.currentTimeMillis()
    db.prepareStatement("update source_subscription set last_attempt_at=?,last_error=?,updated_at=? where id=?").use { it.setLong(1, now); it.setString(2, message.take(500)); it.setLong(3, now); it.setLong(4, id); it.executeUpdate() }
}

private fun java.sql.ResultSet.toSubscription() = SourceSubscription(getLong("id"), getString("url"), getInt("enabled") == 1, getLong("created_at"), getLong("updated_at"), getLong("last_success_at").takeIf { !wasNull() }, getLong("last_attempt_at").takeIf { !wasNull() }, getString("last_error"), getInt("last_imported"), getString("content_hash"))
