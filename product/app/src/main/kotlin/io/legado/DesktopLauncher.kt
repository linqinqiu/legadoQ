package io.legado

import java.awt.BorderLayout
import java.awt.Color
import java.awt.Component
import java.awt.Desktop
import java.awt.Font
import java.awt.GraphicsEnvironment
import java.awt.Image
import java.awt.MenuItem
import java.awt.PopupMenu
import java.awt.RenderingHints
import java.awt.SystemTray
import java.awt.Toolkit
import java.awt.TrayIcon
import java.awt.datatransfer.StringSelection
import java.awt.image.BufferedImage
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream
import java.io.PrintStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.time.Duration
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.CountDownLatch
import javax.imageio.ImageIO
import javax.swing.BorderFactory
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.ImageIcon
import javax.swing.JLabel
import javax.swing.JOptionPane
import javax.swing.JPanel
import javax.swing.JWindow
import javax.swing.SwingUtilities
import javax.swing.UIManager
import kotlin.io.path.absolutePathString
import kotlin.system.exitProcess

/**
 * 桌面壳入口（jpackage `--main-class io.legado.DesktopLauncherKt`）。
 *
 * 职责只有三件，与 PROPOSAL-017 / ADR-017 一致：
 *  1. 探测端口（已在跑 = 只开窗口就退，顺便充当单实例锁）；
 *  2. 带 `LEGADO_*` 起服务（复用 `createLegadoEngine`，不改 `Guard.kt`、不加鉴权）；
 *  3. 服务就绪后开一个**应用窗口**（Chromium 系的 `--app`：没有地址栏也没有标签页；找不到浏览器可执行文件
 *     才退回系统默认浏览器），并在系统托盘给一个"打开 / 数据 / 日志 / 退出"，退出时优雅关服务。
 *
 * webview 一律直接开到 `http://127.0.0.1:<port>?desktop=1`，壳只当"进程管家 + 窗口"，
 * 绝不自己加载界面当"前端宿主" —— 否则同源闸门会让所有写操作 403（详见 ADR-017 §2）。
 *
 * 0.1.7 起的壳内改进（都不碰业务代码）：
 *  - 输出同时落到 `<安装目录>/server.log`（超过 5MB 轮转成 server.log.1）；
 *  - 把 `user.dir` 钉到安装目录，`logs/`、`next/` 这类相对路径不再随"从哪双击"漂走；
 *  - 启动超过一瞬的等待有轻量启动画面（`--no-open` 下不显示，保持脚本/门禁无窗口）；
 *  - 托盘项扩成版本/地址/打开窗口/浏览器打开/数据目录/日志目录/程序目录/复制地址/退出；
 *  - 托盘图标优先用 PNG（Java ImageIO 读不了 ICO，旧实现实际是 1×1 透明图）；
 *  - 应用窗口带 `?desktop=1`，前端据此不弹 PWA 安装条（桌面版本来就不是 PWA 场景）；
 *  - 启动失败给带日志路径的对话框，而不是只在托盘停 8 秒。
 */
