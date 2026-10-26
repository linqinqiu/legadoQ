package io.legado.backup

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import java.nio.charset.Charset
import java.nio.file.Path
import java.security.MessageDigest
import java.util.Base64
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import javax.crypto.Cipher
import javax.crypto.spec.SecretKeySpec
import io.legado.data.Database
import io.legado.data.importBookGroups
import io.legado.data.importLibrary
import io.legado.data.importReplaceRules
import io.legado.data.importRssSources
import io.legado.data.importSources
import io.legado.data.setCookieForUrl
import io.legado.model.BackupImportSummary
import io.legado.model.BackupShelfEntry
import io.legado.model.KeptBackupEntry
import io.legado.model.ReplaceRule
import io.legado.source.SourceCodec

/**
 * Legado App 备份包导入器，跨版本兼容。
 *
 * 认的包内条目（大小写、是否带目录前缀都无所谓）：
 * - 现版本：`bookSource.json` / `replaceRule.json` / `bookshelf.json` / `cookies.json` /
 *   `rssSources.json`（上游 `help/storage/Backup.kt` 写出的名字）
 * - 老版本：`myBookSource.json` / `myBookReplaceRule.json` / `myBookShelf.json`（字段是扁平的，走 [LegacyBackup] 迁移）
 * - 分叉与网页版别名：`readAppBookSource.json`、`sources.json`
 *
 * 包外形状也一并兜住：`{data:[…]}` / `{bookSources:[…]}` / 整个文件只有一个源对象、UTF-8 BOM、
 * GB18030 编码、布尔写成 `1/0`、数字写成字符串。
 *
 * 实现要点：
 * 1. 全程用 [ZipFile] 按条目名读取，绝不把条目解包到磁盘，从根本上规避 zip-slip 路径穿越；
 * 2. 声明解压体积超限直接拒绝，避免 zip 炸弹撑爆内存；
 * 3. 书架的 `origin` 经 [SourceCodec.normalizeSourceId] 归一化，才能与书源表主键（也是 sourceId）对齐；
 * 4. 承接不了的条目如实写进 `skippedSections`，不静默丢弃。
 */
/**
 * 手机 Legado 备份包的加解密口径，逐字照上游 `help/storage/BackupAES.kt`：
 * `AES(MD5Utils.md5Encode(password).encodeToByteArray(0, 16))` —— 也就是
 * **密钥 = 密码 MD5 的小写十六进制串取前 16 个字符的 ASCII 字节**（不是 16 字节摘要），
 * 模式 ECB、PKCS5 填充，密文以 base64 落盘。包内只有 `cookies.json` / `servers.json`
 * 与 `config` 里的 `webDavPassword` 走这条路。
 */
internal object BackupAes {
    fun keyOf(password: String): ByteArray = md5Hex(password).take(16).toByteArray(Charsets.UTF_8)

    fun encryptBase64(plain: String, password: String): String =
        Base64.getEncoder().encodeToString(cipher(password, Cipher.ENCRYPT_MODE).doFinal(plain.toByteArray(Charsets.UTF_8)))

    fun decryptBase64(encoded: String, password: String): String {
        val body = encoded.trim().removeSurrounding("\"")
        val bytes = Base64.getMimeDecoder().decode(body)
        return String(cipher(password, Cipher.DECRYPT_MODE).doFinal(bytes), Charsets.UTF_8)
    }

    private fun cipher(password: String, mode: Int): Cipher =
        Cipher.getInstance("AES/ECB/PKCS5Padding").apply { init(mode, SecretKeySpec(keyOf(password), "AES")) }

    private fun md5Hex(text: String): String =
        MessageDigest.getInstance("MD5").digest(text.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
}

class BackupImporter(private val database: Database, private val keep: BackupStore? = null) {

