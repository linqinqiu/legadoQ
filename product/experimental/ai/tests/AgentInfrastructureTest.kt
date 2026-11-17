package io.legado

import io.legado.ai.Agent
import io.legado.ai.AgentContext
import io.legado.ai.AgentResult
import io.legado.ai.BuiltinTools
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 框架基础设施三件套的判据：工具注册表 / 生命周期钩子 / 接入开关。
 *
 * 这一组测的是「提供更多可能」是否真的立住了 —— 外部能不能不改框架源码就
 * 注册工具、挂钩子、开接入点。测的是基础设施本身，不是某个具体业务工具。
 */
class AgentInfrastructureTest {

    private fun tempDb(): String = Files.createTempFile("legado-infra-test", ".sqlite").toString()
    private fun tempDir(tag: String) = Files.createTempDirectory("legado-infra-$tag")

    private fun buildAgent(
        dbPath: String,
        registry: ToolRegistry? = null,
        hooks: ToolHooks? = null,
    ): Pair<Database, Agent> {
        val database = Database(dbPath).apply { initialize() }
        val runner = RuleRunner(database = database)
        val coverCache = CoverCache(directory = tempDir("covers"), cookieFor = { database.getCookieForUrl(it) })
        val ctx = AgentContext(
            database = database,
            runner = runner,
            debugger = SourceDebugger(runner),
            health = SourceHealth(runner),
            subscriptions = SubscriptionService(database) { },
            coverCache = coverCache,
        )
        val agent = Agent(
            ctx = ctx,
            homeDirectory = tempDir("home"),
            registry = registry ?: ToolRegistry(),
            hooks = hooks ?: ToolHooks(),
        )
        return database to agent
    }

    private fun cleanup(path: String) {
        runCatching { Files.deleteIfExists(java.nio.file.Path.of(path)) }
    }

    /** 造一个不碰库的演示工具：把收到的 args 原样回显。 */
    private fun echoTool(id: String, group: String = "demo", writes: Boolean = false): Tool =
        Tool { _, args -> AgentResult(status = "ok", code = "ok", message = "echo", data = args) }
            .also { it.meta = ToolMeta(id = id, group = group, description = "回显参数", writes = writes) }

    // ========== 一、工具注册表 ==========

    @Test
    fun `注册表 内置工具默认全部在册`() {
        val reg = ToolRegistry()
        val builtinIds = BuiltinTools.all().map { it.meta.id }.toSet()
        assertEquals("内置工具数量应与 BuiltinTools.all() 一致", builtinIds.size, reg.size())
        assertTrue("内置 id 应能查到", reg.find("source.list") != null)
        assertTrue("source.list 应被标记为内置", reg.isBuiltin("source.list"))
    }

    @Test
    fun `注册表 外部能注册自己的工具并被 runTool 调到`() {
        val path = tempDb()
        try {
            val reg = ToolRegistry()
            val before = reg.size()
            assertTrue("首次注册应成功", reg.register(echoTool("demo.echo")))
            assertEquals("注册后数量 +1", before + 1, reg.size())

            val (db, agent) = buildAgent(path, registry = reg)
            runBlocking {
                val res = agent.runTool("demo.echo", mapOf("hello" to "world"))
                assertEquals("ok", res.status)
                assertEquals("外部注册的工具应真的被执行到", "echo", res.message)
                @Suppress("UNCHECKED_CAST")
                val data = res.data as? Map<String, Any?>
                assertEquals("world", data?.get("hello"))
            }
            db.close()
        } finally {
            cleanup(path)
        }
    }

    @Test
    fun `注册表 重复 id 默认拒绝覆盖 显式 replace 才覆盖`() {
        val reg = ToolRegistry()
        assertTrue(reg.register(echoTool("demo.dup")))
        assertFalse("同 id 再注册应被拒（防两个来源互相踩）", reg.register(echoTool("demo.dup")))
        assertTrue("显式 replace=true 才允许覆盖", reg.register(echoTool("demo.dup", group = "demo2"), replace = true))
        assertEquals("覆盖后仍只有一个", "demo2", reg.find("demo.dup")?.meta?.group)
    }

