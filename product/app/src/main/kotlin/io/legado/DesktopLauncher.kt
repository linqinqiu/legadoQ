package io.legado

import java.awt.Desktop
import java.awt.MenuItem
import java.awt.PopupMenu
import java.awt.SystemTray
import java.awt.TrayIcon
import java.awt.event.ActionListener
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Path
import kotlin.io.path.absolutePathString
import java.time.Duration
import java.util.concurrent.CountDownLatch
import javax.imageio.ImageIO
import kotlin.system.exitProcess

/**
 * 桌面壳入口（jpackage `--main-class io.legado.DesktopLauncherKt`）。
 *
 * 职责只有三件，与 PROPOSAL-017 / ADR-017 一期一致：
 *  1. 探测端口（占用即退出，顺便充当单实例锁）；
 *  2. 带 `LEGADO_*` 起服务（复用 `createLegadoEngine`，不改 `Guard.kt`、不加鉴权）；
 *  3. 服务就绪后开一个**应用窗口**（Chromium 系的 `--app`：没有地址栏也没有标签页；找不到浏览器可执行文件
 *     才退回系统默认浏览器），并在系统托盘给一个"打开 / 退出"，退出时优雅关服务。
 *
 * webview 一律直接开到 `http://127.0.0.1:<port>`，壳只当"进程管家 + 窗口"，
 * 绝不自己加载界面当"前端宿主" —— 否则同源闸门会让所有写操作 403（详见 ADR-017 §2）。
 */
