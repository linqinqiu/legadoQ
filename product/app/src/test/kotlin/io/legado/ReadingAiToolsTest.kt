package io.legado

import io.legado.ai.Agent
import io.legado.ai.AgentContext
import io.legado.ai.AgentResult
import io.legado.ai.BuiltinTools
import io.legado.cache.CoverCache
import io.legado.data.Database
import io.legado.data.getCookieForUrl
import io.legado.data.getProgress
import io.legado.data.listNotes
import io.legado.data.saveBookshelf
import io.legado.data.saveReplaceRule
import io.legado.data.shelfBook
import io.legado.model.BookGroup
import io.legado.model.BookNote
import io.legado.model.BookshelfWriteRequest
import io.legado.model.ReplaceRule
import io.legado.rules.RuleRunner
import io.legado.source.SourceDebugger
import io.legado.source.SourceHealth
import io.legado.subscription.SubscriptionService
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 0.8.5：阅读器 AI 三件套 + 书籍分组 + 进度写入的行为判据。
 *
 * 背景：用户说「ai 不能在对应地点研究」。
 * 之前 AI 只能看见「你在读第 N 章」，看不见「你选了哪段」，
 * 也整理不了自己的书架（分组、进度）。
 *
 * 这里钉的是**行为**，不是"函数名写对了"：
 * - 清洗要真的按规则改掉文本（不是原样返回）
 * - 选中动作要真的落库（能再查回来）
 * - 分组要真的建出来、书要真的进组、删组后书要回未分组
 * - 进度要真的写进去并能读回来
 */
class ReadingAiToolsTest {

    private fun tempDb(): String = Files.createTempFile("legado-reading-ai", ".sqlite").toString()
    private fun tempDir(tag: String) = Files.createTempDirectory("legado-reading-ai-$tag").toString()

    private fun buildAgent(dbPath: String): Pair<Database, Agent> {
        val database = Database(dbPath).apply { initialize() }
        val runner = RuleRunner(database = database)
        val ctx = AgentContext(
            database = database,
            runner = runner,
            debugger = SourceDebugger(runner),
            health = SourceHealth(runner),
            subscriptions = SubscriptionService(database) { },
            coverCache = CoverCache(directory = java.nio.file.Path.of(tempDir("covers")), cookieFor = { database.getCookieForUrl(it) }),
        )
        return database to Agent(ctx = ctx, homeDirectory = java.nio.file.Path.of(tempDir("home")))
    }

    private fun call(agent: Agent, id: String, args: Map<String, Any?> = emptyMap()): AgentResult =
        runBlocking { agent.runTool(id, args) }

    // ===== 进度写入 =====

    @Test
    fun `progress set 写入后能读回来`() {
        val path = tempDb()
        val (db, agent) = buildAgent(path)
        try {
            val res = call(agent, "progress.set", mapOf(
                "sourceId" to "src-1",
                "bookUrl" to "https://example.com/book/1",
                "chapterUrl" to "https://example.com/book/1/c3",
                "chapterIndex" to 3,
                "scrollPosition" to 0.42,
            ))
            assertEquals("进度写入应成功：${res.code} ${res.message}", "ok", res.status)

            val loaded = db.getProgress("src-1", "https://example.com/book/1")
            assertNotNull("进度应真的落库", loaded)
            assertEquals(3, loaded!!.chapterIndex)
            assertEquals(0.42, loaded.scrollPosition, 0.0001)
        } finally {
            db.close()
        }
    }

    @Test
    fun `progress set 缺 sourceId 或 bookUrl 要报错而不是默默写坏数据`() {
        val path = tempDb()
        val (db, agent) = buildAgent(path)
        try {
            val res = call(agent, "progress.set", mapOf("chapterIndex" to 1))
            assertEquals("error", res.status)
            assertEquals("invalid_request", res.code)
        } finally {
            db.close()
        }
    }

    // ===== 书籍分组 =====

