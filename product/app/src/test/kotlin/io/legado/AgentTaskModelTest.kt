package io.legado

import io.legado.ai.Agent
import io.legado.ai.AgentContext
import io.legado.ai.AgentProfileStore
import io.legado.ai.AgentSkillStore
import io.legado.ai.AgentTaskModelStore
import io.legado.ai.LlmMessage
import io.legado.ai.LlmProvider
import io.legado.ai.LlmProviderRegistry
import io.legado.ai.LlmReply
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
import java.nio.file.Path
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 按任务选模型。
 *
 * 判据分两层：
 * - 存储/解析层：路由怎么写、清、以及"指向已删连接"这种烂数据怎么收场；
 * - 调用层：**模型实际收到的 profile.model** 是什么。只看返回码的话，
 *   "路由没生效"与"路由生效了但连接恰好也是那条"长得一模一样。
 */
class AgentTaskModelTest {

    /** 记录每次外呼用的模型名，回复固定文本。 */
    private class RecordingProvider : LlmProvider {
        override val id = "openai-compatible"
        override val displayName = "记录版"
        override val description = "记下每次外呼的模型名"
        val models = mutableListOf<String?>()

        override fun chat(profile: AgentProfileStore.Profile, messages: List<LlmMessage>): String? {
            models += profile.model
            return "收到"
        }

        override fun chatWithTools(
            profile: AgentProfileStore.Profile,
            messages: List<LlmMessage>,
            tools: List<ToolMeta>,
        ): LlmReply {
            models += profile.model
            return LlmReply(content = "收到")
        }
    }

    private fun profile(id: String, model: String, isDefault: Boolean = false) = AgentProfileStore.Profile(
        id = id,
        name = id,
        kind = AgentProfileStore.ProfileKind.OPENAI_COMPATIBLE,
        baseUrl = "http://127.0.0.1:9/v1",
        apiKey = "",
        model = model,
        options = if (isDefault) mapOf("default" to "1") else emptyMap(),
    )

    private fun buildAgent(home: Path, provider: RecordingProvider): Pair<Database, Agent> {
        val db = Database(Files.createTempFile("task-model", ".sqlite").toString()).apply { initialize() }
        val runner = RuleRunner(db)
        val ctx = AgentContext(
            database = db, runner = runner,
            debugger = SourceDebugger(runner), health = SourceHealth(runner),
            subscriptions = SubscriptionService(db) { },
            coverCache = CoverCache(directory = Files.createTempDirectory("tm-cov"), cookieFor = { db.getCookieForUrl(it) }),
        )
        val providers = LlmProviderRegistry().apply { register(provider, replace = true) }
        return db to Agent(ctx, home, registry = ToolRegistry(), providerRegistry = providers, hooks = ToolHooks())
    }

    // ===== 存储层 =====

    @Test
    fun `路由可以只改模型、只改连接，也可以整条清掉`() {
        val home = Files.createTempDirectory("task-model-store")
        val profiles = listOf(profile("cheap", "m-cheap", isDefault = true), profile("strong", "m-strong"))

        assertNull("没配路由时 resolve 返回 null（调用方走默认选择）", AgentTaskModelStore.resolve(home, "chat", profiles))

        AgentTaskModelStore.save(home, "chat", AgentTaskModelStore.Route(model = "m-mini"))
        assertEquals("只写 model：仍走默认连接，只换模型名", "cheap", AgentTaskModelStore.resolve(home, "chat", profiles)?.id)
        assertEquals("m-mini", AgentTaskModelStore.resolve(home, "chat", profiles)?.model)

        AgentTaskModelStore.save(home, "chat", AgentTaskModelStore.Route(connectionId = "strong"))
        assertEquals("只写连接：用那条连接自己的模型", "m-strong", AgentTaskModelStore.resolve(home, "chat", profiles)?.model)

        AgentTaskModelStore.save(home, "chat", AgentTaskModelStore.Route(connectionId = "strong", model = "m-max"))
        assertEquals("两个都写：连接按路由、模型按路由", "m-max", AgentTaskModelStore.resolve(home, "chat", profiles)?.model)
        assertEquals("strong", AgentTaskModelStore.resolve(home, "chat", profiles)?.id)

        AgentTaskModelStore.save(home, "chat", null)
        assertNull("清空后回到默认选择", AgentTaskModelStore.resolve(home, "chat", profiles))
        assertEquals("清空不该留下空壳条目", emptyMap<String, AgentTaskModelStore.Route>(), AgentTaskModelStore.load(home))
    }

