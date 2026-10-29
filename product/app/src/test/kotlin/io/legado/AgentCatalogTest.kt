package io.legado

import io.legado.ai.AgentCatalog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `AgentCatalog` —— 契约自举。
 *
 * 它把随包的 `agent-api.json` 读进来，作为"AI 视角的能力清单"。
 * 这段代码原来**零覆盖**（0/28 行），而它正是 AI 与外部程序共享同一份契约的落点 ——
 * 它读错了，AI 看到的端点清单就与 `/api/catalog` 不一致，而且**不会有任何报错**。
 *
 * 判据分两层：
 * 1. 结构正确：能读出端点、字段齐全、write 标记对；
 * 2. 与权威契约一致：条数等于 `agent-api.json` 的 endpoints 长度、版本号来自同一处。
 */
class AgentCatalogTest {

    @Test
    fun `能读出全部端点，且条数与随包契约一致`() {
        val endpoints = AgentCatalog.loadEndpoints()
        assertTrue("应读到端点，实际 ${endpoints.size} 条", endpoints.isNotEmpty())
        // 权威契约当前是 154 条（web/test/ApiCatalog.test.ts 与 :app:verifyFramework 双重钉住）
        assertEquals("端点条数应与 agent-api.json 一致", 154, endpoints.size)
    }

    @Test
    fun `每条端点的必填字段都不为空`() {
        val endpoints = AgentCatalog.loadEndpoints()
        for (e in endpoints) {
            assertTrue("method 不该为空：$e", e.method.isNotBlank())
            assertTrue("path 不该为空：$e", e.path.isNotBlank())
            assertTrue("path 应以 /api 开头：$e", e.path.startsWith("/api"))
            assertTrue("group 不该为空（缺失时应回落成 other，不是空串）：$e", e.group.isNotBlank())
            assertTrue("purpose 不该为空（缺失时应回落成 path）：$e", e.purpose.isNotBlank())
        }
    }

    @Test
    fun `method 只出现真实 HTTP 方法，且至少有一个写操作`() {
        val endpoints = AgentCatalog.loadEndpoints()
        val allowed = setOf("GET", "POST", "PUT", "DELETE", "PATCH", "WS")
        val bad = endpoints.filter { it.method !in allowed }
        assertEquals("出现了非法 method：${bad.map { it.method }}", emptyList<String>(), bad.map { it.method })
        assertTrue("应存在写操作端点", endpoints.any { it.write })
        assertTrue("也应存在只读端点", endpoints.any { !it.write })
    }

    @Test
    fun `版本号与随包契约同源，不是写死的`() {
        val endpoints = AgentCatalog.loadEndpoints()
        val versions = endpoints.mapNotNull { it.version }.toSet()
        assertEquals("所有端点应共享同一个版本号", 1, versions.size)
        // agent-api.json 里写的是 0.8.3；这里只断言"不是空、不是 unknown"，
        // 不写死具体版本号 —— 否则每次发版都要改这个测试（那正是版本漂移的来源）。
        val v = versions.first()
        assertTrue("版本号不该为空", v.isNotBlank())
        assertTrue("版本号不该是 unknown", v != "unknown")
        assertTrue("版本号应形如 x.y.z，实际 $v", Regex("""^\d+\.\d+\.\d+$""").matches(v))
    }

    @Test
    fun `写操作端点里能看到已知的写接口`() {
        val endpoints = AgentCatalog.loadEndpoints()
        val writes = endpoints.filter { it.write }.map { "${it.method} ${it.path}" }.toSet()
        // 抽几条必然存在的写接口做锚点：它们变了说明契约真的变了，不是这份代码读错了。
        // 注意：`/api/sources` **只有 GET**（列表），新建/覆盖书源是 `PUT /api/sources/{id}`
        // —— 一开始我把 `POST /api/sources` 当锚点，测试当场就红了，正好说明这条判据有用。
        assertTrue("应含 PUT /api/sources/{id}：$writes", writes.contains("PUT /api/sources/{id}"))
        assertTrue("应含 PUT /api/reading-progress", writes.contains("PUT /api/reading-progress"))
        assertTrue("应含 POST /api/agent/sources（AI 组唯一的写操作之一）",
            writes.contains("POST /api/agent/sources"))
    }

    @Test
    fun `只读接口不会被标成写`() {
        val endpoints = AgentCatalog.loadEndpoints()
        val byKey = endpoints.associateBy { "${it.method} ${it.path}" }
        // 这几条是明确的只读：读目录、读能力清单、读正文
        for (key in listOf("GET /api/catalog", "GET /api/agent/manifest", "GET /api/sources")) {
            val e = byKey[key]
            assertNotNull("契约里应有 $key", e)
            assertFalse("$key 不该被标成写操作", e!!.write)
        }
        // 反向：一个明确的写操作必须被标成写
        assertTrue("PUT /api/reading-progress 应标成写", byKey["PUT /api/reading-progress"]!!.write)
    }

    @Test
    fun `buildContextNote 报出的条数与 loadEndpoints 一致`() {
        val endpoints = AgentCatalog.loadEndpoints()
        val note = AgentCatalog.buildContextNote("9.9.9-test")
        assertTrue("应提到版本号", note.contains("9.9.9-test"))
        assertTrue("应报出端点总数 ${endpoints.size}", note.contains("${endpoints.size} 个端点"))
        val writeCount = endpoints.count { it.write }
        assertTrue("应报出写操作数 $writeCount", note.contains("$writeCount 个是写操作"))
        assertTrue("应说明没有第二条实现路径", note.contains("没有第二条实现路径"))
        assertTrue("应说明不能绕过护栏", note.contains("不能绕过护栏"))
    }

    @Test
    fun `默认版本号取构建号而不是写死`() {
        val note = AgentCatalog.buildContextNote()
        // 开发态（classes 目录）BuildInfo.version 是 "dev"，发行版是真实版本号。
        // 两种都接受，但不接受空串。
        assertTrue("默认版本号不该为空", note.contains("版本 "))
        assertFalse("不该出现空版本号", note.contains("版本 ）"))
    }
}