fun main(args: Array<String>) {
    val noOpen = args.contains("--no-open")

    val imageRoot = computeImageRoot()
    val env = readEnvFile(imageRoot)
    val pick = { name: String, fallback: String -> env[name] ?: System.getenv(name) ?: fallback }

    // 端口优先级：port.txt（界面上最后改的那一下）> .env / 环境变量 > 固定 1234。
    // 必须显式定死：裸 jar 默认是 8080，不传就会"起了但连不上"。
    val host = pick("LEGADO_HOST", "127.0.0.1")
    var port = readPortFile(imageRoot) ?: pick("LEGADO_PORT", "1234").toIntOrNull() ?: 1234

    // 数据目录：.env / 环境变量显式给的优先；相对路径相对"镜像根"（exe 所在目录）解析；
    // 都没给就落在 <镜像根>/data（便携、不写系统盘）。不静默迁移，首屏用 .env 记住选择即可。
    val dataDirRaw = pick("LEGADO_DATA_DIR", "data")
    val dataDir = if (File(dataDirRaw).isAbsolute) Path.of(dataDirRaw) else imageRoot.resolve(dataDirRaw).toAbsolutePath()
    val databasePath = env["LEGADO_DATABASE"] ?: System.getenv("LEGADO_DATABASE")
        ?: dataDir.resolve("legado.sqlite").absolutePathString()

    // 不让 JVM 临时目录落到系统盘（默认是 C:\Users\<用户>\AppData\Local\Temp）。
    val tmpDir = imageRoot.resolve("tmp")
    tmpDir.toFile().mkdirs()
    System.setProperty("java.io.tmpdir", tmpDir.toString())

    // 端口策略（决策必须在 ServerConfig/url 构造之前完成）：
    //  - 端口上已经是青阅自己（/healthz 报青阅）→ 已在运行：只开界面然后退出，不留第二个进程；
    //  - 端口被**别的程序**占用 → 不再拒绝启动（用户 2026-10-10：「可以自定义端口，不要固定」）：
    //    从下一个端口起顺延找空闲的，用上后写回 port.txt 记住 —— 下次启动稳定在这个端口，
    //    界面里"服务端口"那一栏看到的也是它。20 个端口内都占满才认输。
    if (isPortOpen(host, port)) {
        if (isQingyueOn(host, port)) {
            val runningUrl = "http://${if (host == "0.0.0.0" || host == "::") "127.0.0.1" else host}:$port"
            logDesktop("青阅已在运行 $runningUrl")
            // 已经有一个实例在跑：这一份壳开完窗口就退，所以不装「关窗口收服务」的看门狗。
            if (!noOpen) openBrowser(runningUrl, imageRoot, env, watchExit = false)
            exitProcess(0)
        }
        val shifted = shiftToFreePort(host, port, imageRoot) ?: run {
            val msg = "端口 $port–${port + 20} 全被别的程序占用，青阅无法启动。请腾出一个或在 .env 里设 LEGADO_PORT。"
            logDesktop(msg); showError(msg); exitProcess(1)
        }
        port = shifted
    } else if (!canBind(host, port)) {
        // 端口上没人监听、但也绑不上（防火墙/权限）：同样顺延。
        val shifted = shiftToFreePort(host, port, imageRoot) ?: run {
            val msg = "端口 $port 无法绑定，且 $port–${port + 20} 内没有空闲端口。"
            logDesktop(msg); showError(msg); exitProcess(1)
        }
        port = shifted
    }

    val config = ServerConfig(
        host = host,
        port = port,
        databasePath = databasePath,
        coverCacheDirectory = dataDir.resolve("covers"),
        localBooksDirectory = dataDir.resolve("local_books"),
        nextDirectory = Path.of(pick("LEGADO_NEXT_DIR", "next")),
        homeDirectory = imageRoot.toAbsolutePath(),
    )

    val browseHost = if (host == "0.0.0.0" || host == "::") "127.0.0.1" else host
    val url = "http://$browseHost:$port"

    logDesktop("青阅 ${BuildInfo.version} 启动中 $url")
    logDesktop("安装目录 $imageRoot")
    logDesktop("数据目录 $dataDir")
    logDesktop("日志     ${imageRoot.resolve("server.log")}")
    logDesktop("临时目录 $tmpDir")

    val engine = createLegadoEngine(config)
    // 优雅关闭：托盘"退出"或进程被终止（SIGINT/SIGTERM）都走这里，服务干净收尾。
    engine.start(wait = false)
    Runtime.getRuntime().addShutdownHook(Thread {
        try { engine.stop(5000, 10000) } catch (_: Throwable) { }
    })

    val ready = waitForHealth(url)
    if (!ready) {
        val msg = "等了很久服务 $url 还没就绪，看看日志：${imageRoot.resolve("server.log")}"
        logDesktop(msg)
        showError(msg)
        exitProcess(1)
    }
    logDesktop("服务已就绪 $url")
    if (!noOpen) openBrowser(url, imageRoot, env)
    showTray("青阅", url, imageRoot, noOpen, env)
    CountDownLatch(1).await() // 守住主线程，靠托盘"退出"或外部信号结束
}

private fun computeImageRoot(): Path {
    val cp = System.getProperty("java.class.path") ?: ""
    val jarEntry = cp.split(File.pathSeparatorChar).firstOrNull { it.endsWith(".jar") }
    val jarFile = if (jarEntry != null) File(jarEntry) else null
    // 打包后 jar 在 <镜像>/app/<jar>：父目录名是 "app"，镜像根再上一级。
    if (jarFile != null && jarFile.parentFile?.name == "app") return jarFile.parentFile!!.parentFile!!.toPath()
    // 开发/IDE 里跑：退回工作目录。
    return Path.of(System.getProperty("user.dir"))
}

private fun readEnvFile(root: Path): Map<String, String> {
    val file = root.resolve(".env")
    if (!file.toFile().exists()) return emptyMap()
    return file.toFile().readText().split(Regex("\r?\n"))
        .mapNotNull { Regex("^\\s*([A-Z_][A-Z0-9_]*)\\s*=\\s*(.*)$").matchEntire(it) }
        .associate { it.groupValues[1] to it.groupValues[2].trim().removeSurrounding("'", "\"").removeSurrounding("\"", "\"") }
}

