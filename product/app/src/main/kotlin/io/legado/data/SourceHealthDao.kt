package io.legado.data

import io.legado.model.SourceHealthCheckItem

/**
 * `Database` 的书源体检结论面。
 *
 * 为什么要有这一张表：体检跑一场要几十分钟，结论以前只落在浏览器 localStorage 里，
 * 服务端看不到。于是「搜索优先搜能用的源」这件事根本无从做起 ——
 * 最需要它的地方（搜索）拿不到它。
 *
 * 一个源一行，按 `source_id` 覆盖：只存「最近一次结论」，不存历史。
 * 理由：搜索要的是"现在这个源活不活"，历史时间轴对排序没有帮助，
 * 而存历史会让这张表随体检次数无界增长。
 */
fun Database.saveHealthResults(results: List<SourceHealthCheckItem>): Int = write { db ->
    val now = System.currentTimeMillis()
    db.autoCommit = false
    var written = 0
    try {
        db.prepareStatement("""insert into source_health(source_id,name,ok,latency_ms,status_category,error,checked_at)
            values(?,?,?,?,?,?,?)
            on conflict(source_id) do update set name=excluded.name,ok=excluded.ok,latency_ms=excluded.latency_ms,
              status_category=excluded.status_category,error=excluded.error,checked_at=excluded.checked_at""").use { st ->
            for (item in results) {
                st.setString(1, item.id)
                st.setString(2, item.name)
                st.setInt(3, if (item.ok) 1 else 0)
                st.setLong(4, item.latencyMs)
                st.setString(5, item.statusCategory)
                st.setString(6, item.error)
                st.setLong(7, now)
                st.addBatch()
            }
            written = st.executeBatch().count { it >= 0 }
        }
        db.commit()
    } catch (error: Throwable) {
        runCatching { db.rollback() }
        throw error
    } finally {
        db.autoCommit = true
    }
    written
}

/** 全部体检结论，按「能用的在前、快的在前」排 —— 搜索按这个顺序发车。 */
fun Database.listHealthResults(): List<SourceHealthCheckItem> = connect { db ->
    db.prepareStatement("""select source_id,name,ok,latency_ms,status_category,error,checked_at
        from source_health order by ok desc, latency_ms asc""").use { st ->
        st.executeQuery().use { rs ->
            buildList {
                while (rs.next()) add(
                    SourceHealthCheckItem(
                        id = rs.getString(1),
                        name = rs.getString(2) ?: "",
                        ok = rs.getInt(3) != 0,
                        latencyMs = rs.getLong(4),
                        statusCode = 0,
                        statusCategory = rs.getString(5) ?: "",
                        error = rs.getString(6),
                    ),
                )
            }
        }
    }
}

/**
 * 搜索用的**排序键**：源 id → 「优先分 + 延迟」。
 *
 * 只返回体检过的源（没体检过的源不在表里，搜索时它们按未知处理）。
 * 返回 compact 结构而不是整份 item：搜索每轮要查几千个源，
 * 不该为这个把 name/error 也一起搬出来。
 */
fun Database.healthSearchOrder(): Map<String, Pair<Int, Long>> = connect { db ->
    db.prepareStatement("select source_id, ok, latency_ms from source_health").use { st ->
        st.executeQuery().use { rs ->
            buildMap {
                while (rs.next()) {
                    val id = rs.getString(1) ?: continue
                    // 分越小越先搜：体检通过(0) → 慢(1) → 连不上/未知(2)
                    val bucket = when {
                        rs.getInt(2) != 0 && rs.getLong(3) < 3000 -> 0
                        rs.getInt(2) != 0 -> 1
                        else -> 2
                    }
                    put(id, bucket to rs.getLong(3))
                }
            }
        }
    }
}

/** 体检过多少个源（界面要能说出"这些结论是哪来的"）。 */
fun Database.healthResultCount(): Int = connect { db ->
    db.prepareStatement("select count(*) from source_health").use { st ->
        st.executeQuery().use { rs -> if (rs.next()) rs.getInt(1) else 0 }
    }
}
