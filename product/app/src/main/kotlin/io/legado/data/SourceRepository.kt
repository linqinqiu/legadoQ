package io.legado.data

import io.legado.model.BatchSourceResponse
import io.legado.model.ImportResponse
import io.legado.model.SourceHealthCheckItem
import io.legado.model.SourceHealthCheckRequest
import io.legado.model.SourceHealthCheckResponse
import io.legado.model.SourceSummary
import io.legado.model.SourceRecord
import io.legado.model.ValidateResponse
import io.legado.rules.RuleRunner
import io.legado.source.SourceCodec
import io.legado.source.SourceHealth
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext

/**
 * 书源域的组合层：批量整理、体检编排、导入导出。
 *
 * 从 `http/SourcesRoutes.kt` 抽出来的部分**只有业务**：动作 → 回执文案、体检的取数与并发编排、
 * 结论落库。端点的路径、数量与回包形状一个都没动（`ApiCatalog.test.ts` 逐条盯着）。
 *
 * 为什么放在 `data/` 而不是 `source/`：`source/` 属于规则引擎那一层，
 * `ArchitectureBoundaryTest` 的 `engine → infra` 基线只许缩小，把新的 `source → data`
 * 依赖塞进去就得往基线里加一条 —— 那正是重构要避免的方向。`BookshelfRepository` 同样住在这里。
 *
 * @param log 只用来记一行「批量操作做了什麼」「体检结论没存进去」这类运行日志。
 *   收成一个函数而不是把 Ktor 的 `Application` 传进来：这一层不该认识 HTTP。
 */
class SourceRepository(
    private val database: Database,
    private val runner: RuleRunner,
    private val log: (String) -> Unit = {},
) {

    // ==================== 列表 ====================

    fun list(query: String? = null): List<SourceSummary> = database.listSources(query)

    // ==================== 批量整理 ====================

    /**
     * 一次对多本书源做同一个动作（启用 / 停用 / 删除 / 改分组 / 打标签 / 摘标签）。
     *
     * 事务边界在 DAO 里（`batchUpdateSources` 自己 `write { autoCommit = false … }`）——
     * 这里**不要**再包一层 `database.write`：池里只有一条写连接，内层退出会把 autoCommit
     * 复位成 true，外层 commit 必抛 `database in auto-commit mode`。
     *
     * @throws IllegalArgumentException 动作名不认识，或 tag/untag 缺标签。路由据此回 400。
     */
    fun batchUpdate(ids: List<String>, action: String, group: String?): BatchSourceResponse {
        val count = database.batchUpdateSources(ids, action, group)
        log("source batch operation: action=$action, count=$count")
        return BatchSourceResponse(
            ok = true,
            affected = count,
            action = action,
            message = batchMessage(action, count, group),
        )
    }

    /** 动作 → 给人看的一句话。界面直接显示它，所以措辞在这里定，不在路由里。 */
    private fun batchMessage(action: String, count: Int, group: String?): String = when (action) {
        "enable" -> "已成功启用 $count 个书源"
        "disable" -> "已成功停用 $count 个书源"
        "delete" -> "已成功删除 $count 个书源"
        "set_group" ->
            if (group.isNullOrBlank()) "已清空 $count 个书源的分组" else "已将 $count 个书源移至分组“$group”"
        "tag_group" -> "已为 $count 个书源加上标签“$group”"
        "untag_group" -> "已摘掉 $count 个书源的标签“$group”"
        else -> "已处理 $count 个书源"
    }

    // ==================== 体检 ====================

    /**
     * 批量体检：并发 16、单个默认 5 秒超时，跑完才回（阻塞式长任务，没有进度流）。
     *
     * 没点名 ids 时只体检**启用中**的源。整库里被用户停用的那批他根本不读，
     * 探它们既慢又会在结果里堆一大片「连不上」，把真正要看的那几十个淹掉。
     * 停用的仍可显式点名，或在界面上勾「连停用的一起体检」来覆盖。
     *
     * 结论会落进 `source_health` 表（搜索按它排序）；落库失败不挡住响应 ——
     * 结论已经算出来了，存不进去是另一件事，如实记一行日志。
     */
    suspend fun healthCheck(request: SourceHealthCheckRequest): SourceHealthCheckResponse {
        val timeoutMs = request.timeoutMs.coerceIn(1000L, 10000L)
        val allSources = database.listSources(null)
        val targetSources = if (!request.ids.isNullOrEmpty()) {
            val idSet = request.ids.toSet()
            allSources.filter { it.id in idSet }
        } else {
            allSources.filter { it.enabled }
        }

        // 目标书源的完整记录一次性取回（键 = id）：原来是在并发闸门里逐个查库，
        // 属于 N+1 —— 几百个源挤在那 16 个并发槽里排队查库，跟真正的外呼抢时间。
        val recordsById = withContext(Dispatchers.IO) { database.listSourceRecords(request.ids) }

        val startTotalNs = System.nanoTime()
        val health = SourceHealth(runner)
        val semaphore = Semaphore(16)

        val results = coroutineScope {
            targetSources.map { summary ->
                async(Dispatchers.IO) {
                    semaphore.withPermit {
                        val record = recordsById[summary.id]
                        if (record == null) {
                            SourceHealthCheckItem(
                                id = summary.id,
                                name = summary.name,
                                ok = false,
                                latencyMs = 0L,
                                statusCode = 0,
                                statusCategory = "invalid",
                                error = "书源记录不存在",
                            )
                        } else {
                            health.probe(summary.id, summary.name, record.json, request.keyword ?: "都市", timeoutMs)
                        }
                    }
                }
            }.awaitAll()
        }

        runCatching { withContext(Dispatchers.IO) { database.saveHealthResults(results) } }
            .onFailure { log("体检结论落库失败：${it.message}") }

        return SourceHealthCheckResponse(
            total = results.size,
            successCount = results.count { it.statusCategory == "valid" },
            slowCount = results.count { it.statusCategory == "slow" },
            failedCount = results.count { !it.ok },
            durationMs = (System.nanoTime() - startTotalNs) / 1_000_000,
            results = results,
        )
    }

    // ==================== 单源读写 ====================

    fun get(id: String): SourceRecord? = database.getSource(id)

    /**
     * 新建或覆盖一份书源。
     *
     * @param expectedVersion 乐观锁：给了就比对库里的 version，不符抛 [VersionConflict]（路由翻成 409）。
     * @throws IllegalArgumentException 书源 JSON 结构不合法。
     */
    fun save(json: String, expectedVersion: Long?): SourceRecord =
        database.saveSource(SourceCodec.parse(json), expectedVersion)

    fun delete(id: String): Boolean = database.deleteSource(id)

    /**
     * 校验一份书源：给了 [draft] 就校验草稿（编辑器里未保存的内容），否则校验库里那一份。
     *
     * @return `null` 表示库里没有这个 id 且没给草稿 —— 路由据此回 404，而不是回一个「合法」的空结论。
     */
    fun validate(id: String, draft: String?): ValidateResponse? {
        val text = draft?.takeIf { it.isNotBlank() } ?: database.getSource(id)?.json ?: return null
        return SourceCodec.validate(text)
    }

    // ==================== 导入 / 导出 / 排序 ====================

    fun importSources(sources: List<String>): ImportResponse = database.importSources(sources)

    fun exportSources(ids: List<String>?): List<String> = database.exportSources(ids)

    fun reorder(ids: List<String>): Int = database.reorderSources(ids)

    fun clearOrder(): Int = database.clearSourceOrder()
}