    @Test
    fun `路由指向已删连接时整条失效，不把模型名套到别家`() {
        val home = Files.createTempDirectory("task-model-dangling")
        val profiles = listOf(profile("cheap", "m-cheap", isDefault = true))
        AgentTaskModelStore.save(home, "chat", AgentTaskModelStore.Route(connectionId = "gone", model = "deepseek-chat"))

        assertNull(
            "连接没了就必须退回默认选择：把 deepseek-chat 发给 OpenAI 只会得到一个与配置无关的报错",
            AgentTaskModelStore.resolve(home, "chat", profiles),
        )
    }

    @Test
    fun `坏文件不让 AI 整体不可用`() {
        val home = Files.createTempDirectory("task-model-broken")
        Files.writeString(home.resolve(AgentTaskModelStore.FILE_NAME), "{ 这不是 json")
        assertEquals("读不出来就是空表", emptyMap<String, AgentTaskModelStore.Route>(), AgentTaskModelStore.load(home))
        assertNull(AgentTaskModelStore.resolve(home, "chat", listOf(profile("a", "m"))))
    }

    @Test
    fun `任务 id 由命中技能决定`() {
        val none = AgentTaskModelStore.taskForSkills(emptyList())
        assertEquals("没有技能命中就是普通对话", AgentTaskModelStore.TASK_CHAT, none)
        val skill = AgentSkillStore.Skill(id = "source-debug", name = "书源排错")
        assertEquals("命中技能时按技能走", "skill:source-debug", AgentTaskModelStore.taskForSkills(listOf(skill)))
    }

    // ===== 调用层：模型实际收到什么 =====

    @Test
    fun `命中技能时用技能任务的路由，普通对话仍用默认连接`() = runBlocking {
        val home = Files.createTempDirectory("task-model-chat")
        AgentProfileStore.register(home, profile("cheap", "m-cheap", isDefault = true))
        AgentProfileStore.register(home, profile("strong", "m-strong"))
        AgentTaskModelStore.save(home, "skill:source-debug", AgentTaskModelStore.Route(connectionId = "strong"))

        val provider = RecordingProvider()
        val (db, agent) = buildAgent(home, provider)

        // 命中「书源排错」的关键词（技能库按关键词自动挑）。
        agent.chat(listOf("user" to "这个书源的目录为空，帮我看看规则"))
        assertEquals("命中技能要走技能任务的连接", "m-strong", provider.models.last())

        agent.chat(listOf("user" to "你好"))
        assertEquals("没有技能命中时仍走默认连接", "m-cheap", provider.models.last())
        db.close()
    }

    @Test
    fun `摘要任务可以单独指定模型`() = runBlocking {
        val home = Files.createTempDirectory("task-model-comprehend")
        AgentProfileStore.register(home, profile("cheap", "m-cheap", isDefault = true))
        AgentTaskModelStore.save(home, AgentTaskModelStore.TASK_COMPREHEND, AgentTaskModelStore.Route(model = "m-summary"))

        val provider = RecordingProvider()
        val (db, agent) = buildAgent(home, provider)

        agent.comprehend("这是一段正文。", null, 1, 3)
        assertEquals("摘要走自己的模型，连接仍是默认那条", "m-summary", provider.models.last())
        db.close()
    }
}
