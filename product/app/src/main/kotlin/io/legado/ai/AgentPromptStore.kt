package io.legado.ai

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

/**
 * 提示词预设 —— 借自 MD3 的 `AiPromptPreset`：一段可以随时开关的系统说明，按顺序拼进 system。
 *
 * 与技能的分工（这条写进文档，也写进界面提示，否则两者会混成"两个 system 输入框"）：
 * - **提示词预设是"怎么说话"**：语气、字数、格式、要不要先给结论。对所有对话生效（开关控制）。
 * - **技能是"这类任务怎么做"**：书源排错、阅读助手、书库整理，命中关键词才注入，一次最多 3 条。
 *
 * 为什么落 JSON 而不是像技能那样一条一个 .md：预设是一行一行的短句，用户要的是"排序 + 开关"，
 * 拆成几十个文件后排序只能靠文件名，反而难维护。正文仍限长（[MAX_INSTRUCTION_CHARS]），
 * 长方法论应该写成技能，而不是塞进提示词。
 *
 * 文件：`{home}/agent-prompts.json`。删除时整份文件先备份到 `.trash/`，误删可以找回。
 */
object AgentPromptStore {

    private const val FILE_NAME = "agent-prompts.json"
    private const val TRASH_DIR = ".trash"
    const val MAX_INSTRUCTION_CHARS = 2000
    const val MAX_PROMPTS = 30

    @Serializable
    data class Preset(
        val id: String,
        val name: String,
        val instruction: String,
        val enabled: Boolean = true,
        /** 越小越先注入；相同则按名称。 */
        val order: Int = 0,
    )

    @Serializable
    private data class FileShape(val prompts: List<Preset> = emptyList())

    private val json = Json {
        ignoreUnknownKeys = true
        prettyPrint = true
        encodeDefaults = true
    }

    fun list(homeDirectory: Path): List<Preset> = read(homeDirectory).sortedWith(compareBy({ it.order }, { it.name }))

    /** 该注入本轮对话的预设：只取启用的，顺序即注入顺序。 */
    fun select(homeDirectory: Path): List<Preset> = list(homeDirectory).filter { it.enabled }

    /**
     * 写锁：整份文件是「读 → 改 → 写」，两个并发写必然互相覆盖。
     *
     * 这不是假想的坑：界面上点一次「上移」会连着发两条保存（交换两条的 order），
     * 两条请求各自读到自己那份快照再整份写回，后落盘的那条就把先落盘的改动顶没了 ——
     * 实测点完上移，两条的 order 变成同一个数。
     *
     * 锁放在存储层而不是调用方：除了 HTTP，脚本与插件也走同一个 save。
     * `list` / `select` 是幂等读，不进锁（读到的最坏情况是上一毫秒的快照）。
     */
    private val writeLock = Any()

    /**
     * 新建或覆盖。id 缺省时按名称生成。
     * 返回落盘后的那一条（`order` 缺省时排到末尾）。
     */
    fun save(
        homeDirectory: Path,
        id: String?,
        name: String,
        instruction: String,
        enabled: Boolean,
        order: Int?,
    ): Preset = synchronized(writeLock) {
        require(name.isNotBlank()) { "提示词名称不能为空" }
        require(instruction.isNotBlank()) { "提示词内容不能为空" }
        val current = read(homeDirectory)
        val finalId = sanitizeId(id?.takeIf { it.isNotBlank() } ?: name)
        val existing = current.firstOrNull { it.id == finalId }
        val others = current.filterNot { it.id == finalId }
        require(existing != null || others.size < MAX_PROMPTS) { "提示词最多 $MAX_PROMPTS 条，先删掉不用的" }
        val preset = Preset(
            id = finalId,
            name = name.trim().take(60),
            instruction = instruction.trim().take(MAX_INSTRUCTION_CHARS),
            enabled = enabled,
            // 新条目默认排最后；改已有条目时没传 order 就保持原位。
            order = order ?: existing?.order ?: ((others.maxOfOrNull { it.order } ?: -1) + 1),
        )
        write(homeDirectory, current.filterNot { it.id == finalId } + preset)
        preset
    }

    /**
     * 删除一条。删除前把整份文件复制到 `.trash/agent-prompts-<时间戳>.json`，
     * 与技能"不直接删"的口径一致：预设是用户手写的，误删一次就得重写。
     */
    fun delete(homeDirectory: Path, id: String): Boolean = synchronized(writeLock) {
        val current = read(homeDirectory)
        if (current.none { it.id == id }) return false
        runCatching {
            val trash = homeDirectory.resolve(TRASH_DIR)
            Files.createDirectories(trash)
            val target = trash.resolve("agent-prompts-${System.currentTimeMillis()}.json")
            Files.copy(fileOf(homeDirectory), target, StandardCopyOption.REPLACE_EXISTING)
        }
        write(homeDirectory, current.filterNot { it.id == id })
        true
    }

    /** 清空（只在测试/自检里用）。 */
    internal fun clear(homeDirectory: Path) {
        Files.deleteIfExists(fileOf(homeDirectory))
    }

    private fun fileOf(homeDirectory: Path): Path = homeDirectory.resolve(FILE_NAME)

    private fun read(homeDirectory: Path): List<Preset> {
        val file = fileOf(homeDirectory)
        if (!Files.isRegularFile(file)) return emptyList()
        return runCatching {
            val text = Files.readString(file).removePrefix("\uFEFF")
            json.decodeFromString(FileShape.serializer(), text).prompts
        }.getOrDefault(emptyList())
    }

    /** 先写临时文件再原子替换：中途崩溃不能留下半截 JSON（下次读会整份丢弃）。 */
    private fun write(homeDirectory: Path, prompts: List<Preset>) {
        Files.createDirectories(homeDirectory)
        val file = fileOf(homeDirectory)
        val temp = homeDirectory.resolve("$FILE_NAME.tmp")
        Files.writeString(temp, json.encodeToString(FileShape.serializer(), FileShape(prompts)))
        runCatching { Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE) }
            .onFailure { Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING) }
    }

    /** 与技能同一套白名单：保留中文/Unicode 字母，只把路径分隔符等换成 '-'。 */
    private fun sanitizeId(raw: String): String {
        val id = raw.trim().lowercase().map { ch ->
            if (ch.isLetterOrDigit() || ch == '-' || ch == '_') ch else '-'
        }.joinToString("").trim('-', '.')
        require(id.isNotBlank()) { "提示词 id 不合法" }
        return id.take(48)
    }
}
