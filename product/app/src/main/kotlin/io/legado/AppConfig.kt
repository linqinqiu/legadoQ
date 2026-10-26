package io.legado

/**
 * 集中读取"可调阈值"的环境变量。**默认值一律等于改造前源码里的写死值**，
 * 所以不设任何 env 时行为与现在完全一致；只有显式设置才改变。目的：把散落的
 * 魔数变成使用者可自定义的旋钮（开源「支持自定义」），不必改源码重编译。
 *
 * 全部项见 .env.example / app/README.md 的配置表。
 */
object AppConfig {
    private val env: Map<String, String> = System.getenv()

    private fun int(key: String, default: Int): Int = env[key]?.trim()?.toIntOrNull() ?: default
    private fun long(key: String, default: Long): Long = env[key]?.trim()?.toLongOrNull() ?: default
    private fun str(key: String, default: String): String =
        env[key]?.trim()?.takeIf { it.isNotEmpty() } ?: default

    /** Ktor CIO 引擎处理请求与写响应的分组线程数。 */
    val callGroupSize: Int = int("LEGADO_CALL_GROUP_SIZE", 64)

    /** 多书源并发搜索的并发上下限（按 CPU 核数在此区间内取）。 */
    val searchConcurrencyMin: Int = int("LEGADO_SEARCH_CONCURRENCY_MIN", 16)
    val searchConcurrencyMax: Int = int("LEGADO_SEARCH_CONCURRENCY_MAX", 32)

    /** 单次搜索整体截止（毫秒）。 */
    val searchTimeoutMs: Long = long("LEGADO_SEARCH_TIMEOUT_MS", 30_000L)

    /**
     * 同步 `/api/search` 的**总量截止**（毫秒）。
     *
     * 为什么需要它：单源超时管不住整批。`RuleRunner` 用的是阻塞式
     * `HttpClient.send()`，而阻塞调用不响应线程中断 —— 外面套的 `withTimeout`
     * 取消不掉它，慢源会一直占着并发名额。实测 65 个源的样本就能拖过 300 秒。
     *
     * 到点后返回**已经搜到的部分**，并在响应头上如实标出「截断了、搜了多少个」。
     * 不静默：`X-Search-Truncated` / `X-Search-Completed` / `X-Search-Total` 三个头
     * 让调用方分得清"就这么多结果"与"没搜完"。
     *
     * 设为 0 表示不限制（回到旧行为，调用方自己兜超时）。
     */
    val searchTotalTimeoutMs: Long = long("LEGADO_SEARCH_TOTAL_TIMEOUT_MS", 60_000L)

    /**
     * 一次对话里最多让模型调几轮工具。
     *
     * 原来是 `Agent.MAX_TOOL_ROUNDS` 写死的 6。调到可配置不是为了"能改大"，
     * 而是为了**能改小**：接的模型很笨时会反复调同一个工具，把一次对话拖成十几次外呼；
     * 那时要能把它压到 2~3 轮，不必重新编译。
     */
    val aiMaxToolRounds: Int = int("LEGADO_AI_MAX_TOOL_ROUNDS", 6).coerceIn(1, 20)

    /** 单次工具结果塞回模型上下文的字符上限。默认 4000（约 2 KB 中文）。 */
    val aiMaxToolData: Int = int("LEGADO_AI_MAX_TOOL_DATA", 4000).coerceIn(500, 20000)

    /** 整书离线缓存的分片并发数。 */
    val cacheConcurrency: Int = int("LEGADO_CACHE_CONCURRENCY", 4)

    /** SQLite 只读连接池上限。 */
    val dbPoolSize: Int = int("LEGADO_DB_POOL_SIZE", 16)

    /** Edge-TTS 结果缓存条目上限。 */
    val edgeTtsCacheMax: Int = int("LEGADO_EDGE_TTS_CACHE_MAX", 250)

    /**
     * Edge-TTS 握手用的完整 Chromium 版本号（Sec-MS-GEC-Version 与 UA 都据此派生）。
     * 微软改协议时改这里即可，不必重编译——旧值会导致合成静默返回 0 字节。
     */
    val edgeTtsChromiumVersion: String = str("LEGADO_EDGE_TTS_CHROMIUM_VERSION", "143.0.3650.75")

    /** 朗读会话空闲多久回收 / 单会话最长寿命（毫秒）。 */
    val ttsIdleTimeoutMs: Long = long("LEGADO_TTS_IDLE_TIMEOUT_MS", 10 * 60 * 1000L)
    val ttsMaxLifetimeMs: Long = long("LEGADO_TTS_MAX_LIFETIME_MS", 6 * 60 * 60 * 1000L)

    /** 书源订阅自动更新的周期（毫秒）。 */
    val subscriptionUpdateMs: Long = long("LEGADO_SUBSCRIPTION_UPDATE_MS", 6 * 60 * 60 * 1000L)

