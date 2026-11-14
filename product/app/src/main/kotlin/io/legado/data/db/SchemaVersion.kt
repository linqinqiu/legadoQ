package io.legado.data.db

import java.sql.Connection

/**
 * 库版本号与有序迁移（P0-3）。
 *
 * 为什么要有它：在此之前库的「版本」只存在于代码里 —— 21 张表靠 `create table if not exists`
 * 加六段幂等补列凑出来，没有版本号就**无法回答「这个库到底是哪一版」**：要么永远把所有补列
 * 跑一遍（现在就是这样，跑多了会慢、也没法安全删除废弃字段），要么以后想加一步不可幂等的
 * 迁移时没有任何锚点。
 *
 * 三条设计取舍（与 `PHASE2_PREFLIGHT_REPORT.md` §6.4 一致）：
 *
 * 1. **版本存在 `pragma user_version`**，不建 `app_meta.schema_version` 键 —— 后者会和业务键
 *    （`source_revision` 等）混在一张表里，谁都可能把它清掉；`user_version` 是 SQLite 头字段，
 *    不会被任何 `delete from app_meta` 波及，`VACUUM` 也会原样保留。
 * 2. **现有库一律视为 version 0**：先把六段历史补列原样跑一遍（它们本身幂等），跑完回填成
 *    [BASELINE]。这样存量用户升级 = 一次普通启动，不需要人工介入，也不会漏补。
 * 3. **每步迁移与版本号同事务**：迁移抛错则整步回滚、`user_version` 保持旧值，启动直接失败
 *    （禁止带病运行）。库停在旧版本上可以原地重试，不会落到「补了一半」的状态。
 *
 * 新增一步迁移的做法：把 [TARGET] 加一，并在 [steps] 里注册 `新版本号 to 迁移动作`。
 * 迁移动作用到的 DDL/DML 必须能在旧库形状上跑（旧库不会先补齐新列）。
 */
object SchemaVersion {

    /** 基线版本：建表 + 六段历史补列跑完之后的形状。 */
    const val BASELINE = 1

    /** 当前代码期望的库版本。 */
    const val TARGET = BASELINE

    /**
     * 有序迁移注册表：键 = 目标版本，值 = 把库从「键 - 1」升到「键」的动作。
     *
     * 只增不改：已经发出去的版本号不许改语义，否则同一份库在不同客户端上会分叉。
     */
    internal val steps: Map<Int, (Connection) -> Unit> = mapOf(
        BASELINE to ::baseline,
    )

    /** 读库当前版本；新库与历史库都是 0。 */
    fun current(db: Connection): Int =
        db.createStatement().use { statement ->
            statement.executeQuery("pragma user_version").use { rs -> if (rs.next()) rs.getInt(1) else 0 }
        }

    private fun setCurrent(db: Connection, version: Int) {
        db.createStatement().use { it.execute("pragma user_version = $version") }
    }

    /**
     * 把库升到 [target]。返回升级后的版本号。
     *
     * **必须在一个事务里调用**（`Database.transaction {}`），失败时由调用方回滚。
     * 这里不自己动 `autoCommit` —— 见 `Database.transaction` 的注释。
     *
     * @param target 目标版本，默认 [TARGET]；测试用它验证「逐级升级」。
     * @param plan 迁移注册表，默认 [steps]；测试用它注入会失败的步骤。
     */
    fun migrate(
        db: Connection,
        target: Int = TARGET,
        plan: Map<Int, (Connection) -> Unit> = steps,
    ): Int {
        var version = current(db)
        if (version > target) {
            // 库比程序新：多半是回退了程序版本。继续跑会按旧代码解释新库，危险。
            throw IllegalStateException(
                "数据库版本 $version 高于程序支持的 $target（程序被降级过？），拒绝启动以免写坏数据",
            )
        }
        while (version < target) {
            val next = version + 1
            val step = plan[next]
                ?: throw IllegalStateException("缺少 v$version → v$next 的迁移步骤，无法升级数据库")
            step(db)
            // 版本号与迁移动作同事务落盘：动作抛错时这一行不会生效。
            setCurrent(db, next)
            version = next
        }
        return version
    }

    /**
     * 基线迁移（v0 → v1）：先建表已由 `Schema.createTables` 完成，这里只把历史上散落的
     * 六段补列跑一遍。每段自身幂等，重复跑不炸，所以对全新库与老库是同一条路径。
     *
     * 前提：`Schema.createTables` 已经跑过（`Database.initialize` 的固定顺序）。
     * 这六段只补列、不建表 —— 表都没有的库不是「旧库」，是坏库，让它在这里炸掉才是对的。
     */
    private fun baseline(db: Connection) {
        Migration.migrateReadingProgress(db)
        Migration.migrateBookshelf(db)
        Migration.migrateSourceTable(db)
        Migration.migrateLegacyCookieJars(db)
        Migration.migrateBookNote(db)
        Migration.migrateBookContentCache(db)
    }
}
