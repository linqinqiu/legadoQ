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
import io.legado.ai.agentComprehend
import io.legado.ai.agentCreateConnection
import io.legado.ai.agentCreateSource
import io.legado.ai.agentDeleteConnection
import io.legado.ai.agentListConnections
import io.legado.ai.agentManifest
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
        }
}


