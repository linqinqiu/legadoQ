package io.legado.ai

import kotlinx.serialization.Serializable
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption

/**
 * 技能库 —— 借自 refgd/legado 的 SKILL.md 与 MD3 的"任务预设 + 提示词"。
 *
 * 为什么需要它：系统提示词只有一个，而真实使用场景是分裂的 ——
 * 「书源为什么搜不到」「这本书讲到哪」「帮我把失效源清掉」需要完全不同的工作方法
 * （先查什么工具、给什么格式、哪些动作必须先问）。把这些方法写进一个万能 system prompt，
 * 要么长得塞不下，要么互相干扰。技能就是**按需注入的一段专业说明**：
 * 命中关键词（或用户显式指定）才进上下文，一次最多 3 条、每条 4000 字。
 *
 * 与 refgd 的差异：
 * - 它的 SKILL.md 放在应用资源里，用户改不了；这里放在 `{home}/agent-skills/<技能id>.md`，
 *   用户可直接编辑，也能通过 `/api/agent/skills` 增删改。
 * - 它用"关键词出现在最后一条用户消息里"触发；这里的规则相同，但额外支持显式传 id，
 *   让前端可以在气泡里挂"本次使用技能"。
 *
 * 文件格式（frontmatter 故意只支持 `key: value`，不引 YAML 依赖）：
 * ```
 * ---
 * name: 书源排错
 * description: 搜索为空/目录为空/正文不对时怎么查
 * keywords: 书源,搜不到,目录,正文
 * enabled: true
 * ---
 * 正文（会作为 system 消息注入）
 * ```
 */
object AgentSkillStore {

    private const val DIR_NAME = "agent-skills"
    const val MAX_CONTENT_CHARS = 4000
    const val MAX_SELECTED = 3

    @Serializable
    data class Skill(
        val id: String,
        val name: String,
        val description: String = "",
        val keywords: List<String> = emptyList(),
        val enabled: Boolean = true,
        val content: String = "",
        /** true = 内置（不在磁盘上，删除会被拒绝；保存同 id 会生成用户覆盖版）。 */
        val builtin: Boolean = false,
    )

    /** 内置技能：没有用户文件时也能用，避免"功能装好了但是空的"。 */
    private val builtins: List<Skill> = listOf(
        Skill(
            id = "source-debug",
            name = "书源排错",
            description = "按「结构 → 搜索 → 详情 → 目录 → 正文」定位书源问题",
            keywords = listOf("书源", "搜不到", "搜索为空", "目录为空", "正文", "调试", "规则"),
            builtin = true,
            content = """
                排查书源时按固定顺序来，不要一上来就改规则：
                1. 先用 source.validate 看结构错误；有错先修结构。
                2. 再用 source.debug（只给 json）跑「结构→搜索→详情→目录→正文」，看第一个失败的阶段。
                3. 搜索失败：看 searchUrl 是否需要 POST、是否要 headers/cookies、关键词编码是否正确。
                4. 目录为空：检查 tocUrl 是否来自详情页、目录规则是否命中了错误容器（先取第一条的文本验证）。
                5. 正文不对：先确认 chapterUrl 是详情页章节还是目录页章节；再检查 content 规则是否命中了广告容器。
                6. 需要登录的源（needs_login / needs_webview）不要反复试规则，直接告诉用户先在书源页登录。
                结论里给出「失败阶段 + 可疑字段 + 一条可粘贴的修改」，不要泛泛而谈。
            """.trimIndent(),
        ),
        Skill(
            id = "reading-companion",
            name = "阅读助手",
            description = "贴着当前章节回答剧情、人物与伏笔",
            keywords = listOf("剧情", "人物", "伏笔", "这一章", "这本书", "讲了什么", "概括", "结局"),
            builtin = true,
            content = """
                回答阅读问题时：
                - 用户问「这一章」时，只基于当前章节与已读内容回答，不要提前剧透后续章节；
                  用户明确要「后面会怎样」时，先说明这会涉及剧透。
                - 引用原文时给出短句（不超过 40 字），不要整段复制。
                - 不确定人物关系时直说「从已读内容看不出」，不要编造。
                - 如果用户想记笔记/划线，用 ai.selectTextAction；想清洗广告，用 ai.textClean。
            """.trimIndent(),
        ),
        Skill(
            id = "library-curator",
            name = "书库整理",
            description = "批量清理失效源、重排、分组时先看清再动手",
            keywords = listOf("清理", "失效", "批量", "删除书源", "分组", "重排", "整理"),
            builtin = true,
            content = """
                书库整理的安全顺序：
                1. 先用 source.list（limit=0 看总数，再分页看摘要）与 source.health 确认哪些真的失效；
                   health 的 needs_login / needs_webview 不等于失效，不要建议删除。
                2. 删除前把「将影响 N 个源」和名单摘要告诉用户，等用户明确同意。
                3. 批量删除用 source.batch，并且必须带 confirm=true；单条删除用 source.delete。
                4. 分组用 source.group.*，groupId=0 表示移出分组。
                5. 结束后回报「实际删除/移动了多少」，不要用"已处理"这种模糊说法。
            """.trimIndent(),
        ),
    )

    fun list(homeDirectory: Path): List<Skill> {
        val user = readUserSkills(homeDirectory)
        val overridden = user.map { it.id }.toSet()
        return (builtins.filterNot { it.id in overridden } + user).sortedWith(compareBy({ !it.builtin }, { it.name }))
    }

    fun get(homeDirectory: Path, id: String): Skill? =
        readUserSkills(homeDirectory).firstOrNull { it.id == id } ?: builtins.firstOrNull { it.id == id }

