package io.legado.data

import kotlinx.serialization.Serializable
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.sql.Connection
import java.util.Comparator

/** 一份快照的清单条目：字节数、sidecar 记录的 SHA-256、实测是否吻合（完整性判定）、创建时刻。 */
@Serializable
data class SnapshotInfo(
    val name: String,
    val bytes: Long,
    val sha256: String?,
    val verified: Boolean,
    val createdAt: Long,
)

/**
 * 启动时给 SQLite 库做一份**文件级一致性快照**（`VACUUM INTO`），落在 `<库同目录>/backups/`，
 * 每份配一个 SHA-256 sidecar，只保留最近 N 份。目的：用户误操作、坏迁移、或进程崩溃把库
 * 写坏时，手里有一份**能直接打开、且能验证没坏**的历史副本，而不是只有"内容导出"那一层。
 *
 * 为什么用 `VACUUM INTO` 而不是直接复制 `.db`：WAL 模式下尚未合并的 `-wal` 段不在 `.db` 文件里，
 * 裸拷文件可能拿到"半提交"的状态（恢复时 `database disk image is malformed`）。`VACUUM INTO`
 * 走 SQLite 自带的在线备份语义，产出**已合并、自包含**的单文件快照（与本类 `reclaimFreePages`
 * 用 `VACUUM` 的同一手法，也是这里刻意复用连接、不新开读连接的原因）。
 *
 * 失败一律不抛错打断启动：快照是保险，"保险没做成"不该把主程序带崩——只打一条带原因的 stderr，
 * 与 `reclaimFreePages`「失败必须说出来」同一口径。
 */
object DbSnapshot {
    private const val PREFIX = "legado-"
    private const val SUFFIX = ".sqlite"

    fun backupsDirOf(dbPath: String): Path =
        Paths.get(dbPath).toAbsolutePath().parent.resolve("backups")

    /** 快照文件名里的毫秒时间戳；不是我们的命名格式一律忽略。 */
    private fun timestampOf(name: String): Long? =
        name.takeIf { it.startsWith(PREFIX) && it.endsWith(SUFFIX) }
            ?.removePrefix(PREFIX)?.removeSuffix(SUFFIX)?.toLongOrNull()

    /** 当前最新一份快照的写入时刻（毫秒）；一份都没有（或目录不存在）返回 null。 */
    fun latestSnapshotTs(dir: Path): Long? {
        if (!Files.isDirectory(dir)) return null
        val names: List<String> = Files.list(dir).use { stream ->
            stream.map { it.fileName.toString() }.toList()
        }
        return names.mapNotNull(::timestampOf).maxOrNull()
    }

    private const val RESTORE_MARKER = ".pending-restore"
    private const val PRE_RESTORE_PREFIX = "pre-restore-"

    /** 某份快照是否存在且完整（sidecar SHA-256 == 实测）。 */
    fun isVerified(dbPath: String, name: String): Boolean =
        list(dbPath).firstOrNull { it.name == name }?.verified == true

    /**
     * 排定一次恢复：只把选定的快照名写进标记文件，**绝不碰正在使用的库**。
     * 真正落地发生在下次启动 [applyPendingRestore]（在打开库文件之前）。
     * 只接受本模块命名、且当前通过校验的快照名（`timestampOf` 挡掉路径穿越 / 任意文件）。
     */
    fun scheduleRestore(dbPath: String, name: String): Boolean {
        if (timestampOf(name) == null) return false
        if (!isVerified(dbPath, name)) return false
        val dir = backupsDirOf(dbPath)
        Files.createDirectories(dir)
        Files.writeString(dir.resolve(RESTORE_MARKER), name)
        return true
    }

