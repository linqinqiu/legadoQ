package io.legado.http

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import io.legado.data.Database
import io.legado.data.batchUpdateSources
import io.legado.data.clearSourceOrder
import io.legado.data.cookieBucket
import io.legado.data.cookieBucketMentions
import io.legado.data.deleteSource
import io.legado.data.exportSources
import io.legado.data.getCookieForUrl
import io.legado.data.getSource
import io.legado.data.getSourceLoginState
import io.legado.data.importSources
import io.legado.data.listCookieBuckets
import io.legado.data.listSourceRecords
import io.legado.data.listSources
import io.legado.data.parseCookieString
import io.legado.data.removeCookieBucket
import io.legado.data.removeSourceLoginHeader
import io.legado.data.removeSourceLoginInfo
import io.legado.data.reorderSources
import io.legado.data.saveSource
import io.legado.data.saveSourceLoginHeader
import io.legado.data.saveSourceLoginInfo
import io.legado.data.setCookieForUrl
import io.legado.data.VersionConflict
import io.legado.model.ApiError
import io.legado.model.BatchSourceRequest
import io.legado.model.BatchSourceResponse
import io.legado.model.ExternalLoginStatus
import io.legado.model.GlobalCookieEntry
import io.legado.model.GlobalCookieListResponse
import io.legado.model.ImportRequest
import io.legado.model.ShelfOrderResult
import io.legado.model.SourceBrowserCookieResponse
import io.legado.model.SourceBrowserInlineRequest
import io.legado.model.SourceBrowserInlineResponse
import io.legado.model.SourceBrowserSessionRequest
import io.legado.model.SourceBrowserSessionResponse
import io.legado.model.SourceCookieRemoveResponse
import io.legado.model.SourceCredentialStatus
import io.legado.model.SourceHealthCheckItem
import io.legado.model.SourceHealthCheckRequest
import io.legado.data.saveHealthResults
import io.legado.model.SourceHealthCheckResponse
import io.legado.model.SourceLoginActionRequest
import io.legado.model.SourceLoginCookieResponse
import io.legado.model.SourceLoginCookieUpdateRequest
import io.legado.model.SourceLoginHeaderUpdateRequest
import io.legado.model.SourceLoginInfoUpdateRequest
import io.legado.model.SourceLoginUiResponse
import io.legado.model.SourceOrderRequest
import io.legado.model.SourceValidateRequest
import io.legado.model.SourceWriteRequest
import io.legado.rules.RuleRunner
import io.legado.source.DebugStep
import io.legado.source.ExternalBrowserLogin
import io.legado.source.ProxiedPayload
import io.legado.source.SourceCodec
import io.legado.source.SourceDebugger
import io.legado.source.SourceHealth
import io.legado.source.WebViewException
import io.legado.source.WebViewProxy
import java.net.URI
import java.net.URLEncoder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * 从 `Routes.kt` 拆出（0.8.2 结构重排）：书源列表与批量整理、单源读写校验调试、登录与凭据、内置浏览器代理。
 * 处理器文本逐字未动；本函数由 `Routes.kt` 的 `apiRoutes` 挂在 `route("/api")` 内，顺序与拆前一致。
 * 契约核对：`web/test/ApiCatalog.test.ts` 把本目录全部 `*Routes.kt` 视为挂在 `/api` 之下逐条比对。
 */