    /**
     * 保存（新建或覆盖）一个技能。id 缺省时由 name 生成。
     * 返回落盘后的技能。
     */
    fun save(
        homeDirectory: Path,
        id: String?,
        name: String,
        description: String,
        keywords: List<String>,
        content: String,
        enabled: Boolean,
    ): Skill {
        require(name.isNotBlank()) { "技能名称不能为空" }
        require(content.isNotBlank()) { "技能内容不能为空" }
        val finalId = sanitizeId(id?.takeIf { it.isNotBlank() } ?: name)
        val dir = homeDirectory.resolve(DIR_NAME)
        Files.createDirectories(dir)
        val file = dir.resolve("$finalId.md")
        val text = buildString {
            appendLine("---")
            appendLine("name: ${name.trim()}")
            appendLine("description: ${description.trim().replace('\n', ' ')}")
            appendLine("keywords: ${keywords.joinToString(",") { it.trim() }.trim(',')}")
            appendLine("enabled: $enabled")
            appendLine("---")
            append(content.trim())
        }
        Files.writeString(
            file,
            text,
            StandardOpenOption.CREATE,
            StandardOpenOption.TRUNCATE_EXISTING,
            StandardOpenOption.WRITE,
        )
        return Skill(finalId, name.trim(), description.trim(), keywords, enabled, content.trim())
    }

    /**
     * 删除用户技能。内置技能不能删（删了下次还会出现，只会让用户困惑）。
     *
     * 不直接删文件：移到 `agent-skills/.trash/`。技能是用户手写的提示词，
     * 误删一次就得重写；留一份回收站比"删得干净"重要。返回是否真的移动了。
     */
    fun delete(homeDirectory: Path, id: String): Boolean {
        if (builtins.any { it.id == id }) {
            throw IllegalArgumentException("内置技能不能删除；可以把它停用，或保存同 id 的用户版本覆盖")
        }
        val dir = homeDirectory.resolve(DIR_NAME)
        val file = dir.resolve("${sanitizeId(id)}.md")
        if (!Files.exists(file)) return false
        val trash = dir.resolve(".trash")
        Files.createDirectories(trash)
        val target = trash.resolve("${file.fileName}.${System.currentTimeMillis()}.bak")
        Files.move(file, target)
        return true
    }

    /**
     * 为这一轮挑技能：显式 id 优先；否则按关键词命中最后一条用户消息。
     * 返回最多 [MAX_SELECTED] 条，按关键词命中数排序。
     */
    fun select(homeDirectory: Path, explicitIds: List<String>, userText: String): List<Skill> {
        val all = list(homeDirectory).filter { it.enabled }
        if (all.isEmpty()) return emptyList()
        if (explicitIds.isNotEmpty()) {
            val byId = all.associateBy { it.id }
            return explicitIds.mapNotNull { byId[it] }.distinctBy { it.id }.take(MAX_SELECTED)
        }
        val text = userText.lowercase()
        if (text.isBlank()) return emptyList()
        return all.map { skill -> skill to skill.keywords.count { it.isNotBlank() && text.contains(it.lowercase()) } }
            .filter { it.second > 0 }
            .sortedByDescending { it.second }
            .take(MAX_SELECTED)
            .map { it.first }
    }

    private fun readUserSkills(homeDirectory: Path): List<Skill> {
        val dir = homeDirectory.resolve(DIR_NAME)
        if (!Files.isDirectory(dir)) return emptyList()
        return runCatching {
            val files = Files.list(dir).use { stream ->
                stream.filter { it.fileName.toString().endsWith(".md", ignoreCase = true) }.toList()
            }
            files.sorted().mapNotNull { parseFile(it) }
        }.getOrDefault(emptyList())
    }

    private fun parseFile(file: Path): Skill? = runCatching {
        val raw = Files.readString(file)
        val text = if (raw.isNotEmpty() && raw[0] == '\uFEFF') raw.substring(1) else raw
        val id = file.fileName.toString().removeSuffix(".md").removeSuffix(".MD")
        var name = id
        var description = ""
        var keywords = emptyList<String>()
        var enabled = true
        var body = text.trim()
        if (text.startsWith("---")) {
            val end = text.indexOf("\n---", startIndex = 3)
            if (end > 0) {
                val header = text.substring(3, end).trim()
                body = text.substring(end + 4).trim()
                header.lineSequence().forEach { line ->
                    val idx = line.indexOf(':')
                    if (idx <= 0) return@forEach
                    val key = line.substring(0, idx).trim().lowercase()
                    val value = line.substring(idx + 1).trim()
                    when (key) {
                        "name" -> name = value.ifBlank { id }
                        "description" -> description = value
                        "keywords" -> keywords = value.split(',', '，').map { it.trim() }.filter { it.isNotBlank() }
                        "enabled" -> enabled = value.lowercase() !in setOf("false", "0", "no", "off")
                    }
                }
            }
        }
        if (body.isBlank()) null
        else Skill(id, name, description, keywords, enabled, body.take(MAX_CONTENT_CHARS))
    }.getOrNull()

    /**
     * 文件名白名单：防止 `../` 之类把技能写到目录外。
     * 保留中文/其它 Unicode 字母（技能名常是中文，强行转拼音或哈希会让文件不可读），
     * 只把路径分隔符与其它符号替换掉。
     */
    private fun sanitizeId(raw: String): String {
        val id = raw.trim().lowercase().map { ch ->
            if (ch.isLetterOrDigit() || ch == '-' || ch == '_') ch else '-'
        }.joinToString("").trim('-', '.')
        require(id.isNotBlank()) { "技能 id 不合法" }
        return id.take(48)
    }
}