    fun import(file: Path, password: String? = null): BackupImportSummary = ZipFile(file.toFile()).use { zip ->
        val entries = zip.entries().asSequence().filter { !it.isDirectory }.toList()
        require(entries.sumOf { it.size.coerceAtLeast(0L) } <= MAX_TOTAL_BYTES) {
            "备份包展开后超过 ${MAX_TOTAL_BYTES / 1024 / 1024} MiB，已拒绝"
        }
        val present = entries.map { it.name.substringAfterLast('/').lowercase() }.toSet()
        val sources = readSection(zip, entries, SOURCE_NAMES)?.let(::parseSources).orEmpty()
        val rules = readSection(zip, entries, RULE_NAMES)?.let(::parseRules).orEmpty()
        val shelf = readSection(zip, entries, SHELF_NAMES)?.let(::parseShelf).orEmpty()
        val groups = readSection(zip, entries, GROUP_NAMES)?.let(::parseBookGroups).orEmpty()
        val rss = readSection(zip, entries, RSS_NAMES)?.let(::parseRssSources).orEmpty()
        // 手机上只勾了个性化条目（书签 / 搜索历史 / TXT 分章规则…）导出的包也是合法备份：
        // 以前这类包会被判"不是可识别的 Legado 备份"整包拒收，用户看到的是"我明明导出来了"。
        val keepable = present.intersect(BackupStore.KEEP_NAMES.map { it.lowercase() }.toSet())
        require(sources.isNotEmpty() || rules.isNotEmpty() || shelf.isNotEmpty() || keepable.isNotEmpty()) {
            "不是可识别的 Legado 备份：找过 ${SOURCE_NAMES.joinToString()} / ${RULE_NAMES.joinToString()} / " +
                "${SHELF_NAMES.joinToString()}，也没有能收下的个性化条目，包内实际有 ${present.size} 个条目"
        }

        val sourceResult = database.importSources(sources)
        val ruleResult = database.importReplaceRules(rules)
        // 分组必须先落库：书架条目上的 groupId 是手机那侧的号码，要经这张映射换成本机号，
        // 否则会把本机同号的另一个组（往往是「本地」）当成目标，书就悄悄归错组了。
        val groupMap = database.importBookGroups(groups)
        val library = database.importLibrary(shelf.map { it.copy(groupId = groupMap[it.phoneGroupId] ?: 0L) })
        val rssResult = database.importRssSources(rss)
        // 书源要先落库，cookie 才能按域名找到该挂到哪些书源上
        val cookies = importCookies(zip, entries, password)
        /*
         * 用户 2026-09-30：「备份包里的 TTS、字典、阅读样式、书签、书架分组以外的个性化条目，
         * 这个如果可以的话试着做一下」。这一节把服务端**没有原生归宿**的那些条目原样收进数据目录
         * （见 BackupStore：七类配置按用户口径禁止建表，其余没有消费界面，建表就是假支持），
         * 并把它们从"没承接"名单里摘出来 —— 收下了却还报"不承接"是另一种不诚实。
         */
        val kept = LinkedHashMap<String, KeptBackupEntry>()
        if (keep != null) {
            val handled = (SOURCE_NAMES + RULE_NAMES + SHELF_NAMES + COOKIE_NAMES + GROUP_NAMES + RSS_NAMES).toSet()
            for (entry in entries) {
                val name = entry.name.substringAfterLast('/')
                val lower = name.lowercase()
                if (lower in handled || lower in KEEP_EXCLUDED) continue
                val text = runCatching { readEntry(zip, entry) }.getOrNull() ?: continue
                if (!keep.keep(name, text)) continue
                kept[lower] = KeptBackupEntry(
                    name = name,
                    label = BackupStore.labelOf(name),
                    bytes = text.toByteArray(Charsets.UTF_8).size.toLong(),
                    items = runCatching { LegacyBackup.elementsOf(text).size }.getOrDefault(0),
                    appliable = BackupStore.isAppliable(name),
                    updatedAt = System.currentTimeMillis(),
                )
            }
        }
        BackupImportSummary(
            sources = sourceResult.imported,
            sourcesUpdated = sourceResult.updated,
            rules = ruleResult.imported,
            rulesUpdated = ruleResult.updated,
            books = library.imported,
            booksUpdated = library.updated,
            progress = library.progress,
            cookies = cookies.applied,
            cookiesNote = cookies.note,
            bookGroups = groupMap.size,
            rssSources = rssResult.imported,
            rssSourcesUpdated = rssResult.updated,
            skippedSections = (KNOWN_BUT_UNSUPPORTED - kept.keys.toSet()).filter { it in present }.sorted(),
            keptSections = kept.values.sortedBy { it.name.lowercase() },
            errors = sourceResult.errors + rssResult.errors,
        )
    }