    @Test
    fun `分组 新建后能列出 书能进组 删组后书回未分组`() {
        val path = tempDb()
        val (db, agent) = buildAgent(path)
        try {
            // 1) 建组
            val created = call(agent, "source.group.add", mapOf("name" to "测试分组"))
            assertEquals("建组应成功：${created.code} ${created.message}", "ok", created.status)
            // 返回的是 BookGroup 数据类（id / name / bookCount）
            val group = created.data as? BookGroup
            assertNotNull("建组结果应带 id：${created.data}", group)
            val groupId = group!!.id
            assertTrue("分组 id 必须是正数", groupId > 0)

            // 2) 列表里能看见（返回的是 List<BookGroup>）
            val listed = call(agent, "source.group.list")
            val items = listed.data as? List<*>
            assertTrue(
                "建完组应能在列表里看见：$listed",
                items?.any { (it as? BookGroup)?.name == "测试分组" } == true,
            )

            // 3) 放一本书进书架，再把它归到组里
            db.saveBookshelf(
                BookshelfWriteRequest(
                    sourceId = "src-1",
                    bookUrl = "https://example.com/book/1",
                    name = "测试书",
                    tocUrl = "https://example.com/book/1/toc",
                ),
                cover = null,
            )
            val assigned = call(agent, "source.group.assign", mapOf(
                "sourceId" to "src-1",
                "bookUrl" to "https://example.com/book/1",
                "groupId" to groupId,
            ))
            assertEquals("归组应成功：${assigned.code} ${assigned.message}", "ok", assigned.status)
            assertEquals(groupId, db.shelfBook("src-1", "https://example.com/book/1")?.groupId)

            // 4) 删组：组里的书要回未分组，不能被一起删掉
            val removed = call(agent, "source.group.remove", mapOf("id" to groupId))
            assertEquals("删组应成功：${removed.code} ${removed.message}", "ok", removed.status)
            val after = db.shelfBook("src-1", "https://example.com/book/1")
            assertNotNull("删组不该把书一起删了", after)
            assertEquals("删组后书应回到未分组", 0L, after!!.groupId)
        } finally {
            db.close()
        }
    }

    @Test
    fun `分组 归到不存在的组要报 not_found 而不是悄悄吞掉`() {
        val path = tempDb()
        val (db, agent) = buildAgent(path)
        try {
            val res = call(agent, "source.group.assign", mapOf(
                "sourceId" to "src-1",
                "bookUrl" to "https://example.com/book/1",
                "groupId" to 999999L,
            ))
            assertEquals("error", res.status)
            assertEquals("not_found", res.code)
        } finally {
            db.close()
        }
    }

    @Test
    fun `分组 删不存在的组要说没有`() {
        val path = tempDb()
        val (db, agent) = buildAgent(path)
        try {
            val res = call(agent, "source.group.remove", mapOf("id" to 999999L))
            assertEquals("error", res.status)
            assertEquals("not_found", res.code)
        } finally {
            db.close()
        }
    }

    // ===== 阅读器 A I：清洗 =====

    @Test
    fun `textClean 按净化规则真的把文本改掉`() {
        val path = tempDb()
        val (db, agent) = buildAgent(path)
        try {
            db.saveReplaceRule(
                ReplaceRule(
                    id = "rule-ad",
                    name = "去广告",
                    pattern = "【.*?广告.*?】",
                    replacement = "",
                    isRegex = true,
                    scopeContent = true,
                    isEnabled = true,
                ),
            )

            val text = "正文开始【这是广告】正文结束"
            val res = call(agent, "ai.textClean", mapOf("text" to text, "ruleIds" to listOf("rule-ad")))
            assertEquals("清洗应成功：${res.code} ${res.message}", "ok", res.status)

            @Suppress("UNCHECKED_CAST")
            val data = res.data as? Map<*, *>
            val content = data?.get("content") as? String
            assertNotNull("结果应带 content", content)
            assertFalse("广告应被规则删掉：$content", content!!.contains("广告"))
            assertTrue("正文应保留：$content", content.contains("正文开始"))
            assertEquals("changed 应为 true", true, data?.get("changed"))
        } finally {
            db.close()
        }
    }

    @Test
    fun `textClean 规则不存在时原样返回 不报错`() {
        val path = tempDb()
        val (db, agent) = buildAgent(path)
        try {
            val text = "没有对应规则的正文"
            val res = call(agent, "ai.textClean", mapOf("text" to text, "ruleIds" to listOf("不存在的规则")))
            assertEquals("ok", res.status)
            @Suppress("UNCHECKED_CAST")
            val data = res.data as? Map<*, *>
            assertEquals(text, data?.get("content"))
            assertEquals("没规则可执行就不该说变了", false, data?.get("changed"))
        } finally {
            db.close()
        }
    }

