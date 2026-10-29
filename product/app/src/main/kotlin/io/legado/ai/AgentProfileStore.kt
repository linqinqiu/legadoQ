package io.legado.ai

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.nio.file.Files
import java.nio.file.Path

/**
 * 自定义接入的「连接档案」持久层。
 *
 * 这里只存**用户登记的外部连接**（openai-compatible）。框架不再提供任何内置连接：
 * 没有连接时 AI 功能明确不可用（HTTP 409 `no_connection`），不做本地抽取兜底 ——
 * 那会让调用方分不清"模型给的"和"正则抽的"。
 *
 * 连接既可以由用户在配置文件里预先写死，也可以经由 `POST /api/agent/connections`
 * 在运行时注册 —— 两者都落到同一份本地 JSON，重启后自动恢复。
 *
 * 设计红线：这里只是「连接描述」的存取，不做任何真实外呼；真正发请求的是
 * [io.legado.ai.Agent]。
 */
object AgentProfileStore {

    /** 配置文件名：优先放在「安装根目录」，其次 `.data/`，与 port.txt / 其他本机个性化条目同级。 */
    private const val FILE_NAME = "agent-profiles.json"

    private val json = Json { ignoreUnknownKeys = true; isLenient = true; encodeDefaults = true; prettyPrint = true }

    /**
     * 连接类型。**wire 值必须与 [LlmProvider.id] 对上** —— 注册表按它挑协议实现。
     *
     * 三种：
     * - `openai-compatible`：`/v1/chat/completions`（默认档，任何兼容服务）
     * - `anthropic`：`/v1/messages`（Claude）
     * - `openai-responses`：`/v1/responses`（gpt-5 / o 系列推荐）
     *
     * 老档案只写了 `openai-compatible`，照常可用 —— 新枚举值只是多了两条可选路。
     */
    @Serializable
    enum class ProfileKind(val wire: String) {
        @SerialName("openai-compatible")
        OPENAI_COMPATIBLE("openai-compatible"),

        @SerialName("anthropic")
        ANTHROPIC("anthropic"),

        @SerialName("openai-responses")
        OPENAI_RESPONSES("openai-responses");

        companion object {
            /** 宽容解析：大小写、下划线/短横线混写都认；认不出返回 null。 */
            fun parse(raw: String?): ProfileKind? {
                val normalized = raw?.trim()?.lowercase()?.replace('_', '-') ?: return null
                if (normalized == "openaicompatible") return OPENAI_COMPATIBLE
                return entries.firstOrNull { it.wire == normalized }
            }
        }
    }

    @Serializable
    data class Profile(
        val id: String,
        val name: String,
        val kind: ProfileKind,
        val baseUrl: String? = null,
        val apiKey: String? = null,
        val model: String? = null,
        val options: Map<String, String> = emptyMap(),
    )

    @Serializable
    private data class Store(val profiles: List<Profile> = emptyList())

    private fun resolveFile(homeDirectory: Path): Path {
        val primary = homeDirectory.resolve(FILE_NAME)
        if (Files.isReadable(primary)) return primary
        val fallback = homeDirectory.resolve(".data").resolve(FILE_NAME)
        return if (Files.isReadable(fallback)) fallback else primary
    }

    /** 列出当前全部连接。没有登记过就是空列表。 */
    fun list(homeDirectory: Path): List<Profile> = readPersisted(homeDirectory)

    /** 按 id 取一个；没有就返回 null。 */
    fun get(homeDirectory: Path, id: String): Profile? =
        readPersisted(homeDirectory).firstOrNull { it.id == id }

    /**
     * 注册/更新一个用户连接，写回磁盘。
     * 返回的 Profile 即为落库后的形态（id 被规整过）。
     */
    fun register(homeDirectory: Path, draft: Profile): Profile {
        require(draft.id.isNotBlank()) { "连接 id 不能为空" }
        val normalized = draft.copy(
            id = draft.id.trim(),
            kind = draft.kind,
            baseUrl = draft.baseUrl?.trim()?.takeIf { it.isNotBlank() },
        )
        val current = readPersisted(homeDirectory).filter { it.id != normalized.id }.toMutableList()
        current.add(normalized)
        writePersisted(homeDirectory, current)
        return normalized
    }

    /** 删除一个连接。返回是否真的删掉了。 */
    fun delete(homeDirectory: Path, id: String): Boolean {
        val current = readPersisted(homeDirectory).toMutableList()
        val removed = current.removeIf { it.id == id }
        if (removed) writePersisted(homeDirectory, current)
        return removed
    }

    /**
     * 读本机保存的连接。
     *
     * **必须逐条容错，不能整份解析失败就返回空列表**：0.8.2 及更早的配置里可能还有
     * `"kind": "builtin-stub"`（当时的内置本地连接）。0.8.3 把这个类型删了，若整份
     * `decodeFromString` 一失败就 `getOrDefault(emptyList())`，用户**所有**外部连接会一起
     * 消失且毫无提示 —— 界面上只显示"未连接外部模型"，人根本想不到是配置文件里一条老记录
     * 把整份文件带崩了。
     *
     * 所以这里按条解析：坏的那条跳过并记一条日志，其余照常恢复。
     */
    private fun readPersisted(homeDirectory: Path): List<Profile> {
        val file = resolveFile(homeDirectory)
        if (!Files.isReadable(file)) return emptyList()
        return runCatching {
            // 容忍带 UTF-8 BOM 的配置文件（很多编辑器/脚本默认写出 BOM），否则 kotlinx 解析会静默失败。
            val raw = Files.readString(file)
            val text = if (raw.length > 0 && raw[0] == '\uFEFF') raw.substring(1) else raw
            if (text.isBlank()) return emptyList()
            val root = json.parseToJsonElement(text).jsonObject
            val items = root["profiles"]?.jsonArray ?: return emptyList()
            items.mapNotNull { element ->
                runCatching { json.decodeFromJsonElement(Profile.serializer(), element) }
                    .onFailure { error ->
                        // 跳过这一条，但要说出来 —— 静默丢配置比报错更难查。
                        val id = runCatching {
                            element.jsonObject["id"]?.jsonPrimitive?.contentOrNull
                        }.getOrNull() ?: "(无 id)"
                        System.err.println(
                            "[agent-profiles] 跳过一条无法识别的连接记录 id=$id：" +
                                "${error.message ?: error::class.simpleName}（老版本的 builtin-stub 记录属于此类，可安全删除）",
                        )
                    }
                    .getOrNull()
            }
        }.getOrDefault(emptyList())
    }

    private fun writePersisted(homeDirectory: Path, profiles: List<Profile>) {
        val file = homeDirectory.resolve(FILE_NAME)
        Files.createDirectories(homeDirectory)
        // .data 兜底目录也同步一份，便于备份/迁移；主文件在安装根。
        runCatching { Files.createDirectories(homeDirectory.resolve(".data")) }
        val primary = file
        Files.writeString(primary, json.encodeToString(Store.serializer(), Store(profiles)))
        runCatching {
            val fallback = homeDirectory.resolve(".data").resolve(FILE_NAME)
            Files.writeString(fallback, json.encodeToString(Store.serializer(), Store(profiles)))
        }
    }
}
