package io.legado.ai

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import io.legado.BuildInfo

/**
 * 契约自举：把随包的 `agent-api.json` 读进来，作为 AI 视角的"能力清单"。
 *
 * 关键点：AI 看到的端点目录，与 `/api/catalog` 对外部程序发的**是同一份文件、同一个版本号**
 * （[BuildInfo.version]）。这样"程序内部 AI 能做什么"永远跟着真实的 HTTP 表面走，不会自己漂。
 *
 * 这份清单只读，不新增任何对外 HTTP 路由——本模块只是进程内的另一类消费者。
 */
object AgentCatalog {

    private val json = Json { ignoreUnknownKeys = true }

    data class Endpoint(
        val method: String,
        val path: String,
        val group: String,
        val purpose: String,
        val write: Boolean,
        val version: String?,
    )

    fun loadEndpoints(): List<Endpoint> {
        val text = AgentCatalog::class.java.getResourceAsStream("/agent-api.json")
            ?.readBytes()?.decodeToString()
            ?: return emptyList()
        val root = json.parseToJsonElement(text).jsonObject
        val version = root["version"]?.jsonPrimitive?.content
        val array = root["endpoints"]?.jsonArray ?: return emptyList()
        return array.mapNotNull { element ->
            val obj = element.jsonObject
            val method = obj["method"]?.jsonPrimitive?.content ?: return@mapNotNull null
            val path = obj["path"]?.jsonPrimitive?.content ?: return@mapNotNull null
            Endpoint(
                method = method,
                path = path,
                group = obj["group"]?.jsonPrimitive?.content ?: "other",
                purpose = obj["purpose"]?.jsonPrimitive?.content ?: path,
                write = obj["write"]?.jsonPrimitive?.content?.toBoolean() ?: false,
                version = version,
            )
        }
    }

    fun buildContextNote(agentVersion: String = BuildInfo.version): String {
        val endpoints = loadEndpoints()
        val writeCount = endpoints.count { it.write }
        return buildString {
            appendLine("你是运行在 legadoQ 服务进程内部的 AI 助手（版本 $agentVersion）。")
            appendLine("本进程通过 /api/catalog 暴露了 ${endpoints.size} 个端点，其中 $writeCount 个是写操作。")
            appendLine("你能改的东西与界面/脚本通过 HTTP 能改的东西完全一致，没有第二条实现路径。")
            appendLine("你只能调用已注册的工具（见工具清单），不能绕过护栏直接改库。")
        }
    }
}
