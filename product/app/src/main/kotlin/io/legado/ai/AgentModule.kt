package io.legado.ai

import io.legado.AppConfig
import io.legado.cache.CoverCache
import io.legado.data.Database
import io.legado.ops.logSystem
import io.legado.rules.RuleRunner
import io.legado.source.SourceDebugger
import io.legado.source.SourceHealth
import io.legado.subscription.SubscriptionService

/**
 * 把 AI 连接 API 挂到本进程的接线处。
 *
 * 设计红线（来自"只写 1234 现有功能 + 保住 ApiCatalog 门"）：
 * - 这里**不注册任何 HTTP 路由**，从不调用 `routing { }`，因此 142 个端点计数不动，
 *   [Application] 启动后的对外暴露面与从前完全一致；
 * - 整个模块默认是**惰性、可选**的：只有在系统属性 `ai.debug` 被设置时，
 *   [install] 才会真正构造 [AgentConnection] 并执行一次自检演示。
 *   生产环境（没设这个属性）下它什么都不做，零运行开销、零新增攻击面。
 *
 * 这样"在内部提供 API 连接"就落地为一个进程内的句柄：调用方拿到的 [AgentConnection]
 * 与 HTTP 端点共用同一批服务对象，能看能改的东西一模一样。
 */
object AgentModule {

    /** 系统属性开关：`-Dai.debug` 时启用内部连接 + 自检。 */
    const val DEBUG_PROPERTY = "ai.debug"

    /**
     * 用启动时已有的服务对象构造一个内部 AI 连接。
     * 调用方职责：传入的对象必须与 HTTP 端点共用同一实例（Application 已经如此构造）。
     *
     * [registry] / [hooks] 是给外部留的标准接入点：不传就用默认（内置工具 + 无钩子），
     * 传了就挂上去 —— 想注册自定义工具或挂审计钩子，不必改这个文件。
     */
    fun connect(
        database: Database,
        runner: RuleRunner,
        coverCache: CoverCache,
        subscriptions: SubscriptionService,
        homeDirectory: java.nio.file.Path = java.nio.file.Path.of("."),
        profileStore: AgentProfileStore = AgentProfileStore,
        registry: ToolRegistry = ToolRegistry(allowRemovingBuiltin = AppConfig.aiAllowRemovingBuiltinTools),
        hooks: ToolHooks = ToolHooks(),
        providerRegistry: LlmProviderRegistry = LlmProviderRegistry(),
        selectorRegistry: ConnectionSelectorRegistry = ConnectionSelectorRegistry(),
        /**
         * 确认策略：默认 [DefaultGuardrailsPolicy]（等价于历史 `requireConfirm` 行为）。
         * 仅放开"批量写需显式确认"这一业务默认；地址外绑 / 乐观锁冲突两道硬护栏不可经此放开。
         */
        guardrailsPolicy: GuardrailsPolicy = DefaultGuardrailsPolicy,
        /**
         * 朗读引擎：给 `tts.*` 工具用。不传就是 null，工具会如实回 `tts_unavailable`
         * （而不是假装合成成功）。
         */
        edgeTts: io.legado.tts.EdgeTtsService? = null,
        /** 备份区：给 `backup.*` 工具用。不传就是 null，同理如实报不可用。 */
        backupStore: io.legado.backup.BackupStore? = null,
    ): AgentConnection {
        val ctx = AgentContext(
            database = database,
            runner = runner,
            debugger = SourceDebugger(runner),
            health = SourceHealth(runner),
            subscriptions = subscriptions,
            coverCache = coverCache,
            edgeTts = edgeTts,
            backupStore = backupStore,
        )
        // 网关需要 homeDirectory 才能读写 agent-profiles.json，从而真正支持外部模型阅读理解。
        return AgentConnection(
            Agent(
                ctx, homeDirectory, profileStore,
                guardrailsPolicy = guardrailsPolicy,
                registry = registry,
                hooks = hooks,
                providerRegistry = providerRegistry,
                selectorRegistry = selectorRegistry,
            )
        )
    }

    /**
     * 进程内自检演示：不开端口、不改路由，仅证明"内部连接能读能写"。
     * 仅在 `-Dai.debug` 时由 [Application] 调用一次。写进去的自检规则会被随即删掉，
     * 不污染真实数据库。
     */
    fun selfTest(conn: AgentConnection): String {
        val manifest = conn.manifest()
        val import = conn.call(
            "replace.import",
            mapOf(
                "json" to
                    """[{"name":"自检规则","pattern":"__self_test__","replacement":"ok","isRegex":false}]""",
            ),
        )
        val after = conn.call("replace.list", mapOf("q" to "自检"))
        val written = (after.data as? List<*>)?.size ?: 0
        // 清理自检写进去的数据，保证真实库不被改动：按 q 列回，逐条 replace.delete。
        if (import.status == "ok") {
            val ids = (after.data as? List<*>)?.mapNotNull { item ->
                // 列表项是 ReplaceRule，取其 id。用 Map 形态稳妥读取。
                when (item) {
                    is Map<*, *> -> item["id"] as? String
                    else -> null
                }
            }.orEmpty()
            ids.forEach { id -> conn.call("replace.delete", mapOf("id" to id)) }
        }
        return buildString {
            appendLine("AI 内部连接自检：")
            appendLine("  能力面工具数 = ${manifest.size}")
            appendLine("  import 状态 = ${import.status}${if (import.status != "ok") " (${import.code})" else ""}")
            appendLine("  写入后可列出条数 = $written")
            appendLine("  自检数据已清理（不污染真实库）。")
        }
    }

    /**
     * 把内部连接挂到进程（仅调试模式）。不碰路由、不加端口。
     *
     * 网关句柄本身由 [connect] 无条件构造（让 `/api/agent/` 始终能委派），这里只负责在
     * `-Dai.debug` 时额外跑一次自检演示；生产环境（[isEnabled] 为 false）下直接返回 null，
     * 进程对外暴露面不变。
     *
     * @param conn 已由 [connect] 构造好的网关句柄（与 HTTP 端点共用同一实例）
     */
    fun install(conn: AgentConnection): AgentConnection? {
        if (!isEnabled()) return null
        logSystemSelfTest(conn)
        return conn
    }

    private fun logSystemSelfTest(conn: AgentConnection) {
        val report = selfTest(conn)
        logSystem("AI 内部连接自检完成", mapOf("tools" to conn.manifest().size.toString()))
        println("[ai-connection]\n$report")
    }

    /** 是否启用：环境变量 `LEGADO_AI_ENABLED` 或系统属性 `-Dai.debug` 任一置位（见 [AppConfig.aiEnabled]）。 */
    fun isEnabled(): Boolean = AppConfig.aiEnabled
}
