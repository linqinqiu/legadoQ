package io.legado.data

import io.legado.model.RssSourceSummary

/**
 * `Database` 的RSS 订阅源清单、单源读取与启停删面（0.8.2 结构重排从 `Database.kt` 逐字拆出）。
 * 写成同包扩展函数：调用点 `database.foo()` 与成员写法逐字一致；连接、`connect`/`write`（internal）、
 * 建表与迁移留在 `Database.kt`。跨包调用这些面需 `import io.legado.data.<方法>`（顶层扩展不是成员）。
 */
fun Database.listRssSources(query: String?): List<RssSourceSummary> = connect { db ->
    val columns = "select source_url, name, source_group, source_icon, enabled, has_list_rule, updated_at from rss_source"
    val sql = if (query.isNullOrBlank()) "$columns order by name collate nocase"
    else "$columns where name like ? or source_url like ? or source_group like ? order by name collate nocase"
    db.prepareStatement(sql).use { statement ->
        if (!query.isNullOrBlank()) {
            val like = "%${query.replace("%", "").replace("_", "")}%"
            statement.setString(1, like); statement.setString(2, like); statement.setString(3, like)
        }
        statement.executeQuery().use { rs ->
            buildList {
                while (rs.next()) add(
                    RssSourceSummary(
                        sourceUrl = rs.getString(1),
                        name = rs.getString(2),
                        group = rs.getString(3),
                        icon = rs.getString(4),
                        enabled = rs.getInt(5) == 1,
                        hasListRule = rs.getInt(6) == 1,
                        updatedAt = rs.getLong(7),
                    )
                )
            }
        }
    }
}

fun Database.getRssSource(sourceUrl: String): String? = connect { db ->
    db.prepareStatement("select payload from rss_source where source_url=?").use { statement ->
        statement.setString(1, sourceUrl)
        statement.executeQuery().use { rs -> if (rs.next()) rs.getString(1) else null }
    }
}

/** 停用的订阅源不替它发起抓取：界面上「已停用」必须真的挡住请求，否则这个开关是装饰品。 */
fun Database.rssSourceIsEnabled(sourceUrl: String): Boolean = connect { db ->
    db.prepareStatement("select enabled from rss_source where source_url=?").use { statement ->
        statement.setString(1, sourceUrl)
        statement.executeQuery().use { rs -> rs.next() && rs.getInt(1) == 1 }
    }
}

fun Database.setRssSourceEnabled(sourceUrl: String, enabled: Boolean): Boolean = write { db ->
    db.prepareStatement("update rss_source set enabled=?, updated_at=? where source_url=?").use { statement ->
        statement.setInt(1, if (enabled) 1 else 0)
        statement.setLong(2, System.currentTimeMillis())
        statement.setString(3, sourceUrl)
        statement.executeUpdate() == 1
    }
}

fun Database.deleteRssSource(sourceUrl: String): Boolean = write { db ->
    db.prepareStatement("delete from rss_source where source_url=?").use { statement ->
        statement.setString(1, sourceUrl)
        statement.executeUpdate() == 1
    }
}
