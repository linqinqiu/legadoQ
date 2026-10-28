package io.legado.source

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.net.http.WebSocket
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.concurrent.TimeUnit
import io.legado.data.Database
import io.legado.data.setCookieForUrl

/**
 * 基线对比的键：Cookie 的域（去前导点、小写）加名字。CDP 的 `domain` 在子域上带前导点
 * （`.fanqienovel.com`），同一块 Cookie 两次读回必须映射到同一个键，否则全被判成"变了"。
 */
internal fun cookieKey(domain: String, name: String): String = "${domain.lowercase().trim('.')}|$name"

/**
 * `Page.getNavigationHistory` 回包里出现过的 http(s) 主机名。
 * 只要主机名，交给调用方按注册域归并；`chrome://`、`about:blank` 一律跳过。
 * 拆成顶层纯函数是为了在单测里钉住判据，不必真拉一个 Chromium。
 */
internal fun historyHosts(result: JsonObject?): List<String> {
    val entries = result?.get("entries") as? JsonArray ?: return emptyList()
    return entries.mapNotNull { element ->
        val url = ((element as? JsonObject)?.get("url") as? JsonPrimitive)?.contentOrNull ?: return@mapNotNull null
        if (!url.startsWith("http://", true) && !url.startsWith("https://", true)) return@mapNotNull null
        runCatching { URI(url).host }.getOrNull()
    }
}

/**
 * 外部真浏览器登录：由服务端拉起一个真正的 Chromium 窗口（Chrome / Edge），
 * 在**独立但持久**的 profile 里打开书源的登录页，用户按正常方式登录 —— 扫码、账号密码、
 * 站点自己的风控 JS 都照常工作。内嵌的反向代理 iframe 做不到这件事：那个沙箱把页面置于
 * opaque origin（AGENTS.md 明令不得开 `allow-same-origin`），番茄的 secsdk 在里面跑不起来。
 *
 * 登录完由这里**自动回读**：走 CDP 浏览器级 `Storage.getCookies`，它看得见 **HttpOnly** 的
 * `sessionid` 一类（书签方案里 `document.cookie` 看不见，那正是它对番茄无效的原因），
 * 再按注册域折进全局凭据表 —— 与上游 `CookieManager` 的 eTLD+1 归桶同口径。
 *
 * 一条绕不开的边界：**附加不到用户已经开着的那个浏览器**。没带 `--remote-debugging-port`
 * 启动的实例，任何本地程序都贴不上去（这是浏览器自己的反调试边界），而它已登录的 Cookie
 * 存在被独占锁住的库里。所以用我们自己的 profile：第一次要在那个窗口里登一遍，
 * 之后 profile 持久，登录态就留着。调试端口只绑 127.0.0.1，且由浏览器自己挑（写 0）。
 *
 * 同一个 profile 只能有一个实例：服务重启后内存里的句柄会丢，但窗口还在，这时靠 profile 里的
 * 端口文件重新附着（[attachExisting]），而不是再拉第二个进程 —— Chromium 见到同目录被占会直接
 * 退出，表现就是「打开」一直卡住。端口读两份：我们自己记的 `legado-debug-port`（每次拉起都写）
 * 与 Chromium 的 `DevToolsActivePort`。不扫本机其它调试端口，免得接上别人的浏览器。
 */