fun Route.sourcesRoutes(
    database: Database,
    runner: RuleRunner,
    webView: WebViewProxy,
    externalLogin: ExternalBrowserLogin,
    debugger: SourceDebugger,
) {
        get("/sources") {
            call.respond(database.listSources(call.request.queryParameters["q"]))
        }
        // 全局登录凭据表：删书源不再连带清桶（凭据按注册域共享），所以必须有个地方
        // 能看见全部、能逐个撤掉 —— 否则就成了"看不见又删不掉"。
        get("/cookies") {
            val rows = withContext(Dispatchers.IO) {
                // 一次扫描拿到全部桶的计数：逐桶查以前把这个接口拖到 2 分半
                val mentions = database.cookieBucketMentions()
                database.listCookieBuckets().map { bucket ->
                    GlobalCookieEntry(
                        domain = bucket.domain,
                        keys = bucket.keys,
                        mentionedBy = mentions[bucket.domain] ?: 0,
                    )
                }
            }
            call.respond(GlobalCookieListResponse(count = rows.size, cookies = rows))
        }
        delete("/cookies") {
            if (!call.requireSameOriginWrite()) return@delete
            val target = call.request.queryParameters["u"]?.trim()
            if (target.isNullOrBlank()) {
                call.respond(HttpStatusCode.BadRequest, ApiError("missing_parameter", "缺少 u 参数（要删除哪个域的凭据）"))
                return@delete
            }
            val removed = withContext(Dispatchers.IO) { database.removeCookieBucket(target) }
            call.respond(mapOf("ok" to true, "removed" to removed))
        }
        post("/sources/batch") {
            if (!call.requireSameOriginWrite()) return@post
            val req = call.receive<BatchSourceRequest>()
            if (req.ids.isEmpty()) {
                call.respond(HttpStatusCode.BadRequest, ApiError("empty_selection", "请先选择需要操作的书源"))
                return@post
            }
            try {
                val count = database.batchUpdateSources(req.ids, req.action, req.group)
                val msg = when (req.action) {
                    "enable" -> "已成功启用 $count 个书源"
                    "disable" -> "已成功停用 $count 个书源"
                    "delete" -> "已成功删除 $count 个书源"
                    "set_group" -> if (req.group.isNullOrBlank()) "已清空 $count 个书源的分组" else "已将 $count 个书源移至分组“${req.group}”"
                    "tag_group" -> "已为 $count 个书源加上标签“${req.group}”"
                    "untag_group" -> "已摘掉 $count 个书源的标签“${req.group}”"
                    else -> "已处理 $count 个书源"
                }
                call.application.log.info("source batch operation: action={}, count={}", req.action, count)
                call.respond(BatchSourceResponse(ok = true, affected = count, action = req.action, message = msg))
            } catch (error: IllegalArgumentException) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_action", error.message ?: "无效的批量操作"))
            } catch (error: Throwable) {
                call.application.log.error("source batch operation failed", error)
                call.respond(HttpStatusCode.InternalServerError, ApiError("batch_failed", error.message ?: "批量操作失败"))
            }
        }
        post("/sources/health-check") {
            // 这个接口会让服务端对全部启用书源发起外呼，属于「能被跨站触发的资源消耗」，
            // 因此和其余写接口一样要 CSRF；原来还把请求体解析失败吞成默认值，等于允许空体跨站触发。
            if (!call.requireSameOriginWrite()) return@post
            val req = runCatching { call.receive<SourceHealthCheckRequest>() }.getOrElse {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 JSON")); return@post
            }
            val timeoutMs = req.timeoutMs.coerceIn(1000L, 10000L)
            val allSources = database.listSources(null)
            // 没点名 ids 时只体检**启用中**的源。整库 5,574 个里被用户停用的那批他根本不读，
            // 探它们既慢（并发 16、单个 5 秒超时，一轮就是几十分钟）又会在结果里堆一大片
            // 「连不上」，把真正要看的那几十个淹掉 —— 这正是「体检过慢、管理功能异常」的实测成因。
            // 停用的那批仍可显式点名（ids）或在界面上勾「连停用的一起体检」来覆盖。
            val targetSources = if (!req.ids.isNullOrEmpty()) {
                val idSet = req.ids.toSet()
                allSources.filter { it.id in idSet }
            } else {
                allSources.filter { it.enabled }
            }

            // 目标书源的完整记录一次性取回（键 = id）：原来是在并发闸门里逐个 database.getSource 查库，
            // 属于 N+1 —— 几百个源挤在那 16 个并发槽里排队查库，跟真正的外呼抢时间。批量后查库退到闸门之外。
            val recordsById = withContext(Dispatchers.IO) { database.listSourceRecords(req.ids) }

            val startTotalNs = System.nanoTime()
            val health = SourceHealth(runner)
            val semaphore = Semaphore(16)

            val results = coroutineScope {
                targetSources.map { summary ->
                    async(Dispatchers.IO) {
                        semaphore.withPermit {
                            val record = recordsById[summary.id]
                            if (record == null) {
                                SourceHealthCheckItem(
                                    id = summary.id,
                                    name = summary.name,
                                    ok = false,
                                    latencyMs = 0L,
                                    statusCode = 0,
                                    statusCategory = "invalid",
                                    error = "书源记录不存在",
                                )
                            } else {
                                health.probe(summary.id, summary.name, record.json, req.keyword ?: "都市", timeoutMs)
                            }
                        }
                    }
                }.awaitAll()
            }
            val totalDurationMs = (System.nanoTime() - startTotalNs) / 1_000_000
            val successCount = results.count { it.statusCategory == "valid" }
            val slowCount = results.count { it.statusCategory == "slow" }
            val failedCount = results.count { !it.ok }

            // 落库：体检结论以前只活在浏览器 localStorage 里，服务端看不到，
            // 于是「搜索优先搜能用的源」无从做起。现在存进 source_health 表，
            // 搜索按它排序 —— 一场跑几十分钟的体检，终于能被最需要它的地方用上。
            // 失败不挡住响应：结论已经算出来了，存不进去是另一件事，如实记一行日志。
            runCatching { withContext(Dispatchers.IO) { database.saveHealthResults(results) } }
                .onFailure { call.application.log.warn("体检结论落库失败：${it.message}") }

            call.respond(
                SourceHealthCheckResponse(
                    total = results.size,
                    successCount = successCount,
                    slowCount = slowCount,
                    failedCount = failedCount,
                    durationMs = totalDurationMs,
                    results = results,
                )
            )
        }
        get("/sources/export") {
            call.respondText(
                text = Json.encodeToString(database.exportSources(call.request.queryParameters.getAll("id"))),
                contentType = ContentType.Application.Json.withCharset(Charsets.UTF_8),
            )
        }
        post("/sources/import") {
            if (!call.requireSameOriginWrite()) return@post
            val response = database.importSources(call.receive<ImportRequest>().sources)
            call.application.log.info("source import completed: imported={}, updated={}, skipped={}", response.imported, response.updated, response.skipped)
            call.respond(response)
        }
        // 注册在 `/sources/{id}` 之前：字面段本来就优先于参数段，但顺序摆在这儿，
        // 读代码的人不用去查路由树的优先级就能确定 `PUT /sources/order` 打的是哪一个。
        put("/sources/order") {
            if (!call.requireSameOriginWrite()) return@put
            val request = runCatching { call.receive<SourceOrderRequest>() }.getOrElse {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 JSON")); return@put
            }
            if (request.ids.isEmpty()) {
                call.respond(HttpStatusCode.BadRequest, ApiError("empty_order", "没有要排序的书源")); return@put
            }
            call.respond(ShelfOrderResult(database.reorderSources(request.ids)))
        }
        delete("/sources/order") {
            if (!call.requireSameOriginWrite()) return@delete
            call.respond(ShelfOrderResult(database.clearSourceOrder()))
        }
        route("/sources/{id}") {
            get {
                val source = database.getSource(call.parameters["id"]!!)
                if (source == null) call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书源不存在")) else call.respond(source)
            }
            put {
                if (!call.requireSameOriginWrite()) return@put
                val request = call.receive<SourceWriteRequest>()
                try { call.respond(database.saveSource(SourceCodec.parse(request.json), request.version)); call.application.log.info("source updated: {}", call.parameters["id"]) }
                catch (_: VersionConflict) { call.respond(HttpStatusCode.Conflict, ApiError("version_conflict", "书源已在其他页面更新，请刷新后重试")) }
                catch (error: IllegalArgumentException) { call.respond(HttpStatusCode.BadRequest, ApiError("invalid_source", error.message ?: "书源无效")) }
            }
            delete {
                if (!call.requireSameOriginWrite()) return@delete
                if (database.deleteSource(call.parameters["id"]!!)) { call.application.log.info("source deleted: {}", call.parameters["id"]); call.respond(HttpStatusCode.NoContent) } else call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书源不存在"))
            }
            post("/validate") {
                if (!call.requireSameOriginWrite()) return@post
                // 带草稿时校验编辑器里的未保存内容：否则「校验」永远在检查上一次落库的旧版本。
                val draft = runCatching { call.receive<SourceValidateRequest>().json }.getOrNull()?.takeIf { it.isNotBlank() }
                val text = draft ?: database.getSource(call.parameters["id"]!!)?.json
                    ?: run { call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书源不存在")); return@post }
                call.respond(SourceCodec.validate(text))
            }
            get("/debug") {
                val source = database.getSource(call.parameters["id"]!!) ?: run { call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书源不存在")); return@get }
                val keyword = call.request.queryParameters["keyword"]?.takeIf { it.isNotBlank() } ?: "测试"
                val targetBookUrl = call.request.queryParameters["bookUrl"]
                val chapterIndex = call.request.queryParameters["chapterIndex"]?.toIntOrNull() ?: 0
                call.response.cacheControl(CacheControl.NoStore(null))
                call.respondTextWriter(ContentType.Text.EventStream) {
                    write("event: start\ndata: ${jsonEvent("开始调试 ${source.id}｜关键词「$keyword」")}\n\n"); flush()
                    // 各阶段最坏要等满引擎超时，所以边跑边发：驱动器在 IO 线程里往 channel 塞，
                    // 这里逐条写回前端。客户端断开时 `write` 抛取消，IO 侧的发送只是 trySend 失败，不会挂住。
                    val steps = Channel<DebugStep>(Channel.UNLIMITED)
                    coroutineScope {
                        launch(Dispatchers.IO) {
                            runCatching { debugger.flow(source.json, keyword, targetBookUrl, chapterIndex) { steps.trySend(it) } }
                                .onFailure { steps.trySend(DebugStep("调试", "驱动器异常", it.message ?: it.javaClass.simpleName, false)) }
                            steps.close()
                        }
                        for (step in steps) {
                            write("event: step\ndata: ${debugJson.encodeToString(DebugStep.serializer(), step)}\n\n"); flush()
                        }
                    }
                    write("event: done\ndata: ${jsonEvent("调试结束")}\n\n"); flush()
                }
            }
            get("/explore") {
                val source = database.getSource(call.parameters["id"]!!) ?: run { call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书源不存在")); return@get }
                call.respond(runCatching { runner.exploreTabs(source.json) }.getOrElse { error ->
                    call.respond(HttpStatusCode.BadGateway, ApiError("explore_failed", error.message ?: "发现页解析失败")); return@get
                })
            }
            get("/login-ui") {
                val source = database.getSource(call.parameters["id"]!!) ?: run { call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书源不存在")); return@get }
                val items = runner.parseLoginUi(source.json)
                val state = database.getSourceLoginState(source.id)
                val sourceObj = runCatching { Json.parseToJsonElement(source.json).jsonObject }.getOrNull()
                val sourceName = (sourceObj?.get("bookSourceName") as? JsonPrimitive)?.contentOrNull ?: source.id
                val loginUrl = (sourceObj?.get("loginUrl") as? JsonPrimitive)?.contentOrNull
                call.respond(
                    SourceLoginUiResponse(
                        sourceId = source.id,
                        sourceName = sourceName,
                        hasLogin = items.isNotEmpty() || !loginUrl.isNullOrBlank() || sourceObj?.get("loginCheckJs") != null,
                        loginUi = items,
                        loginUrl = loginUrl,
                        loginInfo = state?.loginInfo ?: emptyMap(),
                        loginHeader = state?.loginHeader,
                        sourceVariable = state?.sourceVariable,
                        loginIsScript = runner.loginIsScript(source.json),
                        cookieDomains = WebViewProxy.credentialDomains(source.json),
                    )
                )
            }
            post("/login-info") {
                if (!call.requireSameOriginWrite()) return@post
                val sourceId = call.parameters["id"]!!
                val req = call.receive<SourceLoginInfoUpdateRequest>()
                database.saveSourceLoginInfo(sourceId, req.loginInfo)
                call.respond(mapOf("ok" to true))
            }
            delete("/login-info") {
                if (!call.requireSameOriginWrite()) return@delete
                val sourceId = call.parameters["id"]!!
                database.removeSourceLoginInfo(sourceId)
                call.respond(mapOf("ok" to true))
            }
            post("/login-header") {
                if (!call.requireSameOriginWrite()) return@post
                val sourceId = call.parameters["id"]!!
                val req = call.receive<SourceLoginHeaderUpdateRequest>()
                database.saveSourceLoginHeader(sourceId, req.loginHeader)
                call.respond(mapOf("ok" to true))
            }
            options("/login-cookie") {
                if (!allowCookieSyncOrigin(call, database)) { call.respond(HttpStatusCode.Forbidden); return@options }
                call.response.headers.append(HttpHeaders.AccessControlAllowMethods, "POST, OPTIONS")
                call.response.headers.append(HttpHeaders.AccessControlAllowHeaders, "Content-Type")
                call.respond(HttpStatusCode.OK)
            }
            post("/login-cookie") {
                val sourceId = call.parameters["id"]!!
                val targetSource = database.getSource(sourceId)
                    ?: database.listSources(null).firstOrNull {
                        it.id.contains(sourceId) || sourceId.contains(it.id) || (it.url.isNotBlank() && (sourceId.contains(it.url) || it.url.contains(sourceId)))
                    }?.let { database.getSource(it.id) }

                // 这个接口是给「在目标站点页面上运行的书签 / Chrome 扩展」用的，跨站、拿不到会话，
                // 所以原来写成 Access-Control-Allow-Origin: *。那等于任何网页都能往用户书源的 Cookie 罐里注入。
                // 改成只放行确实属于该书源站点的 Origin。
                //
                // 但界面自己的「粘贴 Cookie」也是 POST，Chrome 必然带上 Origin=本站，
                // 按域名规则永远不匹配 —— 那个页签一点就是 403，等于功能被安全加固顺手打死。
                // 同源这一支单独放行，条件是必须带有效会话 + CSRF 头；跨站仍然只认书源自己的域名。
                val sameOrigin = sameOriginCall(call)
                if (!sameOrigin && !allowCookieSyncOrigin(call, database, targetSource?.json)) {
                    call.respond(HttpStatusCode.Forbidden, ApiError("origin_not_allowed", "该页面不属于此书源的站点，已拒绝同步 Cookie"))
                    return@post
                }
                // 上面已经按 Origin 判过（同源或命中该书源自己的域），这里不再要会话
                val resolvedSourceId = targetSource?.id ?: sourceId
                val req = call.receive<SourceLoginCookieUpdateRequest>()
                val rawCookie = req.cookie.trim()
                var savedCount = 0
                if (rawCookie.isNotEmpty()) {
                    val cookieMap = database.parseCookieString(rawCookie)
                    savedCount = cookieMap.size
                    database.setCookieForUrl(req.url ?: resolvedSourceId, rawCookie)
                    val cookieStr = cookieMap.entries.joinToString("; ") { "${it.key}=${it.value}" }
                    val state = database.getSourceLoginState(resolvedSourceId)
                    if (state?.loginHeader.isNullOrBlank() && cookieStr.isNotBlank()) {
                        val headerMap = mapOf("Cookie" to cookieStr)
                        database.saveSourceLoginHeader(resolvedSourceId, Json.encodeToString(headerMap))
                    }
                    call.application.log.info("cookie synchronized for source: {}, count: {}, url: {}", resolvedSourceId, savedCount, req.url)
                }
                call.respond(SourceLoginCookieResponse(ok = true, message = "Cookie 同步成功", count = savedCount))
            }
            delete("/login-header") {
                if (!call.requireSameOriginWrite()) return@delete
                val sourceId = call.parameters["id"]!!
                database.removeSourceLoginHeader(sourceId)
                call.respond(mapOf("ok" to true))
            }
            post("/login-action") {
                if (!call.requireSameOriginWrite()) return@post
                val source = database.getSource(call.parameters["id"]!!) ?: run { call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书源不存在")); return@post }
                val req = call.receive<SourceLoginActionRequest>()
                val outcome = runner.executeLoginAction(source.json, req.action, req.loginData, req.isLongClick, req.browserCompleted)
                call.respond(outcome)
            }
            get("/login-check") {
                val source = database.getSource(call.parameters["id"]!!) ?: run { call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书源不存在")); return@get }
                val check = runner.checkLoginStatus(source.json)
                call.respond(check)
            }
            // 某个地址的注册域上到底有没有凭据 —— 发现页用它把"这一栏要登录"和"站点确实返回空"分开。
            // 只回答有/无，不假装能判定登录态（上游没有这个机制，loginCheckJs 只是响应改写器）。
            get("/credential") {
                val url = call.request.queryParameters["u"]?.trim()
                if (url.isNullOrBlank()) {
                    call.respond(HttpStatusCode.BadRequest, ApiError("missing_parameter", "缺少 u 参数（要查哪个地址所在域）"))
                    return@get
                }
                val domain = database.cookieBucket(url)
                call.respond(SourceCredentialStatus(domain = domain, has = database.getCookieForUrl(url) != null))
            }
            route("/browser") {
                post("/session") {
                    if (!call.requireSameOriginWrite()) return@post
                    val source = database.getSource(call.parameters["id"]!!) ?: run { call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书源不存在")); return@post }
                    val sourceObj = runCatching { Json.parseToJsonElement(source.json).jsonObject }.getOrNull()
                    val loginUrl = (sourceObj?.get("loginUrl") as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf { it.startsWith("http") }
                    val sourceUrl = (sourceObj?.get("bookSourceUrl") as? JsonPrimitive)?.contentOrNull?.trim()
                    val homeUrl = sourceUrl?.takeIf { it.startsWith("http://") || it.startsWith("https://") }
                    // 书源 JS 里的 java.startBrowserAwait(url) 会给出真实入口，优先级最高
                    val requestedRaw = runCatching { call.receive<SourceBrowserSessionRequest>() }.getOrNull()?.url?.trim()
                    val requestedHttp = requestedRaw?.takeIf { it.startsWith("http://") || it.startsWith("https://") }
                    val inlineOnly = requestedRaw != null && requestedHttp == null && webView.isInlineDataUrl(requestedRaw)
                    if (requestedRaw != null && requestedHttp == null && !inlineOnly) {
                        call.respond(HttpStatusCode.BadRequest, ApiError("unsupported_url", "内置浏览器仅支持 HTTP(S) 地址或书源脚本生成的内置页面"))
                        return@post
                    }
                    val startUrl = requestedHttp
                        // loginUrl 是整段登录 JS 时，真正的登录地址只有脚本知道（`java.startBrowserAwait(...)`）
                        ?: runner.loginBrowserStartUrl(source.json)
                        ?: loginUrl
                        ?: homeUrl
                        ?: WebViewProxy.defaultStartUrl(source.json)
                    if (startUrl == null && !inlineOnly) {
                        call.respond(HttpStatusCode.BadRequest, ApiError("no_login_url", "该书源未配置 loginUrl，且书源内容中没有任何网址，无法打开内置浏览器"))
                        return@post
                    }
                    val token = webView.issueTicket(source.id, source.json, startUrl)
                    call.application.log.info("webview session opened for source: {}, start: {}, inline: {}", source.id, startUrl ?: "(内置页面)", inlineOnly)
                    call.respond(
                        SourceBrowserSessionResponse(
                            token = token,
                            startUrl = startUrl ?: "",
                            expiresInSeconds = 1800,
                            inlineOnly = inlineOnly,
                        )
                    )
                }
                delete("/session") {
                    if (!call.requireSameOriginWrite()) return@delete
                    call.request.queryParameters["t"]?.let { webView.revokeTicket(it) }
                    call.respond(HttpStatusCode.NoContent)
                }
                get("/cookies") {
                    val sourceId = call.parameters["id"]!!
                    val json = database.getSource(sourceId)?.json ?: "{}"
                    val jar = withContext(Dispatchers.IO) { webView.jarSnapshot(json) }
                    call.respond(SourceBrowserCookieResponse(count = jar.size, domains = jar.keys.toList(), cookies = jar))
                }
                // 删掉某个注册域的凭据（界面要能单独撤掉误抓来的统计域，比如 hm.baidu.com）。
                // 域是全局共享的：这一删对所有会访问该域的书源同时生效，界面必须把这点说清楚。
                delete("/cookies") {
                    if (!call.requireSameOriginWrite()) return@delete
                    val sourceId = call.parameters["id"]!!
                    val json = database.getSource(sourceId)?.json ?: "{}"
                    val target = call.request.queryParameters["u"]?.trim()
                    if (target.isNullOrBlank()) {
                        call.respond(HttpStatusCode.BadRequest, ApiError("missing_parameter", "缺少 u 参数（要删除哪个域名的 Cookie）"))
                        return@delete
                    }
                    val removed = withContext(Dispatchers.IO) { database.removeCookieBucket(target) }
                    val jar = withContext(Dispatchers.IO) { webView.jarSnapshot(json) }
                    call.respond(SourceCookieRemoveResponse(ok = true, removed = removed, count = jar.size, domains = jar.keys.toList()))
                }
                // 真浏览器登录（外部 Chromium + CDP 回读），与内置代理浏览器并列的另一条路：
                // 内嵌 iframe 过不了站点风控，这里交给真引擎，登录完自动按域读回 HttpOnly 凭据。
                route("/external-login") {
                    suspend fun targetHosts(id: String): Pair<String, List<String>> {
                        val source = database.getSource(id) ?: return id to emptyList()
                        return source.id to WebViewProxy.credentialDomains(source.json)
                    }
                    post {
                        if (!call.requireSameOriginWrite()) return@post
                        val sourceId = call.parameters["id"]!!
                        val source = database.getSource(sourceId)
                            ?: return@post call.respond(HttpStatusCode.NotFound, ApiError("source_not_found", "书源不存在"))
                        val startUrl = runCatching {
                            Json.parseToJsonElement(call.receiveText().ifBlank { "{}" }).jsonObject["url"]
                                ?.jsonPrimitive?.contentOrNull?.takeIf { it.startsWith("http") }
                        }.getOrNull()
                            ?: runner.loginBrowserStartUrl(source.json)
                            ?: WebViewProxy.defaultStartUrl(source.json)
                            ?: source.id
                        val (resolvedId, _) = targetHosts(sourceId)
                        val outcome = runCatching { withContext(Dispatchers.IO) { externalLogin.start(startUrl) } }
                        outcome.getOrElse { error ->
                            call.respond(HttpStatusCode.ServiceUnavailable, ApiError("browser_unavailable", error.message ?: "启动浏览器失败"))
                            return@post
                        }
                        call.application.log.info("external browser opened for source: {}, pid: {}", resolvedId, outcome.getOrThrow().pid)
                        call.respond(externalLoginStatus(externalLogin, targetHosts(sourceId).second, null))
                    }
                    get {
                        val sourceId = call.parameters["id"]!!
                        val (resolvedId, hosts) = targetHosts(sourceId)
                        val seen = withContext(Dispatchers.IO) { externalLogin.peekDomains(hosts) }
                        call.respond(externalLoginStatus(externalLogin, hosts, seen))
                    }
                    post("/capture") {
                        if (!call.requireSameOriginWrite()) return@post
                        val sourceId = call.parameters["id"]!!
                        val (resolvedId, hosts) = targetHosts(sourceId)
                        val stored = withContext(Dispatchers.IO) { externalLogin.capture(hosts) }
                        val json = database.getSource(sourceId)?.json ?: "{}"
                        val jar = withContext(Dispatchers.IO) { webView.jarSnapshot(json) }
                        call.application.log.info(
                            "external login captured cookies for {}: {} domains",
                            resolvedId,
                            stored.size,
                        )
                        call.respond(externalLoginStatus(externalLogin, hosts, stored).copy(stored = stored, count = jar.size))
                    }
                    delete {
                        if (!call.requireSameOriginWrite()) return@delete
                        withContext(Dispatchers.IO) { externalLogin.stop() }
                        call.respond(HttpStatusCode.NoContent)
                    }
                }
                get("/page") {
                    val sourceId = call.parameters["id"]!!
                    val token = call.request.queryParameters["t"]
                    if (token.isNullOrBlank()) {
                        call.respond(HttpStatusCode.BadRequest, ApiError("missing_parameter", "缺少 token 参数"))
                        return@get
                    }
                    // i = 服务端托管的内置页面（书源 JS 生成的数据地址，直接进 URL 会超出请求行上限）
                    val inlineKey = call.request.queryParameters["i"]
                    if (!inlineKey.isNullOrBlank()) {
                        call.respondProxied { webView.openInlinePage(sourceId, token, inlineKey) }
                        return@get
                    }
                    val target = call.request.queryParameters["u"]
                    if (target.isNullOrBlank()) {
                        call.respond(HttpStatusCode.BadRequest, ApiError("missing_parameter", "缺少 u 参数"))
                        return@get
                    }
                    call.respondProxied { webView.openPage(sourceId, token, target) }
                }
                post("/inline") {
                    if (!call.requireSameOriginWrite()) return@post
                    val sourceId = call.parameters["id"]!!
                    val req = call.receive<SourceBrowserInlineRequest>()
                    try {
                        val key = webView.registerInlinePage(sourceId, req.token, req.url)
                        call.respond(SourceBrowserInlineResponse(key = key))
                    } catch (error: WebViewException) {
                        call.respond(HttpStatusCode.BadRequest, ApiError("inline_page_failed", error.message ?: "内置页面无法打开"))
                    }
                }
                /*
                  子资源与站点自己发的请求走这一个口。原来只注册了 GET，而注入脚本把**所有方法**的
                  fetch/XHR 都改写到 `/res` —— 于是"登录 = fetch POST /login"的站点，POST 落在 405 上
                  根本没发出去，那条 Set-Cookie 也就永远吸不到（用户：「登录抓取 cookie 还是失败」）。
                  表单那条路（/submit）一直有 POST，所以只有走 XHR 的源中招。
                */
                route("/res") {
                    // Ktor 的 `method` 不收变长参数，逐个注册；处理体只有一份，免得五份里改一份忘四份
                    for (verb in listOf(HttpMethod.Get, HttpMethod.Post, HttpMethod.Put, HttpMethod.Patch, HttpMethod.Delete)) {
                        method(verb) {
                            handle {
                                val sourceId = call.parameters["id"]!!
                                val token = call.request.queryParameters["t"]
                                val target = call.request.queryParameters["u"]
                                if (token.isNullOrBlank() || target.isNullOrBlank()) {
                                    call.respond(HttpStatusCode.BadRequest, ApiError("missing_parameter", "缺少 token 或 u 参数"))
                                    return@handle
                                }
                                val requestMethod = call.request.httpMethod.value
                                val body = if (requestMethod == "GET") ByteArray(0) else call.receiveStream().readBytes()
                                val contentType = call.request.headers[HttpHeaders.ContentType]
                                call.respondProxied { webView.openResource(sourceId, token, target, requestMethod, contentType, body) }
                            }
                        }
                    }
                }
                get("/submit") {
                    val sourceId = call.parameters["id"]!!
                    val token = call.request.queryParameters["t"]
                    val base = call.request.queryParameters["u"]
                    if (token.isNullOrBlank() || base.isNullOrBlank()) {
                        call.respond(HttpStatusCode.BadRequest, ApiError("missing_parameter", "缺少 token 或 u 参数"))
                        return@get
                    }
                    val extras = call.request.queryParameters.entries()
                        .filter { it.key != "t" && it.key != "u" }
                        .flatMap { entry -> entry.value.map { "${URLEncoder.encode(entry.key, Charsets.UTF_8)}=${URLEncoder.encode(it, Charsets.UTF_8)}" } }
                    val target = if (extras.isEmpty()) base else base + (if (base.contains('?')) "&" else "?") + extras.joinToString("&")
                    call.respondProxied { webView.submitForm(sourceId, token, target, "GET", null, ByteArray(0)) }
                }
                post("/submit") {
                    val sourceId = call.parameters["id"]!!
                    val token = call.request.queryParameters["t"]
                    val target = call.request.queryParameters["u"]
                    if (token.isNullOrBlank() || target.isNullOrBlank()) {
                        call.respond(HttpStatusCode.BadRequest, ApiError("missing_parameter", "缺少 token 或 u 参数"))
                        return@post
                    }
                    val body = call.receiveStream().readBytes()
                    val contentType = call.request.headers[HttpHeaders.ContentType]
                    call.respondProxied { webView.submitForm(sourceId, token, target, "POST", contentType, body) }
                }
            }
        }
}

/** 外部浏览器登录的统一回包：开着没有、是哪个浏览器、目标域、以及哪些域已经见到 Cookie。 */
private fun externalLoginStatus(
    externalLogin: ExternalBrowserLogin,
    hosts: List<String>,
    seen: List<String>?,
) = ExternalLoginStatus(
    opened = externalLogin.status() != null,
    browser = externalLogin.status()?.browser ?: "",
    port = externalLogin.status()?.port ?: 0,
    pid = externalLogin.status()?.pid ?: 0,
    hosts = hosts,
    seen = seen ?: emptyList(),
)

private fun jsonEvent(message: String): String = Json.encodeToString(message)

/** 调试事件的序列化器：`encodeDefaults` 必须开着，否则前端拿到的 JSON 会缺掉空字段。 */

private val debugJson = Json { encodeDefaults = true }

/**
 * Cookie 同步接口只接受「该书源自己的站点」发来的跨站请求：没有 Origin 头视为本机工具或同源页面，放行；
 * 有 Origin 则必须命中书源 `bookSourceUrl` / `loginUrl` 的注册域（或该主机名确实出现在这份书源配置里，
 * 兼容用自定义标识当 URL 的聚合源）。命中时回显该 Origin 并带 `Vary: Origin`，不再使用 `*`。
 */
/** Origin 的主机与端口都指向服务自己的绑定身份（判定在 Guard.kt，0.6.23 起与写闸门同一份）。 */
private fun sameOriginCall(call: ApplicationCall): Boolean =
    isSameOriginIdentity(call.request.headers[HttpHeaders.Origin]?.trim())

private fun allowCookieSyncOrigin(call: ApplicationCall, database: Database, sourceJson: String? = null): Boolean {
    val origin = call.request.headers[HttpHeaders.Origin]?.trim()?.takeIf { it.isNotEmpty() } ?: return true
    val host = runCatching { URI(origin).host?.lowercase() }.getOrNull()?.takeIf { it.isNotEmpty() }
        ?: return false
    val json = sourceJson ?: call.parameters["id"]?.let { database.getSource(it)?.json }
    val domains = json?.let { runCatching { WebViewProxy.allowedDomains(it) }.getOrNull() }.orEmpty()
    val registrable = runCatching { WebViewProxy.registrableDomain(host) }.getOrDefault(host)
    val matchesDomain = domains.any { registrable == it || host == it || host.endsWith(".$it") }
    if (!matchesDomain && json?.contains(host) != true) return false
    call.response.headers.append(HttpHeaders.AccessControlAllowOrigin, origin)
    call.response.headers.append(HttpHeaders.Vary, "Origin")
    return true
}

/**
 * 把代理结果写回响应；失败时返回一张可读的 HTML 错误页（因为它会被渲染进内置浏览器 iframe）。
 */
private suspend fun ApplicationCall.respondProxied(block: () -> ProxiedPayload) {
    // iframe 处于 sandbox 不透明源下，页面内 JS 发起的请求需要 CORS 放行；
    // 这些端点本身由一次性令牌鉴权，不依赖管理会话，因此放开 * 不会泄露权限。
    response.headers.append(HttpHeaders.AccessControlAllowOrigin, "*")
    try {
        val payload = withContext(Dispatchers.IO) { block() }
        respondBytes(
            bytes = payload.body,
            contentType = runCatching { ContentType.parse(payload.contentType) }.getOrNull(),
            status = HttpStatusCode.fromValue(payload.status),
        )
    } catch (error: WebViewException) {
        application.log.warn("webview proxy failed: {}", error.message)
        respondText(
            text = webViewErrorPage(error.message ?: "内置浏览器请求失败"),
            contentType = ContentType.Text.Html.withCharset(Charsets.UTF_8),
            status = HttpStatusCode.BadGateway,
        )
    }
}

private fun webViewErrorPage(message: String): String {
    val escaped = message
        .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return """
        <!doctype html>
        <html lang="zh-CN"><head><meta charset="utf-8"><title>内置浏览器无法打开页面</title>
        <style>
          body{margin:0;padding:32px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
               background:#0f1115;color:#e6e8eb;display:flex;align-items:center;justify-content:center;min-height:100vh}
          .card{max-width:520px;background:#171a21;border:1px solid #262b36;border-radius:12px;padding:24px}
          h1{margin:0 0 12px;font-size:16px;color:#f87171}
          p{margin:0;font-size:13px;line-height:1.7;color:#9aa4b2;word-break:break-all}
        </style></head>
        <body><div class="card"><h1>无法打开该页面</h1><p>$escaped</p></div></body></html>
    """.trimIndent()
}