    @Test
    fun `注册表 内置工具默认删不掉 外部工具删得掉`() {
        val reg = ToolRegistry()
        assertFalse("默认不许注销内置工具（防插件摘掉核心能力）", reg.unregister("source.delete"))
        assertTrue("内置工具仍在", reg.find("source.delete") != null)

        reg.register(echoTool("demo.temp"))
        assertTrue("自己注册的可以注销", reg.unregister("demo.temp"))
        assertNull("注销后查不到", reg.find("demo.temp"))
    }

    @Test
    fun `注册表 显式允许时才可注销内置工具`() {
        val reg = ToolRegistry(allowRemovingBuiltin = true)
        assertTrue("显式开启后允许注销内置", reg.unregister("source.delete"))
        assertNull(reg.find("source.delete"))
    }

    @Test
    fun `注册表 清单按 id 排序 不随哈希漂移`() {
        val reg = ToolRegistry()
        reg.register(echoTool("zzz.last"))
        reg.register(echoTool("aaa.first"))
        val ids = reg.manifest().map { it.id }
        assertEquals("manifest 必须按 id 排序，否则两次调用顺序不同会像 bug", ids.sorted(), ids)
    }

    @Test
    fun `注册表 没贴 id 的工具不许注册`() {
        val reg = ToolRegistry()
        val noMeta = Tool { ctx, _ -> ctx.error("ok", "x") }
        var threw = false
        try {
            reg.register(noMeta)
        } catch (e: IllegalArgumentException) {
            threw = true
            assertTrue("报错要说清怎么贴 meta", (e.message ?: "").contains("ToolMeta"))
        }
        assertTrue("__unset__ 的工具必须拒绝注册", threw)
    }

    // ========== 二、生命周期钩子 ==========

    @Test
    fun `钩子 before 返回非空即拦截 工具本体不执行`() {
        val path = tempDb()
        try {
            val hooks = ToolHooks()
            var toolRan = false
            val reg = ToolRegistry()
            reg.register(Tool { _, _ ->
                toolRan = true
                AgentResult(status = "ok", message = "should-not-run")
            }.also { it.meta = ToolMeta("demo.blocked", "demo", "会被拦", false) })

            hooks.install(before = { _, _ -> AgentResult(status = "error", code = "rate_limited", message = "太频繁") })

            val (db, agent) = buildAgent(path, registry = reg, hooks = hooks)
            runBlocking {
                val res = agent.runTool("demo.blocked", emptyMap())
                assertEquals("拦截结果应原样返回", "rate_limited", res.code)
                assertFalse("被拦截时工具本体绝不能执行", toolRan)
            }
            db.close()
        } finally {
            cleanup(path)
        }
    }

    @Test
    fun `钩子 before 全放行时工具照常执行`() {
        val path = tempDb()
        try {
            val hooks = ToolHooks()
            hooks.install(before = { _, _ -> null })  // 放行
            val reg = ToolRegistry().apply { register(echoTool("demo.pass")) }
            val (db, agent) = buildAgent(path, registry = reg, hooks = hooks)
            runBlocking {
                val res = agent.runTool("demo.pass", mapOf("k" to "v"))
                assertEquals("放行后应正常执行", "ok", res.status)
                assertEquals("echo", res.message)
            }
            db.close()
        } finally {
            cleanup(path)
        }
    }

    @Test
    fun `钩子 after 能改写结果`() {
        val path = tempDb()
        try {
            val hooks = ToolHooks()
            hooks.install(after = { _, _, result -> result.copy(message = "已被钩子改写") })
            val reg = ToolRegistry().apply { register(echoTool("demo.after")) }
            val (db, agent) = buildAgent(path, registry = reg, hooks = hooks)
            runBlocking {
                val res = agent.runTool("demo.after", emptyMap())
                assertEquals("after 钩子应能改写结果", "已被钩子改写", res.message)
            }
            db.close()
        } finally {
            cleanup(path)
        }
    }