private fun readPortFile(root: Path): Int? {
    val file = root.resolve("port.txt")
    if (!file.toFile().exists()) return null
    val n = file.toFile().readText().trim().toIntOrNull()
    return if (n != null && n > 0 && n < 65536) n else null
}

private fun isPortOpen(host: String, port: Int): Boolean = try {
    Socket().use { it.connect(InetSocketAddress(host, port), 1000); true }
} catch (_: Throwable) { false }

private fun canBind(host: String, port: Int): Boolean = try {
    java.net.ServerSocket().use { it.bind(InetSocketAddress(host, port)); true }
} catch (_: Throwable) { false }

/** 从 from..to 里找第一个能绑上的端口；一个都没有返回 null。 */
private fun findFreePort(host: String, from: Int, to: Int): Int? {
    for (p in from..to) if (canBind(host, p)) return p
    return null
}

/**
 * 被占用后顺延：挑一个空闲端口并写回 port.txt 记住（下次启动稳定在它上面，
 * 界面里"服务端口"读到的也是它）。返回 null 表示范围内全满。
 */
private fun shiftToFreePort(host: String, occupied: Int, imageRoot: Path): Int? {
    val shifted = findFreePort(host, occupied + 1, occupied + 20) ?: return null
    imageRoot.resolve("port.txt").toFile().writeText("$shifted\n")
    logDesktop("端口 $occupied 被占用，自动改用 $shifted（已写进 port.txt 记住）")
    return shifted
}

/** 端口上跑的是不是青阅自己：/healthz 的应答体里有应用名才算（别的程序占着端口不算）。 */
private fun isQingyueOn(host: String, port: Int): Boolean {
    return try {
        val client = HttpClient.newBuilder().connectTimeout(Duration.ofMillis(1200)).build()
        val res = client.send(
            HttpRequest.newBuilder(URI("http://$host:$port/healthz")).timeout(Duration.ofMillis(1200)).GET().build(),
            HttpResponse.BodyHandlers.ofString(),
        )
        res.body().contains("青阅")
    } catch (_: Throwable) { false }
}

private fun waitForHealth(url: String, timeoutMs: Long = 120_000): Boolean {
    val client = HttpClient.newBuilder().connectTimeout(Duration.ofMillis(2000)).build()
    val deadline = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < deadline) {
        try {
            val res = client.send(
                HttpRequest.newBuilder(URI("$url/healthz")).timeout(Duration.ofMillis(2000)).GET().build(),
                HttpResponse.BodyHandlers.discarding(),
            )
            if (res.statusCode() == 200) return true
        } catch (_: Throwable) { }
        Thread.sleep(400)
    }
    return false
}

private fun openBrowser(url: String, imageRoot: Path, env: Map<String, String>, watchExit: Boolean = true): Boolean {
    val browser = browserExecutable(env)
    if (browser != null) {
        val opened = runCatching {
            val process = ProcessBuilder(
                browser.absolutePath,
                "--app=$url",
                // 专用 profile：Edge/Chrome 已经用默认 profile 开着窗时，`--app` 会被并进那个进程
                // 变成**又一个标签页** —— 换一个 profile 目录才保证是"一个新窗口"（用户的原话诉求）。
                "--user-data-dir=${imageRoot.resolve("browser-profile").absolutePathString()}",
                "--no-first-run",
                "--no-default-browser-check",
            ).start()
            // 关窗口 = 收服务（PROPOSAL-017 §6-5 的"桌面直觉"）。要服务常驻就用 `--no-open` 起壳，托盘还在。
            // 从托盘再开一个窗口时**不装这个看门狗**：那扇窗关掉不该把整个服务带走（watchExit=false）。
            if (watchExit) {
                Thread {
                    runCatching { process.waitFor() }
                    logDesktop("窗口已关闭，退出服务")
                    exitProcess(0) // shutdown hook 会 engine.stop(...)，端口与进程都干净归零
                }.apply { isDaemon = true; name = "qingyue-window-watcher" }.start()
            }
            true
        }.getOrDefault(false)
        if (opened) return true
    }
    // `Desktop.browse` 返回 Unit，直接放进 runCatching 会让整块推断成 Any 而不是 Boolean。
    val openedDefault = runCatching {
        if (!Desktop.isDesktopSupported()) false
        else {
            Desktop.getDesktop().browse(URI(url))
            true
        }
    }.getOrDefault(false)
    if (!openedDefault) logDesktop("没能自动打开界面，手动访问 $url")
    return openedDefault
}

