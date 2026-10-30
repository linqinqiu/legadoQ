package io.legado.http

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import io.legado.charsetOf
import io.legado.content.ContentProcessor
import io.legado.data.Database
import io.legado.data.deleteReplaceRule
import io.legado.data.deleteReplaceRules
import io.legado.data.exportReplaceRules
import io.legado.data.getEnabledReplaceRulesForScope
import io.legado.data.getReplaceRule
import io.legado.data.importReplaceRules
import io.legado.data.listReplaceRules
import io.legado.data.saveReplaceRule
import io.legado.data.toggleReplaceRules
import io.legado.decodeTextAuto
import io.legado.model.ApiError
import io.legado.model.ReplaceRule
import io.legado.model.ReplaceRulePreviewRequest
import io.legado.model.ReplaceRulePreviewResponse
import io.legado.model.ReplaceRuleToggleRequest
import io.legado.rules.JsSandbox
import io.legado.rules.RuleRunner
import java.net.URI
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * 从 `Routes.kt` 拆出（0.8.2 结构重排）：净化规则增删改、导入导出与预览。
 * 处理器文本逐字未动；本函数由 `Routes.kt` 的 `apiRoutes` 挂在 `route("/api")` 内，顺序与拆前一致。
 * 契约核对：`web/test/ApiCatalog.test.ts` 把本目录全部 `*Routes.kt` 视为挂在 `/api` 之下逐条比对。
 */
fun Route.replaceRulesRoutes(
    database: Database,
    runner: RuleRunner,
) {
        route("/replace-rules") {
            get {
                val q = call.request.queryParameters["q"]
                val group = call.request.queryParameters["group"]
                val scope = call.request.queryParameters["scope"] ?: call.request.queryParameters["bookName"]
                call.respond(database.listReplaceRules(q, group, scope))
            }
            get("/{id}") {
                val id = call.parameters["id"] ?: return@get call.respond(HttpStatusCode.BadRequest, ApiError("invalid_id", "缺少规则 ID"))
                database.getReplaceRule(id)?.let { call.respond(it) } ?: call.respond(HttpStatusCode.NotFound, ApiError("not_found", "规则不存在"))
            }
            post {
                if (!call.requireSameOriginWrite()) return@post
                val rule = call.receive<ReplaceRule>()
                if (rule.pattern.isBlank()) {
                    call.respond(HttpStatusCode.BadRequest, ApiError("invalid_rule", "匹配模式不能为空"))
                    return@post
                }
                call.respond(database.saveReplaceRule(rule))
            }
            put("/{id}") {
                if (!call.requireSameOriginWrite()) return@put
                val id = call.parameters["id"] ?: return@put call.respond(HttpStatusCode.BadRequest, ApiError("invalid_id", "缺少规则 ID"))
                val rule = call.receive<ReplaceRule>().copy(id = id)
                if (rule.pattern.isBlank()) {
                    call.respond(HttpStatusCode.BadRequest, ApiError("invalid_rule", "匹配模式不能为空"))
                    return@put
                }
                call.respond(database.saveReplaceRule(rule))
            }
            delete("/{id}") {
                if (!call.requireSameOriginWrite()) return@delete
                val id = call.parameters["id"] ?: return@delete call.respond(HttpStatusCode.BadRequest, ApiError("invalid_id", "缺少规则 ID"))
                if (database.deleteReplaceRule(id)) call.respond(HttpStatusCode.NoContent)
                else call.respond(HttpStatusCode.NotFound, ApiError("not_found", "规则不存在"))
            }
            post("/delete-batch") {
                if (!call.requireSameOriginWrite()) return@post
                val ids = call.receive<List<String>>()
                val count = database.deleteReplaceRules(ids)
                call.respond(mapOf("deleted" to count))
            }
            post("/toggle") {
                if (!call.requireSameOriginWrite()) return@post
                val req = call.receive<ReplaceRuleToggleRequest>()
                val count = database.toggleReplaceRules(req.ids, req.enabled)
                call.respond(mapOf("updated" to count))
            }
            get("/export") {
                val ids = call.request.queryParameters.getAll("id")
                call.respondText(
                    text = Json.encodeToString(database.exportReplaceRules(ids)),
                    contentType = ContentType.Application.Json.withCharset(Charsets.UTF_8),
                )
            }
            post("/import") {
                if (!call.requireSameOriginWrite()) return@post
                // 规则里全是中文（模式/替换文案），用 GBK 发过来时以前会静默变成一串替换字符再入库。
                val bodyText = call.receiveStrictText()
                val parsedRules = parseImportedReplaceRules(bodyText)
                val response = database.importReplaceRules(parsedRules)
                call.respond(response)
            }
            post("/preview") {
                val req = call.receive<ReplaceRulePreviewRequest>()
                val rules = if (req.rule != null) listOf(req.rule) else database.getEnabledReplaceRulesForScope(req.bookName, req.sourceUrl)
                val jsSandbox = JsSandbox(runner)
                val cleaned = ContentProcessor.processContent(req.text, rules, jsSandbox = jsSandbox, bookName = req.bookName)
                val appliedNames = rules.filter { ContentProcessor.applyRule(req.text, it, jsSandbox = jsSandbox, bookName = req.bookName) != req.text }.map { it.name.ifBlank { it.pattern } }
                call.respond(ReplaceRulePreviewResponse(
                    originalText = req.text,
                    cleanedText = cleaned,
                    changed = cleaned != req.text,
                    appliedRules = appliedNames,
                ))
            }
        }
}

