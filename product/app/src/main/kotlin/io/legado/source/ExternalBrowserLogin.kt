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

    private data class BrowserCookie(val domain: String, val name: String, val value: String)

    private val monitor = Any()
    private var process: Process? = null
    private var running: Running? = null

    private val http = HttpClient.newBuilder()
        .followRedirects(HttpClient.Redirect.NEVER)
        .connectTimeout(Duration.ofSeconds(5))
        .build()

    /** 我们拉起来的浏览器是否还活着；进程没了顺手清状态。 */
    fun status(): Running? = synchronized(monitor) {
        val current = running ?: return@synchronized null
        if (ProcessHandle.of(current.pid).map { it.isAlive }.orElse(false)) {
            current
        } else {
            running = null
            process = null
            null
        }
    }

    fun start(startUrl: String): Running = synchronized(monitor) {
        status()?.let { return@synchronized it }
        Files.createDirectories(profileDir)
        Files.deleteIfExists(profileDir.resolve("DevToolsActivePort"))
        val executable = browserExecutable()
            ?: error("没找到 Chrome / Edge：可设环境变量 LEGADO_BROWSER_PATH 指向浏览器可执行文件")
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
        val port = awaitDebugPort(profileDir)
        if (port == null) {
            launched.destroy()
            error("浏览器没能开出调试端口，详见 ${profileDir.resolve("launch.log")}（该端口只监听 127.0.0.1）")
        }
        Running(executable.label, port, launched.pid(), System.currentTimeMillis()).also {
            process = launched
            running = it
        }
    }

    fun stop(): Boolean = synchronized(monitor) {
        val alive = process?.takeIf { it.isAlive }
        alive?.destroy()
        process = null
        running = null
        alive != null
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
     * 抓取并入库：读回全部 Cookie，按注册域归桶，只写**这本书源配置里会访问的域**。
     * 返回真正入库的域；空列表通常意味着还没登录（或该站的凭据都在别的域上）。
     */
    fun capture(hosts: List<String>): List<String> {
        val session = status() ?: return emptyList()
        val wanted = registrableSet(hosts)
        if (wanted.isEmpty()) return emptyList()
        val buckets = linkedMapOf<String, MutableMap<String, String>>()
        readAllCookies(session.port).forEach { cookie ->
            val registrable = runCatching { WebViewProxy.registrableDomain(cookie.domain) }.getOrNull() ?: return@forEach
            if (registrable !in wanted) return@forEach
            buckets.getOrPut(registrable) { linkedMapOf() }[cookie.name] = cookie.value
        }
        return buckets.mapNotNull { (domain, pairs) ->
            val value = pairs.entries.joinToString("; ") { (name, raw) -> "$name=$raw" }
            domain.takeIf { value.isNotBlank() && database.setCookieForUrl("https://$domain/", value) }
        }
    }

    private fun registrableSet(hosts: List<String>): Set<String> = hosts.mapNotNull { host ->
        runCatching { WebViewProxy.registrableDomain(host) }.getOrNull()
    }.filter { it.isNotBlank() }.toSet()

    /** 浏览器级 WS 上发 `Storage.getCookies`：不受单个 target 会话限制，且含 HttpOnly。 */
    private fun readAllCookies(port: Int): List<BrowserCookie> {
        val version = fetchJson("http://127.0.0.1:$port/json/version") as? JsonObject ?: return emptyList()
        val socketUrl = (version["webSocketDebuggerUrl"] as? JsonPrimitive)?.contentOrNull ?: return emptyList()
        val reply = CompletableFuture<String>()
        val socket = try {
            http.newWebSocketBuilder().buildAsync(URI(socketUrl), CookieFrameListener(reply)).get(8, TimeUnit.SECONDS)
        } catch (error: Exception) {
            return emptyList()
        }
        return try {
            socket.sendText("""{"id":1,"method":"Storage.getCookies"}""", true).get(5, TimeUnit.SECONDS)
            val payload = Json.parseToJsonElement(reply.get(8, TimeUnit.SECONDS)).jsonObject
            val cookies = payload["result"]?.jsonObject?.get("cookies") as? JsonArray ?: return emptyList()
            cookies.mapNotNull { element ->
                val obj = element as? JsonObject ?: return@mapNotNull null
                val domain = (obj["domain"] as? JsonPrimitive)?.contentOrNull?.trim('.') ?: return@mapNotNull null
                val name = (obj["name"] as? JsonPrimitive)?.contentOrNull ?: return@mapNotNull null
                val value = (obj["value"] as? JsonPrimitive)?.contentOrNull ?: return@mapNotNull null
                if (name.isBlank()) null else BrowserCookie(domain, name, value)
            }
        } catch (error: Exception) {
            emptyList()
        } finally {
            runCatching { socket.sendClose(WebSocket.NORMAL_CLOSURE, "done") }
        }
    }

    /** CDP 在同一条连接上还会推事件，所以只认 `id == 1` 那条回包。 */
    private class CookieFrameListener(private val target: CompletableFuture<String>) : WebSocket.Listener {
        private val buffer = StringBuilder()

        override fun onText(session: WebSocket, data: CharSequence, last: Boolean): CompletionStage<*> {
            buffer.append(data)
            if (last) {
                val text = buffer.toString()
                buffer.setLength(0)
                val wanted = runCatching {
                    (Json.parseToJsonElement(text).jsonObject["id"] as? JsonPrimitive)?.intOrNull == 1
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

    /** 端口写 0 时浏览器把真实端口写进 profile 的 DevToolsActivePort，避免我们猜端口撞车。 */
    private fun awaitDebugPort(dir: Path): Int? {
        val marker = dir.resolve("DevToolsActivePort")
        repeat(60) {
            val first = runCatching { Files.readAllLines(marker).firstOrNull()?.trim() }.getOrNull()
            first?.toIntOrNull()?.let { port -> if (port > 0) return port }
            Thread.sleep(250)
        }
        return null
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
