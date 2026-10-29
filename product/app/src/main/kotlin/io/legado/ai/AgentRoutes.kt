package io.legado.ai

import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.request.receive
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.response.respondTextWriter
import io.legado.data.Database
import io.legado.data.saveSource
import io.legado.http.NetworkSecurity
import io.legado.model.ApiError
import io.legado.model.SourceWriteRequest
import io.legado.source.SourceCodec
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.nio.file.Path

// `/api/agent/` 这一组的真实处理体。
// 这一组就是「用户自定义接入」的承载面，但**不动基础框架**：基础框架只在这里把几个稳固的钩子点
// 立出来（清单 / 连接注册 / 书源新建 / 书源校验 / 阅读理解），真正「接什么模型、连哪个地址」完全
// 交给用户在 agent-profiles.json 里配、或运行时 POST 注册。没有连接时 AI 明确不可用，不做本地兜底。
// 各路由在 Routes.kt 里仍是字面注册（供 ApiCatalog 门禁逐条核对）；这里把处理器抽成顶层扩展函数。
// 写门（requireSameOriginWrite）仍由各路由自己的第一行字面值决定，本文件不替它下结论。
// 阅读理解（comprehend）与对话（chat）都委派给网关 AgentConnection，缺连接返回 409、外呼失败返回 502。

// ===== 清单 manifest =====

@Serializable
private data class ManifestParam(
    val name: String,
    val type: String,
    val description: String = "",
    val required: Boolean = false,
    val enum: List<String> = emptyList(),
)

@Serializable
private data class ManifestTool(
    val id: String,
    val group: String,
    val description: String,
    val writes: Boolean,
    /**
     * 工具来源：插件系统已移除，当前所有工具都来自框架内置，恒为 `"builtin"`。
     * 保留这个字段只为契约稳定（前端已按它读取）。
     */
    val origin: String = "builtin",
    /** 参数声明（与 provider 收到的 JSON Schema 同源），供界面展示与调试。 */
    val parameters: List<ManifestParam> = emptyList(),
)

@Serializable
private data class ManifestResponse(
    val enabled: Boolean,
    val tools: List<ManifestTool>,
    val builtinConnections: List<String>,
)

suspend fun ApplicationCall.agentManifest(profileStoreHome: Path, profileStore: AgentProfileStore?, agentConnection: AgentConnection?) {
    val store = profileStore ?: AgentProfileStore
    // 「是否启用」取决于真实档案里有没有外部连接。没有连接时 AI 功能不可用，
    // 不再用内置 local 兜底——所以 builtinConnections 恒为空，保留字段只为契约稳定。
    val externalExists = store.list(profileStoreHome).isNotEmpty()
    val tools = agentConnection?.manifest().orEmpty().map {
        ManifestTool(
            id = it.id,
            group = it.group,
            description = it.description,
            writes = it.writes,
            origin = it.origin ?: "builtin",
            parameters = it.params.map { p ->
                ManifestParam(p.name, p.type, p.description, p.required, p.enum)
            },
        )
    }
    respond(
        ManifestResponse(
            enabled = externalExists,
            tools = tools,
            builtinConnections = emptyList(),
        ),
    )
}

// ===== 连接管理 connections =====

@Serializable
private data class ConnectionRegisterRequest(
    val id: String? = null,
    val name: String,
    val kind: String,
    val baseUrl: String? = null,
    val apiKey: String? = null,
    val model: String? = null,
    val options: Map<String, String>? = null,
)

@Serializable
private data class ConnectionResponse(
    val id: String,
    val name: String,
    val kind: String,
    val model: String? = null,
    val baseUrl: String? = null,
    /** 连接自己的配置（自定义头 / 思考强度 / 超时 / default 标记），不含 apiKey。 */
    val options: Map<String, String> = emptyMap(),
)

