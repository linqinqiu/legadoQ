package io.legado

import java.io.File
import java.nio.file.Files
import java.nio.file.Path

/**
 * 数据目录选址结果：实际路径 + 是否从便携位置退回到了用户目录。
 *
 * 单独拆出来是为了能测：这段逻辑决定"用户的库到底在哪"，出错的表现是"书全没了"，
 * 不能只靠手工双击安装包去验。
 */
internal data class DataDirChoice(val path: Path, val fellBack: Boolean)

/**
 * 选数据目录。
 *
 * 规则：
 * - 显式配置（`.env` / 环境变量 `LEGADO_DATA_DIR`）**永远优先**，且**不**做退回 ——
 *   用户点名了路径，就按他说的用；不可写时由调用方如实报错。静默改到别处，
 *   在用户眼里就是"数据全丢了"。
 * - 没配置时用便携语义 `<镜像根>/data`；**只有它不可写**才退回 `%LOCALAPPDATA%\legadoQ\data`。
 *   这一条是给"解压到 `C:\Program Files` 直接双击"准备的：那里默认写不进去，
 *   旧行为是启动失败并弹一句"数据目录不可写"。
 * - 连 `LOCALAPPDATA` 都没有（极简环境）时保持原路径，让既有的失败对话框去解释。
 */
internal fun chooseDataDir(
    imageRoot: Path,
    configured: String?,
    localAppData: String?,
    writable: (Path) -> Boolean,
): DataDirChoice {
    if (!configured.isNullOrBlank()) {
        val path = if (File(configured).isAbsolute) Path.of(configured) else imageRoot.resolve(configured).toAbsolutePath()
        return DataDirChoice(path, fellBack = false)
    }
    val portable = imageRoot.resolve("data").toAbsolutePath()
    if (writable(portable)) return DataDirChoice(portable, fellBack = false)
    val fallback = localAppData
        ?.takeIf { it.isNotBlank() }
        ?.let { Path.of(it).resolve("legadoQ").resolve("data").toAbsolutePath() }
        ?: return DataDirChoice(portable, fellBack = false)
    return DataDirChoice(fallback, fellBack = true)
}

/**
 * 真去建目录并写一个探针文件。
 *
 * 不用 `File.canWrite()`：它看的是 ACL 位，而 Program Files 下的实际失败来自 UAC 虚拟化 /
 * 继承权限，`canWrite()` 会返回 true 然后写的时候才炸。探针文件是唯一可信的判据。
 */
internal fun isWritableDir(path: Path): Boolean = runCatching {
    Files.createDirectories(path)
    val probe = Files.createTempFile(path, ".write-probe", ".tmp")
    Files.deleteIfExists(probe)
    true
}.getOrDefault(false)
