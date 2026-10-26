package io.legado

import io.legado.ai.Agent
import io.legado.ai.AgentContext
import io.legado.ai.AgentProfileStore
import io.legado.ai.ConnectionSelector
import io.legado.ai.ConnectionSelectorRegistry
import io.legado.ai.LlmProvider
import io.legado.ai.LlmProviderRegistry
import io.legado.ai.LlmReply
import io.legado.ai.ToolHooks
import io.legado.ai.ToolRegistry
import io.legado.cache.CoverCache
import io.legado.data.Database
import io.legado.data.getCookieForUrl
import io.legado.rules.RuleRunner
import io.legado.source.SourceDebugger
import io.legado.source.SourceHealth
import io.legado.subscription.SubscriptionService
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

/**
 * Gap 3 验收：把"连哪个外部连接"抽成可插拔钩子，默认仍取第一个（AGENTS.md §4 的已确认行为）。
 *
 * 两个维度：
 * 1. [ConnectionSelectorRegistry] 本身的逻辑：默认选第一个、自定义策略可替换默认、撤光退化。
 * 2. [Agent] 集成：多连接下默认走第一个；换成自定义 selector 后走第二个——
 *    证明框架只立钩子，决定权真的能交给外部（这正是"只做框架"的落点）。
 *
 * 注：本仓库统一用 JUnit 4（`junit:junit:4.13.2`，见 `app/build.gradle`），
 * 断言的消息参数在**第一个**位置；测试名里也不能出现 `.` / `/` 这类字符。
 */
class ConnectionSelectorTest {

    private val p1 = AgentProfileStore.Profile(
        id = "first", name = "第一个", kind = AgentProfileStore.ProfileKind.OPENAI_COMPATIBLE,
        baseUrl = "http://127.0.0.1:1/v1", model = "m1",
    )
    private val p2 = AgentProfileStore.Profile(
        id = "second", name = "第二个", kind = AgentProfileStore.ProfileKind.OPENAI_COMPATIBLE,
        baseUrl = "http://127.0.0.1:2/v1", model = "m2",
    )

    // ========== 注册表纯逻辑 ==========

    /**
     * 注册表用 `selector::class.simpleName` 当 id（见 ConnectionSelector.kt:62），
     * 而**匿名对象**的 simpleName 是 null —— 用 `object : ConnectionSelector {}` 注册会直接
     * 返回 false。所以桩必须是具名类，这也正是文档里"外部策略用命名类"的实际约束。
     */
    private class SecondSelector : ConnectionSelector {
        override fun select(profiles: List<AgentProfileStore.Profile>) = profiles.getOrNull(1)
    }

    /** 永远返回 null 的策略：验证"选不到就退化取第一个，不凭空造连接"。 */
    private class NullSelector : ConnectionSelector {
        override fun select(profiles: List<AgentProfileStore.Profile>) = null
    }

    @Test
    fun `默认 FirstProfileSelector 取第一个连接`() {
        val reg = ConnectionSelectorRegistry()
        assertEquals("FirstProfileSelector", reg.defaultId())
        assertEquals("first", reg.selected(listOf(p1, p2))!!.id)
        assertEquals("first", reg.selected(listOf(p1))!!.id)
    }

    @Test
    fun `没有连接时 selected 返回 null`() {
        val reg = ConnectionSelectorRegistry()
        assertNull(reg.selected(emptyList()))
    }

    @Test
    fun `匿名对象不能注册 因为 simpleName 为空`() {
        val reg = ConnectionSelectorRegistry()
        val anonymous = object : ConnectionSelector {
            override fun select(profiles: List<AgentProfileStore.Profile>) = profiles.getOrNull(1)
        }
        assertFalse("匿名对象没有 simpleName，注册必须被拒", reg.register(anonymous))
        assertEquals("被拒后注册表大小不变", 1, reg.size())
    }

    @Test
    fun `自定义 selector 注册后 可设为默认 选出第二个`() {
        val reg = ConnectionSelectorRegistry()
        assertTrue(reg.register(SecondSelector()))
        assertTrue(reg.setDefault(SecondSelector::class.simpleName!!))
        assertEquals("second", reg.selected(listOf(p1, p2))!!.id)
    }

    @Test
    fun `默认策略选不到时 退化到第一个 不凭空造连接`() {
        val reg = ConnectionSelectorRegistry()
        assertTrue(reg.register(NullSelector()))
        assertTrue(reg.setDefault(NullSelector::class.simpleName!!))
        // 自定义策略返回 null（极端异常）→ 框架不崩，退化取第一个。
        assertEquals("first", reg.selected(listOf(p1, p2))!!.id)
    }

    // ========== Agent 集成（证明默认行为不变 + 可插拔生效） ==========

    /** 回显所选中连接的 id：provider 拿到的是框架"选好"的那个 profile。 */
    private class EchoProvider : LlmProvider {
        override val id = "openai-compatible"
        override val displayName = "回显"
        override val description = "测试"
        override fun chat(profile: AgentProfileStore.Profile, messages: List<io.legado.ai.LlmMessage>): String? = "echo:${profile.id}"
        override fun chatWithTools(profile: AgentProfileStore.Profile, messages: List<io.legado.ai.LlmMessage>, tools: List<io.legado.ai.ToolMeta>): LlmReply? =
            LlmReply(content = "echo:${profile.id}")
    }

    private fun buildAgent(selectors: ConnectionSelectorRegistry, home: java.nio.file.Path): Pair<Database, Agent> {
        val db = Database(Files.createTempFile("sel", ".sqlite").toString()).apply { initialize() }
        val runner = RuleRunner(db)
        val ctx = AgentContext(
            database = db, runner = runner,
            debugger = SourceDebugger(runner), health = SourceHealth(runner),
            subscriptions = SubscriptionService(db) { },
            coverCache = CoverCache(directory = Files.createTempDirectory("sel-cov"), cookieFor = { db.getCookieForUrl(it) }),
        )
        return db to Agent(ctx, home, registry = ToolRegistry(), hooks = ToolHooks(), providerRegistry = LlmProviderRegistry(listOf(EchoProvider())), selectorRegistry = selectors)
    }

    @Test
    fun `Agent 默认 多连接下走第一个（不改 AGENTS 第 4 节行为）`() {
        val home = Files.createTempDirectory("sel-home1")
        AgentProfileStore.register(home, p1)
        AgentProfileStore.register(home, p2)
        val (db, agent) = buildAgent(ConnectionSelectorRegistry(), home)
        try {
            assertTrue("默认应看到有连接", agent.hasConnection())
            val reply = runBlocking { agent.callLlm("hi") }
            assertEquals("默认必须从第一个连接出去，不能自动顺延", "echo:first", reply)
        } finally { runCatching { db.close() } }
    }

    @Test
    fun `Agent 换成自定义 selector 后 走第二个（钩子可插拔）`() {
        val home = Files.createTempDirectory("sel-home2")
        AgentProfileStore.register(home, p1)
        AgentProfileStore.register(home, p2)
        val selectors = ConnectionSelectorRegistry()
        val secondOnly = SecondSelector()
        selectors.register(secondOnly)
        selectors.setDefault(SecondSelector::class.simpleName!!)
        val (db, agent) = buildAgent(selectors, home)
        try {
            val reply = runBlocking { agent.callLlm("hi") }
            assertEquals("换成自定义 selector 后应走第二个连接", "echo:second", reply)
        } finally { runCatching { db.close() } }
    }
}
