package io.legado.backup

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.util.Base64
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import javax.crypto.Cipher
import javax.crypto.spec.SecretKeySpec
import io.legado.data.Database
import io.legado.data.importBookGroupsOn
import io.legado.data.importLibraryOn
import io.legado.data.importReplaceRulesOn
import io.legado.data.importRssSourcesOn
import io.legado.data.importSourcesOn
import io.legado.data.importSubscriptionsOn
import io.legado.data.setCookieForUrl
import io.legado.data.previewLibraryRestore
import io.legado.data.planLibraryRestore
import io.legado.data.applyLibraryRestore
import io.legado.data.libraryRestoreContext
import io.legado.model.BackupLibraryPolicy
import io.legado.decodeTextAuto
import io.legado.model.BackupImportSummary
import io.legado.model.BackupImportPreview
import io.legado.model.BackupSectionPreview
import io.legado.model.BackupShelfEntry
import io.legado.model.BackupSubscriptionEntry
import io.legado.model.ImportResponse
import io.legado.model.KeptBackupEntry
import io.legado.model.LibraryImportResult
import io.legado.model.ReplaceRule
import io.legado.model.ReplaceRuleImportResponse
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

class BackupPreviewChangedException : IllegalStateException("备份文件、策略或相关书架与进度已变化，请重新预览后确认")

class BackupImporter(private val database: Database, private val keep: BackupStore? = null) {

    /**
     * 测试用失败注入：按步骤名在落库前抛错，用来验证「六步里任何一步失败，六个域全部回滚」。
     * 只给测试看，默认 null；不做成运行时开关（安全边界不靠配置）。
     */
    internal var stepHook: ((String) -> Unit)? = null

    /**
     * 认两种容器：手机导出的 zip，以及兄弟项目/分享链接常见的**裸 JSON**
     * （书源数组、`{bookSource:[…],bookshelf:[…]}` 这类合并导出）。
     *
     * 容器按内容判别（zip 头 `PK`），不看扩展名 —— 微信、网盘转存常把 `backup.zip`
     * 改成 `.json` 或干脆没有扩展名；反过来，`.json` 里装 zip 也照样能认。
     */
    fun import(file: Path, password: String? = null, sections: Set<String>? = null,
        libraryPolicy: BackupLibraryPolicy? = null, previewToken: String? = null): BackupImportSummary {
        require(sections == null || (sections.isNotEmpty() && SECTION_IDS.containsAll(sections))) {
            "请选择有效的备份模块"
        }
        libraryPolicy?.validate()
        require((libraryPolicy == null && previewToken == null) || (libraryPolicy != null && !previewToken.isNullOrBlank())) {
            "冲突策略与预览凭证必须一起提交，请重新预览"
        }
        val fileHash = hashFile(file)
        if (libraryPolicy != null && previewToken?.substringBefore(':') != libraryRestoreContext(libraryPolicy, fileHash)) {
            throw BackupPreviewChangedException()
        }
        val data = prepare(file, password)
        fun selected(id: String) = sections == null || id in sections
        fun selectedKeep(name: String) = selected(if (name.lowercase() in SUB_NAMES.map(String::lowercase)) "subscriptions" else "kept")
        // 用户没勾选的留档项不是“不支持”；只把真正没承接的条目留给结果汇总。
        val unselectedKeeps = data.pendingKeeps.filterNot { selectedKeep(it.first) }.map { it.first.lowercase() }.toSet()
        return commit(
            data.sources.takeIf { selected("sources") }.orEmpty(),
            data.rules.takeIf { selected("rules") }.orEmpty(),
            data.shelf.takeIf { selected("shelf") }.orEmpty(),
            data.groups.takeIf { selected("groups") }.orEmpty(),
            data.rss.takeIf { selected("rss") }.orEmpty(),
            data.subscriptions.takeIf { selected("subscriptions") }.orEmpty(),
            data.present - unselectedKeeps,
            data.pendingKeeps.filter { selectedKeep(it.first) },
            libraryPolicy,
            previewToken,
            fileHash,
            data.sourceArchive.takeIf { selected("sources") },
        ) {
            if (!selected("cookies")) CookieOutcome(0, null)
            else data.cookieNote?.let { CookieOutcome(0, it) }
                ?: if (data.cookieRows.isEmpty()) CookieOutcome(0, null) else applyCookies(data.cookieRows)
        }
    }

