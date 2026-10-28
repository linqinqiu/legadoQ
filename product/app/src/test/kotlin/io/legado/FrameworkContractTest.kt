package io.legado

import io.legado.ai.*
import io.legado.http.RouteCatalog
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.name
import kotlin.io.path.readText

/**
 * 框架契约测试 —— 与 `web/test/ApiCatalog.test.ts` 互为双锁，
 * 并由 Gradle `verifyFramework` 任务钉进每次 `check`。
 *
 * 它要守住的几条「框架纪律」（不依赖具体实现，只钉形状与不变量）：
 *
 * 1. **协议可插拔、框架不夹带默认协议**：`LlmProviderRegistry` 只内置 `openai-compatible` 一个默认实现，
 *    重复 id 注册被拒绝（返回 false，不抛），外部 provider 用新 id 可正常注册/注销。
 * 2. **连接选择可插拔**：`ConnectionSelectorRegistry` 只内置 `FirstProfileSelector`（首连接优先，
 *    即 AGENTS.md §4 的「已确认正确行为」）；外部策略用命名类可增删，同名类注册被拒。
 * 3. **工具面可插拔、内置工具不可被默认摘掉**：`ToolRegistry` 内置一份 `BuiltinTools.all()`，
 *    外部工具可注册/注销，但内置工具默认拒绝删除（保持框架不被插件悄悄削弱）。
 * 4. **端点计数契约**：随包的 `agent-api.json` 是 144 条端点 / 19 个组，其中 `AI 自定义接入` 组 9 条。
 *    这是与 `http/` 路由文件双向核对的真实数目（见 AGENTS.md §6）。计数随端点增减同步更新：
 *    141（移除插件）→ 143（补全局 Cookie 管理两条）→ 144（连接模型清单探针），见
 *    `web/test/ApiCatalog.test.ts` 同一串注释。
 * 5. **框架容器不注册任何 HTTP 路由**：`plugin/`（纯框架容器）与 `ai/`（内置 AI 接入，类比 `features/`）
 *    都不 import `io.ktor.server.routing`、不出现 `routing {` / `route(` —— 端点只由 `http/` 装配，
 *    因此 144 计数稳定，框架扩展不会凭空多出路由。
 *
 * 注意：本文件只断言「框架形状」，不绑定任何具体业务端点/工具 id；新增内置工具或 provider 时，
 * 只要不破坏上述不变量，本测试照常通过。
 *
 * 注：本仓库统一用 JUnit 4（`junit:junit:4.13.2`，见 `app/build.gradle`），
 * 所以这里用 `org.junit.Test` + `org.junit.Assert`，不用 JUnit 5 的 `@Tag`。
 * 只跑这一条时用 Gradle 的类过滤：`--tests "*FrameworkContractTest"`。
 */
class FrameworkContractTest {

    // ===== 1. LLM 协议层：可插拔 + 不夹带默认协议 =====

    @Test
    fun `LlmProviderRegistry 只内置 openai-compatible 且拒绝重复 id`() {
        val registry = LlmProviderRegistry()

        // 默认只含一个内置实现，且就是 OpenAiCompatibleProvider（类型身份不能漂）。
        assertEquals("默认只应内置一个 provider", 1, registry.size())
        assertTrue(
            "内置 provider 必须是 OpenAiCompatibleProvider",
            registry.find("openai-compatible") is OpenAiCompatibleProvider,
        )

        // 用相同 id 注册应被拒（返回 false），且注册表数量不变 —— 不允许静默覆盖。
        assertFalse(
            "重复 id 注册必须返回 false",
            registry.register(DupIdProvider),
        )
        assertEquals("重复 id 注册后数量不应变化", 1, registry.size())

        // 用新 id 的外部 provider 可正常注册，并能被注销。
        assertTrue("新 id 的 provider 应能注册", registry.register(ExternalOllamaProvider))
        assertEquals(2, registry.size())
        assertNotNull("应能按新 id 找到外部 provider", registry.find("ollama-external"))
        assertTrue("应能注销外部 provider", registry.unregister("ollama-external"))
        assertEquals(1, registry.size())
    }

    // ===== 2. 连接选择层：可插拔 + 首连接优先为默认 =====

