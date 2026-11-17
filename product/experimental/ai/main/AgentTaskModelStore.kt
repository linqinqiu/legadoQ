package io.legado.ai

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.nio.file.Files
import java.nio.file.Path

/**
 * 「按任务选模型」的路由表。
 *
 * 背景：连接一直是「一条打天下」—— 摘要、书源排错、日常对话共用同一个模型。
 * 用户要的是「摘要用便宜模型、改写用强模型」这种配比，而不是再登记一条连接
 * 然后靠删掉前面那条来换。
 *
 * 所以这里存一张 `任务 → (连接, 模型)` 的小表：
 * - 任务 id 只有两类：内置的 `chat` / `comprehend`，以及技能任务 `skill:<技能id>`；
 * - 连接可以只写 `connectionId`（用那条连接自己的模型），也可以只写 `model`
 *   （仍走默认连接，只换模型名）—— 同一个 key 下这两件事本来就是分开的；
 * - 两者都不填 = 这一项没有路由，照旧走 [ConnectionSelector] 的默认选择。
 *
 * 设计红线：这里只决定「用哪条连接、哪个模型名」，不做任何外呼，也不改连接档案本身。
 * 路由指定的连接被删掉时**整条路由失效**（退回默认选择），不会把它的模型名套到
 * 另一家的连接上 —— 那会把 `deepseek-chat` 发给 OpenAI，报出来的错跟配置毫无关系。
 */
object AgentTaskModelStore {
    /** 与 `agent-profiles.json` 同级：安装根目录优先，其次 `.data/`。 */
    const val FILE_NAME = "agent-task-models.json"

    /** 内置任务 id。技能任务统一用 [SKILL_PREFIX] + 技能 id。 */
    const val TASK_CHAT = "chat"
    const val TASK_COMPREHEND = "comprehend"
    const val SKILL_PREFIX = "skill:"

    /** 任务 id 长度上限：路由表是手写文件，别让一个超长 key 把界面撑坏。 */
    const val MAX_TASK_ID = 120

    private val json = Json { ignoreUnknownKeys = true; isLenient = true; encodeDefaults = true; prettyPrint = true }
    private val lock = Any()

    @Serializable
    data class Route(val connectionId: String? = null, val model: String? = null) {
        /** 两个字段都空 = 没配（与"没这一条"同义，读的时候直接丢掉）。 */
        fun isEmpty(): Boolean = connectionId.isNullOrBlank() && model.isNullOrBlank()
    }

    @Serializable
    private data class Store(val tasks: Map<String, Route> = emptyMap())

    /** 这一轮该算哪个任务：命中技能就按技能走，否则是普通对话。 */
    fun taskForSkills(skills: List<AgentSkillStore.Skill>): String =
        skills.firstOrNull()?.let { SKILL_PREFIX + it.id } ?: TASK_CHAT

    /** 全部路由（任务 id → 路由）。读不出来就是空表，不让一个坏文件把 AI 整体拖垮。 */
    fun load(homeDirectory: Path): Map<String, Route> = synchronized(lock) {
        val file = resolveFile(homeDirectory)
        if (!Files.isReadable(file)) return@synchronized emptyMap()
        runCatching {
            val raw = Files.readString(file)
            val text = if (raw.isNotEmpty() && raw[0] == '\uFEFF') raw.substring(1) else raw
            if (text.isBlank()) return@synchronized emptyMap()
            json.decodeFromString(Store.serializer(), text).tasks.filterValues { !it.isEmpty() }
        }.getOrElse { emptyMap() }
    }

    /**
     * 写入一条路由；`route` 为空（或两个字段都空）= 删掉这一条。
     * 返回落盘后的整张表，调用方不必再读一次。
     */
    fun save(homeDirectory: Path, task: String, route: Route?): Map<String, Route> = synchronized(lock) {
        val id = task.trim().take(MAX_TASK_ID)
        require(id.isNotBlank()) { "任务 id 不能为空" }
        val next = load(homeDirectory).toMutableMap()
        if (route == null || route.isEmpty()) next.remove(id)
        else next[id] = Route(
            connectionId = route.connectionId?.trim()?.takeIf { it.isNotBlank() },
            model = route.model?.trim()?.takeIf { it.isNotBlank() },
        )
        write(homeDirectory, next)
        next
    }

    /**
     * 按任务挑连接。
     *
     * @return 命中的连接（模型名已按路由覆盖）；没有路由、或路由指向的连接已经不存在时返回 null，
     *         调用方据此退回默认选择。
     */
    fun resolve(
        homeDirectory: Path,
        task: String,
        profiles: List<AgentProfileStore.Profile>,
    ): AgentProfileStore.Profile? {
        val route = load(homeDirectory)[task] ?: return null
        if (profiles.isEmpty()) return null
        val base = when {
            !route.connectionId.isNullOrBlank() ->
                // 指定的连接被删了：整条路由作废，别把它的模型名套到别家连接上。
                profiles.firstOrNull { it.id == route.connectionId } ?: return null
            else -> profiles.firstOrNull { ProfileOptions.isDefault(it.options) } ?: profiles.first()
        }
        val model = route.model?.takeIf { it.isNotBlank() } ?: base.model
        return base.copy(model = model)
    }

    private fun resolveFile(homeDirectory: Path): Path {
        val primary = homeDirectory.resolve(FILE_NAME)
        if (Files.isReadable(primary)) return primary
        val fallback = homeDirectory.resolve(".data").resolve(FILE_NAME)
        return if (Files.isReadable(fallback)) fallback else primary
    }

    private fun write(homeDirectory: Path, tasks: Map<String, Route>) {
        Files.createDirectories(homeDirectory)
        val text = json.encodeToString(Store.serializer(), Store(tasks))
        Files.writeString(homeDirectory.resolve(FILE_NAME), text)
        // 与连接档案一样在 `.data/` 留一份，便于备份与迁移。
        runCatching {
            Files.createDirectories(homeDirectory.resolve(".data"))
            Files.writeString(homeDirectory.resolve(".data").resolve(FILE_NAME), text)
        }
    }
}