suspend fun ApplicationCall.agentListConnections(profileStoreHome: Path, profileStore: AgentProfileStore?) {
    val store = profileStore ?: AgentProfileStore
    val profiles = store.list(profileStoreHome)
    respond(profiles.map { toConnectionResponse(it) })
}

suspend fun ApplicationCall.agentCreateConnection(profileStoreHome: Path, profileStore: AgentProfileStore?) {
    val store = profileStore ?: AgentProfileStore
    val req = runCatching { receive<ConnectionRegisterRequest>() }.getOrElse {
        respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的连接描述")); return
    }
    if (req.name.isBlank()) {
        respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "连接名称 name 不能为空")); return
    }
    val kind = AgentProfileStore.ProfileKind.parse(req.kind) ?: run {
        respond(
            HttpStatusCode.BadRequest,
            ApiError(
                "invalid_kind",
                "不支持的连接类型「${req.kind}」；可选 openai-compatible / anthropic / openai-responses",
            ),
        ); return
    }
    val id = (req.id ?: req.name).trim().ifBlank { req.name }.replace(Regex("[^\\w\\-.]"), "_")
    // 编辑已有连接时前端不回传密钥（GET 本来也不返回它）：apiKey 缺省 = 沿用原来的。
    // 显式传空串才表示"清掉密钥"，否则改个模型名就会把 key 洗没。
    val existing = store.get(profileStoreHome, id)
    val apiKey = when (req.apiKey) {
        null -> existing?.apiKey
        else -> req.apiKey.ifBlank { null }
    }
    val profile = AgentProfileStore.Profile(
        id = id,
        name = req.name.trim(),
        kind = kind,
        baseUrl = req.baseUrl,
        apiKey = apiKey,
        model = req.model,
        // options 缺省也沿用：编辑表单没展开高级项时不该把已配的头丢掉。
        options = req.options ?: existing?.options ?: emptyMap(),
    )
    runCatching { store.register(profileStoreHome, profile) }.onFailure { ex ->
        respond(HttpStatusCode.BadRequest, ApiError("register_failed", ex.message ?: "注册连接失败")); return
    }
    respond(toConnectionResponse(store.get(profileStoreHome, id) ?: profile))
}

suspend fun ApplicationCall.agentDeleteConnection(
    id: String,
    profileStoreHome: Path,
    profileStore: AgentProfileStore?,
) {
    val store = profileStore ?: AgentProfileStore
    val removed = store.delete(profileStoreHome, id)
    if (!removed) {
        respond(HttpStatusCode.NotFound, ApiError("not_found", "连接 $id 不存在")); return
    }
    respond(DeleteConnectionResponse(removed = id))
}

@Serializable
private data class DeleteConnectionResponse(val ok: Boolean = true, val removed: String)

private fun toConnectionResponse(p: AgentProfileStore.Profile) = ConnectionResponse(
    id = p.id,
    name = p.name,
    // 用 wire 值（openai-compatible / anthropic / openai-responses），前端按它选协议预设。
    kind = p.kind.wire,
    model = p.model,
    baseUrl = p.baseUrl,
    options = p.options,
)

// ===== 模型清单 models =====
// 只读探针：拿用户刚填的 baseUrl / key 去 GET {base}/v1/models，把可选的模型名回给界面。
// 不写库、不登记连接；key 只在本进程内存里用一次，不落盘、不进日志。

@Serializable
private data class ModelListRequest(
    val baseUrl: String? = null,
    val apiKey: String? = null,
    /** 连接类型；缺省按 openai-compatible 探。 */
    val kind: String? = null,
    val options: Map<String, String>? = null,
)

@Serializable
private data class ModelListResponse(
    val models: List<String>,
    /** 这个协议是否提供模型清单端点。Anthropic 没有，界面应退回自由输入。 */
    val supported: Boolean = true,
)

