package io.legado

import io.legado.ai.Agent
import io.legado.ai.AgentContext
import io.legado.ai.AgentProfileStore
import io.legado.ai.AgentResult
import io.legado.ai.LlmMessage
import io.legado.ai.LlmProvider
import io.legado.ai.LlmProviderRegistry
import io.legado.ai.LlmReply
import io.legado.ai.LlmToolCall
import io.legado.ai.Tool
import io.legado.ai.ToolHooks
import io.legado.ai.ToolMeta
import io.legado.ai.ToolRegistry
import io.legado.cache.CoverCache
import io.legado.data.Database
import io.legado.data.getCookieForUrl
import io.legado.rules.RuleRunner
import io.legado.source.SourceDebugger
import io.legado.source.SourceHealth
import io.legado.subscription.SubscriptionService
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「AI 能完成插件级功能」的判据 —— 模型能真的调用插件注册的工具。
 *
 * 用假 provider 模拟模型行为（第一轮说"我要调工具"，第二轮给结论），
 * 验证框架的**工具调用循环**真的跑通：执行工具 → 回灌结果 → 让模型继续。
 *
 * 这比"模型能不能聊天"重要得多：它意味着装了插件之后，AI 就能用插件的能力，
 * 不需要为每个插件单独写一套 AI 集成。
 */
class AgentToolCallingTest {

    /** 可编排的假 provider：按轮次返回预设回复。 */
    private class ScriptedProvider(
        private val replies: MutableList<LlmReply>,
    ) : LlmProvider {
        override val id = "openai-compatible"
        override val displayName = "编排版"
        override val description = "按剧本回复"
        /** 每次 chatWithTools 收到的工具清单（用于断言工具真的传给了模型）。 */
        val seenTools = mutableListOf<List<ToolMeta>>()
        /** 每次收到的对话（用于断言工具结果被回灌）。 */
        val seenConversations = mutableListOf<List<LlmMessage>>()

        override fun chat(profile: AgentProfileStore.Profile, messages: List<LlmMessage>): String? {
            seenConversations += messages
            return "（收敛答复）"
        }

        override fun chatWithTools(
            profile: AgentProfileStore.Profile,
            messages: List<LlmMessage>,
            tools: List<ToolMeta>,
        ): LlmReply? {
            seenTools += tools
            seenConversations += messages
            return if (replies.isEmpty()) LlmReply(content = "（没有更多剧本）") else replies.removeAt(0)
        }
    }

    private fun buildAgent(
        providers: LlmProviderRegistry,
        registry: ToolRegistry,
        home: java.nio.file.Path,
    ): Pair<Database, Agent> {
        val db = Database(Files.createTempFile("toolcall", ".sqlite").toString()).apply { initialize() }
        val runner = RuleRunner(db)
        val ctx = AgentContext(
            database = db, runner = runner,
            debugger = SourceDebugger(runner), health = SourceHealth(runner),
            subscriptions = SubscriptionService(db) { },
            coverCache = CoverCache(directory = Files.createTempDirectory("tc-cov"), cookieFor = { db.getCookieForUrl(it) }),
        )
        return db to Agent(ctx, home, registry = registry, hooks = ToolHooks(), providerRegistry = providers)
    }

    private fun registerExternal(home: java.nio.file.Path) {
        AgentProfileStore.register(home, AgentProfileStore.Profile(
            id = "fake", name = "假模型", kind = AgentProfileStore.ProfileKind.OPENAI_COMPATIBLE,
            baseUrl = "http://127.0.0.1:9/v1", apiKey = "", model = "m", options = emptyMap(),
        ))
    }

    private fun echoTool(called: MutableList<Map<String, Any?>>): Tool =
        Tool { _, args -> called += args; AgentResult(status = "ok", code = "ok", message = "查到了 3 条") }
            .also { it.meta = ToolMeta("plugin.query", "demo", "插件提供的查询能力", writes = false) }

    @Test
    fun `模型要求调工具时 框架真的执行了插件注册的工具`() {
        val home = Files.createTempDirectory("tc-home1")
        registerExternal(home)
        val called = mutableListOf<Map<String, Any?>>()
        val registry = ToolRegistry().apply { register(echoTool(called)) }
        val providers = LlmProviderRegistry().apply {
            register(ScriptedProvider(mutableListOf(
                LlmReply(content = "", toolCalls = listOf(LlmToolCall("plugin.query", mapOf("q" to "测试")))),
                LlmReply(content = "根据查询结果，有 3 条。"),
            )), replace = true)
        }
        val (db, agent) = buildAgent(providers, registry, home)
        try {
            val out = runBlocking { agent.chat(listOf("user" to "帮我查一下")) }
            assertEquals("插件工具应被真的执行", 1, called.size)
            assertEquals("参数应传到工具", "测试", called[0]["q"])
            assertEquals("最终答复应来自模型", "根据查询结果，有 3 条。", out.content)
            assertNotNull("应记录执行过的工具", out.toolRounds)
            assertEquals(listOf("plugin.query:ok"), out.toolRounds)
        } finally { runCatching { db.close() } }
    }

    @Test
    fun `工具清单会传给模型 —— 插件注册的工具自动可见`() {
        val home = Files.createTempDirectory("tc-home2")
        registerExternal(home)
        val registry = ToolRegistry().apply { register(echoTool(mutableListOf())) }
        val provider = ScriptedProvider(mutableListOf(LlmReply(content = "直接回答")))
        val providers = LlmProviderRegistry().apply { register(provider, replace = true) }
        val (db, agent) = buildAgent(providers, registry, home)
        try {
            runBlocking { agent.chat(listOf("user" to "你好")) }
            assertTrue("应至少问过模型一次", provider.seenTools.isNotEmpty())
            val tools = provider.seenTools.first()
            assertTrue("插件注册的工具应在清单里", tools.any { it.id == "plugin.query" })
            assertTrue("内置工具也应在清单里", tools.any { it.id == "source.list" })
        } finally { runCatching { db.close() } }
    }