    /**
     * 下次启动、打开库文件之前消费恢复标记（[Application] 在建 `Database` 前调用）。
     * 步骤：校验快照 SHA-256 → 把当前库连同其 `-wal/-shm` 移作 `pre-restore-<ts>` 安全副本（可回退）→
     * 用快照落成主库 → 删标记。任一步不满足或失败：当前库原样不动、标记改存 `.failed` 供排查，返回 false。
     * 关键是**绝不半路覆盖出一个坏库**——先验后用，改库是一步 copy。无标记时快速返回 false。
     */
    fun applyPendingRestore(dbPath: String): Boolean {
        val dir = backupsDirOf(dbPath)
        val marker = dir.resolve(RESTORE_MARKER)
        if (!Files.isRegularFile(marker)) return false
        fun bail(reason: String): Boolean {
            runCatching { Files.move(marker, dir.resolve("$RESTORE_MARKER.failed"), StandardCopyOption.REPLACE_EXISTING) }
            System.err.println("待恢复快照已放弃（当前库保持不变）：$reason")
            return false
        }
        val name = runCatching { Files.readString(marker).trim() }.getOrDefault("")
        if (timestampOf(name) == null) return bail("标记里的名字不合法：$name")
        val snap = dir.resolve(name)
        if (!Files.isRegularFile(snap)) return bail("快照不存在：$name")
        val recorded = runCatching {
            Files.readString(dir.resolve("$name.sha256")).substringBefore(" ").trim().lowercase()
        }.getOrNull()
        val actual = runCatching { sha256Of(snap) }.getOrNull()
        if (recorded == null || actual == null || recorded != actual) return bail("快照 SHA-256 校验不通过：$name")

        val target = Paths.get(dbPath).toAbsolutePath()
        val stamp = System.currentTimeMillis()
        return runCatching {
            if (Files.exists(target)) {
                Files.move(target, dir.resolve("$PRE_RESTORE_PREFIX$stamp$SUFFIX"), StandardCopyOption.REPLACE_EXISTING)
            }
            runCatching { Files.deleteIfExists(Paths.get("$target-wal")) }
            runCatching { Files.deleteIfExists(Paths.get("$target-shm")) }
            Files.copy(snap, target, StandardCopyOption.REPLACE_EXISTING)
            Files.deleteIfExists(marker)
            System.err.println("已按启动快照恢复库：$name（原库留作 $PRE_RESTORE_PREFIX$stamp$SUFFIX，可回退）")
            true
        }.getOrElse { bail("落库失败：${it.message}") }
    }

    /**
     * 跑一次快照并写 sidecar、淘汰超额。返回写出的目标文件路径。
     * `keep <= 0` 直接返回 null（关闭快照）。VACUUM/哈希失败打 stderr 后返回 null，不抛错。
     */
    fun run(db: Connection, dbPath: String, keep: Int): Path? {
        if (keep <= 0) return null
        val dir = backupsDirOf(dbPath)
        val dest = dir.resolve("$PREFIX${System.currentTimeMillis()}$SUFFIX")
        return try {
            Files.createDirectories(dir)
            // VACUUM INTO 的目标文件名是字面量、不支持绑定参数，单引号必须成对转义。
            val literal = dest.toString().replace("'", "''")
            db.createStatement().use { it.execute("VACUUM INTO '$literal'") }
            val digest = sha256Of(dest)
            Files.writeString(dir.resolve("${dest.fileName}.sha256"), "$digest  ${dest.fileName}\n")
            prune(dir, keep)
            dest
        } catch (error: Throwable) {
            System.err.println(
                "启动库快照失败（不影响运行，仅少了一份可回滚副本）：${error::class.simpleName}: ${error.message}",
            )
            null
        }
    }

    fun sha256Of(file: Path): String {
        val md = MessageDigest.getInstance("SHA-256")
        Files.newInputStream(file).use { input ->
            val buffer = ByteArray(8192)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                md.update(buffer, 0, read)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    /**
     * 只读列出已有快照 + 逐份校验完整性（重算 SHA-256 与 sidecar 比对）。
     * 不抛错：目录不存在返回空表；单份读失败按 `verified=false` 如实标出，不隐藏。
     */
    fun list(dbPath: String): List<SnapshotInfo> {
        val dir = backupsDirOf(dbPath)
        if (!Files.isDirectory(dir)) return emptyList()
        val files = Files.list(dir).use { stream ->
            stream.filter { Files.isRegularFile(it) && timestampOf(it.fileName.toString()) != null }.toList()
        }
        return files.mapNotNull { file ->
            val created = timestampOf(file.fileName.toString()) ?: return@mapNotNull null
            val bytes = runCatching { Files.size(file) }.getOrDefault(0L)
            val recorded = runCatching {
                Files.readString(file.resolveSibling("${file.fileName}.sha256")).substringBefore(" ").trim().lowercase()
            }.getOrNull()
            val actual = runCatching { sha256Of(file) }.getOrNull()
            SnapshotInfo(
                name = file.fileName.toString(),
                bytes = bytes,
                sha256 = recorded,
                verified = recorded != null && actual != null && recorded == actual,
                createdAt = created,
            )
        }.sortedByDescending { it.createdAt }
    }

    /**
     * 按文件名里的**数值时间戳**（而不是字典序）倒序保留最新 [keep] 份，
     * 其余连同各自的 `.sha256` sidecar 一起删。这里删的是本程序自己刚生成的轮转副本，
     * 与运行日志轮转同类，不涉及用户数据文件。
     */
    fun prune(dir: Path, keep: Int) {
        if (keep <= 0 || !Files.isDirectory(dir)) return
        val snapshots: List<Path> = Files.list(dir).use { stream ->
            stream
                .filter { Files.isRegularFile(it) && timestampOf(it.fileName.toString()) != null }
                .sorted(Comparator.comparingLong { p -> -(timestampOf(p.fileName.toString()) ?: 0L) })
                .toList()
        }
        snapshots.drop(keep).forEach { old ->
            runCatching { Files.deleteIfExists(old) }
            runCatching { Files.deleteIfExists(old.resolveSibling("${old.fileName}.sha256")) }
        }
    }
}