suspend fun ApplicationCall.agentListModels() {
    val req = runCatching { receive<ModelListRequest>() }.getOrElse {
        respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 {baseUrl, apiKey}")); return
    }
    val baseUrl = req.baseUrl?.trim().orEmpty()
    if (baseUrl.isBlank()) {
        respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "接口地址 baseUrl 不能为空")); return
    }
    val kind = AgentProfileStore.ProfileKind.parse(req.kind ?: "openai-compatible") ?: run {
        respond(
            HttpStatusCode.BadRequest,
            ApiError("invalid_kind", "不支持的连接类型「${req.kind}」；可选 openai-compatible / anthropic / openai-responses"),
        ); return
    }
    val profile = AgentProfileStore.Profile(
        id = "model-probe",
        name = "model-probe",
        kind = kind,
        baseUrl = baseUrl,
        apiKey = req.apiKey?.takeIf { it.isNotBlank() },
        options = req.options.orEmpty(),
    )
    val provider = LlmProviderRegistry().forProfile(profile)
    if (provider == null) {
        respond(HttpStatusCode.BadGateway, ApiError("no_provider", "没有能处理「${kind.wire}」这种连接的 provider")); return
    }
    try {
        val models = provider.listModels(profile)
        // null = 这个协议不提供模型清单（如 Anthropic），不是错误：界面据此改为自由输入。
        respond(ModelListResponse(models.orEmpty(), supported = models != null))
    } catch (blocked: NetworkSecurity.BlockedAddressException) {
        // 与对话同一条闸门：内网 / 本机地址默认拒，用户要能看懂"是你填的地址被拒了"。
        respond(HttpStatusCode.BadRequest, ApiError("invalid_request", blocked.message ?: "地址被出站安全闸门拒绝"))
    } catch (unreachable: NetworkSecurity.UnreachableTargetException) {
        respond(HttpStatusCode.BadGateway, ApiError("upstream_unreachable", unreachable.message ?: "拿不到模型清单"))
    } catch (invalid: IllegalArgumentException) {
        respond(HttpStatusCode.BadRequest, ApiError("invalid_request", invalid.message ?: "地址不合法"))
    }
}

// ===== 书源新建 / 校验 =====

suspend fun ApplicationCall.agentCreateSource(database: Database) {
    val req = runCatching { receive<SourceWriteRequest>() }.getOrElse {
        respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 {json, version?}")); return
    }
    if (req.json.isBlank()) {
        respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "json 不能为空")); return
    }
    val parsed = runCatching { SourceCodec.parse(req.json) }.getOrElse {
        respond(HttpStatusCode.BadRequest, ApiError("invalid_source", it.message ?: "书源解析失败")); return
    }
    val record = runCatching { database.saveSource(parsed, req.version) }.getOrElse { ex ->
        when (ex) {
            is io.legado.data.VersionConflict ->
                respond(HttpStatusCode.Conflict, ApiError("version_conflict", "书源已被并发修改，请先读取最新版本再保存"))
            else -> respond(HttpStatusCode.InternalServerError, ApiError("save_failed", ex.message ?: "保存失败"))
        }; return
    }
    respond(
        HttpStatusCode.Created,
        SourceCreatedResponse(id = record.id, version = record.version, updatedAt = record.updatedAt.toString()),
    )
}

@Serializable
private data class SourceCreatedResponse(
    val id: String,
    val version: Long,
    val updatedAt: String,
)

@Serializable
private data class ValidateRequest(val json: String)

@Serializable
private data class ValidateResponseDto(
    val valid: Boolean,
    val errors: List<String>,
    val warnings: List<String>,
)

suspend fun ApplicationCall.agentValidateSource() {
    val req = runCatching { receive<ValidateRequest>() }.getOrElse {
        respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 {json}")); return
    }
    if (req.json.isBlank()) {
        respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "json 不能为空")); return
    }
    // 只校验不落库：与 SourceCodec.validate 同一条路径；这条是只读探针。
    val res = SourceCodec.validate(req.json)
    respond(ValidateResponseDto(valid = res.valid, errors = res.errors, warnings = res.warnings))
}

