package io.legado.http

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import io.legado.ai.AgentConnection
import io.legado.ai.AgentProfileStore
import io.legado.ai.agentChat
import io.legado.ai.agentChatStream
import io.legado.ai.agentComprehend
import io.legado.ai.agentCreateConnection
import io.legado.ai.agentCreateSource
import io.legado.ai.agentDeleteConnection
import io.legado.ai.agentDeleteMcp
import io.legado.ai.agentDeletePrompt
import io.legado.ai.agentDeleteSkill
import io.legado.ai.agentListConnections
import io.legado.ai.agentListMcp
import io.legado.ai.agentListModels
import io.legado.ai.agentListPrompts
import io.legado.ai.agentListSkills
import io.legado.ai.agentListTaskModels
import io.legado.ai.agentManifest
import io.legado.ai.agentRefreshMcp
import io.legado.ai.agentSaveMcp
import io.legado.ai.agentSavePrompt
import io.legado.ai.agentSaveSkill
import io.legado.ai.agentSaveTaskModel
import io.legado.ai.agentValidateSource
import io.legado.data.Database
import java.nio.file.Path

/**
 * 从 `Routes.kt` 拆出（0.8.2 结构重排）：AI 自定义接入面（连接登记、书源双动作、阅读理解、对话）。
 * 处理器文本逐字未动；本函数由 `Routes.kt` 的 `apiRoutes` 挂在 `route("/api")` 内，顺序与拆前一致。
 * 契约核对：`web/test/ApiCatalog.test.ts` 把本目录全部 `*Routes.kt` 视为挂在 `/api` 之下逐条比对。
 */
fun Route.agentApiRoutes(
    database: Database,
    homeDirectory: Path,
    agentConnection: AgentConnection?,
    profileStore: AgentProfileStore?,
) {
        // ===== AI 自定义接入面 `/api/agent/*` =====
        // 这一组是「用户自定义接入」的承载面：基础框架只立下稳固钩子，真正接哪种模型、
        // 连哪个地址完全交给用户在 `agent-profiles.json` 里配、或运行时 POST 注册。框架默认只带本地 stub。
        route("agent") {
            get("manifest") {
                // 只读清单，不写库，无需同源写门。
                // manifest 的 enabled 由真实档案里是否存在外部连接决定（非仅 -Dai.debug 的占位句柄）。
                call.agentManifest(homeDirectory, profileStore, agentConnection)
            }
            get("connections") {
                // 只读列出当前连接，不写库，无需同源写门。
                call.agentListConnections(homeDirectory, profileStore)
            }
            post("connections") {
                // 写：登记/更新一个外部连接（落盘 agent-profiles.json），需同源写门防 CSRF。
                if (!call.requireSameOriginWrite()) return@post
                call.agentCreateConnection(homeDirectory, profileStore)
            }
            delete("connections/{id}") {
                // 写：删除一个用户连接，需同源写门防 CSRF。
                if (!call.requireSameOriginWrite()) return@delete
                val id = call.parameters["id"] ?: ""
                call.agentDeleteConnection(id, homeDirectory, profileStore)
            }
            post("models") {
                // 只读探针：拿用户填的 baseUrl / key 去 GET {base}/v1/models，把可选模型名回给界面。
                // 不写库、不保存 key，与 sources/validate 同一条口径：会外呼，但不改本机状态。
                call.agentListModels()
            }
            post("sources") {
                // 写：新建/覆盖书源（落库），需同源写门防 CSRF。
                if (!call.requireSameOriginWrite()) return@post
                call.agentCreateSource(database)
            }
            post("sources/validate") {
                // 只读探针：仅校验书源合法性，不落库，无需同源写门。
                call.agentValidateSource()
            }
            post("comprehend") {
                // 只读：文章阅读理解（本地抽取 or 外部模型）。直接委派给网关 AgentConnection，
                // 由网关决定走外部模型还是回退本地，不在此另写一份逻辑。不落库，无需同源写门。
                call.agentComprehend(agentConnection)
            }
            post("chat") {
                // 只读：自由对话（多轮），把 messages 数组直接交给外部模型，缺连接/失败回退本地说明。
                // 不落库，无需同源写门。
                call.agentChat(agentConnection)
            }
            post("chat/stream") {
                // 只读：流式对话（SSE）。事件序列 start/delta/tool_start/tool_end/usage/end/error。
                // 不落库；客户端断开即取消生产者，不继续烧模型额度。
                call.agentChatStream(agentConnection)
            }
            get("skills") {
                // 只读：技能库（内置 + 用户）。不写库，无需同源写门。
                call.agentListSkills(agentConnection)
            }
            post("skills") {
                // 写：新建/覆盖一个技能（落盘 agent-skills/*.md），需同源写门防 CSRF。
                if (!call.requireSameOriginWrite()) return@post
                call.agentSaveSkill(agentConnection)
            }
            delete("skills/{id}") {
                // 写：删除用户技能（移入 .trash），需同源写门防 CSRF。
                if (!call.requireSameOriginWrite()) return@delete
                val id = call.parameters["id"] ?: ""
                call.agentDeleteSkill(id, agentConnection)
            }
            get("prompts") {
                // 只读：提示词预设清单（开关 + 排序）。不写库，无需同源写门。
                call.agentListPrompts(agentConnection)
            }
            post("prompts") {
                // 写：新建/覆盖一条提示词预设（落盘 agent-prompts.json），需同源写门防 CSRF。
                if (!call.requireSameOriginWrite()) return@post
                call.agentSavePrompt(agentConnection)
            }
            delete("prompts/{id}") {
                // 写：删除一条预设（删前整份文件备份进 .trash），需同源写门防 CSRF。
                if (!call.requireSameOriginWrite()) return@delete
                val id = call.parameters["id"] ?: ""
                call.agentDeletePrompt(id, agentConnection)
            }
            get("task-models") {
                // 只读：按任务选模型的路由表（对话 / 摘要 / 每条技能）。不写库，无需同源写门。
                call.agentListTaskModels(homeDirectory, profileStore)
            }
            get("mcp") {
                // 只读：已登记的 MCP 服务 + 上一次同步结果。不写库，无需同源写门。
                call.agentListMcp(homeDirectory, agentConnection)
            }
            post("mcp") {
                // 写：登记/更新一台 MCP 服务（落盘 agent-mcp.json 并立即尝试连接），需同源写门防 CSRF。
                if (!call.requireSameOriginWrite()) return@post
                call.agentSaveMcp(homeDirectory, agentConnection)
            }
            post("mcp/refresh") {
                // 写：重新握手并拉取全部服务的工具清单（会外呼，改的是注册表），需同源写门。
                if (!call.requireSameOriginWrite()) return@post
                call.agentRefreshMcp(homeDirectory, agentConnection)
            }
            delete("mcp/{id}") {
                // 写：删掉一台 MCP 服务并摘掉它注册的工具，需同源写门防 CSRF。
                if (!call.requireSameOriginWrite()) return@delete
                val id = call.parameters["id"] ?: ""
                call.agentDeleteMcp(id, homeDirectory, agentConnection)
            }
            post("task-models") {
                // 写：改一项任务路由（落盘 agent-task-models.json），需同源写门防 CSRF。
                if (!call.requireSameOriginWrite()) return@post
                call.agentSaveTaskModel(homeDirectory, profileStore)
            }
        }
}