    /**
     * 单次书源 JS 执行的墙钟上限（毫秒，默 30000）。书源 mainJs/规则是不可信脚本，
     * 一条 `while(true)` 会占死一条工作线程；合法规则都是毫秒级，这个宽上限只砍失控循环。
     */
    val jsTimeoutMs: Long = long("LEGADO_JS_TIMEOUT_MS", 30_000L)

    /** 目录 / 正文分页抓取的最大页数。 */
    val maxTocPages: Int = int("LEGADO_MAX_TOC_PAGES", 40)
    val maxContentPages: Int = int("LEGADO_MAX_CONTENT_PAGES", 30)

    // ———— AI 接入框架（io.legado.ai）————
    //
    // 从前这组能力只有一个开关：系统属性 `-Dai.debug`。想让"进程内 AI 连接"在正式部署里
    // 也能用（而不只是本地自检），就得改启动脚本加 JVM 参数 —— 对一个自托管程序来说太窄。
    // 现在补一条环境变量通道，两者**取或**：任一为真即启用。默认都关，行为与从前一致。

    /**
     * 是否启用 AI 接入框架的进程内自检与对外句柄。
     * `true` / `1` / `yes` / `on` 视为启用（大小写不敏感）；其它值或未设置 = 关闭。
     * 与系统属性 `-Dai.debug` 取或 —— 老用法照常有效。
     *
     * 注意这是 `get()` 计算属性而不是 val：环境变量在进程启动时就定了，但系统属性
     * 可以在运行期改（测试、嵌入式宿主、调试器都会这么干）。写成 val 的话，
     * `object` 初始化那一刻就把结果冻住，之后 `System.setProperty("ai.debug", …)` 完全无效 ——
     * 那会让"向后兼容 -Dai.debug"变成一句假话。
     */
    val aiEnabled: Boolean
        get() = flag("LEGADO_AI_ENABLED") || System.getProperty("ai.debug") != null

    /**
     * 是否允许外部注册的工具**注销内置工具**（默认 false）。
     * 保持 false：插件只能增删自己注册的工具，摘不掉 `source.delete` 这类核心能力。
     * 只有明确知道自己要干什么的部署才该打开。
     */
    val aiAllowRemovingBuiltinTools: Boolean = flag("LEGADO_AI_ALLOW_REMOVING_BUILTIN_TOOLS")

    /**
     * 是否允许把服务绑定到**非回环**地址（默认 false）。
     *
     * 默认拒绝的理由：这台服务不设身份 —— 没有账号、没有 token，写操作唯一的保护是
     * 「浏览器跨站会带 Origin」这一件事。一旦监听 `0.0.0.0`，局域网里任何能访问到这台机器的
     * 东西都能直接读写整库、读走 `agent-profiles.json` 里的明文密钥。
     *
     * 但容器部署又必须绑 `0.0.0.0`（容器内的 127.0.0.1 宿主访问不到），所以留这个显式开关：
     * `LEGADO_ALLOW_EXTERNAL_BIND=1`。打开时会打一条警告日志，把"安全边界已经交给部署方"
     * 这句话说出来，而不是静默放行。
     *
     * 写成 `get()` 而不是 `val`：测试与嵌入式宿主会改环境变量缓存，计算属性才不会被冻住。
     */
    val allowExternalBind: Boolean
        get() = flag("LEGADO_ALLOW_EXTERNAL_BIND")

    /**
     * 是否允许 AI 连接的 `baseUrl` 指向**回环地址**（默认 false）。
     *
     * 为什么需要这个口子：这台软件只跑在本机，而想接的模型也常常就在本机 ——
     * Ollama 默认 `127.0.0.1:11434`、LM Studio 默认 `127.0.0.1:1234/v1`，只有回环地址可填。
     * 闸门一刀切拒掉回环的实际后果是：本机模型接不进来，文档里"任何 openai-compatible 地址都行"
     * 与 provider 自述"支持 Ollama / LM Studio"都成了谎话（内置那 26 条 TXT 规则手工补全角空格
     * 是同一类事：约定只有作者知道，用户看不见）。
     *
     * 放开时守住两条，所以它不是"关掉闸门"：
     * 1. 只放回环（localhost / 127.x / ::1）—— 私网段、CGNAT、链路本地、云元数据照旧拒；
     * 2. 只认**字面**回环、不走 DNS，且**硬拒指向这台服务自己**（见 refusePointingAtSelf）：
     *    本服务对不带 Origin 的请求放行写操作，而 JDK HttpClient 不带 Origin，
     *    能打到自己的 AI 连接等于绕过它唯一的写保护。
     *
     * 设 `LEGADO_AI_ALLOW_LOOPBACK_BASEURL=1` 打开。
     */
    val aiAllowLoopbackBaseUrl: Boolean
        get() = flag("LEGADO_AI_ALLOW_LOOPBACK_BASEURL")

    private fun flag(key: String): Boolean =
        when (env[key]?.trim()?.lowercase()) {
            "1", "true", "yes", "on" -> true
            else -> false
        }
}