// ===== 文章阅读理解 =====

@Serializable
private data class ComprehendRequest(
    val text: String,
    val question: String? = null,
    val summarySentences: Int = 3,
    val topKeywords: Int = 8,
)

@Serializable
private data class ComprehendResponse(
    val engine: String,
    val summary: String,
    val keywords: List<String>,
    val answer: String? = null,
    val sentencesCount: Int,
    val error: String? = null,
)

// 阅读理解收口到网关 AgentConnection：必须有外部模型连接。
// 缺连接返回 409，外呼失败返回 502 —— 不再回退本地抽取。
suspend fun ApplicationCall.agentComprehend(agentConnection: AgentConnection?) {
    val req = runCatching { receive<ComprehendRequest>() }.getOrElse {
        respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 {text, question?}")); return
    }
    if (req.text.isBlank()) {
        respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "text 不能为空")); return
    }
    val conn = agentConnection
    if (conn == null) {
        respond(HttpStatusCode.ServiceUnavailable, ApiError("gateway_missing", "AI 网关未初始化；请重启服务。"))
        return
    }
    val outcome = conn.comprehend(req.text, req.question, req.summarySentences, req.topKeywords)
    if (outcome.error != null) {
        respond(outcomeStatus(outcome.error), ApiError(outcome.error, outcomeMessage(outcome.error, outcome.errorDetail)))
        return
    }
    respond(toComprehendResponse(outcome))
}

// ===== 自由对话 =====

@Serializable
private data class ChatMessageDto(val role: String = "user", val content: String)

@Serializable
private data class ChatRequestDto(
    val messages: List<ChatMessageDto>,
    /** 用户启用的工具组；缺省/空表示不限制（按对话关键词选）。 */
    val toolGroups: List<String>? = null,
    /** 本轮显式指定要注入的技能 id；缺省按关键词自动命中。 */
    val skills: List<String>? = null,
)

@Serializable
private data class ChatUsageDto(
    val promptTokens: Int? = null,
    val completionTokens: Int? = null,
    val totalTokens: Int? = null,
)

@Serializable
private data class ChatResponseDto(
    val engine: String,
    val content: String,
    val error: String? = null,
    /** 本轮实际执行过的工具（`工具id:结果码`）；没调工具就不出现。 */
    val toolRounds: List<String>? = null,
    /** 上游报告的 token 用量（多轮累加）；没报就不出现。 */
    val usage: ChatUsageDto? = null,
    /** 本轮实际注入的技能 id；没命中就不出现。 */
    val skillsUsed: List<String>? = null,
)

// 自由对话（多轮）：直接把 messages 数组交给外部模型。
// 缺连接返回 409，外呼失败返回 502 —— 不再编一段"本地说明"冒充回答。
suspend fun ApplicationCall.agentChat(agentConnection: AgentConnection?) {
    val req = runCatching { receive<ChatRequestDto>() }.getOrElse {
        respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 {messages:[{role,content}]}")); return
    }
    if (req.messages.isEmpty()) {
        respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "messages 不能为空")); return
    }
    val conn = agentConnection
    if (conn == null) {
        respond(HttpStatusCode.ServiceUnavailable, ApiError("gateway_missing", "AI 网关未初始化；请重启服务。"))
        return
    }
    val outcome = conn.chat(
        req.messages.map { (it.role to it.content) },
        req.toolGroups?.filter { it.isNotBlank() }?.toSet(),
        req.skills.orEmpty(),
    )
    if (outcome.error != null) {
        respond(outcomeStatus(outcome.error), ApiError(outcome.error, outcomeMessage(outcome.error, outcome.errorDetail)))
        return
    }
    respond(
        ChatResponseDto(
            engine = outcome.engine,
            content = outcome.content,
            error = outcome.error,
            toolRounds = outcome.toolRounds,
            usage = outcome.usage?.toDto(),
            skillsUsed = outcome.skillsUsed,
        ),
    )
}

