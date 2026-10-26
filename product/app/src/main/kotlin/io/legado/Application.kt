package io.legado

import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.cio.*
import io.ktor.server.engine.*
import io.ktor.server.plugins.*
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.plugins.statuspages.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.sessions.*
import io.ktor.server.websocket.*
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlin.system.exitProcess
import java.nio.file.Files
import io.legado.cache.BookCacheService
import io.legado.cache.CoverCache
import io.legado.data.Database
import io.legado.data.getCookieForUrl
import io.legado.http.SameOriginWriteGate
import io.legado.http.ServerIdentity
import io.legado.http.apiRoutes
import io.legado.http.requireLoopbackBind
import io.legado.model.HealthStatus
import io.legado.ops.LogService
import io.legado.ops.logSystem
import io.legado.rules.RuleRunner
import io.legado.subscription.SubscriptionService
import io.legado.ai.AgentModule
import io.legado.ai.AgentProfileStore
import io.legado.tts.EdgeTtsService
import io.legado.tts.TtsSessionService
import io.legado.model.ApiError

/**
 * 构建并（按需）启动 legadoQ 服务引擎。抽出来是为了让 `main`（裸跑 jar / CDS 归档）和
 * 桌面壳（`DesktopLauncher`）共用同一份启动代码 —— 桌面壳用 `start(wait = false)` 拿到引擎，
 * 自己管生命周期（开浏览器、托盘退出、优雅关闭），而不是把引擎堵在 main 线程上。
 *
 * 停读的客户端会把一个线程整篇压在 socket 的阻塞写上（不是挂起）：实测 24 个"读了 8KB
 * 就不再往下读"的连接，就能让一个无关的 `/healthz` 等 15 秒 —— 表现就是"端口还在听，
 * 服务像死了"。这条现在做成了可重跑的门禁：`tools/verify/stalled-client-check.mjs`。
 *
 * 能调的旋钮是引擎的分组线程数：`callGroupSize` 决定"跑请求处理与写响应"那一组有多大，
 * 默认等于 CPU 核数 —— 也就是说几台停读的浏览器就能把整组占满，连搜索要的算力一起拖死。
 * 给到 64 之后，阻塞写占的是这一组（本来就是为"可能在等"而存在的组），
 * 而 DefaultDispatcher 那批线程留给规则引擎与搜索。
 *
 * 形状上的坑记一笔：`embeddedServer(CIO, host, port) { … }` 那条重载**没有** configure 参数，
 * 尾随 lambda 是 module 而不是引擎配置 —— 要调引擎就得走 environment + configure 这条，
 * 主机端口改由 `connector { }` 给。
 */
fun createLegadoEngine(config: ServerConfig, cdsDump: Boolean = false) = embeddedServer(
    CIO,
    environment = applicationEnvironment(),
    configure = {
        connector { host = config.host; port = config.port }
        callGroupSize = AppConfig.callGroupSize
    },
) {
    // --cds-dump：只为生成 CDS 类归档（tools/make-cds.mjs 用）。服务照常起来，
    // 脚本趁这段时间预热几个接口，然后本进程正常退出 —— 归档由 JVM 的 shutdown hook 写盘。
    legadoApplication(config, cdsDump = cdsDump)
}

fun main(args: Array<String>) {
    val config = ServerConfig.fromEnvironment()
    createLegadoEngine(config, cdsDump = args.contains("--cds-dump")).start(wait = true)
}

