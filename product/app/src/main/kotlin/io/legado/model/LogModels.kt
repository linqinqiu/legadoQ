package io.legado.model

import kotlinx.serialization.Serializable

/**
 * 一条运行日志（阶段 3.2：从 `ops/LogService.kt` 归位到 model/）。
 *
 * 搬家的直接原因不是"DTO 该在 model"这种形式纪律，而是它让 `data/` 为了一个记录类型
 * 反向 import `ops/`，与 `ops/ → data/` 的持久化依赖凑成 2-环（架构判据 6 的 4 对之一）。
 * 归位后 `data → model ← ops`，环消失；JSON 形状不变（kotlinx 只认类名与字段名）。
 */
@Serializable
data class LogEntry(
    /** SQLite 的 rowid。界面按它做行标识与"展开的是哪一条"，没有它只能按数组下标，一刷新就串行。 */
    val id: Long = 0,
    val timestamp: String,
    val category: String,
    val level: String,
    val message: String,
    val context: Map<String, String> = emptyMap(),
    val stackTrace: String? = null,
    /** 合并窗口内同类日志的条数；1 表示就这一条。界面上念成「×N」。 */
    val count: Int = 1,
)