class ExternalBrowserLogin(
    private val database: Database,
    private val profileDir: Path,
) {
    data class Running(
        val browser: String,
        val port: Int,
        val pid: Long,
        val startedAt: Long,
    )

    private data class Launchable(val label: String, val path: String)

    internal data class BrowserCookie(val domain: String, val name: String, val value: String)

    private val monitor = Any()
    private var process: Process? = null
    private var running: Running? = null

    /** 刚关闭过浏览器的时间点：几秒内别再把它「附着」回来。 */
    private var stoppedAt = 0L

    /**
     * 打开登录页那一刻的 Cookie 快照（`域|名` → 值）。
     *
     * 只按书源配置里写死的域抓，会漏掉跨注册域登录：站点走 `passport.*` / OAuth 中转，
     * 或在 JS 里拼出一个配置中没写的接口域。登录开始前记一份基线、抓取时对比，
     * 就能知道这次登录到底在哪些域上留下了东西，而不必把整个登录档的旧 Cookie 全导进来。
     * 附着到服务重启前就存在的窗口时没有基线（不知道登录从哪一刻开始），退回只抓书源自己的域。
     */
    private var baseline: Map<String, String>? = null

    /** 我们自己记的调试端口：Chromium 的 DevToolsActivePort 会被它自己增删，这份不受影响。 */
    private val stateFile get() = profileDir.resolve("legado-debug-port")

    private val http = HttpClient.newBuilder()
        .followRedirects(HttpClient.Redirect.NEVER)
        .connectTimeout(Duration.ofSeconds(5))
        .build()

    /**
     * 我们拉起来的浏览器是否还活着；进程没了顺手清状态。
     * 服务重启后内存状态会丢，但窗口可能还开着 —— 靠 profile 里的调试端口附着回来，
     * 这样界面一打开就能看到「已打开」，不用先盲点一次「打开真浏览器登录」。
     */
    fun status(): Running? = synchronized(monitor) {
        val current = running
        if (current != null) {
            if (alive(current)) return@synchronized current
            running = null
            process = null
        }
        // 刚点过「关闭浏览器」的几秒内不附着：正在退出的进程会被误判成还活着。
        if (System.currentTimeMillis() - stoppedAt < 5_000) return@synchronized null
        attachExisting()?.also {
            running = it
            process = null
        }
    }

    private fun alive(current: Running): Boolean {
        if (current.pid > 0 && ProcessHandle.of(current.pid).map { it.isAlive }.orElse(false)) return true
        return fetchJson("http://127.0.0.1:${current.port}/json/version") != null
    }

    fun start(startUrl: String): Running = synchronized(monitor) {
        // 这个 profile 可能已经被一个还在运行的窗口占着（服务重启后内存状态就丢了）。
        // Chromium 对同一个 user-data-dir 再起第二个实例会直接退出，所以先附着到它的调试端口，
        // 再让它开一个新标签页 —— 用户的登录态和窗口都不用重来。
        val existing = status() ?: attachExisting()?.also {
            running = it
            process = null
        }
        if (existing != null) {
            // 基线只补不覆盖：同一个窗口里反复点「打开登录页」时，第一次记下的才是登录前的状态。
            // 拿不到（CDP 读失败）就保持 null，抓取时退回只认书源自己的域，宁可少抓也不乱导。
            if (baseline == null) baseline = snapshotOf(existing.port)
            // 按钮说的是「打开登录页」：窗口开着也补一个标签，否则点了像没反应。
            if (openTab(existing.port, startUrl)) return@synchronized existing
            // 端口还在应答、开标签却失败：多半是浏览器正在退出。忘掉它，重新拉一个。
            running = null
            process = null
            runCatching { Files.deleteIfExists(stateFile) }
        }
        Files.createDirectories(profileDir)
        // 上一轮留下的端口文件可能指向一个已经关掉的浏览器。Chromium 只有在真正起来之后
        // 才会重写 DevToolsActivePort；若不清掉，下面会立刻读到旧端口并当成新窗口的端口，
        // 「已打开」是真的，但所有 CDP 命令（回读 Cookie、关闭窗口）全发给一个死端口 ——
        // 实测表现就是界面显示已打开、点「抓取并入库」却一个域都入不了库。
        // 走到这里说明 attachExisting() 已经证明没有活着的窗口，删掉是安全的。
        runCatching { Files.deleteIfExists(profileDir.resolve("DevToolsActivePort")) }
        runCatching { Files.deleteIfExists(stateFile) }
        val executable = browserExecutable()
            ?: error("没找到 Chrome / Edge：可设环境变量 LEGADO_BROWSER_PATH 指向浏览器可执行文件")
        val launchedAt = System.currentTimeMillis()
        val launched = ProcessBuilder(
            executable.path,
            "--remote-debugging-port=0",
            "--user-data-dir=${profileDir.toAbsolutePath()}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-sync",
            "--new-window",
            startUrl,
        ).redirectErrorStream(true)
            .redirectOutput(ProcessBuilder.Redirect.appendTo(profileDir.resolve("launch.log").toFile()))
            .start()
        val port = awaitDebugPort(profileDir, launchedAt)
        if (port == null) {
            launched.destroy()
            error("浏览器没能开出调试端口，详见 ${profileDir.resolve("launch.log")}（该端口只监听 127.0.0.1）")
        }
        Running(executable.label, port, launched.pid(), System.currentTimeMillis()).also {
            rememberPort(port)
            process = launched
            running = it
            // 新窗口也记基线：登录档是持久的，里面可能已经有上个书源留下的 Cookie。
            baseline = snapshotOf(port)
        }
    }

    fun stop(): Boolean = synchronized(monitor) {
        // 服务重启后内存里可能没有会话，但窗口还开着：先附着回来再关，别让「关闭浏览器」变成空操作。
        val current = running ?: attachExisting()
        if (current != null) {
            // 让浏览器自己退，而不是直接 TerminateProcess：Browser.close 会把 Cookie 正常落盘，
            // 下次打开还是登录态。以前对我们自己拉起的实例直接 destroy()，Chrome 来不及
            // 把内存里的 Cookie 写回 profile，关一次就得重登一次。
            closeByCdp(current.port)
            waitGone(current.port, current.pid, 3_000)
        }
        process?.takeIf { it.isAlive }?.destroy()
        current?.takeIf { it.pid > 0 }?.let { handle ->
            runCatching { ProcessHandle.of(handle.pid).ifPresent { it.destroy() } }
        }
        process = null
        running = null
        baseline = null
        // 端口记录跟着作废：下次点「打开」应当重新拉一个窗口，而不是去连一个已经关掉的端口。
        runCatching { Files.deleteIfExists(stateFile) }
        stoppedAt = System.currentTimeMillis()
        current != null
    }

    /**
     * 找一个还开着的、用着我们这个 profile 的浏览器窗口，并确认它的调试端口真能应答。
     *
     * 只认两个写在 profile 里的端口线索：我们自己在拉起时记下的 `legado-debug-port`，
     * 以及 Chromium 自己写的 `DevToolsActivePort`。**不猜**「本机某个开着的调试端口」——
     * 实测那样会接上另一个同样带调试开关的浏览器（比如自动化测试自己的窗口），
     * 抓回来的是别人的 Cookie，「关闭浏览器」还会把别人的窗口关掉。
     */
    private fun attachExisting(): Running? {
        for (port in candidatePorts()) {
            val version = fetchJson("http://127.0.0.1:$port/json/version") as? JsonObject ?: continue
            val label = ((version["Browser"] as? JsonPrimitive)?.contentOrNull ?: "Chrome").substringBefore('/')
            rememberPort(port)
            return Running(label, port, 0L, System.currentTimeMillis())
        }
        return null
    }

    private fun candidatePorts(): List<Int> = listOfNotNull(
        runCatching { Files.readString(stateFile).trim().toIntOrNull() }.getOrNull(),
        runCatching {
            Files.readAllLines(profileDir.resolve("DevToolsActivePort")).firstOrNull()?.trim()?.toIntOrNull()
        }.getOrNull(),
    ).filter { it in 1..65535 }.distinct()

    private fun rememberPort(port: Int) {
        runCatching { Files.writeString(stateFile, port.toString()) }
    }

    /** 在已有窗口里开一个标签；返回 false 说明这个调试端口实际已经用不了。 */
    private fun openTab(port: Int, url: String): Boolean {
        val created = sendBrowserCommand(port, 2, "Target.createTarget", """{"url":${JsonPrimitive(url)}}""")
            ?: return false
        // 窗口本来就开着时（尤其最小化/被挡住），把新标签提到前面，否则用户以为按钮没反应。
        val targetId = (created["targetId"] as? JsonPrimitive)?.contentOrNull ?: return false
        sendBrowserCommand(port, 3, "Target.activateTarget", """{"targetId":${JsonPrimitive(targetId)}}""")
        return true
    }

    private fun closeByCdp(port: Int) {
        sendBrowserCommand(port, 3, "Browser.close", "{}", awaitReply = false)
    }

    /** 目标域里哪些已经有 Cookie 了 —— 用来判断"登录是否已经发生"，不猜有效性。 */
    fun peekDomains(hosts: List<String>): List<String> {
        val session = status() ?: return emptyList()
        val wanted = registrableSet(hosts)
        if (wanted.isEmpty()) return emptyList()
        return readAllCookies(session.port).mapNotNull { cookie ->
            runCatching { WebViewProxy.registrableDomain(cookie.domain) }.getOrNull()
        }.filter { it in wanted }.distinct().sorted()
    }

    /**
     * 抓取并入库：读回全部 Cookie，按注册域归桶。
     *
     * 默认只写**这本书源配置里会访问的域**，但登录未必只落在那些域上：番茄走 `passport.*`
     * 一类中转，不少站点走 OAuth，真正代表登录态的 Cookie 落在配置里根本没提过的域上。
     * 全抓会把登录档里别的站点的旧 Cookie 一并导进凭据表；只抓配置域又会让这些站点登了等于没登。
     * 折中见 [capturePlan]：本次新增/变更的 Cookie 且落在这次登录**到过**的页面域上，才额外入库。
     * 「到过」既看当前打开的标签，也看每个标签的导航历史 —— 中转站登录完跳回书源时，
     * 那个标签已经变成书源页，只有历史里还留着中转站那一跳。
     *
     * 返回真正入库的域；空列表通常意味着还没登录（或该站的凭据都在别的域上）。
     */
    fun capture(hosts: List<String>): List<String> = synchronized(monitor) {
        val session = status() ?: return@synchronized emptyList()
        val cookies = readCookiesOrNull(session.port) ?: return@synchronized emptyList()
        val known = registrableSet(hosts)
        val planned = capturePlan(cookies, baseline, visitedDomains(session.port), known)
        if (planned.isEmpty()) return@synchronized emptyList()
        val extra = planned - known
        val changed = changedKeys(cookies, baseline)
        val buckets = linkedMapOf<String, MutableMap<String, String>>()
        cookies.forEach { cookie ->
            val registrable = runCatching { WebViewProxy.registrableDomain(cookie.domain) }.getOrNull() ?: return@forEach
            if (registrable !in planned) return@forEach
            // 书源自己的域照旧全量（登录前就有的 Cookie 也要带上）；
            // 额外域只收这次登录写进去的那些，别把登录档里的历史残留一并导入。
            if (registrable in extra && cookieKey(cookie.domain, cookie.name) !in changed) return@forEach
            buckets.getOrPut(registrable) { linkedMapOf() }[cookie.name] = cookie.value
        }
        return@synchronized buckets.mapNotNull { (domain, pairs) ->
            val value = pairs.entries.joinToString("; ") { (name, raw) -> "$name=$raw" }
            domain.takeIf { value.isNotBlank() && database.setCookieForUrl("https://$domain/", value) }
        }
    }

    /**
     * 决定这次抓取认哪些注册域，纯函数便于钉住判据：
     *  1. 书源配置里会访问的域（[known]）永远都认；
     *  2. 有基线时，本次新增/变更的 Cookie 若落在这次登录**到过**的页面域（[pages]）上也认 ——
     *     这能覆盖 `passport.*` / OAuth 中转，同时不会把登录档里早已存在的无关 Cookie 带进来；
     *  3. 没有基线（服务重启后附着到旧窗口）不知道"这次登录从哪开始"，只认第 1 条。
     */
    internal fun capturePlan(
        cookies: List<BrowserCookie>,
        baseline: Map<String, String>?,
        pages: Set<String>,
        known: Set<String>,
    ): Set<String> {
        val snapshot = baseline ?: return known
        // 页面域在生产路径上已是主机名；这里再兜一层完整 URL，纯函数在测试里怎么传都算得对。
        val pageBuckets = pages.mapNotNull { page ->
            val host = runCatching { URI(page).host }.getOrNull()?.takeIf { it.isNotBlank() } ?: page
            bucketOf(host)
        }.toSet()
        val changedBuckets = cookies.asSequence()
            .filter { snapshot[cookieKey(it.domain, it.name)] != it.value }
            .mapNotNull { bucketOf(it.domain) }
            .toSet()
        return known + changedBuckets.intersect(pageBuckets)
    }

    private fun changedKeys(cookies: List<BrowserCookie>, baseline: Map<String, String>?): Set<String> {
        val snapshot = baseline ?: return emptySet()
        return cookies.asSequence()
            .filter { snapshot[cookieKey(it.domain, it.name)] != it.value }
            .map { cookieKey(it.domain, it.name) }
            .toSet()
    }

    private fun bucketOf(host: String): String? =
        runCatching { WebViewProxy.registrableDomain(host) }.getOrNull()?.takeIf { it.isNotBlank() }

    private fun registrableSet(hosts: List<String>): Set<String> = hosts.mapNotNull(::bucketOf).toSet()

    /**
     * 当前窗口里打开过哪些页面域（注册域）。
     * `Target.getTargets` 是浏览器级的，含所有窗口；只要普通 page target 的 http(s) 地址。
     * 登录跳转经过的中转站会留下一个页面，据此判断"这次登录真的到过这里"。
     */
    private fun pageDomains(port: Int): Set<String> {
        val result = sendBrowserCommand(port, 4, "Target.getTargets") ?: return emptySet()
        val infos = result["targetInfos"] as? JsonArray ?: return emptySet()
        return infos.mapNotNull { element ->
            val obj = element as? JsonObject ?: return@mapNotNull null
            if ((obj["type"] as? JsonPrimitive)?.contentOrNull != "page") return@mapNotNull null
            val url = (obj["url"] as? JsonPrimitive)?.contentOrNull ?: return@mapNotNull null
            if (!url.startsWith("http://", true) && !url.startsWith("https://", true)) return@mapNotNull null
            runCatching { URI(url).host }.getOrNull()
        }.toSet()
    }

    /**
     * 这次登录「到过」哪些域：当前打开的标签 + 每个标签的导航历史。
     *
     * 只看当前标签会漏掉最常见的一类中转登录：在中转站输账号/扫码，授权后跳回书源，
     * 抓取时那个标签早就变回书源页了。`Page.getNavigationHistory` 记着这一跳。
     * 历史读不到就当没有 —— 退回只看当前标签的保守集合，宁可少抓。
     */
    private fun visitedDomains(port: Int): Set<String> = pageDomains(port) + navigationDomains(port)

    /** 逐个标签读导航历史；单个标签失败不拖累其它标签。 */
    private fun navigationDomains(port: Int): Set<String> {
        val targets = fetchJson("http://127.0.0.1:$port/json/list") as? JsonArray ?: return emptySet()
        return targets.mapNotNull { element ->
            val obj = element as? JsonObject ?: return@mapNotNull null
            if ((obj["type"] as? JsonPrimitive)?.contentOrNull != "page") return@mapNotNull null
            val socketUrl = (obj["webSocketDebuggerUrl"] as? JsonPrimitive)?.contentOrNull ?: return@mapNotNull null
            historyDomains(socketUrl)
        }.flatten().toSet()
    }

    /** 页面级 CDP（`/json/list` 给的每条 target 都有自己的 WS）。 */
    private fun historyDomains(webSocketUrl: String): List<String> {
        val reply = CompletableFuture<String>()
        val socket = try {
            http.newWebSocketBuilder().buildAsync(URI(webSocketUrl), BrowserFrameListener(reply, 1)).get(8, TimeUnit.SECONDS)
        } catch (error: Exception) {
            return emptyList()
        }
        return try {
            socket.sendText("""{"id":1,"method":"Page.getNavigationHistory"}""", true).get(5, TimeUnit.SECONDS)
            val payload = Json.parseToJsonElement(reply.get(8, TimeUnit.SECONDS)).jsonObject
            historyHosts(payload["result"] as? JsonObject)
        } catch (error: Exception) {
            emptyList()
        } finally {
            runCatching { socket.sendClose(WebSocket.NORMAL_CLOSURE, "done") }
        }
    }

    /** 打开登录页那一刻的 Cookie 快照；读不到时返回 null（与"确实一个都没有"区分开）。 */
    private fun snapshotOf(port: Int): Map<String, String>? =
        readCookiesOrNull(port)?.associate { cookieKey(it.domain, it.name) to it.value }

    /** 浏览器级 WS 上发命令：不受单个 target 会话限制。 */
    private fun sendBrowserCommand(
        port: Int,
        id: Int,
        method: String,
        paramsJson: String = "{}",
        awaitReply: Boolean = true,
    ): JsonObject? {
        val version = fetchJson("http://127.0.0.1:$port/json/version") as? JsonObject ?: return null
        val socketUrl = (version["webSocketDebuggerUrl"] as? JsonPrimitive)?.contentOrNull ?: return null
        val reply = CompletableFuture<String>()
        val socket = try {
            http.newWebSocketBuilder().buildAsync(URI(socketUrl), BrowserFrameListener(reply, id)).get(8, TimeUnit.SECONDS)
        } catch (error: Exception) {
            return null
        }
        return try {
            socket.sendText("""{"id":$id,"method":"$method","params":$paramsJson}""", true).get(5, TimeUnit.SECONDS)
            if (!awaitReply) return null
            val payload = Json.parseToJsonElement(reply.get(8, TimeUnit.SECONDS)).jsonObject
            payload["result"] as? JsonObject
        } catch (error: Exception) {
            null
        } finally {
            runCatching { socket.sendClose(WebSocket.NORMAL_CLOSURE, "done") }
        }
    }

    /** 浏览器级 WS 上读全部 Cookie：含 HttpOnly。命令失败返回 null，与"确实一个都没有"区分开。 */
    private fun readCookiesOrNull(port: Int): List<BrowserCookie>? {
        val result = sendBrowserCommand(port, 1, "Storage.getCookies") ?: return null
        val cookies = result["cookies"] as? JsonArray ?: return emptyList()
        return cookies.mapNotNull { element ->
            val obj = element as? JsonObject ?: return@mapNotNull null
            val domain = (obj["domain"] as? JsonPrimitive)?.contentOrNull?.trim('.') ?: return@mapNotNull null
            val name = (obj["name"] as? JsonPrimitive)?.contentOrNull ?: return@mapNotNull null
            val value = (obj["value"] as? JsonPrimitive)?.contentOrNull ?: return@mapNotNull null
            if (name.isBlank()) null else BrowserCookie(domain, name, value)
        }
    }

    private fun readAllCookies(port: Int): List<BrowserCookie> = readCookiesOrNull(port).orEmpty()

    /** CDP 在同一条连接上还会推事件，所以只认指定 id 的那条回包。 */
    private class BrowserFrameListener(
        private val target: CompletableFuture<String>,
        private val id: Int,
    ) : WebSocket.Listener {
        private val buffer = StringBuilder()

        override fun onText(session: WebSocket, data: CharSequence, last: Boolean): CompletionStage<*> {
            buffer.append(data)
            if (last) {
                val text = buffer.toString()
                buffer.setLength(0)
                val wanted = runCatching {
                    (Json.parseToJsonElement(text).jsonObject["id"] as? JsonPrimitive)?.intOrNull == id
                }.getOrDefault(false)
                if (wanted && !target.isDone) target.complete(text)
            }
            session.request(1)
            return CompletableFuture.completedFuture(null)
        }

        override fun onError(session: WebSocket, error: Throwable) {
            if (!target.isDone) target.completeExceptionally(error)
        }
    }

    private fun fetchJson(url: String) = runCatching {
        val body = http.send(HttpRequest.newBuilder(URI(url)).GET().build(), HttpResponse.BodyHandlers.ofString()).body()
        Json.parseToJsonElement(body)
    }.getOrNull()

    /**
     * 等浏览器写出**这一次**的调试端口（端口写 0 时浏览器把真实端口写进 DevToolsActivePort，避免我们猜端口撞车）。
     *
     * 只看文件内容不够：上一次会话留下的 DevToolsActivePort 会一直躺在 profile 里，
     * 读到它就会把死端口当成新窗口的端口。所以还要求文件的修改时间不早于启动时刻
     * （留 1 秒余量，文件系统时间戳精度有限）。调用方另外会在启动前删掉旧文件，
     * 两道保险一起兜住「点打开却抓不到 Cookie」。
     */
    private fun awaitDebugPort(dir: Path, launchedAt: Long): Int? {
        repeat(60) {
            debugPortFrom(dir, launchedAt)?.let { port -> return port }
            Thread.sleep(250)
        }
        return null
    }

    /**
     * 读取「本次启动」写出的调试端口；旧会话留下的文件（修改时间早于 launchedAt）一律不认。
     * 单独拆出来是为了能在测试里钉住这条判据，不必真的拉一个 Chromium。
     */
    internal fun debugPortFrom(dir: Path, launchedAt: Long): Int? {
        val marker = dir.resolve("DevToolsActivePort")
        val fresh = runCatching { Files.getLastModifiedTime(marker).toMillis() >= launchedAt - 1_000 }
            .getOrDefault(false)
        if (!fresh) return null
        val port = runCatching { Files.readAllLines(marker).firstOrNull()?.trim()?.toIntOrNull() }.getOrNull()
        return port?.takeIf { it in 1..65535 }
    }

    /** 等浏览器退干净：有关闭回包不代表端口立刻消失，强杀前给它一点时间落盘。 */
    private fun waitGone(port: Int, pid: Long, timeoutMs: Long) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val processGone = pid <= 0 || ProcessHandle.of(pid).map { !it.isAlive }.orElse(true)
            val portGone = fetchJson("http://127.0.0.1:$port/json/version") == null
            if (processGone && portGone) return
            Thread.sleep(100)
        }
    }

    private fun browserExecutable(): Launchable? {
        System.getenv("LEGADO_BROWSER_PATH")?.takeIf { Files.isRegularFile(Path.of(it)) }
            ?.let { return Launchable("自定义", it) }
        val candidates = listOf(
            "C:/Program Files/Google/Chrome/Application/chrome.exe" to "Chrome",
            "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe" to "Chrome",
            "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" to "Edge",
            "C:/Program Files/Microsoft/Edge/Application/msedge.exe" to "Edge",
        ) + System.getenv("LOCALAPPDATA")?.let { listOf("$it/Google/Chrome/Application/chrome.exe" to "Chrome") }.orEmpty()
        return candidates.firstOrNull { (path, _) -> Files.isRegularFile(Path.of(path)) }
            ?.let { (path, label) -> Launchable(label, path) }
    }
}
