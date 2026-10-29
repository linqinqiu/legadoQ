package io.legado

import io.legado.ai.Agent
import io.legado.ai.AgentContext
import io.legado.ai.LlmMessage
import io.legado.ai.LlmProvider
import io.legado.ai.LlmProviderRegistry
import io.legado.ai.OpenAiCompatibleProvider
import io.legado.ai.AgentProfileStore
import io.legado.cache.CoverCache
import io.legado.data.Database
import io.legado.data.getCookieForUrl
import io.legado.rules.RuleRunner
import io.legado.source.SourceDebugger
import io.legado.source.SourceHealth
import io.legado.subscription.SubscriptionService
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * LLM 协议可插拔的判据 —— 「框架牢固」的核心证据。
 *
 * 改造前：`Agent` 里写死 OpenAI 协议（URL 拼 /v1/chat/completions、解析 choices[0]），
 * 想接别家只能改框架源码 —— 那说明框架把"某一家协议"当成了"框架本身"。
 *
 * 改造后：框架只认 [LlmProvider] 形状，`openai-compatible` 只是内置默认实现。
 * 这些判据测的是**框架**：协议能注册、能替换、能卸载，失败不影响调用方。
 */
class LlmProviderFrameworkTest {

    /** 一个假的 provider：不联网，直接回固定文本，用来证明"框架真的走了注册表"。 */
    private class FakeProvider(
        override val id: String,
        private val reply: String? = "来自假 provider 的回复",
    ) : LlmProvider {
        var called = 0
        var lastMessages: List<LlmMessage> = emptyList()
        override val displayName = "假 Provider"
        override val description = "测试用，不联网"
        override fun chat(profile: AgentProfileStore.Profile, messages: List<LlmMessage>): String? {
            called++
            lastMessages = messages
            return reply
        }
    }

    private fun profile(kind: AgentProfileStore.ProfileKind = AgentProfileStore.ProfileKind.OPENAI_COMPATIBLE) =
        AgentProfileStore.Profile(
            id = "test", name = "测试连接", kind = kind,
            baseUrl = "http://127.0.0.1:9/v1", apiKey = "", model = "fake-model", options = emptyMap(),
        )

    // ========== 注册表本身 ==========

    @Test
    fun `注册表 默认含三种协议实现`() {
        val reg = LlmProviderRegistry()
        assertNotNull("默认应有 openai 兼容实现", reg.find("openai-compatible"))
        assertTrue(reg.find("openai-compatible") is OpenAiCompatibleProvider)
        assertTrue("默认应有 Anthropic 实现", reg.find("anthropic") is io.legado.ai.AnthropicProvider)
        assertTrue("默认应有 Responses 实现", reg.find("openai-responses") is io.legado.ai.OpenAiResponsesProvider)
        assertEquals(3, reg.size())
    }

    @Test
    fun `注册表 能注册自己的协议`() {
        val reg = LlmProviderRegistry()
        val fake = FakeProvider("ollama")
        assertTrue("注册应成功", reg.register(fake))
        assertEquals(4, reg.size())
        assertNotNull(reg.find("ollama"))
    }

    @Test
    fun `注册表 重复 id 默认拒绝 显式 replace 才覆盖`() {
        val reg = LlmProviderRegistry()
        assertTrue("首次注册应成功", reg.register(FakeProvider("ollama")))
        assertFalse("同 id 再注册应被拒", reg.register(FakeProvider("ollama", "第二版")))
        assertEquals("被拒时不增加数量", 4, reg.size())
        assertTrue("显式 replace 才覆盖", reg.register(FakeProvider("ollama", "第三版"), replace = true))
        assertEquals("覆盖不增加数量", 4, reg.size())
    }

    @Test
    fun `注册表 能注销内置实现（provider 不是安全边界）`() {
        val reg = LlmProviderRegistry()
        assertTrue(reg.unregister("openai-compatible"))
        assertNull(reg.find("openai-compatible"))
        assertEquals(2, reg.size())
    }

    @Test
    fun `注册表 列表按 id 排序 稳定`() {
        val reg = LlmProviderRegistry()
        reg.register(FakeProvider("zzz"))
        reg.register(FakeProvider("aaa"))
        val ids = reg.all().map { it.id }
        assertEquals(ids.sorted(), ids)
    }

    @Test
    fun `注册表 按档案 kind 挑 provider 找不到时回退默认档`() {
        val reg = LlmProviderRegistry()
        reg.register(FakeProvider("ollama"))
        // kind=openai-compatible → 默认档
        assertEquals("openai-compatible", reg.forProfile(profile())?.id)
        // 一个 provider 都没有时返回 null（调用方据此回退本地）
        reg.unregister("openai-compatible")
        reg.unregister("ollama")
        assertNull("一个 provider 都没有时应返回 null", reg.forProfile(profile()))
    }

    // ========== 框架真的走了注册表 ==========