    @Test
    fun `钩子 拦截结果也会经过 after 链 审计看得见`() {
        val path = tempDb()
        try {
            val hooks = ToolHooks()
            var seenByAfter: String? = null
            hooks.install(
                before = { _, _ -> AgentResult(status = "error", code = "forbidden", message = "没授权") },
                after = { _, _, result -> seenByAfter = result.code; null },
            )
            val reg = ToolRegistry().apply { register(echoTool("demo.audit")) }
            val (db, agent) = buildAgent(path, registry = reg, hooks = hooks)
            runBlocking {
                agent.runTool("demo.audit", emptyMap())
                assertEquals("拦截也是一种结果，after 要能看到", "forbidden", seenByAfter)
            }
            db.close()
        } finally {
            cleanup(path)
        }
    }

    @Test
    fun `钩子 onError 在工具抛异常时被回调 且结果已转成 internal_error`() {
        val path = tempDb()
        try {
            val hooks = ToolHooks()
            var captured: AgentResult? = null
            hooks.install(onError = { _, _, _, converted -> captured = converted })
            val reg = ToolRegistry()
            reg.register(Tool { _, _ -> throw IllegalStateException("炸了") }
                .also { it.meta = ToolMeta("demo.boom", "demo", "会抛异常", false) })

            val (db, agent) = buildAgent(path, registry = reg, hooks = hooks)
            runBlocking {
                val res = agent.runTool("demo.boom", emptyMap())
                assertEquals("异常应被兜底成 internal_error", "internal_error", res.code)
                assertNotNull("onError 应被回调", captured)
                assertEquals("回调拿到的就是最终返回那个结果", "internal_error", captured?.code)
            }
            db.close()
        } finally {
            cleanup(path)
        }
    }

    @Test
    fun `钩子 卸载句柄能移除自己`() {
        val hooks = ToolHooks()
        val handle = hooks.install(before = { _, _ -> null })
        assertEquals(1, hooks.size())
        handle.close()
        assertEquals("注销后应清零", 0, hooks.size())
    }

    @Test
    fun `钩子 自己抛异常时工具不执行且返回 hook_failed`() {
        val path = tempDb()
        try {
            val hooks = ToolHooks()
            var toolRan = false
            hooks.install(before = { _, _ -> throw RuntimeException("钩子炸了") })
            val reg = ToolRegistry()
            reg.register(Tool { _, _ -> toolRan = true; AgentResult(status = "ok") }
                .also { it.meta = ToolMeta("demo.hookboom", "demo", "钩子会炸", false) })

            val (db, agent) = buildAgent(path, registry = reg, hooks = hooks)
            runBlocking {
                val res = agent.runTool("demo.hookboom", emptyMap())
                assertEquals("钩子异常要转成 hook_failed", "hook_failed", res.code)
                assertFalse("钩子炸了不能顺手把工具也跑了", toolRan)
            }
            db.close()
        } finally {
            cleanup(path)
        }
    }

    // ========== 三、接入开关 ==========

    @Test
    fun `开关 默认关闭时不改变进程对外面`() {
        // 未设 LEGADO_AI_ENABLED 且未设 -Dai.debug 时，isEnabled 应为 false。
        // 注意：这条在测试进程里跑，若 CI 设了该环境变量会失真 —— 所以只在两个都未设时断言。
        val envOn = System.getenv("LEGADO_AI_ENABLED")?.lowercase() in setOf("1", "true", "yes", "on")
        val propOn = System.getProperty("ai.debug") != null
        if (!envOn && !propOn) {
            assertFalse("两个开关都没设时应为关闭", io.legado.ai.AgentModule.isEnabled())
        }
    }