// ===== 流式对话（SSE） =====
//
// 事件帧与 `AgentStreamEvent` 一一对应：start / delta / reasoning / tool_start / tool_end /
// usage / end / error。前端按 `type` 分发，`delta` 直接追加到气泡。
//
// 开流前先判连接：SSE 一旦返回 200，前端就进"接收中"状态 —— 此时再报 409
// 只能塞进一个 error 事件里，用户看到的会是"开了又断"。

private val streamJson = Json { encodeDefaults = false; explicitNulls = false }

suspend fun ApplicationCall.agentChatStream(agentConnection: AgentConnection?) {
    val req = runCatching { receive<ChatRequestDto>() }.getOrElse {
        respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 {messages:[{role,content}]}")); return
    }
    if (req.messages.isEmpty()) {
        respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "messages 不能为空")); return
    }
    val conn = agentConnection
    if (conn == null) {
        respond(HttpStatusCode.ServiceUnavailable, ApiError("gateway_missing", "AI 网关未初始化；请重启服务。"))
        return
    }
    if (!conn.hasConnection()) {
        respond(HttpStatusCode.Conflict, ApiError("no_connection", outcomeMessage("no_connection")))
        return
    }
    response.header("X-Accel-Buffering", "no")
    response.header("Cache-Control", "no-cache, no-transform")
    respondTextWriter(ContentType.Text.EventStream, status = HttpStatusCode.OK) {
        try {
            conn.chatStream(
                messages = req.messages.map { it.role to it.content },
                allowedToolGroups = req.toolGroups?.filter { it.isNotBlank() }?.toSet(),
                skillIds = req.skills.orEmpty(),
            ) { event ->
                write("data: " + streamJson.encodeToString(AgentStreamEvent.serializer(), event) + "\n\n")
                flush()
            }
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            // 客户端断开：Ktor 会取消这个协程；生产者随之停止，不再烧模型额度。
            throw cancelled
        } catch (error: Throwable) {
            val frame = AgentStreamEvent(
                "error",
                code = "internal_error",
                message = error.message ?: "流式对话中断（${error::class.simpleName}）",
            )
            runCatching {
                write("data: " + streamJson.encodeToString(AgentStreamEvent.serializer(), frame) + "\n\n")
                flush()
            }
        }
    }
}

// ===== 技能库 skills =====

@Serializable
private data class SkillDto(
    val id: String,
    val name: String,
    val description: String = "",
    val keywords: List<String> = emptyList(),
    val enabled: Boolean = true,
    val builtin: Boolean = false,
    val content: String = "",
)

@Serializable
private data class SkillListResponse(val skills: List<SkillDto>)

@Serializable
private data class SkillSaveRequest(
    val id: String? = null,
    val name: String,
    val description: String = "",
    val keywords: List<String> = emptyList(),
    val content: String,
    val enabled: Boolean = true,
)

@Serializable
private data class SkillDeleteResponse(val ok: Boolean = true, val removed: String)

private fun AgentSkillStore.Skill.toDto() = SkillDto(
    id = id,
    name = name,
    description = description,
    keywords = keywords,
    enabled = enabled,
    builtin = builtin,
    content = content,
)

private fun LlmUsage.toDto() = ChatUsageDto(
    promptTokens = promptTokens,
    completionTokens = completionTokens,
    totalTokens = totalTokens,
)

suspend fun ApplicationCall.agentListSkills(agentConnection: AgentConnection?) {
    val conn = agentConnection
    if (conn == null) {
        respond(HttpStatusCode.ServiceUnavailable, ApiError("gateway_missing", "AI 网关未初始化；请重启服务。"))
        return
    }
    respond(SkillListResponse(conn.listSkills().map { it.toDto() }))
}

