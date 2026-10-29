package io.legado

import io.legado.ai.Agent
import io.legado.ai.AgentContext
import io.legado.ai.AgentProfileStore
import io.legado.ai.AgentPromptStore
import io.legado.ai.AgentSkillStore
import io.legado.ai.AgentStreamEvent
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 提示词预设 + 上下文预算裁剪。
 *
 * 两块都是"看不见的行为"，所以判据必须打在**模型实际收到的那条消息序列**上：
 * 假 provider 把每轮 convo 存下来，断言注入了什么、顺序如何、裁掉了哪几轮。
 * 只看 HTTP 返回码的话，"预设没生效"与"预设生效了但被裁掉了"这两种故障长得一模一样。
 */
class AgentPromptContextTest {

    /** 记录 provider 收到的对话，回复按固定文本走。 */
    private class RecordingProvider(private val reply: String = "收到") : LlmProvider {
        override val id = "openai-compatible"
        override val displayName = "记录版"
        override val description = "把收到的对话存下来"
        val seen = mutableListOf<List<LlmMessage>>()

        override fun chat(profile: AgentProfileStore.Profile, messages: List<LlmMessage>): String? {
            seen += messages
            return reply
        }

        override fun chatWithTools(
            profile: AgentProfileStore.Profile,
            messages: List<LlmMessage>,
            tools: List<ToolMeta>,
        ): LlmReply {
            seen += messages
            return LlmReply(content = reply)
        }
    }

    private fun registerConnection(home: Path) {
        AgentProfileStore.register(home, AgentProfileStore.Profile(
            id = "fake", name = "假模型", kind = AgentProfileStore.ProfileKind.OPENAI_COMPATIBLE,
            baseUrl = "http://127.0.0.1:9/v1", apiKey = "", model = "m", options = emptyMap(),
        ))
    }

    private fun buildAgent(home: Path, provider: RecordingProvider): Pair<Database, Agent> {
        val db = Database(Files.createTempFile("prompt-ctx", ".sqlite").toString()).apply { initialize() }
        val runner = RuleRunner(db)
        val ctx = AgentContext(
            database = db, runner = runner,
            debugger = SourceDebugger(runner), health = SourceHealth(runner),
            subscriptions = SubscriptionService(db) { },
            coverCache = CoverCache(directory = Files.createTempDirectory("pc-cov"), cookieFor = { db.getCookieForUrl(it) }),
        )
        val providers = LlmProviderRegistry().apply { register(provider, replace = true) }
        return db to Agent(ctx, home, registry = ToolRegistry(), providerRegistry = providers, hooks = ToolHooks())
    }

    // ===== 存储层 =====

    @Test
    fun `预设按 order 排序且只取启用的`() {
        val home = Files.createTempDirectory("prompt-store")
        AgentPromptStore.save(home, null, "第二条", "B", enabled = true, order = 5)
        AgentPromptStore.save(home, null, "第一条", "A", enabled = true, order = 1)
        AgentPromptStore.save(home, null, "关掉的", "C", enabled = false, order = 2)

        assertEquals("list 按 order 升序（与名称无关）", listOf("第一条", "关掉的", "第二条"), AgentPromptStore.list(home).map { it.name })
        assertEquals("select 只取启用的，且保持顺序", listOf("第一条", "第二条"), AgentPromptStore.select(home).map { it.name })
    }

    @Test
    fun `同 id 再存是覆盖而不是新增`() {
        val home = Files.createTempDirectory("prompt-store-upsert")
        val first = AgentPromptStore.save(home, null, "结论先行", "旧内容", enabled = true, order = null)
        AgentPromptStore.save(home, first.id, "结论先行", "新内容", enabled = false, order = null)

        val all = AgentPromptStore.list(home)
        assertEquals("同 id 再存应覆盖，不该多出一条", 1, all.size)
        assertEquals("新内容", all[0].instruction)
        assertEquals("改已有条目没传 order 时保持原位", first.order, all[0].order)
        assertFalse("enabled=false 要真的落盘", all[0].enabled)
    }

    @Test
    fun `空名称与空内容被拒`() {
        val home = Files.createTempDirectory("prompt-store-validate")
        assertThrows("空名称必须被拒", IllegalArgumentException::class.java) {
            AgentPromptStore.save(home, null, "  ", "有内容", enabled = true, order = null)
        }
        assertThrows("空内容必须被拒", IllegalArgumentException::class.java) {
            AgentPromptStore.save(home, null, "有名字", "   ", enabled = true, order = null)
        }
    }