    @Test
    fun `textClean 缺 text 要报错`() {
        val path = tempDb()
        val (db, agent) = buildAgent(path)
        try {
            val res = call(agent, "ai.textClean", mapOf("ruleIds" to listOf("x")))
            assertEquals("error", res.status)
            assertEquals("invalid_request", res.code)
        } finally {
            db.close()
        }
    }

    // ===== 阅读器 A I：选中动作 =====

    @Test
    fun `选中动作 highlight 与 note 要真的落库并能查回来`() {
        val path = tempDb()
        val (db, agent) = buildAgent(path)
        try {
            for (action in listOf("highlight", "note")) {
                val res = call(agent, "ai.selectTextAction", mapOf(
                    "action" to action,
                    "sourceId" to "src-1",
                    "bookUrl" to "https://example.com/book/1",
                    "chapterIndex" to 5,
                    "chapterUrl" to "https://example.com/book/1/c6",
                    "startOffset" to 10,
                    "endOffset" to 20,
                    "excerpt" to "被选中的这一段",
                    "note" to "这一段的批注",
                ))
                assertEquals("$action 应成功：${res.code} ${res.message}", "ok", res.status)
            }

            val notes = db.listNotes("src-1", "https://example.com/book/1")
            assertEquals("两条都该落库", 2, notes.size)
            val saved = notes.first { it.note == "这一段的批注" }
            assertEquals("章节号要落在正确的章", 5, saved.chapterIndex)
            assertEquals(10, saved.startOffset)
            assertEquals("选中的原文要留着", "被选中的这一段", saved.excerpt)
        } finally {
            db.close()
        }
    }

    @Test
    fun `选中动作 delete 要真的删掉那条笔记`() {
        val path = tempDb()
        val (db, agent) = buildAgent(path)
        try {
            val added = call(agent, "ai.selectTextAction", mapOf(
                "action" to "note",
                "sourceId" to "src-1",
                "bookUrl" to "https://example.com/book/1",
                "excerpt" to "要删掉的一段",
                "note" to "临时",
            ))
            assertEquals("ok", added.status)
            // 返回 mapOf("action" to …, "note" to BookNote)
            @Suppress("UNCHECKED_CAST")
            val data = added.data as? Map<*, *>
            val written = data?.get("note") as? BookNote
            assertNotNull("新增结果应带回笔记 id：${added.data}", written)
            assertTrue("笔记 id 必须是正数", written!!.id > 0)

            val deleted = call(agent, "ai.selectTextAction", mapOf("action" to "delete", "noteId" to written.id))
            assertEquals("删除应成功：${deleted.code} ${deleted.message}", "ok", deleted.status)
            assertTrue("删完不该还剩", db.listNotes("src-1", "https://example.com/book/1").isEmpty())
        } finally {
            db.close()
        }
    }

    @Test
    fun `选中动作 不支持的动作要说清楚 别默默成功`() {
        val path = tempDb()
        val (db, agent) = buildAgent(path)
        try {
            val res = call(agent, "ai.selectTextAction", mapOf("action" to "explode", "sourceId" to "s", "bookUrl" to "b"))
            assertEquals("error", res.status)
            assertEquals("invalid_action", res.code)
        } finally {
            db.close()
        }
    }

    @Test
    fun `选中动作 缺 sourceId 或 bookUrl 要报错`() {
        val path = tempDb()
        val (db, agent) = buildAgent(path)
        try {
            val res = call(agent, "ai.selectTextAction", mapOf("action" to "note"))
            assertEquals("error", res.status)
            assertEquals("invalid_request", res.code)
        } finally {
            db.close()
        }
    }

    // ===== 阅读器 A I：改写 =====

    @Test
    fun `textRewrite 把原文与目的带回去 供模型改写`() {
        val path = tempDb()
        val (db, agent) = buildAgent(path)
        try {
            val res = call(agent, "ai.textRewrite", mapOf(
                "text" to "要改写的一段正文",
                "purpose" to "更简洁",
                "length" to "short",
            ))
            assertEquals("ok", res.status)
            @Suppress("UNCHECKED_CAST")
            val data = res.data as? Map<*, *>
            assertEquals("更简洁", data?.get("purpose"))
            val content = data?.get("content") as? String
            assertNotNull(content)
            assertTrue("原文要带给模型：$content", content!!.contains("要改写的一段正文"))
        } finally {
            db.close()
        }
    }