    fun preview(file: Path, password: String? = null, libraryPolicy: BackupLibraryPolicy = BackupLibraryPolicy()): BackupImportPreview {
        libraryPolicy.validate()
        val data = prepare(file, password)
        val plan = database.previewLibraryRestore(data.shelf, libraryPolicy, hashFile(file))
        val sections = buildList {
            fun section(id: String, label: String, count: Int, policy: String) {
                if (count > 0) add(BackupSectionPreview(id, label, count, policy))
            }
            section("sources", "书源", data.sources.size, "按 ID 合并，已有书源保留本机启用状态")
            section("rules", "替换净化规则", data.rules.size, "按规则标识覆盖")
            section("groups", "分组", data.groups.size, "按名称合并并重编号；不勾选时新导入的书不分组")
            section("shelf", "书架与阅读进度", data.shelf.size, "书架与进度分别按所选策略处理；保留删除决定与已有书本机分组；同一本书重复记录取最后一条")
            section("rss", "RSS 订阅源", data.rss.size, "按地址覆盖内容和启用状态")
            section("subscriptions", "书源订阅", maxOf(data.subscriptions.size,
                data.pendingKeeps.count { it.first.lowercase() in SUB_NAMES.map(String::lowercase) }),
                "仅 type=0 按地址覆盖启用状态；原包扩展字段留档，其他订阅类型只留档")
            section("cookies", "登录凭据", data.cookieRows.size, "按域名合并凭据；需要单独勾选")
            section("kept", "个性化条目与恢复留档", data.pendingKeeps.count { it.first.lowercase() !in SUB_NAMES.map(String::lowercase) },
                "原样保存文件，个性化条目覆盖同名留档；冲突版本按内容保留，不自动激活；不会自动套用阅读样式或分章规则")
        }
        return BackupImportPreview(sections, buildList {
            add("模块括号内的数量表示包内可解析条目，不是预计新增数；书架与进度另列处理预测，无效书源或 RSS 条目在实际导入时单独报告")
            // 真实手机包可同时包含同站点不同 # 注解的规则版本；当前主键会去掉注解。
            // 不在这里改变标识/覆盖协议，但确认前必须明确暴露合并数量，不能把包内数量当恢复数。
            val archive = data.sourceArchive
            if (archive.mergedVersions > 0) {
                add("${archive.validSources} 条有效书源按本机标识归一化后为 ${archive.uniqueSources} 个，将合并 ${archive.mergedVersions} 条；" +
                    "同标识仅保留包内最后一条。选择书源时强制保存可下载的冲突版本留档（含原始书源字段与全部书架 origin），留档失败则数据库导入回滚；" +
                    "书架仍绑定归一化后的胜出版本，原始关联可能有歧义，不自动迁移。请保留原始备份，本次恢复不是全部书源版本的无损迁移。")
            }
            data.cookieNote?.let { add(it) }
        }, libraryPolicy, plan.diff, plan.token)
    }