    @Test
    fun `预设数量有上限，超了要报错而不是静默丢`() {
        val home = Files.createTempDirectory("prompt-store-cap")
        repeat(AgentPromptStore.MAX_PROMPTS) { i ->
            AgentPromptStore.save(home, "cap-$i", "预设$i", "内容$i", enabled = true, order = null)
        }
        assertEquals(AgentPromptStore.MAX_PROMPTS, AgentPromptStore.list(home).size)
        assertThrows("超出上限必须报错", IllegalArgumentException::class.java) {
            AgentPromptStore.save(home, null, "超出的一条", "内容", enabled = true, order = null)
        }
        // 覆盖已有条目不受上限影响（否则用户改不动最后一条）。
        val saved = AgentPromptStore.save(home, "cap-0", "预设0", "改过了", enabled = true, order = null)
        assertEquals("改过了", saved.instruction)
        assertEquals(AgentPromptStore.MAX_PROMPTS, AgentPromptStore.list(home).size)
    }

    @Test
    fun `删除前整份文件备份进 trash`() {
        val home = Files.createTempDirectory("prompt-store-trash")
        val kept = AgentPromptStore.save(home, "keep", "留着", "留着的内容", enabled = true, order = null)
        val gone = AgentPromptStore.save(home, "gone", "要删", "要删的内容", enabled = true, order = null)
        assertTrue("删除应返回 true", AgentPromptStore.delete(home, gone.id))
        assertFalse("再删同一条返回 false", AgentPromptStore.delete(home, gone.id))

        assertEquals("只剩没删的那条", listOf(kept.id), AgentPromptStore.list(home).map { it.id })
        val trash = home.resolve(".trash")
        val backups = Files.list(trash).use { s ->
            s.filter { it.fileName.toString().startsWith("agent-prompts-") }.map { Files.readString(it) }.toList()
        }
        assertTrue("删一次应留一份整文件备份，实际 ${backups.size}", backups.isNotEmpty())
        val latest = backups.last()
        assertTrue("备份里要能看到被删的那条", latest.contains("要删的内容"))
        assertTrue("备份是删前的整份快照，也该含留下的那条", latest.contains("留着的内容"))
    }

    @Test
    fun `正文超过上限时截断并保留可辨认的开头`() {
        val home = Files.createTempDirectory("prompt-store-truncate")
        val saved = AgentPromptStore.save(
            home, null, "长文", "开".repeat(AgentPromptStore.MAX_INSTRUCTION_CHARS + 500), enabled = true, order = null,
        )
        assertEquals(AgentPromptStore.MAX_INSTRUCTION_CHARS, saved.instruction.length)
        assertTrue("截断保留的是开头", saved.instruction.startsWith("开开"))
    }

    // ===== 注入 =====

    @Test
    fun `注入顺序是 宿主system → 预设 → 技能 → 对话`() {
        val home = Files.createTempDirectory("prompt-inject")
        registerConnection(home)
        AgentPromptStore.save(home, "p1", "结论先行", "先给结论再给理由", enabled = true, order = 1)
        AgentPromptStore.save(home, "p2", "少字", "不要超过 100 字", enabled = true, order = 2)
        AgentPromptStore.save(home, "p3", "关掉的预设", "这条不该出现", enabled = false, order = 3)
        val skill = AgentSkillStore.save(home, "s1", "自定义排错流程", "我自己的排错顺序", listOf("排错"), "先看日志再看规则", true)

        val provider = RecordingProvider()
        val (db, agent) = buildAgent(home, provider)
        try {
            val out = runBlocking {
                agent.chat(listOf("system" to "你是 legadoQ 的内置助手", "user" to "帮我排错一下"))
            }
            assertEquals(1, provider.seen.size)
            val convo = provider.seen[0]
            val systemTexts = convo.filter { it.role == "system" }.map { it.content }

            assertTrue("宿主自己的 system 必须排第一", systemTexts[0].startsWith("你是 legadoQ"))
            assertEquals("两条启用预设按 order 注入，接着才是技能",
                listOf("【提示词：结论先行】", "【提示词：少字】", "【技能：自定义排错流程】"),
                systemTexts.drop(1).map { it.substringBefore("\n") })
            assertTrue("未启用的预设一个字都不该出现", convo.none { it.content.contains("这条不该出现") })
            assertEquals("最后一条仍是用户本轮的原话", "帮我排错一下", convo.last().content)

            assertEquals("回报实际注入的预设 id（按顺序）", listOf("p1", "p2"), out.promptsUsed)
            assertEquals("回报注入的技能 id", listOf(skill.id), out.skillsUsed)
            assertEquals("没到预算就不该裁", 0, out.trimmed)
        } finally { runCatching { db.close() } }
    }