    @Test
    fun `textRewrite 缺 text 要报错`() {
        val path = tempDb()
        val (db, agent) = buildAgent(path)
        try {
            val res = call(agent, "ai.textRewrite", mapOf("purpose" to "x"))
            assertEquals("error", res.status)
            assertEquals("invalid_request", res.code)
        } finally {
            db.close()
        }
    }

    // ===== 契约：新工具都在册且分组正确 =====

    @Test
    fun `新工具都在册且写工具被正确标记`() {
        val byId = BuiltinTools.all().associateBy { it.meta.id }

        for (id in listOf(
            "ai.textClean", "ai.textRewrite", "ai.selectTextAction",
            "source.group.list", "source.group.add", "source.group.remove", "source.group.assign",
            "progress.set",
        )) {
            assertNotNull("内置工具里缺少 $id", byId[id])
        }

        // 写工具必须被标成 writes=true：护栏据此决定要不要拦。
        assertTrue("选中动作会写库，必须标 writes", byId["ai.selectTextAction"]!!.meta.writes)
        assertTrue("建组会写库，必须标 writes", byId["source.group.add"]!!.meta.writes)
        assertTrue("删组会写库，必须标 writes", byId["source.group.remove"]!!.meta.writes)
        assertTrue("归组会写库，必须标 writes", byId["source.group.assign"]!!.meta.writes)
        assertTrue("写进度会写库，必须标 writes", byId["progress.set"]!!.meta.writes)

        // 读工具不能被标成写：标错会让护栏多问一次确认。
        assertFalse("清洗不改数据，不该标 writes", byId["ai.textClean"]!!.meta.writes)
        assertFalse("改写不改数据，不该标 writes", byId["ai.textRewrite"]!!.meta.writes)
        assertFalse("列分组不改数据，不该标 writes", byId["source.group.list"]!!.meta.writes)
        assertFalse("读进度不改数据，不该标 writes", byId["progress.get"]!!.meta.writes)
    }

    @Test
    fun `新工具的 group 名符合既有面划分`() {
        val byId = BuiltinTools.all().associateBy { it.meta.id }
        // 工具分组 != HTTP 端点分组：reading 是新增的工具面，不影响 /api/catalog 的 142 条。
        assertEquals("reading", byId["ai.textClean"]!!.meta.group)
        assertEquals("reading", byId["ai.textRewrite"]!!.meta.group)
        assertEquals("reading", byId["ai.selectTextAction"]!!.meta.group)
        assertEquals("sources", byId["source.group.list"]!!.meta.group)
        assertEquals("notes", byId["progress.set"]!!.meta.group)
        assertEquals("tts", byId["tts.voices"]!!.meta.group)
        assertEquals("tts", byId["tts.speak"]!!.meta.group)
        assertEquals("backup", byId["backup.list"]!!.meta.group)
        assertEquals("backup", byId["backup.get"]!!.meta.group)
    }

    // ===== 朗读 / 备份：服务没接时要如实说不，不能假装成功 =====

    @Test
    fun `没接朗读引擎时 tts 工具如实报不可用`() {
        val path = tempDb()
        val (db, agent) = buildAgent(path) // buildAgent 不传 edgeTts
        try {
            for (id in listOf("tts.voices", "tts.speak")) {
                val res = call(agent, id, mapOf("text" to "测试"))
                assertEquals("$id 在没朗读引擎时应报错", "error", res.status)
                assertEquals("$id 的错误码要能让人分清是「没装」还是「合成失败」", "tts_unavailable", res.code)
            }
        } finally {
            db.close()
        }
    }

    @Test
    fun `没接备份区时 backup 工具如实报不可用`() {
        val path = tempDb()
        val (db, agent) = buildAgent(path)
        try {
            for (id in listOf("backup.list", "backup.get")) {
                val res = call(agent, id, mapOf("name" to "x"))
                assertEquals("$id 在没备份区时应报错", "error", res.status)
                assertEquals("backup_unavailable", res.code)
            }
        } finally {
            db.close()
        }
    }

    @Test
    fun `朗读与备份工具都是只读的，不该被标成写库`() {
        val byId = BuiltinTools.all().associateBy { it.meta.id }
        assertFalse("列音色不改数据", byId["tts.voices"]!!.meta.writes)
        assertFalse("合成音频不改库", byId["tts.speak"]!!.meta.writes)
        assertFalse("列备份不改数据", byId["backup.list"]!!.meta.writes)
        assertFalse("读备份不改数据", byId["backup.get"]!!.meta.writes)
    }
}