    @Test
    fun `框架 换成假 provider 后 chat 走的是它 不是硬编码协议`() {
        val db = Database(Files.createTempFile("llm-frame", ".sqlite").toString()).apply { initialize() }
        val home = Files.createTempDirectory("llm-home")
        try {
            val runner = RuleRunner(db)
            val ctx = AgentContext(
                database = db, runner = runner,
                debugger = SourceDebugger(runner), health = SourceHealth(runner),
                subscriptions = SubscriptionService(db) { },
                coverCache = CoverCache(directory = Files.createTempDirectory("llm-cov"), cookieFor = { db.getCookieForUrl(it) }),
            )
            val fake = FakeProvider("openai-compatible", "假 provider 说的话")
            val providers = LlmProviderRegistry().apply { register(fake, replace = true) }
            val agent = Agent(ctx, home, providerRegistry = providers)

            // 让档案里有一条外部连接（指向不可达地址，但假 provider 不联网）
            AgentProfileStore.register(home, AgentProfileStore.Profile(
                id = "fake", name = "假连接", kind = AgentProfileStore.ProfileKind.OPENAI_COMPATIBLE,
                baseUrl = "http://127.0.0.1:9/v1", apiKey = "", model = "m", options = emptyMap(),
            ))

            val out = kotlinx.coroutines.runBlocking { agent.chat(listOf("user" to "你好")) }
            assertEquals("应走假 provider", "external:fake", out.engine)
            assertEquals("回复应来自假 provider，而不是真发 HTTP", "假 provider 说的话", out.content)
            assertTrue("假 provider 应被调用过", fake.called > 0)
            assertEquals("消息应原样传下去", "你好", fake.lastMessages.last().content)
        } finally {
            runCatching { db.close() }
        }
    }

    @Test
    fun `框架 provider 返回 null 时回退本地 不抛异常`() {
        val db = Database(Files.createTempFile("llm-null", ".sqlite").toString()).apply { initialize() }
        val home = Files.createTempDirectory("llm-home2")
        try {
            val runner = RuleRunner(db)
            val ctx = AgentContext(
                database = db, runner = runner,
                debugger = SourceDebugger(runner), health = SourceHealth(runner),
                subscriptions = SubscriptionService(db) { },
                coverCache = CoverCache(directory = Files.createTempDirectory("llm-cov2"), cookieFor = { db.getCookieForUrl(it) }),
            )
            val providers = LlmProviderRegistry().apply { register(FakeProvider("openai-compatible", null), replace = true) }
            val agent = Agent(ctx, home, providerRegistry = providers)
            AgentProfileStore.register(home, AgentProfileStore.Profile(
                id = "dead", name = "连不上", kind = AgentProfileStore.ProfileKind.OPENAI_COMPATIBLE,
                baseUrl = "http://127.0.0.1:9/v1", apiKey = "", model = "m", options = emptyMap(),
            ))

            val out = kotlinx.coroutines.runBlocking { agent.chat(listOf("user" to "你好")) }
            assertEquals("拿不到就该明确报错，不再本地兜底", "unavailable", out.engine)
            assertEquals("upstream_unreachable", out.error)
            assertEquals("不该伪造回答", "", out.content)
        } finally {
            runCatching { db.close() }
        }
    }

    @Test
    fun `框架 provider 抛异常时被兜住 视为失败`() {
        val db = Database(Files.createTempFile("llm-boom", ".sqlite").toString()).apply { initialize() }
        val home = Files.createTempDirectory("llm-home3")
        try {
            val runner = RuleRunner(db)
            val ctx = AgentContext(
                database = db, runner = runner,
                debugger = SourceDebugger(runner), health = SourceHealth(runner),
                subscriptions = SubscriptionService(db) { },
                coverCache = CoverCache(directory = Files.createTempDirectory("llm-cov3"), cookieFor = { db.getCookieForUrl(it) }),
            )
            val boom = object : LlmProvider {
                override val id = "openai-compatible"
                override val displayName = "会炸"
                override val description = "x"
                override fun chat(profile: AgentProfileStore.Profile, messages: List<LlmMessage>): String? =
                    throw RuntimeException("provider 炸了")
            }
            val providers = LlmProviderRegistry().apply { register(boom, replace = true) }
            val agent = Agent(ctx, home, providerRegistry = providers)
            AgentProfileStore.register(home, AgentProfileStore.Profile(
                id = "boom", name = "会炸", kind = AgentProfileStore.ProfileKind.OPENAI_COMPATIBLE,
                baseUrl = "http://127.0.0.1:9/v1", apiKey = "", model = "m", options = emptyMap(),
            ))

            val out = kotlinx.coroutines.runBlocking { agent.chat(listOf("user" to "你好")) }
            assertEquals("provider 炸了也要明确报错，不能把链路带走", "unavailable", out.engine)
            assertEquals("upstream_unreachable", out.error)
        } finally {
            runCatching { db.close() }
        }
    }

    @Test
    fun `框架 没有任何外部连接时不调 provider`() {
        val db = Database(Files.createTempFile("llm-none", ".sqlite").toString()).apply { initialize() }
        val home = Files.createTempDirectory("llm-home4")
        try {
            val runner = RuleRunner(db)
            val ctx = AgentContext(
                database = db, runner = runner,
                debugger = SourceDebugger(runner), health = SourceHealth(runner),
                subscriptions = SubscriptionService(db) { },
                coverCache = CoverCache(directory = Files.createTempDirectory("llm-cov4"), cookieFor = { db.getCookieForUrl(it) }),
            )
            val fake = FakeProvider("openai-compatible")
            val providers = LlmProviderRegistry().apply { register(fake, replace = true) }
            val agent = Agent(ctx, home, providerRegistry = providers)

            val out = kotlinx.coroutines.runBlocking { agent.chat(listOf("user" to "你好")) }
            assertEquals("没有连接就该明确不可用", "unavailable", out.engine)
            assertEquals("no_connection", out.error)
            assertEquals("不该调用 provider", 0, fake.called)
        } finally {
            runCatching { db.close() }
        }
    }
}