    @Test
    fun `ConnectionSelectorRegistry 默认首连接优先且外部策略可增删`() {
        val registry = ConnectionSelectorRegistry()

        // 默认只内置 FirstProfileSelector（首连接优先，已确认正确行为）。
        assertEquals("默认只应内置一个选择器", 1, registry.size())
        assertTrue(
            "内置选择器必须是 FirstProfileSelector",
            registry.find("FirstProfileSelector") is FirstProfileSelector,
        )

        // 命名类（simpleName 非空）可注册；同名类再注册应被拒。
        assertTrue("命名类选择器应能注册", registry.register(MySelector()))
        assertEquals(2, registry.size())
        assertNotNull("应能按类名找到外部选择器", registry.find("MySelector"))
        assertFalse("同名选择器重复注册必须返回 false", registry.register(MySelector()))
        assertEquals(2, registry.size())

        // 外部策略可注销。
        assertTrue("应能注销外部选择器", registry.unregister("MySelector"))
        assertEquals(1, registry.size())
    }

    // ===== 3. 工具层：可插拔 + 内置工具默认不可摘 =====

    @Test
    fun `ToolRegistry 接受外部工具注册且默认拒绝删除内置工具`() {
        val registry = ToolRegistry()
        val before = registry.size()
        assertTrue("应至少含一份内置工具", before > 0)

        // 外部工具（新 id）可注册。
        val external = Tool { ctx, _ -> ctx.error("ok", "contract hello") }.also {
            it.meta = ToolMeta("contract.demo", "demo", "契约测试用外部工具", writes = false)
        }
        assertTrue("外部工具应能注册", registry.register(external))
        assertEquals(before + 1, registry.size())
        assertNotNull("应能按 id 找到外部工具", registry.find("contract.demo"))

        // 内置工具默认拒绝删除（防止插件削弱框架）。
        val builtinId = registry.builtinToolIds().first()
        assertFalse("默认不应能删除内置工具", registry.unregister(builtinId))

        // 外部工具可删除，删后数量回到初始。
        assertTrue("应能注销外部工具", registry.unregister("contract.demo"))
        assertEquals(before, registry.size())
    }

    // ===== 4. 端点计数契约（144 / 19 / 9） =====

    @Test
    fun `agent-api 契约：144 端点、19 组、AI 自定义接入 9 条`() {
        // RouteCatalog 从 classpath 读 /agent-api.json，serve 会补齐 version、count 与 baseUrl。
        val raw = RouteCatalog.serve("0.0.0-contract", "http://127.0.0.1:1234")
        val root = Json.parseToJsonElement(raw).jsonObject
        val endpoints = root["endpoints"]?.jsonArray
            ?: error("agent-api.json 缺少 endpoints 数组")

        // count 字段必须等于实际端点条数（防止手写数字漂移）。
        val declaredCount = root["count"]?.jsonPrimitive?.int
        assertEquals("count 必须等于 endpoints 实际条数", endpoints.size, declaredCount)

        // 全量契约：144 条端点（插件移除后 141，补 Cookie 两条与模型清单探针一条）。
        assertEquals("端点总数必须是 144", 144, endpoints.size)

        // baseUrl 必须按运行时地址注入，不能沿用文件里写死的端口。
        val injectedBase = root["howToConnect"]?.jsonObject?.get("baseUrl")?.jsonPrimitive?.content
        assertEquals("howToConnect.baseUrl 应注入运行时地址", "http://127.0.0.1:1234", injectedBase)

        val groups = endpoints.map { (it as JsonObject)["group"]!!.jsonPrimitive.content }
        // 19 个互不相同的组。
        assertEquals("组数必须是 19", 19, groups.toSet().size)
        // AI 自定义接入组恰好 9 条（含新增的模型清单探针）。
        val aiGroupCount = groups.count { it == "AI 自定义接入" }
        assertEquals("AI 自定义接入 组必须是 9 条", 9, aiGroupCount)
    }

    // ===== 5. 框架容器不注册任何 HTTP 路由 =====