/**
 * 找一个能开 `--app` 窗口的浏览器可执行文件：环境变量优先，然后按系统目录找 Edge / Chrome。
 * 一律从 `PROGRAMFILES(X86)` / `PROGRAMFILES` / `LOCALAPPDATA` 这几个环境变量拼，
 * 不写死任何一台机器的绝对路径（`opensource-hygiene-check` 那条「不许有个人盘符路径」也在管这个）。
 */
private fun browserExecutable(env: Map<String, String>): File? {
    // `.env` 里写的也算（壳自己读的这份文件优先于进程环境，与其它 LEGADO_* 一个口径）。
    (env["LEGADO_BROWSER_PATH"] ?: System.getenv("LEGADO_BROWSER_PATH"))?.let { declared ->
        val file = File(declared)
        if (file.isFile) return file
    }
    val roots = listOf("PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)")
        .mapNotNull { System.getenv(it) }
        .map(::File)
    val candidates = roots.flatMap { root ->
        listOf(
            File(root, "Microsoft/Edge/Application/msedge.exe"),
            File(root, "Google/Chrome/Application/chrome.exe"),
        )
    }
    return candidates.firstOrNull { it.isFile }
}

private fun logDesktop(message: String) {
    println("[青阅] $message")
}

private fun loadIcon(imageRoot: Path): java.awt.Image? {
    val ico = imageRoot.resolve("app.ico").toFile()
    if (ico.exists()) runCatching { return ImageIO.read(ico) }.getOrNull()
    // 退路：1x1 透明图，保证 TrayIcon 不空。
    return java.awt.image.BufferedImage(1, 1, java.awt.image.BufferedImage.TYPE_INT_ARGB)
}

private fun showTray(title: String, url: String, imageRoot: Path, noOpen: Boolean, env: Map<String, String>) {
    if (!SystemTray.isSupported()) return
    runCatching {
        val tray = SystemTray.getSystemTray()
        val popup = PopupMenu()
        val openItem = MenuItem("打开青阅").also { it.addActionListener(ActionListener { openBrowser(url, imageRoot, env, watchExit = false) }) }
        val exitItem = MenuItem("退出").also { it.addActionListener(ActionListener { exitProcess(0) }) }
        popup.add(openItem)
        popup.add(exitItem)
        val icon = TrayIcon(loadIcon(imageRoot), title, popup).also {
            it.isImageAutoSize = true
            if (!noOpen) it.addActionListener(ActionListener { openBrowser(url, imageRoot, env, watchExit = false) })
        }
        tray.add(icon)
    }
}

private fun showError(message: String) {
    if (!SystemTray.isSupported()) return
    runCatching {
        val tray = SystemTray.getSystemTray()
        val popup = PopupMenu()
        val exitItem = MenuItem("退出").also { it.addActionListener(ActionListener { exitProcess(1) }) }
        popup.add(MenuItem(message))
        popup.add(exitItem)
        val icon = TrayIcon(loadIcon(Path.of(System.getProperty("user.dir"))), "青阅", popup).also { it.isImageAutoSize = true }
        tray.add(icon)
        Thread.sleep(8000) // 错误托盘停留几秒，给用户看到提示
    }
}