    /**
     * 恢复包内 `cookies.json`（手机 Legado 的登录态）。上游是
     * `aes.encryptBase64(GSON.toJson(cookieDao.all))` —— **整份都是 AES 密文**，没密码读不了；
     * 解密后是 `[{url, cookie}]`，`url` 是注册域。
     *
     * 两处口径差异是有意的：
     * - 上游缺密码直接抛错、整个恢复中止；我们只跳过这一节并如实回报，别为了 cookie 把书源和书架也赔上。
     * - 存储形状与上游一致：**全局一张表、按注册域存**（`Cookie.kt` 只有 url/cookie 两列），
     *   所以这里把每行直接写进对应域的桶即可，不再"按域名去找哪些书源用得到"逐个发放。
     *   写入走 [Database.setCookieForUrl] 的按键合并，与上游 `CookieStore.restoreCookie` 同语义。
     */
    private fun importCookies(zip: ZipFile, entries: List<ZipEntry>, password: String?): CookieOutcome {
        val raw = readSection(zip, entries, COOKIE_NAMES)?.trim() ?: return CookieOutcome(0, null)
        if (raw.isEmpty()) return CookieOutcome(0, "包内 cookies.json 是空的")
        if (password.isNullOrBlank()) {
            return CookieOutcome(0, "包内有加密的 cookies.json（手机备份里的登录态），填备份密码才能恢复")
        }
        val plain = runCatching { BackupAes.decryptBase64(raw, password) }
            .getOrElse { return CookieOutcome(0, "cookies.json 解密失败：备份密码不对") }
        val rows = runCatching { parseCookieRows(plain) }
            .getOrElse { return CookieOutcome(0, "cookies.json 内容不是预期的 [{url,cookie}] 数组") }
        var applied = 0
        var legacySkipped = 0
        rows.forEach { row ->
            // 老 OkHttp 的主键形如 `url|name|domain`，映射不到主机，跳过而不是猜一个键
            if (row.url.isBlank() || "|" in row.url) { legacySkipped++; return@forEach }
            if (database.setCookieForUrl("https://${row.url.trim()}/", row.cookie)) applied++
        }
        val note = buildString {
            if (legacySkipped > 0) append("跳过 $legacySkipped 条老格式（OkHttp 主键带 | ）记录")
            if (applied == 0 && isEmpty()) append("包内没有可写入的凭据记录")
        }.takeIf { it.isNotEmpty() }
        return CookieOutcome(applied, note)
    }

    private fun parseCookieRows(text: String): List<CookieRow> = LegacyBackup.elementsOf(text).mapNotNull { element ->
        val obj = element as? JsonObject ?: return@mapNotNull null
        val url = obj.text("url") ?: return@mapNotNull null
        CookieRow(url = url, cookie = obj.text("cookie").orEmpty())
    }

    private data class CookieRow(val url: String, val cookie: String)
    private data class CookieOutcome(val applied: Int, val note: String?)