    @Test
    fun `没有预设与技能时对话原样透传`() {
        val home = Files.createTempDirectory("prompt-inject-empty")
        registerConnection(home)
        val provider = RecordingProvider()
        val (db, agent) = buildAgent(home, provider)
        try {
            val out = runBlocking { agent.chat(listOf("user" to "只是问一句")) }
            assertEquals(listOf("user" to "只是问一句"), provider.seen[0].map { it.role to it.content })
            assertNull("没注入任何东西时不该回报空壳字段", out.promptsUsed)
            assertNull(out.skillsUsed)
        } finally { runCatching { db.close() } }
    }

    @Test
    fun `超出注入预算的预设整条不注入`() {
        val home = Files.createTempDirectory("prompt-inject-budget")
        registerConnection(home)
        // 每条都顶到单条上限，凑到超过每轮总预算：放不下的那条必须整条丢掉，不截半句。
        val filler = "字".repeat(AgentPromptStore.MAX_INSTRUCTION_CHARS)
        val slots = Agent.MAX_PROMPT_CHARS / AgentPromptStore.MAX_INSTRUCTION_CHARS // 预算能装几条
        repeat(slots + 2) { i ->
            AgentPromptStore.save(home, "b$i", "预设$i", "${i}号开头" + filler, enabled = true, order = i)
        }

        val provider = RecordingProvider()
        val (db, agent) = buildAgent(home, provider)
        try {
            val out = runBlocking { agent.chat(listOf("user" to "问一句")) }
            val convo = provider.seen[0]
            val injectedNames = convo.filter { it.role == "system" && it.content.startsWith("【提示词：") }
                .map { it.content.substringAfter("【提示词：").substringBefore("】") }
            assertEquals("预算只装得下 $slots 条", (0 until slots).map { "预设$it" }, injectedNames)
            assertTrue("被挡掉的那条一个字都不该出现", convo.none { it.content.contains("${slots}号开头") })
            assertEquals("回报的 ids 必须与实际注入的一致，不能把没注入的说成注入了",
                (0 until slots).map { "b$it" }, out.promptsUsed)
        } finally { runCatching { db.close() } }
    }

    // ===== 预算裁剪 =====

    @Test
    fun `超预算时从最旧的整轮开始丢，system 与最后一条用户消息保留`() {
        val home = Files.createTempDirectory("prompt-trim")
        registerConnection(home)
        val chunk = "长".repeat(3_000)
        val history = mutableListOf("system" to "人设")
        repeat(12) { i ->
            history += "user" to "第${i}问 $chunk"
            history += "assistant" to "第${i}答 $chunk"
        }
        val finalQuestion = "最后这一问 $chunk"
        history += "user" to finalQuestion

        val provider = RecordingProvider()
        val (db, agent) = buildAgent(home, provider)
        try {
            val out = runBlocking { agent.chat(history) }
            val convo = provider.seen[0]
            val total = convo.sumOf { it.content.length }

            assertTrue("裁剪后要落回预算内，实际 $total / ${Agent.MAX_CONTEXT_CHARS}", total <= Agent.MAX_CONTEXT_CHARS)
            assertEquals("system 永远保留", "人设", convo.first().content)
            assertEquals("最后一条用户消息永远保留且不被截断", finalQuestion, convo.last().content)
            assertTrue("确实丢掉了旧轮次", out.trimmed > 0)
            assertEquals("丢掉的条数与少掉的条数对得上", history.size - convo.size, out.trimmed)

            // 保留的必须是**最近的连续几轮**，不能中间掏洞。
            val keptIdx = convo.filter { it.role == "user" }
                .mapNotNull { Regex("第(\\d+)问").find(it.content)?.groupValues?.get(1)?.toInt() }
            assertTrue("至少留下一轮", keptIdx.isNotEmpty())
            assertEquals("留下的轮次连续", keptIdx.size, keptIdx.max() - keptIdx.min() + 1)
            assertEquals("留下的是最新的几轮", 11, keptIdx.max())
            assertTrue("丢的确实是最旧的", keptIdx.min() > 0)
        } finally { runCatching { db.close() } }
    }