    @Test
    fun `ai 容器不注册 HTTP 路由`() {
        val base = findServerSourceDir()
        val aiDir = base.resolve("ai")

        val violations = mutableListOf<String>()
        violations += scanRouteRegistration(aiDir, "ai")

        assertTrue(
            "框架容器不得注册 HTTP 路由，发现以下疑似路由装配（应只由 http/ 装配）：\n" +
                violations.joinToString("\n"),
            violations.isEmpty(),
        )
    }

    // ===== 辅助：外部契约桩 =====

    /** 与内置 provider 抢同一 id，用于验证「重复 id 被拒」。 */
    private object DupIdProvider : LlmProvider {
        override val id = "openai-compatible"
        override val displayName = "dup"
        override val description = "duplicate id stub"
        override fun chat(
            profile: AgentProfileStore.Profile,
            messages: List<LlmMessage>,
        ): String? = null
    }

    /** 用新 id 的外部 provider 桩。 */
    private object ExternalOllamaProvider : LlmProvider {
        override val id = "ollama-external"
        override val displayName = "Ollama (外部)"
        override val description = "外部 ollama 桩"
        override fun chat(
            profile: AgentProfileStore.Profile,
            messages: List<LlmMessage>,
        ): String? = null
    }

    /** 命名类选择器（simpleName == "MySelector"），用于验证「外部策略可增删、同名被拒」。 */
    private class MySelector : ConnectionSelector {
        override fun select(profiles: List<AgentProfileStore.Profile>) = profiles.firstOrNull()
    }

    // ===== 辅助：目录扫描 =====

    /**
     * 扫描目录下的 .kt 文件，凡是出现 Ktor 路由装配迹象（`import io.ktor.server.routing`、
     * 或 `routing {`、或 `route(`）就记为违规。先剥掉行注释 `//` 与块注释，以免误伤注释里的字面量。
     * 返回「目录标签:文件:行号」清单。
     */
    private fun scanRouteRegistration(dir: Path, label: String): List<String> {
        if (!Files.exists(dir) || !Files.isDirectory(dir)) return emptyList()
        val violations = mutableListOf<String>()
        Files.walk(dir)
            .filter { it.name.endsWith(".kt") }
            .forEach { file ->
                // 先把整段源码里的块注释（含 KDoc /** */ 与 /* */）和行注释 // 剥掉，
                // 否则像 ai/AgentModule.kt 注释里写的「routing {」会被误判成真实路由装配。
                val cleaned = file.readText()
                    .replace(BLOCK_COMMENT, "")
                    .replace(LINE_COMMENT, "")
                cleaned.lineSequence().forEachIndexed { idx, line ->
                    val bad = KTOR_ROUTING_IMPORT.containsMatchIn(line) ||
                        ROUTING_BLOCK.containsMatchIn(line) ||
                        ROUTE_CALL.containsMatchIn(line)
                    if (bad) violations += "$label:${file.name}:${idx + 1}"
                }
            }
        return violations
    }

    private companion object {
        private val KTOR_ROUTING_IMPORT = Regex("""import\s+io\.ktor\.server\.routing""")
        private val ROUTING_BLOCK = Regex("""\brouting\s*\{""")
        private val ROUTE_CALL = Regex("""\broute\s*\(""")
        private val BLOCK_COMMENT = Regex("""(?s)/\*.*?\*/""")
        private val LINE_COMMENT = Regex("""//.*$""", RegexOption.MULTILINE)

        /** 从多种可能的 cwd（模块根 / 仓库根）向上回溯，定位 server 源码根下的 `io/legado/`。 */
        fun findServerSourceDir(): Path {
            val rel = listOf("src", "main", "kotlin", "io", "legado")
            val candidates = sequence {
                val cur = Path.of(System.getProperty("user.dir"))
                // 模块根：src/...
                yield(cur.resolve(rel.joinToString("/")))
                // 仓库根：app/src/...
                yield(cur.resolve((listOf("server") + rel).joinToString("/")))
                var p: Path? = cur
                while (p != null) {
                    yield(p.resolve(rel.joinToString("/")))
                    yield(p.resolve((listOf("server") + rel).joinToString("/")))
                    p = p.parent
                }
            }
            return candidates.firstOrNull { Files.exists(it) && Files.isDirectory(it) }
                ?: Path.of("app/src/main/kotlin/io/legado")
        }
    }
}