    /** 取候选名里第一个命中的条目；一个都没有时返回 null，由调用方区分「缺这一节」和「不是备份包」。 */
    /** 单条目的读取（大小守卫与编码回落和 readSection 一致），给"原样收下"那一节用。 */
    private fun readEntry(zip: ZipFile, entry: ZipEntry): String = readCappedEntry(zip, entry)

    private fun readSection(zip: ZipFile, entries: List<ZipEntry>, candidates: List<String>): String? {
        val wanted = candidates.map { it.lowercase() }.toSet()
        val entry = entries.firstOrNull { it.name.substringAfterLast('/').lowercase() in wanted } ?: return null
        return readCappedEntry(zip, entry)
    }

    /**
     * 按「真实读取字节」封顶，而不是信 ZipEntry 声明的 size —— zip 炸弹正是靠谎报
     * uncompressed size 骗过声明校验再把内存打爆。读满 上限+1 即判定超限。
     */
    private fun readCappedEntry(zip: ZipFile, entry: ZipEntry): String {
        val bytes = zip.getInputStream(entry).use { stream -> stream.readNBytes((MAX_ENTRY_BYTES + 1).toInt()) }
        require(bytes.size <= MAX_ENTRY_BYTES) { "${entry.name} 展开后超过 ${MAX_ENTRY_BYTES / 1024 / 1024} MiB，已拒绝" }
        return decode(bytes)
    }

    /** 少数老备份是 GB18030 存的：UTF-8 严格解不出来再退一档，免得整包中文变乱码。 */
    private fun decode(bytes: ByteArray): String =
        runCatching { String(bytes, Charsets.UTF_8) }.getOrElse { String(bytes, Charset.forName("GB18030")) }

    private fun parseSources(text: String): List<String> = LegacyBackup.elementsOf(text).mapNotNull { element ->
        // 老格式先按上游映射迁成现版本结构，否则导进来是取不到值的空壳源
        if (LegacyBackup.isOldSource(element)) LegacyBackup.toNewSourceJson(element) else element.toString()
    }

    /**
     * `rssSources.json`（手机「订阅」页的 RSS 源）：RSS 是 Legado 3.x 才有的功能，
     * 字段名从那时起没变过，所以不像书源那样需要老格式迁移，原样交给 [SourceCodec.parseRss]。
     */
    private fun parseRssSources(text: String): List<String> = LegacyBackup.elementsOf(text)
        .filterIsInstance<JsonObject>().map { it.toString() }

    private fun parseRules(text: String): List<ReplaceRule> = LegacyBackup.elementsOf(text).mapNotNull { element ->

        val normalized = LegacyBackup.normalizeReplaceRule(element) ?: return@mapNotNull null
        val rule = Json.parseToJsonElement(normalized).jsonObject
        val pattern = rule.text("pattern") ?: return@mapNotNull null
        ReplaceRule(
            id = rule.text("id").orEmpty(),
            name = rule.text("name") ?: pattern,
            group = rule.text("group"),
            pattern = pattern,
            replacement = rule.text("replacement").orEmpty(),
            isRegex = rule.flag("isRegex") ?: true,
            scope = rule.text("scope"),
            excludeScope = rule.text("excludeScope"),
            scopeTitle = rule.flag("scopeTitle") ?: false,
            scopeContent = rule.flag("scopeContent") ?: true,
            isEnabled = rule.flag("isEnabled") ?: true,
            order = rule.number("order")?.toInt() ?: 0,
            timeoutMillisecond = rule.number("timeoutMillisecond") ?: 3000L,
        )
    }

    /**
     * `bookGroup.json`（上游 `Backup.kt:285` ← `bookGroupDao.all`）：只取 `groupId + groupName`。
     * `cover/order/show/bookSort/onlyUpdateRead` 是手机端的展示偏好，服务端没有对应行为，不假装承接。
     */
    private fun parseBookGroups(text: String): List<Pair<Long, String>> = LegacyBackup.elementsOf(text).mapNotNull { element ->
        val group = element as? JsonObject ?: return@mapNotNull null
        val id = group.number("groupId") ?: return@mapNotNull null
        val name = group.text("groupName")?.trim() ?: return@mapNotNull null
        id to name
    }

