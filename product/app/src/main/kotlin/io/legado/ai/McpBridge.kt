package io.legado.ai

import io.legado.port.logSystem
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.nio.file.Path

/**
 * 把外部 MCP 服务上的工具挂进 [ToolRegistry] —— "AI 能用什么"从内置 55 个变成"内置 + 你接的"。
 *
 * 三条边界，都是刻意的：
 * ① **挂不进来不算错**：服务没开、地址写错、协议不兼容，都只让那一组工具为空，并把原因
 *    记进状态（[statuses]）。聊天不会因此失败 —— 一个外部服务没起来，不该让整条对话不能说话。
 * ② **工具一律进 `mcp` 组**：这样用户在「AI 工具」里一个开关就能全关，默认也不下发
 *    （[ToolSelection] 的默认组里没有它）。模型仍能用 `tool.search` / `tool.call` 够到它们 ——
 *    那两条在 `program` 组，始终可用。
 * ③ **摘干净**：服务被停用/删除/改名时，它注册过的工具要一起摘掉。留下一个"调用必然失败"的
 *    工具，比没有这个工具更糟 —— 模型会一直试。
 *
 * 同步是**尽力而为**的：整份配置里有一台坏掉，其余照常挂。
 */
class McpBridge(
    private val registry: ToolRegistry,
    private val homeDirectory: Path,
) {

    /** 一台服务此刻的状态。`error` 为空且 `ok` 为真才表示工具真的挂上了。 */
    data class ServerStatus(
        val id: String,
        val name: String,
        val url: String,
        val enabled: Boolean,
        val ok: Boolean,
        val toolCount: Int,
        val error: String? = null,
        val syncedAt: Long = 0L,
        /** 只回显请求头的**名字**：值里通常就是 token，不能进界面、更不能进日志。 */
        val headerNames: List<String> = emptyList(),
    )

    private val lock = Any()
    private val clients = HashMap<String, McpClient>()
    /** 服务 id → 它当前注册进来的工具 id。摘工具时按这份清单来。 */
    private val ownedTools = HashMap<String, List<String>>()

    @Volatile
    private var cached: List<ServerStatus> = emptyList()

    @Volatile
    private var lastSyncAt: Long = 0L

    /** 上一次同步的结果（按配置顺序）。没有同步过就是空列表。 */
    fun statuses(): List<ServerStatus> = cached

    /**
     * 按配置同步全部服务。
     *
     * @param force 忽略 [TTL_MS] 的缓存（用户点「刷新」时用）。默认 60 秒内不重复握手 ——
     *        每次对话前都去问一遍外部服务，会让一句"你好"多等几百毫秒。
     */
    fun sync(force: Boolean = false): List<ServerStatus> = synchronized(lock) {
        val now = System.currentTimeMillis()
        if (!force && cached.isNotEmpty() && now - lastSyncAt < TTL_MS) return cached
        val servers = McpServerStore.list(homeDirectory)
        // 配置里已经没有的服务：把它注册过的工具摘掉，否则界面/模型还会看到一个永远调不通的工具。
        (ownedTools.keys - servers.map { it.id }.toSet()).toList().forEach { dropTools(it) }
        val next = servers.map { server ->
            if (!server.enabled) {
                dropTools(server.id)
                server.toStatus(ok = false, toolCount = 0, error = "已停用", syncedAt = now)
            } else {
                connect(server, now)
            }
        }
        lastSyncAt = now
        cached = next
        next
    }

    /** 同步一台（用户刚保存配置时用）：只动这一台，其余状态保持不变。 */
    fun syncOne(id: String): ServerStatus? = synchronized(lock) {
        val server = McpServerStore.get(homeDirectory, id) ?: return null
        val now = System.currentTimeMillis()
        val status = if (!server.enabled) {
            dropTools(server.id)
            server.toStatus(ok = false, toolCount = 0, error = "已停用", syncedAt = now)
        } else {
            connect(server, now)
        }
        cached = cached.filterNot { it.id == id } + status
        cached = cached.sortedBy { it.id }
        lastSyncAt = now
        status
    }

    /** 删除一台服务的工具（配置已经由 [McpServerStore.delete] 删掉了）。 */
    fun forget(id: String) = synchronized(lock) {
        dropTools(id)
        cached = cached.filterNot { it.id == id }
    }

    private fun connect(server: McpServerStore.Server, now: Long): ServerStatus {
        return try {
            val client = McpClient(server)
            client.initialize()
            val tools = client.listTools()
            dropTools(server.id)
            val ids = tools.mapNotNull { tool -> register(server, client, tool) }
            clients[server.id] = client
            ownedTools[server.id] = ids
            server.toStatus(ok = true, toolCount = ids.size, error = null, syncedAt = now)
        } catch (error: Throwable) {
            // 失败就把这台的工具摘干净：留下"看得见、调不通"的工具比没有更糟。
            dropTools(server.id)
            val reason = error.message ?: error::class.simpleName ?: "未知错误"
            logSystem("MCP 服务不可用", mapOf("server" to server.id, "url" to server.url, "error" to reason))
            server.toStatus(ok = false, toolCount = 0, error = reason, syncedAt = now)
        }
    }

    private fun register(server: McpServerStore.Server, client: McpClient, tool: McpTool): String? {
        val name = tool.name.trim()
        if (name.isEmpty()) return null
        // `mcp.<服务id>.<工具名>`：服务 id 唯一，所以两台服务有同名工具也不会撞。
        val id = "mcp.${server.id}.$name"
        val meta = ToolMeta(
            id = id,
            group = GROUP,
            description = tool.description.ifBlank { "MCP 工具 $name（来自 ${server.name}）" },
            // 远端没声明只读就按"会写"记：这个字段目前只用于界面提示与钩子，多标一次无害，
            // 少标一次会让审计以为它只读。
            writes = !tool.readOnly,
            origin = "mcp:${server.id}",
            params = paramsOf(tool.inputSchema),
        )
        val registered = registry.register(
            Tool(meta) { _, args ->
                try {
                    val result = client.callTool(name, args)
                    if (result.isError) {
                        AgentResult("error", "mcp_tool_error", result.text.ifBlank { "MCP 工具 $name 返回错误" })
                    } else {
                        AgentResult("ok", message = null, data = result.text)
                    }
                } catch (error: McpException) {
                    AgentResult("error", "mcp_error", error.message)
                }
            },
            replace = true,
        )
        return if (registered) id else null
    }

    private fun dropTools(serverId: String) {
        ownedTools.remove(serverId)?.forEach { registry.unregister(it) }
        clients.remove(serverId)
    }

    /** `inputSchema.properties` → 我们的扁平参数声明（与内置工具同一套 schema 生成逻辑）。 */
    private fun paramsOf(schema: JsonObject?): List<ToolParam> {
        val properties = schema?.get("properties") as? JsonObject ?: return emptyList()
        val required = (schema["required"] as? JsonArray)
            ?.mapNotNull { it.jsonPrimitive.contentOrNull }
            ?.toSet()
            .orEmpty()
        return properties.map { (name, raw) ->
            val obj = raw as? JsonObject
            val declared = obj?.get("type")?.jsonPrimitive?.contentOrNull ?: "string"
            ToolParam(
                name = name,
                type = declared.takeIf { it in SUPPORTED_TYPES } ?: "string",
                description = obj?.get("description")?.jsonPrimitive?.contentOrNull.orEmpty(),
                required = name in required,
                enum = (obj?.get("enum") as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull }.orEmpty(),
            )
        }
    }

    private fun McpServerStore.Server.toStatus(ok: Boolean, toolCount: Int, error: String?, syncedAt: Long) =
        ServerStatus(
            id = id,
            name = name,
            url = url,
            enabled = enabled,
            ok = ok,
            toolCount = toolCount,
            error = error,
            syncedAt = syncedAt,
            headerNames = headers.keys.sorted(),
        )

    companion object {
        /** 所有 MCP 工具共用的组名。默认不下发，见 [ToolSelection]。 */
        const val GROUP = "mcp"

        /** 同步结果的缓存时长：一句普通对话不该每次都去敲一遍外部服务。 */
        const val TTL_MS = 60_000L

        private val SUPPORTED_TYPES = setOf("string", "integer", "number", "boolean", "array", "object")
    }
}