suspend fun ApplicationCall.agentSaveSkill(agentConnection: AgentConnection?) {
    val conn = agentConnection
    if (conn == null) {
        respond(HttpStatusCode.ServiceUnavailable, ApiError("gateway_missing", "AI 网关未初始化；请重启服务。"))
        return
    }
    val req = runCatching { receive<SkillSaveRequest>() }.getOrElse {
        respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 {name, content}")); return
    }
    val saved = runCatching {
        conn.saveSkill(req.id, req.name, req.description, req.keywords, req.content, req.enabled)
    }.getOrElse { error ->
        respond(HttpStatusCode.BadRequest, ApiError("invalid_skill", error.message ?: "技能保存失败"))
        return
    }
    respond(saved.toDto())
}

suspend fun ApplicationCall.agentDeleteSkill(id: String, agentConnection: AgentConnection?) {
    val conn = agentConnection
    if (conn == null) {
        respond(HttpStatusCode.ServiceUnavailable, ApiError("gateway_missing", "AI 网关未初始化；请重启服务。"))
        return
    }
    val removed = runCatching { conn.deleteSkill(id) }.getOrElse { error ->
        respond(HttpStatusCode.BadRequest, ApiError("invalid_skill", error.message ?: "技能删除失败"))
        return
    }
    if (!removed) {
        respond(HttpStatusCode.NotFound, ApiError("not_found", "技能 $id 不存在"))
        return
    }
    respond(SkillDeleteResponse(removed = id))
}

/**
 * 网关错误的 HTTP 语义。三条各管一件事，从前少了中间那条：
 * - `no_connection` 是没配置，客户端自己就能修 → 409；
 * - `invalid_request` 是**地址被出站闸门拒了 / 参数不对**，同样是客户端可修的 → 400。
 *   从前这个码根本不在表里，落进 `else -> 500`：用户填了 `127.0.0.1:5591` 当 baseUrl，
 *   看到的是"服务器内部错误"，而真相是他自己填的地址被拒 —— 500 还会让人去翻服务端日志。
 * - `upstream_unreachable` / `tool_rounds_exhausted` 是上游问题 → 502。
 */
private fun outcomeStatus(code: String): HttpStatusCode = when (code) {
    "no_connection" -> HttpStatusCode.Conflict
    "invalid_request" -> HttpStatusCode.BadRequest
    "upstream_unreachable", "tool_rounds_exhausted" -> HttpStatusCode.BadGateway
    "empty_messages" -> HttpStatusCode.BadRequest
    else -> HttpStatusCode.InternalServerError
}

/**
 * 错误文案：有真因就报真因（网关那句中文"拒绝访问内网或本机地址"、
 * "无法解析 xxx 域名"），没有才回兜底套话。
 * 从前这里一律套话，于是"被拒绝"与"连不上"在界面上长得一模一样。
 */
private fun outcomeMessage(code: String, detail: String? = null): String {
    val specific = detail?.trim()?.takeIf { it.isNotEmpty() }
    if (specific != null) return specific
    return when (code) {
        "no_connection" -> "尚未登记外部模型连接；请先在「AI 接入 → 连接」里登记一个模型地址。"
        "invalid_request" -> "这个连接用不了：地址不合法或被出站安全闸门拒绝（内网 / 本机地址不放开）。"
        "upstream_unreachable" -> "外部模型连不上，本次没有结果。"
        "tool_rounds_exhausted" -> "外部模型在工具调用轮数上限内仍未给出结论。"
        "empty_messages" -> "messages 不能为空"
        else -> "AI 请求失败：$code"
    }
}

private fun toComprehendResponse(o: Agent.ComprehendOutcome) = ComprehendResponse(
    engine = o.engine,
    summary = o.summary,
    keywords = o.keywords,
    answer = o.answer,
    sentencesCount = o.sentencesCount,
    error = o.error,
)