    private fun parseShelf(text: String): List<BackupShelfEntry> = LegacyBackup.elementsOf(text).mapNotNull { element ->
        val jsonText = if (LegacyBackup.isOldShelfEntry(element)) LegacyBackup.toNewShelfJson(element) else element.toString()
        val book = jsonText?.let { Json.parseToJsonElement(it).jsonObject } ?: return@mapNotNull null
        val origin = book.text("origin")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
        val bookUrl = book.text("bookUrl")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
        val sourceId = SourceCodec.normalizeSourceId(origin)
        if (sourceId.isBlank()) return@mapNotNull null
        BackupShelfEntry(
            sourceId = sourceId,
            bookUrl = bookUrl,
            name = book.text("name")?.takeIf { it.isNotBlank() } ?: bookUrl,
            author = book.text("author")?.takeIf { it.isNotBlank() },
            tocUrl = book.text("tocUrl")?.takeIf { it.isNotBlank() } ?: bookUrl,
            coverUrl = (book.text("coverUrl") ?: book.text("customCoverUrl"))?.takeIf { it.isNotBlank() },
            completed = book.text("kind")?.contains("完结") == true,
            chapterIndex = book.number("durChapterIndex")?.toInt() ?: 0,
            phoneGroupId = book.number("groupId") ?: 0L,
            readAt = book.number("durChapterTime") ?: 0L,
        )
    }

    private fun JsonObject.text(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
    private fun JsonObject.flag(key: String): Boolean? = (this[key] as? JsonPrimitive)?.booleanOrNull
    private fun JsonObject.number(key: String): Long? = (this[key] as? JsonPrimitive)?.longOrNull

    private companion object {
        const val MAX_ENTRY_BYTES = 64L * 1024 * 1024
        const val MAX_TOTAL_BYTES = 256L * 1024 * 1024

        val SOURCE_NAMES = listOf("booksource.json", "mybooksource.json", "readappbooksource.json", "sources.json")
        val RULE_NAMES = listOf("replacerule.json", "mybookreplacerule.json", "readappreplacerule.json")
        val SHELF_NAMES = listOf("bookshelf.json", "mybookshelf.json", "readappbookshelf.json")
        val COOKIE_NAMES = listOf("cookies.json")
        val GROUP_NAMES = listOf("bookGroup.json")

        /** 上游 `Backup.kt:287` 写出的名字就是 `rssSources.json`（复数），别和 `rssStar.json` 混了。 */
        val RSS_NAMES = listOf("rssSources.json", "rsssource.json", "rsssources.json")

        /** 备份包里我们暂时承接不了的条目：导入后如实回报，不假装什么都没发生。 */
        val KNOWN_BUT_UNSUPPORTED = listOf(
            "rssstar.json", "sourcesub.json", "bookmemo.json",
            "bookmark.json", "highlight.json", "highlightrule.json", "readrecord.json",
            "readrecorddetail.json", "searchhistory.json", "txttocrule.json", "httptts.json",
            "keyboardassists.json", "dictrule.json", "servers.json", "readconfig.json",
            "themeconfig.json", "config.xml", "videoconfig.xml", "autotask.json", "runtimesourcecache.json",
        )

        /**
         * 仍然只上报、不收进数据目录的条目：config.xml 与 videoconfig.xml 是 Android 侧的
         * SharedPreferences 导出，里面全是本机组件名与绝对路径，收下来既没有消费方又把无关信息
         * 留在服务器上；autotask 与 runtimesourcecache 是运行时缓存，本来就是可再生的。
         */
        val KEEP_EXCLUDED = setOf("config.xml", "videoconfig.xml", "autotask.json", "runtimesourcecache.json")
    }
}
