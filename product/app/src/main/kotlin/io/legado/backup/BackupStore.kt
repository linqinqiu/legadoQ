package io.legado.backup

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import io.legado.model.KeptBackupEntry

/**
 * 备份包里**服务端没有原生归宿**的个性化条目，原样留在磁盘上的一个目录。
 *
 * 为什么是文件而不是表：用户口径里有一条红线 —— `themeConfig` / `readConfig` / `config.xml` /
 * `videoConfig` / `highlightRule` / `keyboardAssists` / `servers` 这七类是**配置**，
 * 不许为了"支持导入"就给它们建表。而字典、阅读记录、搜索历史这些虽然能建表，
 * 但本服务当前没有对应的界面去消费它们，建了表等于制造"导入成功但其实没地方用"的假支持。
 *
 * 所以这里的取舍是：**先原样收下并如实上报**（文件名、条数、字节数、什么时候收的），
 * 界面上能列出来、能下载回去；其中我们真能落地的两类（阅读样式、朗读引擎）由前端映射到
 * 自己的 `readerSettings` 上，套用的动作是显式的、可撤销的，而不是导入时偷偷改用户的设置。
 */
class BackupStore(private val directory: Path) {
    /** Version activation accepts only intact, content-addressed evidence; never normalize a path. */
    internal fun sourceArchive(name: String): JsonObject {
        require(SOURCE_ARCHIVE.matches(name)) { "书源留档名称无效" }
        require(Files.isDirectory(directory, java.nio.file.LinkOption.NOFOLLOW_LINKS)) { "书源留档目录不可用" }
        val path = directory.resolve(name)
        require(Files.isRegularFile(path, java.nio.file.LinkOption.NOFOLLOW_LINKS)) { "书源留档不存在" }
        val bytes = Files.newInputStream(path, java.nio.file.LinkOption.NOFOLLOW_LINKS).use {
            it.readNBytes((BackupImporter.MAX_ENTRY_BYTES + 1).toInt())
        }
        require(bytes.size <= BackupImporter.MAX_ENTRY_BYTES) { "书源留档超过大小限制" }
        val text = Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString()
        return BackupSourceArchive.validate(name, text)
    }
    /** Only recognized regular files; never follow links or silently omit corrupt evidence. */
    internal fun migrationFiles(): List<Pair<String, ByteArray>> {
        if (!Files.exists(directory, java.nio.file.LinkOption.NOFOLLOW_LINKS)) return emptyList()
        require(Files.isDirectory(directory, java.nio.file.LinkOption.NOFOLLOW_LINKS)) { "留档目录不可读" }
        var total = 0L
        return Files.list(directory).use { stream ->
            val paths = stream.filter { BackupMigration.allowed(it.fileName.toString()) }
                .limit((BackupMigration.MAX_FILES + 1).toLong()).toList().sorted()
            require(paths.size <= BackupMigration.MAX_FILES) { "留档文件过多，请分批保管原始备份" }
            require(paths.map { it.fileName.toString().lowercase() }.distinct().size == paths.size) { "留档名称大小写冲突" }
            paths.map { path ->
            val name = path.fileName.toString()
            require(Files.isRegularFile(path, java.nio.file.LinkOption.NOFOLLOW_LINKS)) { "留档必须为普通文件" }
            val bytes = Files.newInputStream(path, java.nio.file.LinkOption.NOFOLLOW_LINKS).use {
                it.readNBytes((BackupImporter.MAX_ENTRY_BYTES + 1).toInt())
            }
            total += bytes.size
            require(bytes.size <= BackupImporter.MAX_ENTRY_BYTES && total <= BackupImporter.MAX_TOTAL_BYTES) { "留档大小超过迁移上限" }
            val text = Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString()
            if (BackupMigration.archivePattern.matches(name)) BackupSourceArchive.validate(name, text)
            name to bytes
        } }
    }