    @Test
    fun `工具结果会回灌给模型 —— 它才能基于结果作答`() {
        val home = Files.createTempDirectory("tc-home3")
        registerExternal(home)
        val registry = ToolRegistry().apply { register(echoTool(mutableListOf())) }
        val provider = ScriptedProvider(mutableListOf(
            LlmReply(content = "", toolCalls = listOf(LlmToolCall("plugin.query", emptyMap()))),
            LlmReply(content = "完成"),
        ))
        val providers = LlmProviderRegistry().apply { register(provider, replace = true) }
        val (db, agent) = buildAgent(providers, registry, home)
        try {
            runBlocking { agent.chat(listOf("user" to "查")) }
            assertTrue("应问过两轮以上", provider.seenConversations.size >= 2)
            val secondRound = provider.seenConversations[1]
            assertTrue("第二轮对话里应有工具结果",
                secondRound.any { it.role == "tool" && it.content.contains("plugin.query") })
            assertTrue("工具结果应带工具返回的消息",
                secondRound.any { it.content.contains("查到了 3 条") })
        } finally { runCatching { db.close() } }
    }

    @Test
    fun `工具调用轮数有上限 —— 模型无限要工具不会拖死请求`() {
        val home = Files.createTempDirectory("tc-home4")
        registerExternal(home)
        val registry = ToolRegistry().apply { register(echoTool(mutableListOf())) }
        // 永远要工具，从不停
        val endless = object : LlmProvider {
            override val id = "openai-compatible"
            override val displayName = "无限循环"
            override val description = "永远要工具"
            var rounds = 0
            override fun chat(profile: AgentProfileStore.Profile, messages: List<LlmMessage>): String? = "收敛了"
            override fun chatWithTools(
                profile: AgentProfileStore.Profile,
                messages: List<LlmMessage>,
                tools: List<ToolMeta>,
            ): LlmReply {
                rounds++
                return LlmReply(content = "", toolCalls = listOf(LlmToolCall("plugin.query", emptyMap())))
            }
        }
        val providers = LlmProviderRegistry().apply { register(endless, replace = true) }
        val (db, agent) = buildAgent(providers, registry, home)
        try {
            val out = runBlocking { agent.chat(listOf("user" to "循环")) }
            assertEquals("应停在上限", Agent.MAX_TOOL_ROUNDS, endless.rounds)
            assertNotNull("应记录全部轮次", out.toolRounds)
            assertEquals(Agent.MAX_TOOL_ROUNDS, out.toolRounds!!.size)
            assertEquals("上限后应逼模型收敛", "收敛了", out.content)
        } finally { runCatching { db.close() } }
    }

    @Test
    fun `工具执行失败也回灌 不让对话崩掉`() {
        val home = Files.createTempDirectory("tc-home5")
        registerExternal(home)
        val registry = ToolRegistry() // 没注册那个工具
        val provider = ScriptedProvider(mutableListOf(
            LlmReply(content = "", toolCalls = listOf(LlmToolCall("no.such.tool", emptyMap()))),
            LlmReply(content = "工具不存在，我换个方式回答。"),
        ))
        val providers = LlmProviderRegistry().apply { register(provider, replace = true) }
        val (db, agent) = buildAgent(providers, registry, home)
        try {
            val out = runBlocking { agent.chat(listOf("user" to "调个不存在的")) }
            assertEquals("对话不该崩", "工具不存在，我换个方式回答。", out.content)
            assertEquals("应记录失败的工具", listOf("no.such.tool:unknown_tool"), out.toolRounds)
        } finally { runCatching { db.close() } }
    }

    @Test
    fun `没调工具时 toolRounds 为空 —— 普通对话不受影响`() {
        val home = Files.createTempDirectory("tc-home6")
        registerExternal(home)
        val registry = ToolRegistry()
        val provider = ScriptedProvider(mutableListOf(LlmReply(content = "纯聊天回复")))
        val providers = LlmProviderRegistry().apply { register(provider, replace = true) }
        val (db, agent) = buildAgent(providers, registry, home)
        try {
            val out = runBlocking { agent.chat(listOf("user" to "你好")) }
            assertEquals("纯聊天回复", out.content)
            assertNull("没调工具就不该有 toolRounds", out.toolRounds)
        } finally { runCatching { db.close() } }
    }

    @Test
    fun `插件注册的工具能被 AI 用上 —— 这是插件级功能的闭环`() {
        val home = Files.createTempDirectory("tc-home7")
        registerExternal(home)
        val registry = ToolRegistry()
        // 模拟"插件注册了一个能力"
        registry.register(
            Tool { _, _ -> AgentResult(status = "ok", code = "ok", message = "插件能力执行成功", data = listOf("a", "b")) }
                .also { it.meta = ToolMeta("plugin.capability", "plugin", "插件提供的能力", writes = false) },
        )
        val provider = ScriptedProvider(mutableListOf(
            LlmReply(content = "", toolCalls = listOf(LlmToolCall("plugin.capability", emptyMap()))),
            LlmReply(content = "插件能力已执行"),
        ))
        val providers = LlmProviderRegistry().apply { register(provider, replace = true) }
        val (db, agent) = buildAgent(providers, registry, home)
        try {
            val out = runBlocking { agent.chat(listOf("user" to "用插件能力")) }
            assertEquals("插件能力已执行", out.content)
            assertEquals(listOf("plugin.capability:ok"), out.toolRounds)
        } finally { runCatching { db.close() } }
    }
}
