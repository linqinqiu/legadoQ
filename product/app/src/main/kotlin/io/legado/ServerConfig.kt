package io.legado

import java.nio.file.Path
import kotlin.io.path.absolutePathString

data class ServerConfig(
    val host: String,
    val port: Int,
    val databasePath: String,
    val coverCacheDirectory: Path,
    val localBooksDirectory: Path = coverCacheDirectory.resolveSibling("local_books"),
    /** 新骨架前端的磁盘目录；没有这个目录就不挂 `/next`（见 [staticNext]）。 */
    val nextDirectory: Path = Path.of("next"),
    /**
     * 安装根：界面里改端口时把 `port.txt` 写在这里（启动器下次就从它读端口）。
     * `LEGADO_HOME` 由启动器传（见 `scripts/runtime.mjs` 的 `childEnvironment`）；裸跑 jar 就取当前目录。
     */
    val homeDirectory: Path = Path.of("."),
    /**
     * 是否允许绑定到非回环地址。默认取 `LEGADO_ALLOW_EXTERNAL_BIND`（默认 false）。
     *
     * 放进配置对象而不是每次现读环境变量：这是**这次运行**的属性，测试要能显式声明
     * 「我就是在验绑 0.0.0.0 时的行为」，而不是去改全局环境变量。
     */
    val allowExternalBind: Boolean = AppConfig.allowExternalBind,
) {
    companion object {

        /**
         * 请求是否来自本机。用显式前缀而不是正则：`::1$` 这类锚点会把 `2001:db8::1` 误判成本机，
         * 而 IPv4-mapped 的 `::ffff:127.0.0.1` 与 `127.0.0.53` 又必须放行。
         */
        fun isLoopbackRemote(remoteHost: String?): Boolean {
            val host = remoteHost?.trim() ?: return false
            return host == "::1" || host == "localhost" || host.startsWith("127.") || host.startsWith("::ffff:127.")
        }

        fun fromEnvironment(env: Map<String, String> = System.getenv()): ServerConfig {
            // 裸跑 jar 的默认值必须"安全且友好"：数据落在当前目录的 data/（不写系统盘、不需要 root），
            // 只绑回环——本服务不设身份，绑定地址就是唯一的门（详见 AGENTS.md）。要对外提供服务，
            // 由部署方显式设 LEGADO_HOST=0.0.0.0（Dockerfile / 计算巢模板里都这么写）。
            val dataDir = Path.of(env["LEGADO_DATA_DIR"] ?: "data").toAbsolutePath()
            val host = env["LEGADO_HOST"] ?: "127.0.0.1"
            return ServerConfig(
                host = host,
                port = env["LEGADO_PORT"]?.toIntOrNull() ?: 8080,
                databasePath = env["LEGADO_DATABASE"] ?: dataDir.resolve("legado.sqlite").absolutePathString(),
                coverCacheDirectory = dataDir.resolve("covers"),
                localBooksDirectory = dataDir.resolve("local_books"),
                // 相对当前工作目录，与 data/ 同一套规矩：整合包解开在哪，就在哪找 next/
                nextDirectory = Path.of(env["LEGADO_NEXT_DIR"] ?: "next"),
                homeDirectory = Path.of(env["LEGADO_HOME"] ?: ".").toAbsolutePath(),
                allowExternalBind = AppConfig.allowExternalBind,
            )
        }
    }
}