    /** Content addressed recovery evidence. Existing evidence must match; never overwrite corruption. */
    internal fun keepSourceArchive(text: String): KeptBackupEntry {
        val bytes = text.toByteArray(Charsets.UTF_8)
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val name = "source-variants-$digest.json"
        Files.createDirectories(directory)
        val target = directory.resolve(name)
        if (Files.exists(target)) {
            check(Files.readAllBytes(target).contentEquals(bytes)) { "书源冲突版本留档校验失败" }
        } else {
            val temp = Files.createTempFile(directory, ".variants-", ".tmp")
            try {
                Files.write(temp, bytes)
                Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE)
            } finally {
                Files.deleteIfExists(temp)
            }
        }
        return KeptBackupEntry(name, labelOf(name), bytes.size.toLong(), itemsOf(name, text), false,
            Files.getLastModifiedTime(target).toMillis())
    }

    /** 只接受我们认识的那批条目名，避免把包里任意文件都往数据目录里灌。 */
    fun keep(name: String, text: String): Boolean {
        val safe = name.substringAfterLast('/').replace(KEEP_UNSAFE, "_")
        if (!KEEP_NAMES.any { it.equals(safe, ignoreCase = true) }) return false
        Files.createDirectories(directory)
        val target = directory.resolve(safe)
        val temp = Files.createTempFile(directory, ".keep-", ".tmp")
        Files.write(temp, text.toByteArray(Charsets.UTF_8))
        Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        return true
    }

    fun read(name: String): String? {
        val safe = name.substringAfterLast('/').replace(KEEP_UNSAFE, "_")
        val file = directory.resolve(safe)
        if (!Files.isRegularFile(file)) return null
        return runCatching { Files.readString(file) }.getOrNull()
    }

    fun list(): List<KeptBackupEntry> {
        if (!Files.isDirectory(directory)) return emptyList()
        return Files.list(directory).use { stream ->
            stream.filter { Files.isRegularFile(it) && !it.fileName.toString().startsWith(".") }
                .map { file ->
                    val text = runCatching { Files.readString(file) }.getOrDefault("")
                    KeptBackupEntry(
                        name = file.fileName.toString(),
                        bytes = Files.size(file),
                        items = itemsOf(file.fileName.toString(), text),
                        label = labelOf(file.fileName.toString()),
                        appliable = APPLYABLE_NAMES.any { it.equals(file.fileName.toString(), ignoreCase = true) },
                        updatedAt = runCatching { Files.getLastModifiedTime(file).toMillis() }.getOrElse { 0L },
                    )
                }
                .toList()
        }.sortedBy { it.name.lowercase() }
    }

    /** 上游这些条目都是 JSON 数组；数一下顶层元素，界面上就能说"收下多少条"而不是只报文件名。 */
    companion object {
        private val KEEP_UNSAFE = Regex("[^A-Za-z0-9._-]")
        private val SOURCE_ARCHIVE = Regex("source-variants-[a-f0-9]{64}\\.json")

        private fun itemsOf(name: String, text: String): Int = runCatching {
            if (SOURCE_ARCHIVE.matches(name))
                ((Json.parseToJsonElement(text) as JsonObject)["bookSource"] as JsonArray).size
            else LegacyBackup.elementsOf(text).size
        }.getOrDefault(0)

        /**
         * 备份包里我们目前没有原生归宿、但值得原样收下的条目。
         *
         * 前两组是上游官方的个性化条目；后面是兄弟项目各自加的（MD3 的书签/高亮/首页模块、
         * Night-Reader 的阅读统计与下载任务…）。它们与官方条目不冲突，收下并如实列出即可，
         * 不因为某个项目多写了几节就把它导出的整包判成"不是 Legado 备份"。
         */
        val KEEP_NAMES = listOf(
            "dictrule.json", "readconfig.json", "httptts.json",
            "searchhistory.json", "txtTocRule.json", "bookmemo.json", "rssStar.json",
            "themeConfig.json", "style.json", "theme.json", "readRecord.json",
            "bookmark.json", "bookmarking.json", "highlight.json", "highlightRule.json",
            "highlightTagRule.json", "tagGroupRule.json", "readRecordDetail.json",
            "readRecordSession.json", "httpTtsVoices.json", "homepageModules.json",
            "homepageCustomSets.json", "sourceSub.json", "keyboardAssists.json",
            "readDay.json", "downloadTask.json", "readerChapterContent.json", "manifest.json",
        )

        /** 前端能真的映射到自己设置上的那几类，界面上才给「套用」按钮。 */
        val APPLYABLE_NAMES = listOf("readconfig.json", "httptts.json", "txtTocRule.json")

        val KEEP_LABELS = mapOf(
            "dictrule.json" to "字典规则",
            "readconfig.json" to "阅读样式",
            "httptts.json" to "朗读引擎",
            "searchhistory.json" to "搜索历史",
            "txttocrule.json" to "TXT 分章规则",
            "bookmemo.json" to "书籍笔记",
            "rssstar.json" to "RSS 收藏",
            "themeconfig.json" to "主题配置",
            "style.json" to "阅读样式（旧名）",
            "theme.json" to "主题（旧名）",
            "readrecord.json" to "阅读记录",
            "bookmark.json" to "书签",
            "bookmarking.json" to "阅读书签",
            "highlight.json" to "高亮",
            "highlightrule.json" to "高亮规则",
            "highlighttagrule.json" to "高亮标签规则",
            "taggrouprule.json" to "标签分组规则",
            "readrecorddetail.json" to "阅读记录明细",
            "readrecordsession.json" to "阅读会话",
            "httpttsvoices.json" to "朗读音色",
            "homepagemodules.json" to "首页模块",
            "homepagecustomsets.json" to "首页自定义",
            "sourcesub.json" to "订阅源",
            "keyboardassists.json" to "键盘辅助",
            "readday.json" to "阅读统计",
            "downloadtask.json" to "下载任务",
            "readerchaptercontent.json" to "阅读器章节缓存",
            "manifest.json" to "备份清单",
        )

        fun labelOf(name: String): String = if (SOURCE_ARCHIVE.matches(name)) "书源冲突版本与原始书架引用"
            else KEEP_LABELS[name.substringAfterLast('/').lowercase()] ?: name.substringAfterLast('/')

        fun isAppliable(name: String): Boolean =
            APPLYABLE_NAMES.any { it.equals(name.substringAfterLast('/'), ignoreCase = true) }
    }
}