    private fun hashFile(file: Path): String {
        val digest = MessageDigest.getInstance("SHA-256")
        Files.newInputStream(file).use { input ->
            val buffer = ByteArray(8192)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private data class PreparedBackup(
        val sources: List<String>, val rules: List<ReplaceRule>, val shelf: List<BackupShelfEntry>,
        val groups: List<Pair<Long, String>>, val rss: List<String>,
        val subscriptions: List<BackupSubscriptionEntry>, val present: Set<String>,
        val pendingKeeps: List<Pair<String, String>>, val cookieRows: List<CookieRow>,
        val cookieNote: String? = null,
        val sourceArchive: BackupSourceArchive = BackupSourceArchive(emptyList(), emptyList()),
    )

    private fun prepare(file: Path, password: String?): PreparedBackup {
        val magic = Files.newInputStream(file).use { it.readNBytes(2) }
        val isZip = magic.size == 2 && magic[0] == 'P'.code.toByte() && magic[1] == 'K'.code.toByte()
        return if (isZip) prepareZip(file, password) else prepareJson(file)
    }

    private fun prepareZip(file: Path, password: String?): PreparedBackup = ZipFile(file.toFile()).use { zip ->
        val entries = zip.entries().asSequence().filter { !it.isDirectory }.toList()
        require(entries.sumOf { it.size.coerceAtLeast(0L) } <= MAX_TOTAL_BYTES) {
            "备份包展开后超过 ${MAX_TOTAL_BYTES / 1024 / 1024} MiB，已拒绝"
        }
        val migrationKeeps = BackupMigration.read(zip, entries)
        // Migration roots are authoritative; kept/sourceSub.json is historical evidence only.
        val nativeEntries = if (migrationKeeps == null) entries else entries.filter { '/' !in it.name }
        val present = entries.map { it.name.substringAfterLast('/').lowercase() }.toSet()
        val rawSources = readSection(zip, nativeEntries, SOURCE_NAMES)?.let(LegacyBackup::elementsOf).orEmpty()
        val sources = rawSources.mapNotNull(::sourceOf)
        val rules = readSection(zip, nativeEntries, RULE_NAMES)?.let(::parseRules).orEmpty()
        val rawShelf = readSection(zip, nativeEntries, SHELF_NAMES)?.let(LegacyBackup::elementsOf).orEmpty()
        val shelf = rawShelf.mapNotNull(::shelfOf)
        val groups = readSection(zip, nativeEntries, GROUP_NAMES)?.let(::parseBookGroups).orEmpty()
        val rss = readSection(zip, nativeEntries, RSS_NAMES)?.let(::parseRssSources).orEmpty()
        val subscriptions = readSection(zip, nativeEntries, SUB_NAMES)?.let(::parseSubscriptions).orEmpty()
        // 手机上只勾了个性化条目（书签 / 搜索历史 / TXT 分章规则…）导出的包也是合法备份：
        // 以前这类包会被判"不是可识别的 Legado 备份"整包拒收，用户看到的是"我明明导出来了"。
        val keepable = present.intersect(BackupStore.KEEP_NAMES.map { it.lowercase() }.toSet())
        // 认得出的条目**在包里**就算合法备份，哪怕它是空的数组：
        // 导出侧一域一包，某个域正好是空的时候写出来就是 `bookSource.json` 里只有 `[]`。
        // 以前这种包被判"不是可识别的 Legado 备份"，用户看到的是"我自己导出来的包不让导回去"。
        val recognized = present.intersect(
            (SOURCE_NAMES + RULE_NAMES + SHELF_NAMES + COOKIE_NAMES + GROUP_NAMES + RSS_NAMES + SUB_NAMES)
                .map { it.lowercase() }.toSet(),
        )
        require(sources.isNotEmpty() || rules.isNotEmpty() || shelf.isNotEmpty() || groups.isNotEmpty() ||
            rss.isNotEmpty() || subscriptions.isNotEmpty() || keepable.isNotEmpty() || recognized.isNotEmpty()) {
            "不是可识别的 Legado 备份：找过 ${SOURCE_NAMES.joinToString()} / ${RULE_NAMES.joinToString()} / " +
                "${SHELF_NAMES.joinToString()}，也没有能收下的个性化条目，包内实际有 ${present.size} 个条目"
        }

        /*
         * 用户 2026-09-30：「备份包里的 TTS、字典、阅读样式、书签、书架分组以外的个性化条目，
         * 这个如果可以的话试着做一下」。这一节把服务端**没有原生归宿**的那些条目原样收进数据目录
         * （见 BackupStore：七类配置按用户口径禁止建表，其余没有消费界面，建表就是假支持），
         * 并把它们从"没承接"名单里摘出来 —— 收下了却还报"不承接"是另一种不诚实。
         *
         * 兄弟项目（MD3 / Max / Night-Reader…）正是在这些个性化条目上各有各的扩充，
         * 只要名字在 [BackupStore.KEEP_NAMES] 里就原样收下，不因为多了几节就整包拒收。
         */
        // 个性化条目先只登记、不落盘：等整批事务提交成功再写文件。
        // 以前在解析阶段就 keep.keep()，数据库回滚了文件却已经在数据目录里 —— 半套状态。
        val pendingKeeps = mutableListOf<Pair<String, String>>()
        if (migrationKeeps != null) {
            pendingKeeps += migrationKeeps
        } else if (keep != null) {
            val handled = (SOURCE_NAMES + RULE_NAMES + SHELF_NAMES + COOKIE_NAMES + GROUP_NAMES + RSS_NAMES)
                .map { it.lowercase() }.toSet()
            for (entry in entries) {
                val name = entry.name.substringAfterLast('/')
                val lower = name.lowercase()
                if (lower in handled || lower in KEEP_EXCLUDED || !isKeepName(name)) continue
                val text = runCatching { readEntry(zip, entry) }.getOrNull() ?: continue
                pendingKeeps += name to text
            }
        }

        val cookies = prepareCookies(zip, nativeEntries, password)
        PreparedBackup(sources, rules, shelf, groups, rss, subscriptions, present, pendingKeeps, cookies.first, cookies.second,
            BackupSourceArchive(rawSources, rawShelf))
    }

    /**
     * 裸 JSON：不套 zip 的分享书源（`shareBookSource.json` 这种）、以及把多个小节装进
     * 一个对象的合并导出（`{bookSource:[…],bookshelf:[…],replaceRule:[…]}`）。
     *
     * 条目按**字段特征**归类而不是按文件名：同一个数组里混着书源与书架的包也能读。
     * 认出的小节名不在本服务原生范围内、但属于 [BackupStore.KEEP_NAMES] 的包装键
     * （`bookmark`、`readRecordSession`…）会连同整个值原样收下。
     */
    private fun prepareJson(file: Path): PreparedBackup {
        val size = runCatching { Files.size(file) }.getOrDefault(0L)
        require(size <= MAX_JSON_BYTES) { "JSON 备份超过 ${MAX_JSON_BYTES / 1024 / 1024} MiB，已拒绝" }
        val text = decode(Files.readAllBytes(file)).trim().removePrefix("\uFEFF")
        val elements = collectJsonEntries(text)
        require(elements.isNotEmpty()) {
            "不是可识别的 Legado 备份：文件既不是 zip，也不是带书源 / 书架 / 替换规则的 JSON"
        }

        val sources = mutableListOf<String>()
        val rawSources = mutableListOf<JsonElement>()
        val rawShelf = mutableListOf<JsonElement>()
        val rules = mutableListOf<ReplaceRule>()
        val shelf = mutableListOf<BackupShelfEntry>()
        val groups = mutableListOf<Pair<Long, String>>()
        val rss = mutableListOf<String>()
        val subscriptions = mutableListOf<BackupSubscriptionEntry>()
        val cookieRows = mutableListOf<CookieRow>()
        // 同 importZip：只登记，事务提交成功后才落盘。
        val pendingKeeps = mutableListOf<Pair<String, String>>()

        for (entry in elements) {
            val obj = entry.value as? JsonObject ?: continue
            when (sectionOf(obj)) {
                Section.SOURCE -> { rawSources += obj; sourceOf(obj)?.let { sources += it } }
                Section.RULE -> ruleOf(obj)?.let { rules += it }
                Section.SHELF -> { rawShelf += obj; shelfOf(obj)?.let { shelf += it } }
                Section.GROUP -> groupOf(obj)?.let { groups += it }
                Section.RSS -> rss += obj.toString()
                Section.SUBSCRIPTION -> {
                    subscriptionOf(obj)?.let { subscriptions += it }
                    // 包装键是 sourceSub 时既落表、又原样留档：上游 RuleSub 的 name/js/showRule
                    // 等字段本机表没有落点，光进表会丢。
                    val keepName = entry.name?.let { name ->
                        BackupStore.KEEP_NAMES.firstOrNull { it.equals("$name.json", ignoreCase = true) }
                    }
                    if (keep != null && keepName != null) pendingKeeps += keepName to obj.toString()
                }
                Section.COOKIE -> obj.text("url")?.takeIf { it.isNotBlank() }?.let { url ->
                    cookieRows += CookieRow(url = url, cookie = obj.text("cookie").orEmpty())
                }
                null -> {
                    // 包装键就是数据目录里的条目名：整个值（数组或对象）原样收下
                    val keepName = entry.name?.let { name ->
                        BackupStore.KEEP_NAMES.firstOrNull { it.equals("$name.json", ignoreCase = true) }
                    } ?: continue
                    if (keep == null) continue
                    val raw = entry.value.toString()
                    pendingKeeps += keepName to raw
                }
            }
        }

        val present = buildSet {
            if (sources.isNotEmpty()) add("booksource.json")
            if (rules.isNotEmpty()) add("replacerule.json")
            if (shelf.isNotEmpty()) add("bookshelf.json")
            if (groups.isNotEmpty()) add("bookgroup.json")
            if (rss.isNotEmpty()) add("rsssources.json")
            if (subscriptions.isNotEmpty()) add("sourcesub.json")
            if (cookieRows.isNotEmpty()) add("cookies.json")
            addAll(pendingKeeps.map { it.first.lowercase() })
        }
        require(sources.isNotEmpty() || rules.isNotEmpty() || shelf.isNotEmpty() || groups.isNotEmpty() ||
            rss.isNotEmpty() || subscriptions.isNotEmpty() || cookieRows.isNotEmpty() || pendingKeeps.isNotEmpty()) {
            "不是可识别的 Legado 备份：JSON 里没有书源 / 替换规则 / 书架 / RSS 订阅源 / 分组 / 登录凭据，" +
                "也没有能收下的个性化条目"
        }

        return PreparedBackup(sources, rules, shelf, groups, rss, subscriptions, present, pendingKeeps, cookieRows,
            sourceArchive = BackupSourceArchive(rawSources, rawShelf))
    }

    /**
     * 所有落库与结果汇总只有这一份实现，zip 与裸 JSON 两条入口共用 ——
     * 以前兄弟备份只差几个条目名，没必要让两条路径各写一遍导入顺序。
     *
     * **落库是一整笔事务**：六步里任何一步抛错，六个域一起回到导入前，不会再出现
     * 「书源进去了、书架没进去」。个性化条目（[BackupStore]）是磁盘副作用，只能在
     * 事务提交成功之后写。冲突书源的不可变恢复证据则必须在提交前落盘，失败时阻止提交；
     * 如 SQLite 最终提交失败，可能保留该证据文件，但它不代表导入成功。
     */
    private fun commit(
        sources: List<String>,
        rules: List<ReplaceRule>,
        shelf: List<BackupShelfEntry>,
        groups: List<Pair<Long, String>>,
        rss: List<String>,
        subscriptions: List<BackupSubscriptionEntry>,
        present: Set<String>,
        pendingKeeps: List<Pair<String, String>>,
        libraryPolicy: BackupLibraryPolicy?,
        previewToken: String?,
        fileHash: String,
        sourceArchive: BackupSourceArchive?,
        cookies: () -> CookieOutcome,
    ): BackupImportSummary {
        var sourceResult = ImportResponse(0, 0, 0, emptyList())
        var ruleResult = ReplaceRuleImportResponse(0, 0, 0, 0)
        var groupMap: Map<Long, Long> = emptyMap()
        var library = LibraryImportResult(0, 0, 0)
        var rssResult = ImportResponse(0, 0, 0, emptyList())
        var appliedSubscriptions = 0
        var cookieOutcome = CookieOutcome(0, null)
        val sourceEvidence = mutableListOf<KeptBackupEntry>()
        database.transaction { db ->
            // 必须早于任何域写入；预测和检查共用相同读法，失败则整包没有副作用。
            val libraryPlan = libraryPolicy?.takeIf { shelf.isNotEmpty() }?.let { policy ->
                planLibraryRestore(db, shelf, policy, fileHash).also {
                    if (it.token != previewToken) throw BackupPreviewChangedException()
                }
            }
            stepHook?.invoke("sources")
            sourceResult = database.importSourcesOn(db, sources)
            stepHook?.invoke("rules")
            ruleResult = database.importReplaceRulesOn(db, rules)
            // 分组必须先落库：书架条目上的 groupId 是手机那侧的号码，要经这张映射换成本机号，
            // 否则会把本机同号的另一个组（往往是「本地」）当成目标，书就悄悄归错组了。
            stepHook?.invoke("groups")
            groupMap = database.importBookGroupsOn(db, groups)
            stepHook?.invoke("library")
            library = if (libraryPlan == null) database.importLibraryOn(db, shelf.map { it.copy(groupId = groupMap[it.phoneGroupId] ?: 0L) })
            else applyLibraryRestore(db, libraryPlan.copy(actions = libraryPlan.actions.map { action ->
                action.copy(entry = action.entry.copy(groupId = groupMap[action.entry.phoneGroupId] ?: 0L))
            }))
            stepHook?.invoke("rss")
            rssResult = database.importRssSourcesOn(db, rss)
            stepHook?.invoke("subscriptions")
            appliedSubscriptions = database.importSubscriptionsOn(db, subscriptions)
            stepHook?.invoke("cookies")
            cookieOutcome = cookies()
            // Must succeed before SQLite commits. If COMMIT itself fails, immutable evidence may remain;
            // it is recovery evidence, never an import-success marker, and must not be deleted on a race.
            try {
                sourceArchive?.text(fileHash)?.let { text ->
                    sourceEvidence += requireNotNull(keep) { "此备份存在书源冲突，必须配置留档目录" }.keepSourceArchive(text)
                }
                pendingKeeps.filter { BackupMigration.archivePattern.matches(it.first) }.forEach { (name, text) ->
                    BackupSourceArchive.validate(name, text)
                    sourceEvidence += requireNotNull(keep) { "恢复书源版本证据需要留档目录" }.keepSourceArchive(text)
                }
            } catch (error: Exception) {
                throw BackupArchiveException(error)
            }
        }
        // 缓存只在提交成功后失效：回滚时库里没变，清缓存纯属白做。
        database.invalidateSourceCaches()
        val kept = sourceEvidence + pendingKeeps.filterNot { BackupMigration.archivePattern.matches(it.first) }.mapNotNull { (name, text) ->
            if (keep?.keep(name, text) == true) keptEntry(name, text) else null
        }
        val keptNames = kept.map { it.name.lowercase() }.toSet()
        return BackupImportSummary(
            sources = sourceResult.imported,
            sourcesUpdated = sourceResult.updated,
            rules = ruleResult.imported,
            rulesUpdated = ruleResult.updated,
            books = library.imported,
            booksUpdated = library.updated,
            booksSkippedDeleted = library.skippedDeleted,
            progress = library.progress,
            libraryDiff = library.diff,
            cookies = cookieOutcome.applied,
            cookiesNote = cookieOutcome.note,
            bookGroups = groupMap.size,
            subscriptions = appliedSubscriptions,
            rssSources = rssResult.imported,
            rssSourcesUpdated = rssResult.updated,
            skippedSections = (KNOWN_BUT_UNSUPPORTED - keptNames).filter { it in present }.sorted(),
            keptSections = kept.sortedBy { it.name.lowercase() },
            errors = sourceResult.errors + rssResult.errors,
        )
    }

    private fun keptEntry(name: String, text: String): KeptBackupEntry = KeptBackupEntry(
        name = name,
        label = BackupStore.labelOf(name),
        bytes = text.toByteArray(Charsets.UTF_8).size.toLong(),
        items = runCatching { LegacyBackup.elementsOf(text).size }.getOrDefault(0),
        appliable = BackupStore.isAppliable(name),
        updatedAt = System.currentTimeMillis(),
    )

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
    private fun prepareCookies(zip: ZipFile, entries: List<ZipEntry>, password: String?): Pair<List<CookieRow>, String?> {
        val raw = readSection(zip, entries, COOKIE_NAMES)?.trim() ?: return emptyList<CookieRow>() to null
        if (raw.isEmpty()) return emptyList<CookieRow>() to "包内 cookies.json 是空的"
        if (password.isNullOrBlank()) {
            return emptyList<CookieRow>() to "包内有加密的 cookies.json（手机备份里的登录态），填备份密码才能恢复"
        }
        val plain = runCatching { BackupAes.decryptBase64(raw, password) }
            .getOrElse { return emptyList<CookieRow>() to "cookies.json 解密失败：备份密码不对" }
        val rows = runCatching { parseCookieRows(plain) }
            .getOrElse { return emptyList<CookieRow>() to "cookies.json 内容不是预期的 [{url,cookie}] 数组" }
        return rows to null
    }

    /** 裸 JSON 里的明文凭据与解密后的 zip 凭据走同一套写入与跳过口径。 */
    private fun applyCookies(rows: List<CookieRow>): CookieOutcome {
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

    /**
     * 把任意 JSON 摊成「可能是一条记录」的候选，并保留它所在的包装键。
     *
     * 三步：数组逐项展开；对象若本身就是一条记录（书源 / 规则 / 书架 / 分组 / RSS / 凭据）
     * 就收下；否则当包装对象继续下钻。包装键命中 [BackupStore.KEEP_NAMES] 时整个值原样收下，
     * 不再拆散 —— 书签数组要作为一个文件保存，拆成一条条会把上一条覆盖掉。
     */
    private fun collectJsonEntries(text: String): List<JsonEntry> {
        val root = runCatching { Json.parseToJsonElement(text) }.getOrElse {
            throw IllegalArgumentException("不是可识别的 Legado 备份：文件既不是 zip，也不是合法 JSON")
        }
        val out = mutableListOf<JsonEntry>()
        fun walk(value: JsonElement, name: String?) {
            when (value) {
                is JsonArray -> value.forEach { walk(it, name) }
                is JsonObject -> {
                    if (name != null && isKeepName("$name.json")) {
                        out += JsonEntry(name, value)
                        return
                    }
                    if (sectionOf(value) != null) out += JsonEntry(name, value)
                    else value.forEach { (key, child) -> walk(child, key) }
                }
                else -> {}
            }
        }
        walk(root, null)
        return out
    }

    private fun isKeepName(name: String): Boolean =
        BackupStore.KEEP_NAMES.any { it.equals(name, ignoreCase = true) }

    /**
     * 按字段特征认小节。书源认 `bookSourceUrl` / 老格式标记，RSS 认 `sourceUrl`；
     * 两者都有时是书源（书源自己也允许 `sourceUrl` 作为地址别名）。
     */
    private fun sectionOf(obj: JsonObject): Section? = when {
        LegacyBackup.isOldSource(obj) || obj.containsKey("bookSourceUrl") -> Section.SOURCE
        obj.containsKey("sourceUrl") && !obj.containsKey("bookSourceUrl") -> Section.RSS
        obj.containsKey("pattern") && (obj.containsKey("replacement") || obj.containsKey("isRegex") ||
            obj.containsKey("isEnabled") || obj.containsKey("isEnable")) -> Section.RULE
        obj.containsKey("groupId") && obj.containsKey("groupName") -> Section.GROUP
        // 上游 RuleSub 必带 url/type/autoUpdate；`sourceUrl` 是可空的可选项，不能拿它当判据。
        obj.containsKey("url") && obj.containsKey("type") && obj.containsKey("autoUpdate") -> Section.SUBSCRIPTION
        obj.containsKey("url") && obj.containsKey("cookie") -> Section.COOKIE
        obj.containsKey("bookUrl") || obj.containsKey("noteUrl") || obj.containsKey("bookInfoBean") -> Section.SHELF
        else -> null
    }

    private enum class Section { SOURCE, RULE, SHELF, GROUP, RSS, SUBSCRIPTION, COOKIE }

    private data class JsonEntry(val name: String?, val value: JsonElement)

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

    /**
     * 老备份的编码不一定是我们写出去的 UTF-8：手机端、网盘转存、手工整理都可能留下 GB18030 / 带 BOM 的文件。
     * 统一走 [decodeTextAuto]（BOM → UTF-8 → GB18030），别再用「`String(bytes, UTF_8)` 解不出来再换」——
     * 它从不抛异常，GB18030 那一档是永远走不到的死代码（上一版就是这样，老包整包中文变成 U+FFFD）。
     */
    private fun decode(bytes: ByteArray): String = decodeTextAuto(bytes)

    /** 老格式先按上游映射迁成现版本结构，否则导进来是取不到值的空壳源。 */
    private fun sourceOf(element: JsonElement): String? =
        if (LegacyBackup.isOldSource(element)) LegacyBackup.toNewSourceJson(element) else element.toString()

    /**
     * `rssSources.json`（手机「订阅」页的 RSS 源）：RSS 是 Legado 3.x 才有的功能，
     * 字段名从那时起没变过，所以不像书源那样需要老格式迁移，原样交给 [SourceCodec.parseRss]。
     */
    private fun parseRssSources(text: String): List<String> = LegacyBackup.elementsOf(text)
        .filterIsInstance<JsonObject>().map { it.toString() }

    private fun parseRules(text: String): List<ReplaceRule> =
        LegacyBackup.elementsOf(text).mapNotNull(::ruleOf)

    private fun ruleOf(element: JsonElement): ReplaceRule? {
        val normalized = LegacyBackup.normalizeReplaceRule(element) ?: return null
        val rule = Json.parseToJsonElement(normalized).jsonObject
        val pattern = rule.text("pattern") ?: return null
        return ReplaceRule(
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
    private fun parseBookGroups(text: String): List<Pair<Long, String>> =
        LegacyBackup.elementsOf(text).mapNotNull(::groupOf)

    private fun groupOf(element: JsonElement): Pair<Long, String>? {
        val group = element as? JsonObject ?: return null
        val id = group.number("groupId") ?: return null
        val name = group.text("groupName")?.trim() ?: return null
        return id to name
    }

    /**
     * `sourceSub.json`（上游 `Backup.kt:301` ← `ruleSubDao.all`，实体是 `RuleSub`）。
     * 只收 `type=0`：产物是书源的订阅；`type=1` 是 RSS 订阅、`type=3` 是替换规则订阅，
     * 本机订阅表只描述书源订阅，硬塞会让同步产物对不上。原包仍会原样留档，不丢这三种数据。
     * 上游 `autoUpdate` 对到本机 `enabled`（关掉的订阅留在列表里，可手动更新）。
     */
    private fun parseSubscriptions(text: String): List<BackupSubscriptionEntry> =
        LegacyBackup.elementsOf(text).mapNotNull(::subscriptionOf)

    private fun subscriptionOf(element: JsonElement): BackupSubscriptionEntry? {
        val obj = element as? JsonObject ?: return null
        val url = obj.text("url")?.trim()?.takeIf { it.isNotBlank() } ?: return null
        val type = obj.number("type") ?: 0L
        if (type != 0L) return null
        val flag = obj["autoUpdate"] as? JsonPrimitive
        val enabled = flag?.booleanOrNull ?: flag?.longOrNull?.let { it != 0L } ?: false
        return BackupSubscriptionEntry(url = url, enabled = enabled)
    }

    private fun shelfOf(element: JsonElement): BackupShelfEntry? {
        val jsonText = if (LegacyBackup.isOldShelfEntry(element)) LegacyBackup.toNewShelfJson(element) else element.toString()
        val book = jsonText?.let { Json.parseToJsonElement(it).jsonObject } ?: return null
        val origin = book.text("origin")?.takeIf { it.isNotBlank() } ?: return null
        val bookUrl = book.text("bookUrl")?.takeIf { it.isNotBlank() } ?: return null
        val sourceId = SourceCodec.normalizeSourceId(origin)
        if (sourceId.isBlank()) return null
        return BackupShelfEntry(
            sourceId = sourceId,
            bookUrl = bookUrl,
            name = book.text("name")?.takeIf { it.isNotBlank() } ?: bookUrl,
            author = book.text("author")?.takeIf { it.isNotBlank() },
            tocUrl = book.text("tocUrl")?.takeIf { it.isNotBlank() } ?: bookUrl,
            coverUrl = (book.text("coverUrl") ?: book.text("customCoverUrl"))?.takeIf { it.isNotBlank() },
            completed = book.text("kind")?.contains("完结") == true,
            chapterIndex = book.number("durChapterIndex")?.toInt() ?: 0,
            chapterPos = book.number("durChapterPos")?.toInt()?.coerceAtLeast(0) ?: 0,
            // 现行 Legado/MD3 的书架条目把组号写在 `group`（Book.group）；`groupId` 只出现在
            // 早期兄弟包与老格式转换里。两个都认，否则真实备份导进来会全部落在「未分组」。
            phoneGroupId = book.number("group") ?: book.number("groupId") ?: 0L,
            readAt = book.number("durChapterTime") ?: 0L,
            hasProgress = book.number("durChapterIndex") != null,
        )
    }

    private fun JsonObject.text(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
    private fun JsonObject.flag(key: String): Boolean? = (this[key] as? JsonPrimitive)?.booleanOrNull
    private fun JsonObject.number(key: String): Long? = (this[key] as? JsonPrimitive)?.longOrNull

    internal companion object {
        val SECTION_IDS = setOf("sources", "rules", "shelf", "groups", "rss", "subscriptions", "cookies", "kept")
        const val MAX_ENTRY_BYTES = 64L * 1024 * 1024
        const val MAX_TOTAL_BYTES = 256L * 1024 * 1024
        const val MAX_JSON_BYTES = 64L * 1024 * 1024

        /*
         * 兄弟项目（官方 LegadoTeam、legado-with-MD3、Legado_Max、Ink、Sigma…）核心小节
         * 与上游同名；额外写法来自各家的改名、网页版导出与手工整理包。
         * 匹配统一走 `substringAfterLast('/').lowercase()`，所以这里的驼峰只是为了可读。
         */
        val SOURCE_NAMES = listOf(
            "booksource.json", "mybooksource.json", "readappbooksource.json", "sources.json",
            "booksources.json", "book_source.json", "book-source.json", "source.json",
        )
        val RULE_NAMES = listOf(
            "replacerule.json", "mybookreplacerule.json", "readappreplacerule.json",
            "replacerules.json", "replace_rule.json", "replace-rule.json",
        )
        val SHELF_NAMES = listOf(
            "bookshelf.json", "mybookshelf.json", "readappbookshelf.json",
            "bookshelves.json", "book_shelf.json", "book-shelf.json", "shelf.json", "books.json",
        )
        val COOKIE_NAMES = listOf("cookies.json", "cookie.json")
        val GROUP_NAMES = listOf(
            "bookGroup.json", "bookgroups.json", "book_group.json", "book-group.json", "groups.json",
        )

        /** 上游 `Backup.kt:287` 写出的名字就是 `rssSources.json`（复数），别和 `rssStar.json` 混了。 */
        val RSS_NAMES = listOf(
            "rssSources.json", "rsssource.json", "rsssources.json",
            "rss_sources.json", "rss-sources.json", "rss.json",
        )

        /**
         * 书源订阅地址（上游 `sourceSub.json` ← `RuleSub`）。故意不加进 `prepareZip` 的 `handled`
         * 集合：这一节**既落订阅表、又原样留档**，兄弟项目多写的字段不丢。
         */
        val SUB_NAMES = listOf(
            "sourceSub.json", "sourcesub.json", "ruleSub.json", "rule_sub.json", "rule-sub.json",
        )

        /** 备份包里我们暂时承接不了的条目：导入后如实回报，不假装什么都没发生。 */
        val KNOWN_BUT_UNSUPPORTED = listOf(
            "rssstar.json", "bookmemo.json",
            "bookmark.json", "highlight.json", "highlightrule.json", "readrecord.json",
            "readrecorddetail.json", "searchhistory.json", "txttocrule.json", "httptts.json",
            "keyboardassists.json", "dictrule.json", "servers.json", "readconfig.json",
            "themeconfig.json", "config.xml", "videoconfig.xml", "autotask.json", "runtimesourcecache.json",
        )

        /**
         * 仍然只上报、不收进数据目录的条目：config.xml / config.json / videoconfig.xml 是
         * 客户端本机配置（组件名、绝对路径、设备参数），收下来既没有消费方又把无关信息留在服务器上；
         * autotask、runtimesourcecache、bookCacheIndex、bookChapterCache 是运行时缓存，本来就可再生。
         */
        val KEEP_EXCLUDED = setOf(
            "config.xml", "config.json", "videoconfig.xml", "autotask.json",
            "runtimesourcecache.json", "bookcacheindex.json", "bookchaptercache.json",
        )
    }
}
