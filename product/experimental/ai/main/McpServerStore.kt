package io.legado.ai

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path

/**
 * 外部 MCP 服务的配置层：`{home}/agent-mcp.json`。
 *
 * 和 [AgentProfileStore] 同一套口径 —— 只存"用户登记了什么"，不做任何外呼；
 * 真正握手、拉工具清单、调用工具的是 [McpClient]，把工具挂进注册表的是 [McpBridge]。
 *
 * 为什么单独一份文件而不是塞进 `agent-profiles.json`：连接档案是"跟哪个模型说话"，
 * MCP 是"模型能额外用到哪些外部能力"，两者的生命周期与出错方式完全不同
 * （连接挂了整条对话不可用，MCP 挂了只是少一组工具）。混在一份里，一次坏记录会同时拖垮两件事。
 */
object McpServerStore {

    private const val FILE_NAME = "agent-mcp.json"

    private val json = Json { ignoreUnknownKeys = true; isLenient = true; encodeDefaults = true; prettyPrint = true }

    /**
     * 一台 MCP 服务。
     *
     * [id] 会进工具 id（`mcp.<id>.<工具名>`），所以限制成小写字母/数字/下划线/短横线 ——
     * 允许点号会让"服务 id"和"工具名"的分隔变得有歧义，允许大写会让同一个服务在两处写法不同。
     */
    @Serializable
    data class Server(
        val id: String,
        val name: String = "",
        val url: String,
        val enabled: Boolean = true,
        /** 额外的请求头（如 `Authorization`）。只写不读回界面，见 [McpBridge] 的状态视图。 */
        val headers: Map<String, String> = emptyMap(),
        /** 单次工具调用超时；握手与拉清单另有更短的上限（[McpClient]）。 */
        val timeoutMs: Int = 20_000,
    )

    @Serializable
    private data class Store(val servers: List<Server> = emptyList())

    /** 工具 id 里那一段：小写字母开头，最长 32 位。 */
    private val ID_PATTERN = Regex("^[a-z0-9][a-z0-9_-]{0,31}$")

    fun list(homeDirectory: Path): List<Server> = readPersisted(homeDirectory)

    fun get(homeDirectory: Path, id: String): Server? =
        readPersisted(homeDirectory).firstOrNull { it.id == id }

    /**
     * 登记/更新一台服务，写回磁盘。
     *
     * 校验在这里做而不是留给外呼：id 非法会让工具 id 变成 `mcp...`，地址非法会在
     * 用户点"保存"之后才报错 —— 那时他已经离开这一屏了。宁可保存时就拒。
     */
    fun register(homeDirectory: Path, draft: Server): Server {
        val normalized = normalize(draft)
        val current = readPersisted(homeDirectory).filter { it.id != normalized.id }.toMutableList()
        current.add(normalized)
        writePersisted(homeDirectory, current)
        return normalized
    }

    fun delete(homeDirectory: Path, id: String): Boolean {
        val current = readPersisted(homeDirectory).toMutableList()
        val removed = current.removeIf { it.id == id }
        if (removed) writePersisted(homeDirectory, current)
        return removed
    }

    /** 规整并校验一条配置；不合法直接抛 [IllegalArgumentException]（上层转 400）。 */
    fun normalize(draft: Server): Server {        val id = draft.id.trim().lowercase()
        require(ID_PATTERN.matches(id)) {
            "服务 id 只能用小写字母、数字、下划线与短横线，且以字母或数字开头（最长 32 位）：当前是「${draft.id}」"
        }
        val url = draft.url.trim()
        val uri = runCatching { URI.create(url) }.getOrNull()
            ?: throw IllegalArgumentException("MCP 服务地址不是合法 URL：$url")
        require(uri.scheme in setOf("http", "https") && !uri.host.isNullOrBlank()) {
            "MCP 服务地址必须是 http(s)://主机:端口/路径 的形式：$url"
        }
        val timeout = draft.timeoutMs.coerceIn(1_000, 120_000)
        return draft.copy(
            id = id,
            name = draft.name.trim().ifBlank { id },
            url = url,
            timeoutMs = timeout,
            headers = draft.headers
                .mapKeys { it.key.trim() }
                .filterKeys { it.isNotEmpty() }
                .mapValues { it.value.trim() }
                .filterValues { it.isNotEmpty() },
        )
    }

    /**
     * 由服务名派生一个合法 id。
     *
     * 为什么不让用户自己想 id：id 是 `mcp.<id>.<工具名>` 里的那一段，属于实现细节；
     * 而中文名直接当 id 会被 [normalize] 拒掉（"id 只能用小写字母…"），用户看不懂
     * 为什么"名字"不能用中文。这里做两件事：能取字母数字就取（`本地 File` → `file`），
     * 一个都没有（纯中文、纯符号）就用名字的哈希 —— 稳定、短、两台不同名的服务不会撞。
     */
    fun deriveId(name: String): String {
        val slug = name.lowercase()
            .map { ch -> if (ch in 'a'..'z' || ch in '0'..'9') ch else '-' }
            .joinToString("")
            .replace(Regex("-+"), "-")
            .trim('-')
            .take(32)
        if (slug.isNotEmpty() && (slug[0] in 'a'..'z' || slug[0] in '0'..'9')) return slug
        val hash = (name.trim().hashCode().toLong() and 0xFFFF_FFFFL).toString(16).padStart(8, '0')
        return "srv-$hash"
    }

    /**
     * 逐条容错读取：一条坏记录不该让整份配置消失。
     * 与 [AgentProfileStore] 同样的理由 —— 静默丢掉用户登记的全部 MCP 服务，比报错更难查。
     */
    private fun readPersisted(homeDirectory: Path): List<Server> {
        val file = resolveFile(homeDirectory)
        if (!Files.isReadable(file)) return emptyList()
        return runCatching {
            val raw = Files.readString(file)
            val text = if (raw.isNotEmpty() && raw[0] == '\uFEFF') raw.substring(1) else raw
            if (text.isBlank()) return emptyList()
            val items = json.parseToJsonElement(text).jsonObject["servers"]?.jsonArray ?: return emptyList()
            items.mapNotNull { element ->
                runCatching { json.decodeFromJsonElement(Server.serializer(), element) }
                    .onFailure { error ->
                        val id = runCatching { element.jsonObject["id"]?.jsonPrimitive?.contentOrNull }.getOrNull() ?: "(无 id)"
                        System.err.println(
                            "[agent-mcp] 跳过一条无法识别的 MCP 配置 id=$id：${error.message ?: error::class.simpleName}",
                        )
                    }
                    .getOrNull()
            }
        }.getOrDefault(emptyList())
    }

    private fun writePersisted(homeDirectory: Path, servers: List<Server>) {
        Files.createDirectories(homeDirectory)
        runCatching { Files.createDirectories(homeDirectory.resolve(".data")) }
        val text = json.encodeToString(Store.serializer(), Store(servers))
        Files.writeString(homeDirectory.resolve(FILE_NAME), text)
        runCatching { Files.writeString(homeDirectory.resolve(".data").resolve(FILE_NAME), text) }
    }

    private fun resolveFile(homeDirectory: Path): Path {
        val primary = homeDirectory.resolve(FILE_NAME)
        if (Files.isReadable(primary)) return primary
        val fallback = homeDirectory.resolve(".data").resolve(FILE_NAME)
        return if (Files.isReadable(fallback)) fallback else primary
    }
}
