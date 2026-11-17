package io.legado

import io.legado.http.RouteCatalog
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 端点契约的计数判据（原 FrameworkContractTest 的一部分）。
 *
 * 2026-11-17：AI 那一整套挪到 `product/experimental/ai/` 之后，原来那份「框架契约」判据里
 * 大半在测 AI 框架（provider / 工具注册表 / 连接选择器），跟着代码一起搬走了。
 * 留下的这一份只钉**对外契约**这一件事：条数、组数、count 字段自洽、baseUrl 按运行时注入。
 * 它与 `web/test/ApiCatalog.test.ts`（代码路由 ↔ 契约）和 `docs:api-check`（契约 ↔ 文档）三层同源。
 */
class ApiContractTest {

    @Test
    fun `agent-api 契约：条数与组数与随包 JSON 一致`() {
        val raw = RouteCatalog.serve("0.0.0-contract", "http://127.0.0.1:1234")
        val root = Json.parseToJsonElement(raw).jsonObject
        val endpoints = root["endpoints"]?.jsonArray ?: error("agent-api.json 缺少 endpoints 数组")

        // count 字段必须等于实际条数（防手写数字漂移）
        assertEquals("count 必须等于 endpoints 实际条数", endpoints.size, root["count"]?.jsonPrimitive?.int)

        // 2026-11-17：AI 自定义接入那 22 条随代码挪进 product/experimental/ai/ → 166 - 22 = 144。
        assertEquals("端点总数必须是 144", 144, endpoints.size)

        val groups = endpoints.map { it.jsonObject["group"]!!.jsonPrimitive.content }
        assertEquals("组数必须是 18", 18, groups.toSet().size)
        assertEquals("AI 那组已经随代码挪走，不该还在契约里", 0, groups.count { it == "AI 自定义接入" })

        val injectedBase = root["howToConnect"]?.jsonObject?.get("baseUrl")?.jsonPrimitive?.content
        assertEquals("howToConnect.baseUrl 应注入运行时地址", "http://127.0.0.1:1234", injectedBase)
    }
}