    @Test
    fun `只有一轮时宁可超预算也不动用户原话`() {
        val home = Files.createTempDirectory("prompt-trim-single")
        registerConnection(home)
        val huge = "全是废话".repeat(Agent.MAX_CONTEXT_CHARS)
        val provider = RecordingProvider()
        val (db, agent) = buildAgent(home, provider)
        try {
            val out = runBlocking { agent.chat(listOf("user" to huge)) }
            assertEquals("单条超长用户消息不截断", huge, provider.seen[0].single().content)
            assertEquals("也没有东西可裁", 0, out.trimmed)
        } finally { runCatching { db.close() } }
    }

    @Test
    fun `裁剪以整轮为单位，留下的每轮都完整`() {
        val home = Files.createTempDirectory("prompt-trim-pair")
        registerConnection(home)
        val chunk = "工".repeat(3_000)
        val history = mutableListOf("system" to "人设")
        repeat(14) { i ->
            history += "user" to "P${i}Q $chunk"
            history += "assistant" to "P${i}A $chunk"
        }
        history += "user" to "最后一问"

        val provider = RecordingProvider()
        val (db, agent) = buildAgent(home, provider)
        try {
            runBlocking { agent.chat(history) }
            val convo = provider.seen[0]
            val keptQuestions = convo.filter { it.role == "user" }
                .mapNotNull { Regex("P(\\d+)Q").find(it.content)?.groupValues?.get(1) }
            val keptAnswers = convo.filter { it.role == "assistant" }
                .mapNotNull { Regex("P(\\d+)A").find(it.content)?.groupValues?.get(1) }
            assertEquals("每留下一条回答，它对应的那一问也必须还在（不能把一轮拆half）",
                keptQuestions.toSet(), keptAnswers.toSet())
        } finally { runCatching { db.close() } }
    }

    @Test
    fun `流式同样注入预设并在 start 帧回报 prompts 与 trimmed`() {
        val home = Files.createTempDirectory("prompt-stream")
        registerConnection(home)
        AgentPromptStore.save(home, "sp", "口语化", "用口语回答", enabled = true, order = 1)

        val provider = RecordingProvider()
        val (db, agent) = buildAgent(home, provider)
        try {
            val events = mutableListOf<AgentStreamEvent>()
            val out = runBlocking {
                agent.chatStream(messages = listOf("user" to "随便聊聊"), onEvent = { events += it })
            }
            val start = events.first { it.type == "start" }
            assertEquals("start 帧要带上注入的预设", listOf("sp"), start.prompts)
            assertNull("没裁时 trimmed 不出现", start.trimmed)
            assertEquals("结果里也回报", listOf("sp"), out.promptsUsed)
            assertTrue("发给模型的对话里确实有这条预设", provider.seen[0].any { it.content.contains("用口语回答") })
            assertEquals("end 帧回报同样的预设口径", listOf("sp"), events.last { it.type == "end" }.prompts)
        } finally { runCatching { db.close() } }
    }

    @Test
    fun `流式超预算时 start 与 end 都回报裁剪条数`() {
        val home = Files.createTempDirectory("prompt-stream-trim")
        registerConnection(home)
        val chunk = "多".repeat(4_000)
        val history = mutableListOf<Pair<String, String>>()
        repeat(10) { i ->
            history += "user" to "第${i}问 $chunk"
            history += "assistant" to "第${i}答 $chunk"
        }
        history += "user" to "收个尾"

        val provider = RecordingProvider()
        val (db, agent) = buildAgent(home, provider)
        try {
            val events = mutableListOf<AgentStreamEvent>()
            val out = runBlocking {
                agent.chatStream(messages = history, onEvent = { events += it })
            }
            val start = events.first { it.type == "start" }
            assertTrue("start 要报裁掉了多少条，实际 ${start.trimmed}", (start.trimmed ?: 0) > 0)
            assertEquals("end 帧同一口径", start.trimmed, events.last { it.type == "end" }.trimmed)
            assertEquals("结果对象也带上", start.trimmed, out.trimmed)
            assertEquals("最后一条用户消息保留", "收个尾", provider.seen[0].last().content)
        } finally { runCatching { db.close() } }
    }
}