fun main(args: Array<String>) {
    val noOpen = args.contains("--no-open")

    val imageRoot = computeImageRoot()
    // 相对路径（logs/、next/）由 JVM 的 user.dir 解析，而它默认是"启动时所在目录"。
    // 钉到安装目录后，从开始菜单、桌面快捷方式、资源管理器双击都落同一个地方。
    System.setProperty("user.dir", imageRoot.toAbsolutePath().absolutePathString())
    val env = readEnvFile(imageRoot)
    val logFile = initLogging(imageRoot, env["LEGADO_LOG_FILE"] ?: System.getenv("LEGADO_LOG_FILE"))
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
    //  - 端口上已经是 legadoQ 自己（/healthz 报 legadoQ）→ 已在运行：只开界面然后退出，不留第二个进程；
    //  - 端口被**别的程序**占用 → 不再拒绝启动（用户 2026-10-10：「可以自定义端口，不要固定」）：
    //    从下一个端口起顺延找空闲的，用上后写回 port.txt 记住 —— 下次启动稳定在这个端口，
    //    界面里"服务端口"那一栏看到的也是它。20 个端口内都占满才认输。
    if (isPortOpen(host, port)) {
        if (isLegadoQOn(host, port)) {
            val runningUrl = "http://${if (host == "0.0.0.0" || host == "::") "127.0.0.1" else host}:$port"
            logDesktop("legadoQ 已在运行 $runningUrl")
            // 已经有一个实例在跑：这一份壳开完窗口就退，所以不装「关窗口收服务」的看门狗。
            if (!noOpen) openAppWindow(runningUrl, imageRoot, env, watchExit = false)
            exitProcess(0)
        }
        val shifted = shiftToFreePort(host, port, imageRoot) ?: run {
            val msg = "端口 $port–${port + 20} 全被别的程序占用，legadoQ 无法启动。请腾出一个或在 .env 里设 LEGADO_PORT。"
            logDesktop(msg); showError(msg, logFile, noOpen); exitProcess(1)
        }
        port = shifted
    } else if (!canBind(host, port)) {
        // 端口上没人监听、但也绑不上（防火墙/权限）：同样顺延。
        val shifted = shiftToFreePort(host, port, imageRoot) ?: run {
            val msg = "端口 $port 无法绑定，且 $port–${port + 20} 内没有空闲端口。"
            logDesktop(msg); showError(msg, logFile, noOpen); exitProcess(1)
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

    logDesktop("legadoQ ${BuildInfo.version} 启动中 $url")
    logDesktop("安装目录 $imageRoot")
    logDesktop("数据目录 $dataDir")
    logDesktop("壳日志   $logFile")
    logDesktop("运行日志 ${imageRoot.resolve("logs")}")
    logDesktop("临时目录 $tmpDir")

    if (!noOpen) initLookAndFeel()
    val splash = if (noOpen) null else showSplash(imageRoot, BuildInfo.version, url)

    val engine = try {
        createLegadoEngine(config)
    } catch (error: Throwable) {
        failStartup("服务初始化失败", error, splash, logFile, noOpen, dataDir)
    }
    // 优雅关闭：托盘"退出"或进程被终止（SIGINT/SIGTERM）都走这里，服务干净收尾。
    Runtime.getRuntime().addShutdownHook(Thread {
        try { engine.stop(5000, 10000) } catch (_: Throwable) { }
        logDesktop("服务已停止")
    })
    try {
        engine.start(wait = false)
    } catch (error: Throwable) {
        failStartup("服务启动失败", error, splash, logFile, noOpen, dataDir)
    }

    val ready = waitForHealth(url)
    splash?.close()
    if (!ready) {
        val msg = "等了很久服务 $url 还没就绪，看看日志：$logFile"
        logDesktop(msg)
        showError(msg, logFile, noOpen)
        exitProcess(1)
    }
    logDesktop("服务已就绪 $url")
    if (!noOpen) openAppWindow(url, imageRoot, env)
    val trayReady = showTray(BuildInfo.version, url, dataDir, imageRoot, env)
    if (!trayReady) logDesktop("系统托盘不可用（关掉窗口即退出，服务不会常驻）")
    CountDownLatch(1).await() // 守住主线程，靠托盘"退出"或外部信号结束
}

/** 壳自身输出的落盘：stdout/stderr 同时写控制台与 `<安装目录>/server.log`，超限轮转一次。 */
private const val MAX_LOG_BYTES = 5L * 1024 * 1024

private fun initLogging(root: Path, declared: String?): Path {
    val logFile = when {
        declared.isNullOrBlank() -> root.resolve("server.log")
        File(declared).isAbsolute -> Path.of(declared)
        else -> root.resolve(declared)
    }
    runCatching { logFile.parent?.toFile()?.mkdirs() }
    runCatching {
        val file = logFile.toFile()
        if (file.isFile && file.length() > MAX_LOG_BYTES) {
            Files.move(file.toPath(), logFile.resolveSibling("${logFile.fileName}.1"), StandardCopyOption.REPLACE_EXISTING)
        }
    }
    runCatching {
        val fileOut = FileOutputStream(logFile.toFile(), true)
        val lock = Any()
        System.setOut(PrintStream(TeeStream(System.out, fileOut, lock), true, StandardCharsets.UTF_8))
        System.setErr(PrintStream(TeeStream(System.err, fileOut, lock), true, StandardCharsets.UTF_8))
    }
    Thread.setDefaultUncaughtExceptionHandler { thread, error ->
        System.err.println("[legadoQ] 未捕获异常（${thread.name}）：${error::class.simpleName}: ${error.message}")
    }
    return logFile
}

/** 控制台 + 文件各写一份；两个 PrintStream 共用同一个文件流，靠 [lock] 保证整行不乱序。 */
private class TeeStream(
    private val console: OutputStream,
    private val file: OutputStream,
    private val lock: Any,
) : OutputStream() {
    override fun write(b: Int) {
        synchronized(lock) {
            runCatching { console.write(b) }
            runCatching { file.write(b); file.flush() }
        }
    }

    override fun write(b: ByteArray, off: Int, len: Int) {
        synchronized(lock) {
            runCatching { console.write(b, off, len) }
            runCatching { file.write(b, off, len); file.flush() }
        }
    }

    override fun flush() {
        synchronized(lock) {
            runCatching { console.flush() }
            runCatching { file.flush() }
        }
    }
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

/** 端口上跑的是不是 legadoQ 自己：/healthz 的应答体里有应用名才算（别的程序占着端口不算）。 */
private fun isLegadoQOn(host: String, port: Int): Boolean {
    return try {
        val client = HttpClient.newBuilder().connectTimeout(Duration.ofMillis(1200)).build()
        val res = client.send(
            HttpRequest.newBuilder(URI("http://$host:$port/healthz")).timeout(Duration.ofMillis(1200)).GET().build(),
            HttpResponse.BodyHandlers.ofString(),
        )
        res.body().contains("legadoQ")
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

/** 开"应用窗口"：优先 Chromium 系 `--app`（无地址栏/标签页），找不到才退回系统默认浏览器。 */
private fun openAppWindow(url: String, imageRoot: Path, env: Map<String, String>, watchExit: Boolean = true): Boolean {
    val appUrl = if (url.contains('?')) "$url&desktop=1" else "$url?desktop=1"
    val browser = browserExecutable(env)
    if (browser != null) {
        val opened = runCatching {
            val process = ProcessBuilder(
                browser.absolutePath,
                "--app=$appUrl",
                // 专用 profile：Edge/Chrome 已经用默认 profile 开着窗时，`--app` 会被并进那个进程
                // 变成**又一个标签页** —— 换一个 profile 目录才保证是"一个新窗口"（用户的原话诉求）。
                "--user-data-dir=${imageRoot.resolve("browser-profile").absolutePathString()}",
                "--no-first-run",
                "--no-default-browser-check",
                "--window-size=${appWindowSize()}",
            ).start()
            // 关窗口 = 收服务（PROPOSAL-017 §6-5 的"桌面直觉"）。要服务常驻就用 `--no-open` 起壳，托盘还在。
            // 从托盘再开一个窗口时**不装这个看门狗**：那扇窗关掉不该把整个服务带走（watchExit=false）。
            if (watchExit) {
                Thread {
                    runCatching { process.waitFor() }
                    logDesktop("窗口已关闭，退出服务")
                    exitProcess(0) // shutdown hook 会 engine.stop(...)，端口与进程都干净归零
                }.apply { isDaemon = true; name = "legadoq-window-watcher" }.start()
            }
            true
        }.getOrDefault(false)
        if (opened) return true
    }
    return openInDefaultBrowser(appUrl)
}

/** 系统默认浏览器打开（托盘的"在浏览器中打开"也走这里，不带看门狗）。 */
private fun openInDefaultBrowser(url: String): Boolean {
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

/** 应用窗口尺寸：大屏给 1280×860，小屏按可视区域收，避免窗口比屏幕还大。 */
private fun appWindowSize(): String {
    val screen = runCatching { Toolkit.getDefaultToolkit().screenSize }.getOrNull()
    val width: Int
    val height: Int
    if (screen == null) {
        width = 1280; height = 860
    } else {
        width = minOf(1280, (screen.width - 160).coerceAtLeast(880))
        height = minOf(860, (screen.height - 140).coerceAtLeast(620))
    }
    return "$width,$height"
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

private val logTimeFormat = DateTimeFormatter.ofPattern("HH:mm:ss")

private fun logDesktop(message: String) {
    println("[legadoQ ${LocalTime.now().format(logTimeFormat)}] $message")
}

private fun initLookAndFeel() {
    runCatching { UIManager.setLookAndFeel(UIManager.getSystemLookAndFeelClassName()) }
}

/** 轻量启动画面：只在等待服务就绪时露面，就绪/失败都立刻关掉。`--no-open` 下不创建（脚本无窗口）。 */
private class SplashScreen(private val window: JWindow) {
    fun close() = SwingUtilities.invokeLater { runCatching { window.dispose() } }
}

private fun showSplash(imageRoot: Path, version: String, url: String): SplashScreen? {
    if (GraphicsEnvironment.isHeadless()) return null
    return runCatching {
        var created: JWindow? = null
        SwingUtilities.invokeAndWait {
            val panel = JPanel(BorderLayout(14, 0))
            panel.background = Color(0xFC, 0xFC, 0xFD)
            panel.border = BorderFactory.createCompoundBorder(
                BorderFactory.createLineBorder(Color(0xDD, 0xE1, 0xE8)),
                BorderFactory.createEmptyBorder(18, 22, 18, 26),
            )
            loadIcon(imageRoot)?.let { logo ->
                panel.add(JLabel(ImageIcon(logo.getScaledInstance(52, 52, Image.SCALE_SMOOTH))), BorderLayout.WEST)
            }
            val texts = JPanel()
            texts.isOpaque = false
            texts.layout = BoxLayout(texts, BoxLayout.Y_AXIS)
            texts.add(JLabel("legadoQ").apply {
                font = Font("Microsoft YaHei UI", Font.BOLD, 17)
                foreground = Color(0x1F, 0x23, 0x28)
                alignmentX = Component.LEFT_ALIGNMENT
            })
            texts.add(Box.createVerticalStrut(6))
            texts.add(JLabel("正在启动服务 · $version").apply {
                font = Font("Microsoft YaHei UI", Font.PLAIN, 12)
                foreground = Color(0x5F, 0x63, 0x68)
                alignmentX = Component.LEFT_ALIGNMENT
            })
            texts.add(Box.createVerticalStrut(3))
            texts.add(JLabel(url).apply {
                font = Font("Consolas", Font.PLAIN, 11)
                foreground = Color(0x8A, 0x8F, 0x98)
                alignmentX = Component.LEFT_ALIGNMENT
            })
            panel.add(texts, BorderLayout.CENTER)
            created = JWindow().apply {
                contentPane = panel
                pack()
                setLocationRelativeTo(null)
                isAlwaysOnTop = true
                isVisible = true
            }
        }
        created?.let { SplashScreen(it) }
    }.getOrNull()
}

/**
 * 系统托盘：版本/地址只读展示，其余是可执行项。
 * `--no-open` 时托盘仍在（stop.mjs / 门禁靠进程管理，不靠托盘），双击图标等于"打开应用窗口"。
 */
private fun showTray(version: String, url: String, dataDir: Path, imageRoot: Path, env: Map<String, String>): Boolean {
    if (!SystemTray.isSupported()) return false
    return runCatching {
        val tray = SystemTray.getSystemTray()
        val popup = PopupMenu()

        fun item(label: String, enabled: Boolean = true, onClick: (() -> Unit)? = null): MenuItem =
            MenuItem(label).also { entry ->
                entry.isEnabled = enabled
                if (onClick != null) entry.addActionListener { onClick() }
            }

        popup.add(item("legadoQ $version", enabled = false))
        popup.add(item(url, enabled = false))
        popup.addSeparator()
        popup.add(item("打开应用窗口").also { entry ->
            entry.font = (entry.font ?: Font("SansSerif", Font.PLAIN, 12)).deriveFont(Font.BOLD)
            entry.addActionListener { openAppWindow(url, imageRoot, env, watchExit = false) }
        })
        popup.add(item("在浏览器中打开") { openInDefaultBrowser(url) })
        popup.addSeparator()
        popup.add(item("打开数据目录") { openPath(dataDir) })
        popup.add(item("打开日志目录") { openPath(imageRoot.resolve("logs")) })
        popup.add(item("打开程序目录") { openPath(imageRoot) })
        popup.addSeparator()
        popup.add(item("复制访问地址") { copyToClipboard(url) })
        popup.addSeparator()
        popup.add(item("退出 legadoQ") { exitProcess(0) })

        val icon = TrayIcon(loadIcon(imageRoot), "legadoQ $version · $url", popup).also {
            it.isImageAutoSize = true
            it.addActionListener { openAppWindow(url, imageRoot, env, watchExit = false) }
        }
        tray.add(icon)
        true
    }.getOrDefault(false)
}

private fun openPath(path: Path) {
    runCatching {
        if (!Desktop.isDesktopSupported()) return@runCatching
        val file = path.toFile()
        if (!file.exists()) file.mkdirs()
        if (file.exists()) Desktop.getDesktop().open(if (file.isDirectory) file else file.parentFile)
    }.onFailure { logDesktop("打不开 $path：${it.message}") }
}

private fun copyToClipboard(text: String) {
    runCatching {
        Toolkit.getDefaultToolkit().systemClipboard.setContents(StringSelection(text), null)
        logDesktop("已复制访问地址 $text")
    }.onFailure { logDesktop("复制失败：${it.message}") }
}

private object ShellAssets {
    fun open(name: String) = ShellAssets::class.java.getResourceAsStream(name)
}

/** 托盘/启动画面图标：PNG 优先（ImageIO 读不了 ICO，旧实现只会得到 1×1 透明图）。 */
private fun loadIcon(imageRoot: Path): Image? {
    readImage(imageRoot.resolve("app.png").toFile())?.let { return it }
    runCatching { ShellAssets.open("/static/brand-logo-96.png")?.use { ImageIO.read(it) } }.getOrNull()?.let { return it }
    readImage(imageRoot.resolve("app.ico").toFile())?.let { return it }
    return fallbackIcon()
}

private fun readImage(file: File): Image? =
    if (file.isFile) runCatching { ImageIO.read(file) }.getOrNull() else null

/** 兜底图标：不与品牌图争，只保证托盘不是一块空白。 */
private fun fallbackIcon(): Image {
    val size = 32
    val image = BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB)
    val g = image.createGraphics()
    try {
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
        g.color = Color(0x2F, 0x6F, 0xED)
        g.fillRoundRect(0, 0, size, size, 10, 10)
        g.color = Color.WHITE
        g.font = Font("SansSerif", Font.BOLD, 20)
        val metrics = g.fontMetrics
        val text = "Q"
        g.drawString(text, (size - metrics.stringWidth(text)) / 2, (size - metrics.height) / 2 + metrics.ascent)
    } finally {
        g.dispose()
    }
    return image
}

/**
 * 启动失败统一出口：日志里留**完整堆栈**，对话框里只留一句能照着做的提示。
 *
 * 只打 `error.message` 曾让一次真实故障在日志里只剩 `opening db: '…': 拒绝访问。`——
 * 看不出是谁拒绝的；而 sqlite 那条消息还会把"原生库解不出来"也念成"打不开库"，
 * 堆栈是唯一能区分二者的证据。数据目录权限问题另外补一句可照做的提示
 * （低完整性/受控目录、Program Files 这类安装位置都会走到这里）。
 */
private fun failStartup(
    prefix: String,
    error: Throwable,
    splash: SplashScreen?,
    logFile: Path,
    noOpen: Boolean,
    dataDir: Path,
): Nothing {
    splash?.close()
    System.err.println("[legadoQ] $prefix：${error::class.simpleName}: ${error.message}")
    error.printStackTrace()
    val reason = error.message ?: error::class.simpleName ?: "未知错误"
    val writableHint = if (ACCESS_DENIED_HINT.containsMatchIn(reason)) {
        "\n\n数据目录不可写：$dataDir\n换一个有写权限的目录，或在 .env 里用 LEGADO_DATA_DIR 指定。"
    } else ""
    val msg = "$prefix：$reason$writableHint"
    logDesktop(msg)
    showError(msg, logFile, noOpen)
    exitProcess(1)
}

private val ACCESS_DENIED_HINT =
    Regex("拒绝访问|Access is denied|AccessDenied|SQLITE_CANTOPEN|opening db", RegexOption.IGNORE_CASE)

private fun showError(message: String, logFile: Path, noOpen: Boolean) {
    System.err.println("[legadoQ] $message")
    if (noOpen || GraphicsEnvironment.isHeadless()) return
    runCatching {
        initLookAndFeel()
        SwingUtilities.invokeAndWait {
            JOptionPane.showMessageDialog(
                null,
                "$message\n\n运行日志：$logFile",
                "legadoQ 启动失败",
                JOptionPane.ERROR_MESSAGE,
            )
        }
    }
}