    @Test
    fun `开关 系统属性 ai_debug 仍然有效 向后兼容`() {
        val prev = System.getProperty("ai.debug")
        try {
            System.setProperty("ai.debug", "1")
            assertTrue("老的 -Dai.debug 用法必须继续有效", io.legado.ai.AgentModule.isEnabled())
        } finally {
            if (prev == null) System.clearProperty("ai.debug") else System.setProperty("ai.debug", prev)
        }
    }

    // ========== 四、三件套合起来：基础设施确实"提供更多可能" ==========

    @Test
    fun `组合 不改框架源码就能加一个新能力并挂审计`() {
        val path = tempDb()
        try {
            val audit = mutableListOf<String>()
            val hooks = ToolHooks()
            hooks.install(
                before = { meta, _ -> audit += "before:${meta.id}"; null },
                after = { meta, _, r -> audit += "after:${meta.id}:${r.code}"; null },
            )
            val reg = ToolRegistry()
            reg.register(Tool { _, args ->
                AgentResult(status = "ok", code = "ok", message = "自定义能力跑了，参数=${args["n"]}")
            }.also { it.meta = ToolMeta("custom.greet", "custom", "外部注册的问候", false) })

            val (db, agent) = buildAgent(path, registry = reg, hooks = hooks)
            runBlocking {
                val res = agent.runTool("custom.greet", mapOf("n" to 42))
                assertEquals("ok", res.status)
                assertTrue("自定义能力应真的执行", (res.message ?: "").contains("自定义能力跑了"))
                assertEquals("审计应看到前后两条", listOf("before:custom.greet", "after:custom.greet:ok"), audit)
                assertTrue("自定义工具应出现在能力清单里", agent.toolManifest().any { it.id == "custom.greet" })
            }
            db.close()
        } finally {
            cleanup(path)
        }
    }

    @Test
    fun `组合 通过 AgentConnection 这条对外句柄也能注册工具并挂钩子`() {
        val path = tempDb()
        try {
            val reg = ToolRegistry()
            val hooks = ToolHooks()
            val (db, agent) = buildAgent(path, registry = reg, hooks = hooks)
            // 外部调用方拿到的是 AgentConnection 而不是 Agent —— 这条测的是那条真实路径。
            val conn = io.legado.ai.AgentConnection(agent)

            conn.registry.register(echoTool("ext.via-conn"))
            assertTrue("经 conn.registry 注册的工具应立刻出现在 manifest 里",
                conn.manifest().any { it.id == "ext.via-conn" })

            var audited = false
            conn.hooks.install(before = { meta, _ ->
                if (meta.id == "ext.via-conn") audited = true
                null
            })

            runBlocking {
                val res = conn.callSuspend("ext.via-conn", mapOf("x" to 1))
                assertEquals("ok", res.status)
                assertTrue("经 conn.hooks 挂的钩子应真的被调用", audited)
            }
            assertEquals("内置工具仍应在册", 55, conn.registry.builtinToolIds().size)
            // 数量对不代表内容对：把"阅读侧必须有的几个"逐个点名，
            // 以后谁把 book.info / shelf.get / progress.get 删了，这里会直接报是哪一个。
            val ids = conn.registry.builtinToolIds()
            for (required in listOf(
                "book.info", "shelf.get", "progress.get", "search.run", "content.run",
                // 阅读器 A I 三件套（清洗/改写/选中行为）与书籍分组 ——
                // 「在对应地点研究」靠它们落地，少一个就退回"只能聊天"。
                "ai.textClean", "ai.textRewrite", "ai.selectTextAction",
                // 分组与进度写入：模型要能自己整理书架、记住读到哪。
                "source.group.list", "source.group.add", "source.group.remove",
                "source.group.assign", "progress.set",
            )) {
                assertTrue("内置工具里缺少 $required（AI 的阅读侧能力不许悄悄消失）", ids.contains(required))
            }
            db.close()
        } finally {
            cleanup(path)
        }
    }
}