/** 导入净化规则时的远端拉取：共享一个受控 client（出站必过闸，建连前再做一次 DNS 重绑判定）。 */
private val importFetchClient = NetworkSecurity.newHttpClient(
    connectTimeout = java.time.Duration.ofSeconds(10),
    followRedirects = java.net.http.HttpClient.Redirect.NEVER,
)

private suspend fun parseImportedReplaceRules(bodyText: String, depth: Int = 0): List<ReplaceRule> {
    val cleanText = bodyText.trim().removePrefix("\uFEFF")
    if (cleanText.isBlank()) return emptyList()
    // {"url": ...} 里还可以再含 {"url": ...}：没有深度上限就是一条跟随到底的外呼链
    if (depth > 3) return emptyList()

    val json = Json { ignoreUnknownKeys = true; isLenient = true }
    val jsonElement = runCatching { json.parseToJsonElement(cleanText) }.getOrNull() ?: return emptyList()

    // Check if it's an object with "url"
    if (jsonElement is kotlinx.serialization.json.JsonObject) {
        val url = jsonElement["url"]?.let { if (it is JsonPrimitive) it.contentOrNull else null }
        if (!url.isNullOrBlank()) {
            validateSubscriptionUrl(url)
            val req = java.net.http.HttpRequest.newBuilder().uri(java.net.URI(url))
                .timeout(java.time.Duration.ofSeconds(20)).GET().build()
            // 远端规则文件同样可能是 GBK 存的：先拿字节，再按响应头声明 + 自动探测解，别硬按 UTF-8 读。
            val resp = withContext(Dispatchers.IO) { importFetchClient.send(req, java.net.http.HttpResponse.BodyHandlers.ofByteArray()) }
            val declared = charsetOf(resp.headers().firstValue("Content-Type").orElse(null))
            return parseImportedReplaceRules(decodeTextAuto(resp.body(), declared), depth + 1)
        }
    }

    val array = when (jsonElement) {
        is kotlinx.serialization.json.JsonArray -> jsonElement
        is kotlinx.serialization.json.JsonObject -> {
            (jsonElement["rules"] ?: jsonElement["data"] ?: jsonElement["replaceRules"] ?: jsonElement["items"]) as? kotlinx.serialization.json.JsonArray
        }
        else -> null
    } ?: return emptyList()

    return array.mapNotNull { item ->
        if (item !is kotlinx.serialization.json.JsonObject) return@mapNotNull null
        val pattern = item["pattern"]?.let { if (it is JsonPrimitive) it.contentOrNull else null } ?: return@mapNotNull null
        if (pattern.isBlank()) return@mapNotNull null
        val id = item["id"]?.let { if (it is JsonPrimitive) it.contentOrNull else null } ?: ""
        val name = item["name"]?.let { if (it is JsonPrimitive) it.contentOrNull else null } ?: pattern
        val group = item["group"]?.let { if (it is JsonPrimitive) it.contentOrNull else null } ?: item["groupName"]?.let { if (it is JsonPrimitive) it.contentOrNull else null }
        val replacement = item["replacement"]?.let { if (it is JsonPrimitive) it.contentOrNull else null } ?: ""
        val isRegex = item["isRegex"]?.let { if (it is JsonPrimitive) it.contentOrNull?.toBooleanStrictOrNull() ?: (it.contentOrNull?.toIntOrNull() != 0) else null } ?: true
        val scope = item["scope"]?.let { if (it is JsonPrimitive) it.contentOrNull else null }
        val excludeScope = item["excludeScope"]?.let { if (it is JsonPrimitive) it.contentOrNull else null }
        val scopeTitle = item["scopeTitle"]?.let { if (it is JsonPrimitive) it.contentOrNull?.toBooleanStrictOrNull() ?: (it.contentOrNull?.toIntOrNull() == 1) else null } ?: false
        val scopeContent = item["scopeContent"]?.let { if (it is JsonPrimitive) it.contentOrNull?.toBooleanStrictOrNull() ?: (it.contentOrNull?.toIntOrNull() != 0) else null } ?: true
        val isEnabled = item["isEnabled"]?.let { if (it is JsonPrimitive) it.contentOrNull?.toBooleanStrictOrNull() ?: (it.contentOrNull?.toIntOrNull() != 0) else null } ?: true
        val order = item["order"]?.let { if (it is JsonPrimitive) it.contentOrNull?.toIntOrNull() else null } ?: item["sortOrder"]?.let { if (it is JsonPrimitive) it.contentOrNull?.toIntOrNull() else null } ?: 0
        val timeoutMs = item["timeoutMillisecond"]?.let { if (it is JsonPrimitive) it.contentOrNull?.toLongOrNull() else null } ?: item["timeout_ms"]?.let { if (it is JsonPrimitive) it.contentOrNull?.toLongOrNull() else null } ?: 3000L

        ReplaceRule(
            id = id,
            name = name,
            group = group,
            pattern = pattern,
            replacement = replacement,
            isRegex = isRegex,
            scope = scope,
            excludeScope = excludeScope,
            scopeTitle = scopeTitle,
            scopeContent = scopeContent,
            isEnabled = isEnabled,
            order = order,
            timeoutMillisecond = timeoutMs,
        )
    }
}