fun Application.legadoApplication(config: ServerConfig = ServerConfig.fromEnvironment(), cdsDump: Boolean = false) {
    // 绑定闸门：非回环地址必须显式放行（LEGADO_ALLOW_EXTERNAL_BIND=1），否则直接拒绝启动。
    // 放在最前面：一旦监听 0.0.0.0，整库就已经对局域网开放了，之后再拦请求没有意义。
    val externalBind = requireLoopbackBind(config.host, config.allowExternalBind)
    // 同源闸门比对的是"服务自己是谁"，不是请求头里那个可被 DNS 重绑定摆布的 Host（见 Guard.kt）
    ServerIdentity.init(config.host, config.port)
    // 初始化结构化日志系统
    LogService.initialize(config.databasePath)
    logSystem("legadoQ 服务器启动", mapOf("version" to BuildInfo.version, "host" to config.host, "port" to config.port.toString()))
    if (externalBind) {
        // 放行不等于安全：把"边界已经交给部署方"这句话写进日志，而不是静默运行。
        logSystem(
            "⚠️ 已按 LEGADO_ALLOW_EXTERNAL_BIND=1 绑定到非回环地址",
            mapOf(
                "host" to config.host,
                "warning" to "这台服务不设身份；同源写门只能挡住浏览器跨站请求，挡不住局域网内直连的客户端",
            ),
        )
    }
    
    val database = Database(config.databasePath)
    database.initialize()
    val subscriptions = SubscriptionService(database) { message -> log.info(message) }
    val runner = RuleRunner(database = database)
    // coverCache 要在 bookCache 之前建：离线缓存漫画章节时顺带把图抓进同一个磁盘缓存，
    // 否则离线打开漫画只有 `![图片](url)` 占位、图全裂。
    val coverCache = CoverCache(config.coverCacheDirectory, cookieFor = { database.getCookieForUrl(it) })
    val bookCache = BookCacheService(database, runner, coverCache) { message -> log.info(message) }
    val edgeTts = EdgeTtsService()
    val ttsSessions = TtsSessionService(edgeTts)

    // 内部 AI 连接（网关）句柄：无条件构造，让 `/api/agent/*` 始终能委派阅读理解/外部模型。
    // 它不注册任何路由、不开端口（路由仍由 Routes.kt 字面登记，ApiCatalog 门禁数量不变）；
    // `-Dai.debug` 下只是额外跑一次自检演示，不改变生产运行面。
    val agentConnection = AgentModule.connect(
        database, runner, coverCache, subscriptions,
        homeDirectory = config.homeDirectory,
        // 朗读与备份的 AI 工具要用到这两个；与 HTTP 端点背后是**同一份**服务，
        // 不在进程里另起一套（否则 AI 合成的音频、看到的备份与界面上的不是一回事）。
        edgeTts = edgeTts,
        backupStore = io.legado.backup.BackupStore(config.localBooksDirectory.resolveSibling("backup_kept")),
    )
    // 仅调试：额外自检（不会污染真实库）。生产环境返回 null，不影响任何对外行为。
    AgentModule.install(agentConnection)

    // 插件系统已移除（用户 2026-10-26：不再做插件）。
    // 工具注册表 / 钩子仍在 ai/ 里，宿主代码可以直接 register() 挂工具 —— 那属于 AI 能力面，不是「插件」。
    environment.monitor.subscribe(ApplicationStopping) { 
        logSystem("服务器正在停止")
        subscriptions.stop(); bookCache.stop(); ttsSessions.close(); database.close() 
    }
    environment.monitor.subscribe(ApplicationStopped) { 
        logSystem("服务器已停止")
        subscriptions.stop(); bookCache.stop(); ttsSessions.close(); database.close() 
    }
    /**
     * 订阅同步、缓存续跑、一次性封面回收都是**后台工作**，不必挡在"端口能连"前面。
     *
     * 冷启动实测：这三样在真实数据上要几秒，而这几秒用户正对着界面上的加载页干等。
     * 放到服务真正起来（端口已 listen）之后再跑：先能用界面，这些在背后补。
     * 早期版本给没有封面的本地书画过一张按书名哈希的彩色 SVG（整架看下去就是彩虹），
     * 生成逻辑已删，这里把已经落库的那批回收掉，界面才会回落到主题化的文字占位。
     *
     * `--cds-dump` 时**跳过**这三样：那次运行只为生成类归档（`tools/make-cds.mjs`），
     * 而它可能和正在跑的服务共用同一个库 —— 只读预热不会抢写，跳过这些写活儿才安全。
     */
    if (!cdsDump) {
        environment.monitor.subscribe(ApplicationStarted) {
            subscriptions.start()
            bookCache.start()
            val purgedCovers = coverCache.purgeGeneratedLocalCovers(database)
            if (purgedCovers > 0) log.info("已回收 {} 张自动生成的本地书封面", purgedCovers)
        }
    } else {
        // 生成脚本趁这几秒预热几个接口（让请求路径的类也进归档），然后正常退出。
        environment.monitor.subscribe(ApplicationStarted) {
            Thread {
                Thread.sleep(8000)
                log.info("cds-dump：正常退出以写 CDS 归档")
                exitProcess(0)
            }.apply { isDaemon = true }.start()
        }
    }

    install(ContentNegotiation) {
        // encodeDefaults 必须开：kotlinx 默认 false 会把「取值等于默认值」的字段整个省掉，
        // 于是 replacement/isRegex/isEnabled 在响应里消失，前端按非空类型直接用就会白屏。
        json(Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true })
    }
    install(WebSockets)
    install(StatusPages) {
        // 请求体解析失败是客户端错误。没有这几条时它落进下面的 Throwable 分支 → 500 + 整段堆栈刷日志。
        exception<BadRequestException> { call, cause ->
            this@legadoApplication.log.warn("bad request: {}", cause.message)
            call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", cause.message ?: "请求内容无法解析"))
        }
        exception<ContentTransformationException> { call, cause ->
            this@legadoApplication.log.warn("request transform failed: {}", cause.message)
            call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", cause.message ?: "请求内容格式错误"))
        }
        exception<SerializationException> { call, cause ->
            this@legadoApplication.log.warn("request serialization failed: {}", cause.message)
            call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求内容不符合接口字段要求"))
        }
        exception<Throwable> { call, cause ->
            this@legadoApplication.log.error("Unhandled request failure", cause)
            call.respond(HttpStatusCode.InternalServerError, ApiError("internal_error", "服务器内部错误"))
        }
    }
    // 同源写门：全局拦所有写方法，路由不必再各自记得调一次（只读 POST 走插件内的白名单）。
    install(SameOriginWriteGate)
    routing {
        get("/healthz") {
            call.respond(
                HealthStatus(
                    title = BuildInfo.title,
                    version = BuildInfo.version,
                    status = "ok",
                    // 版本号相同但包是旧的，光看 version 分不出来 —— 这两个字段就是为此而存在
                    ui = BuildInfo.uiFingerprint,
                    startedAtMs = BuildInfo.startedAt,
                )
            )
        }
        // 自定义接入的持久层：随安装根目录，存于 agent-profiles.json（与 port.txt 同级）。
        val profileStore = AgentProfileStore
        apiRoutes(
            database, runner, coverCache, subscriptions, bookCache, edgeTts, ttsSessions,
            config.localBooksDirectory, config.homeDirectory, config.host, config.port,
            agentConnection, profileStore,
        )
        // 注册在 staticWeb 之前：根路由是 `staticResources("/")`，先摆 /next 才不必去猜路由树的优先级
        staticNext(config.nextDirectory)
        staticWeb(config.homeDirectory)
    }
    logSystem(
        if (Files.isRegularFile(config.nextDirectory.resolve("index.html"))) "新骨架界面已挂载 /next" else "新骨架界面未挂载（没有 next/index.html）",
        mapOf("path" to config.nextDirectory.toAbsolutePath().toString()),
    )
}
