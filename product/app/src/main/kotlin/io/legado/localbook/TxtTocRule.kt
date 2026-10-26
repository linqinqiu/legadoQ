package io.legado.localbook

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import io.legado.ops.logParsing
import io.legado.ops.logSystem

/**
 * 本地 TXT 的目录规则（用户 2026-10-02：「txt目录规则，这个可以放到阅读设置里」）。
 *
 * 字段与上游 `data/entities/TxtTocRule.kt` 对齐；内置那 26 条来自上游
 * `app/src/main/assets/defaultData/txtTocRule.json`（LegadoTeam/legado，GPL-3.0，
 * 本项目同为 GPL-3.0），**原样作为随包资源 `assets/txtTocRule.json` 装进来，不手抄**：
 * 这些正则里有 `节(?!课)`、`正文(?!完|结)`、`部(?![分赛游])` 这类负向排除，
 * 抄错一个字就会把"第一节课程"当成一章，或者反过来整本书切不出一章。
 */
@Serializable
data class TxtTocRule(
    val id: Int = 0,
    val name: String = "",
    val rule: String = "",
    /** 上游用它挂"标题净化 JS"；随包这 26 条里都是空的，接上之前不参与解析。 */
    val replacement: String = "",
    val example: String? = null,
    val serialNumber: Int = -1,
    val enable: Boolean = true,
)

/**
 * 规则表与"哪一条适合这本书"的判定。
 *
 * 打分口径照抄上游 `TextFile.getTocRule()`：对**同一份正文**逐条规则跑一遍，
 * `csNum` 是有效标题数，`numE` 是"两次命中之间不足 100 字"的伪命中（这种一般是卷/部，不是章）；
 * 只有 `csNum >= numE * 3` 且比当前最优多 [OVER_RULE_COUNT] 条以上才换规则，
 * 命中超过 [EARLY_ACCEPT] 条就提前定案（前面的规则已经够用了，不必再试后面的）。
 *
 * 为什么要有这套打分：单看一条规则"能匹配上"没有意义——越宽松的规则匹配得越多也错得越多，
 * 必须拿真实正文量出来它切出的章数与噪声比例。
 */
object TocRules {
    /** 界面与备份里用的两个特殊值；其余都是 [TxtTocRule.id] 的十进制字符串。 */
    const val AUTO = "auto"
    const val BUILTIN = "builtin"

    private const val OVER_RULE_COUNT = 2
    private const val EARLY_ACCEPT = 70

    /** 打分只看文件头这么多字符：与上游"读头 512KB 选规则"同一口径，200MB 的书不必全文扫两遍。 */
    private const val SNIFF_CHARS = 512_000

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }
    // ConcurrentHashMap 不许存 null，所以"编不出来"不能塞进同一张表里 ——
    // 第一版就是在这里 `getOrPut(id) { … ?: return@getOrPut null }`，
    // 查一个不存在的规则 id 直接 NPE。成功进 compiled，失败进 rejected。
    private val compiled = java.util.concurrent.ConcurrentHashMap<Int, Regex>()
    private val rejected = java.util.concurrent.ConcurrentHashMap.newKeySet<Int>()

    /**
     * 本机对规则表的改动（手机备份里那份 `txtTocRule.json` 套进来的启用选择、以及包里
     * 自带的自定义规则）。存文件不建表：这张表只在解析目录时被读一次，没有查询需求。
     */
    @Volatile private var storeFile: java.nio.file.Path? = null
    @Volatile private var snapshot: List<TxtTocRule>? = null
    /** 收下但本机用不了的条目（正则编不出来），界面上要报数，不能悄悄丢。 */
    @Volatile var lastApplyUnusable = 0
        private set

    /** 指到 data/ 下那个文件；启动时调一次，之后 `all` 就是"随包 ∪ 本机改动"。 */
    fun useStore(path: java.nio.file.Path) {
        storeFile = path
        reload()
    }

    /** 套用备份之后必须让正在跑的进程用新表 —— 缓存不清就是"点了套用但没生效"。 */
    fun reload() {
        snapshot = null
        compiled.clear()
        rejected.clear()
    }

    /** 随包那 26 条（不含本机改动）。判据用它确认"表没被本机改动污染"。 */
    val packaged: List<TxtTocRule> by lazy { loadPackaged() }

    /** 从备份收下来的、随包没有的那几条 —— 界面上要能报这个数。 */
    val customCount: Int get() = (all.size - packaged.size).coerceAtLeast(0)

    val all: List<TxtTocRule>
        get() = snapshot ?: synchronized(this) { snapshot ?: buildTable().also { snapshot = it } }

    private fun buildTable(): List<TxtTocRule> {
        val overrides = loadOverrides()
        if (overrides.isEmpty()) return packaged
        val packagedIds = packaged.map { it.id }.toSet()
        val merged = packaged.map { rule ->
            // 本机改动带的是**整条**（名字、正则、示例、启用都可能被改过 —— 用户 2026-10-03
            // 要「可新建可编辑」），但 id 与 replacement 仍以随包那条为准：id 是引用，
            // replacement 目前没人写。空字段回落到随包那份，避免旧覆盖文件把名字抹成空串。
            overrides.firstOrNull { it.id == rule.id }?.let { over ->
                rule.copy(
                    enable = over.enable,
                    serialNumber = over.serialNumber,
                    name = over.name.ifBlank { rule.name },
                    rule = over.rule.ifBlank { rule.rule },
                    example = over.example ?: rule.example,
                )
            } ?: rule
        }
        // 备份里带来的、随包没有的那几条（用户在手机上自己写的规则）：收下，能选能用
        return merged + overrides.filter { it.id !in packagedIds && it.rule.isNotBlank() }
    }

    private fun loadOverrides(): List<TxtTocRule> {
        val file = storeFile ?: return emptyList()
        val text = runCatching { java.nio.file.Files.readString(file, Charsets.UTF_8) }.getOrNull()
        if (text.isNullOrBlank()) return emptyList()
        return runCatching { json.decodeFromString<List<TxtTocRule>>(text) }
            .onFailure { Unit.logSystem("TXT 目录规则的本机改动读不出来，按随包那份继续", mapOf("原因" to (it.message ?: ""))) }
            .getOrDefault(emptyList())
    }

    /** 本机改动是否还在（文件在不在）—— 界面上「恢复随包那份」这颗按钮按它出现。 */
    val hasOverrides: Boolean get() = storeFile?.let { java.nio.file.Files.exists(it) } ?: false

    /**
     * 撤掉本机改动，回到随包那 26 条。
     * 套用是一次显式动作，就得配一条显式的撤销 —— 门禁跑完也要靠它把用户的规则表还原。
     */
    fun clearOverrides(): Boolean {
        val file = storeFile ?: return false
        val existed = java.nio.file.Files.deleteIfExists(file)
        reload()
        return existed
    }

    /**
     * 套用备份包里那份规则表。
     *
     * 上游的 `txtTocRule.json` 是整张表（含用户在手机上勾的启用/停用与自己加的规则），
     * 但 id 是手机端分配的，与本机随包那份对不上号 —— 所以**按 `rule` 字面匹配**，
     * 匹配上就采纳它的启用与顺序，匹配不上就当作一条新规则收下。
     * 正则编不出来的条目不入库（入库会让"这条规则切不出章"变成随机现象），只报数。
     */
    fun applyBackup(text: String): Map<String, Int> {
        val incoming = runCatching { json.decodeFromString<List<TxtTocRule>>(text) }.getOrDefault(emptyList())
            .filter { it.rule.isNotBlank() }
        val current = all
        // ArrayList(容量) 造出来的是**空表**，这里要的是当前这张表的副本 ——
        // 写成 `ArrayList(current.size + incoming.size)` 时"匹配上的那条"根本找不到位置去改，
        // 计数照报 flipped=1，文件里却只剩新收的规则（门禁抓到过一次，红得很安静）。
        val merged = ArrayList(current)
        var matched = 0
        var flipped = 0
        var added = 0
        var unusable = 0
        for (rule in incoming) {
            if (!canCompile(rule.rule)) {
                unusable += 1
                continue
            }
            val same = current.firstOrNull { it.rule == rule.rule }
            if (same != null) {
                matched += 1
                if (same.enable != rule.enable) flipped += 1
                val at = merged.indexOfFirst { it.id == same.id }
                if (at >= 0) merged[at] = same.copy(enable = rule.enable, serialNumber = rule.serialNumber)
            } else {
                added += 1
                merged += rule.copy(id = nextCustomId(merged))
            }
        }
        val file = storeFile ?: return emptyMap()
        java.nio.file.Files.createDirectories(file.parent)
        java.nio.file.Files.writeString(file, json.encodeToString(merged), Charsets.UTF_8)
        lastApplyUnusable = unusable
        reload()
        return mapOf("matched" to matched, "flipped" to flipped, "added" to added, "unusable" to unusable, "total" to all.size)
    }

    /**
     * 界面上可以手动选的：**编得出来就可选**，不看 `enable`。
     * `enable` 只决定"自动"那条路走不走它 —— 让手动选择也受它管，
     * 等于把 26 条里的 12 条（章回体「第N回」这类都在里面）变成既看不见也选不了。
     */
    val selectable: List<TxtTocRule> get() = all.filter { compiles(it.id) }

    /** 正则编不出来的条目（备份里带来的坏规则）。界面上要数得出来，不能悄悄不出现。 */
    val brokenCount: Int get() = all.count { !compiles(it.id) }

    /**
     * 单独开关一条规则（只影响它是否参与"自动"打分）。
     * 写的是整张表 —— 与 `applyBackup` 同一个文件同一个形状，别把本机改动分成两种格式。
     */
    fun setEnable(id: Int, enable: Boolean): TxtTocRule? {
        val file = storeFile ?: return null
        val current = all
        if (current.none { it.id == id }) return null
        writeTable(file, current.map { if (it.id == id) it.copy(enable = enable) else it })
        return byId(id)
    }

    /** 覆盖文件写的是"这一台机器上的整张表"，所以任何一处改动都走同一个写入口。 */
    private fun writeTable(file: java.nio.file.Path, table: List<TxtTocRule>) {
        java.nio.file.Files.createDirectories(file.parent)
        java.nio.file.Files.writeString(file, json.encodeToString(table), Charsets.UTF_8)
        reload()
    }

    /**
     * 所有分章正则的**唯一**编译入口。三个旗标都有明确理由，改这里必须三处同时改
     * （[compile] 缓存、[patternUsable] 保存前校验、[applyBackup] 收备份）：
     * 校验与真实编译用不同旗标，就会出现"存进去了但运行时不匹配"这种最难查的错。
     *
     * `UNICODE_CHARACTER_CLASS` 是修「txt目录规则有问题」的关键：Java 的 `\s` 只认 ASCII 空白，
     * **不含全角空格 U+3000**，而中文 TXT 的章节标题恰恰普遍用全角空格缩进。
     * 证据就在随包那 26 条里：23 条都手工补了 `　`（写成 `[ 　\t]{0,4}`、`[\s　]`）——
     * 上游作者被迫绕开这个局限。用户按浏览器直觉写 `^\s*第\d+章`，在 JS 里能匹配
     * "　　第一章"，存进 Java 引擎就成了 0 命中：整本书切不出一章，
     * 界面上却写着"规则已保存"，这就是「规则有问题」的体感来源。
     * 加上这个旗标后 `\s`=`[\t\n\x0B\f\r\p{Z}]`（含 U+3000）、`\d` 认全角数字，与 JS 语义对齐。
     */
    private fun compilePattern(pattern: String): Regex =
        Regex("(?U)$pattern", RegexOption.MULTILINE)

    private fun canCompile(pattern: String): Boolean = runCatching { compilePattern(pattern) }.isSuccess

    /** 一条正则在这台机器上编不编得出来 —— 保存之前先问，别把"选了切不出章"留给用户。 */
    fun patternUsable(pattern: String): Boolean = canCompile(pattern)

    /**
     * 新建或改一条规则（用户 2026-10-03：「txt目录规则可新建可编辑」）。三条口径：
     * ① 随包那 26 条**也允许改** —— 改的是本机这一份，「恢复随包那份规则表」整张还原。
     *    不让改的话用户只能"另建一条同名的"，两条同名规则比一条改过的更难懂。
     * ② 名字与正则都要非空，且正则必须在服务端编译得出来才落盘：坏正则入库会让
     *    "选了这条却一章切不出"变成随机现象（解析层是跳过并记日志，可界面上它仍然可选，
     *    那就是骗人）。
     * ③ `id == null` 才是新建。**不能拿 -1 之类的数字当"新建"哨兵** —— 随包表的 id
     *    本来就是负数（-1 是「目录(去空白)」），第一版这么写，"新建一条"把 -1 那条改了名
     *    （门禁 ⑦ 当场抓到：表还是 26 条，只是多了个"门禁改过-"的名字）。
     *    返回 null = 没改成，由路由层翻成一句人话。
     */
    fun save(id: Int?, name: String, rule: String, example: String?, enable: Boolean): TxtTocRule? {
        val file = storeFile ?: return null
        val trimmed = name.trim()
        val pattern = rule.trim()
        if (trimmed.isBlank() || pattern.isBlank() || !patternUsable(pattern)) return null
        val current = all
        val existing = id?.let { want -> current.firstOrNull { it.id == want } }
        if (id != null && existing == null) return null
        val next = existing?.copy(name = trimmed, rule = pattern, example = example?.trim(), enable = enable)
            ?: TxtTocRule(
                id = nextCustomId(current),
                name = trimmed,
                rule = pattern,
                example = example?.trim(),
                serialNumber = (current.maxOfOrNull { it.serialNumber } ?: 0) + 1,
                enable = enable,
            )
        val replaced = current.map { if (it.id == next.id) next else it }
        writeTable(file, if (existing == null) replaced + next else replaced)
        return byId(next.id)
    }

    /** 这条能不能删（界面按它决定摆不摆删除键）。随包条目不可删，见 [remove]。 */
    fun removable(id: Int): Boolean = all.any { it.id == id } && packaged.none { it.id == id }

    /**
     * 删掉一条**自建**的规则。随包那 26 条删不掉：它们是上游给的默认表，
     * 不想用可以取消「自动」勾选；给它们开删除洞，「恢复随包那份」就没有参照了。
     */
    fun remove(id: Int): Boolean {
        val file = storeFile ?: return false
        if (!removable(id)) return false
        writeTable(file, all.filterNot { it.id == id })
        return true
    }

    private fun nextCustomId(existing: List<TxtTocRule>): Int =
        generateSequence(CUSTOM_ID_BASE) { it + 1 }.first { id -> existing.none { it.id == id } }

    /** 自建规则的 id 起点：用它区分"随包段/自建段"（见 [suggest] 的早停条件）。 */
    private const val CUSTOM_ID_BASE = 10_000


    /** 能参与打分/选用的：启用、规则非空、且真的编译得出来（坏正则跳过，不是崩）。 */
    val candidates: List<TxtTocRule> get() = all.filter { it.enable && compile(it.id) != null }

    fun byId(id: Int): TxtTocRule? = all.firstOrNull { it.id == id }

    /** 界面上显示的名字（找不到规则时说真话，不把裸 id 甩给用户）。 */
    fun label(key: String): String = when (key) {
        AUTO -> "自动选择（按正文打分）"
        BUILTIN -> "内置规则"
        else -> byId(key.toIntOrNull() ?: Int.MIN_VALUE)?.name ?: "未知规则（$key）"
    }

    /**
     * 随包那张表里，"内置逐行匹配"自己占一条（id -100，`rule` 是空的 —— 它没有正则，
     * 分章走 `LocalBookParser` 里那段手写逐行匹配）。它**不是坏规则**：
     * `compile` 返回 null 只是因为没东西可编译。它也不进 `candidates` ——
     * 自动打分要的是"哪条正则切得最好"，这条没有正则。
     */
    const val PACKAGED_BUILTIN_ID = -100

    /** 给界面用：这条能不能拿来用（内置那条没有正则但可用；备份里带来的坏正则不算）。 */
    fun compiles(id: Int): Boolean = id == PACKAGED_BUILTIN_ID || compile(id) != null

    /** 上游用 `Pattern.MULTILINE` + `find()` 全文找标题，这里保持同一语义。 */
    private fun compile(id: Int): Regex? {
        compiled[id]?.let { return it }
        if (id in rejected) return null
        val rule = byId(id)
        if (rule == null || rule.rule.isBlank()) {
            rejected += id
            return null
        }
        val regex = runCatching { compilePattern(rule.rule) }.getOrElse { error ->
            // 坏规则不该拖垮整条导入链，但必须看得见是哪一条坏了（本轮日志改造的口径）。
            rejected += id
            Unit.logParsing("TXT 目录规则正则编译失败，已跳过该规则", mapOf("规则" to rule.name, "原因" to (error.message ?: "")))
            return null
        }
        compiled[id] = regex
        return regex
    }

    fun regexFor(key: String?): Regex? {
        val id = key?.toIntOrNull() ?: return null
        return compile(id)
    }

    /** 这本书用的规则是不是"自动"这一档（含没存过规则的老数据）。 */
    fun isAuto(key: String?): Boolean = key.isNullOrBlank() || key == AUTO

    /**
     * 这条规则有没有**把文件开头那一章漏掉**。
     *
     * 上游的打分只比命中条数，且"多不出 [OVER_RULE_COUNT] 条就不换规则"：几百章的书没问题，
     * 五章的书正好踩中 —— 像「目录(去空白)」这种 `\n` 起头的规则，第一条标题前面没有换行，
     * 于是**第一章永远不命中**，整章变成「前言」（实测这本 5 章的探针书切出 4 章 + 一个 2985px 的前言）。
     *
     * 判据不靠"间隔比例"那种碰运气的阈值，直接看事实：开头空出来的那一段，它的第一行
     * 本身就是一条章节标题（内置那条识别得出来）—— 那就是漏了边界，不是"这本书真有前言"。
     */
    private fun missesFirstHeading(head: String, regex: Regex): Boolean {
        val firstLine = head.substringBefore('\n').trim()
        if (firstLine.isBlank() || !LocalBookParser.CHAPTER_TITLE_REGEX.matches(firstLine)) return false
        return (regex.findAll(head).firstOrNull()?.range?.first ?: 0) > 0
    }

    /**
     * 按上游口径给一条规则打分：返回（有效标题数, 伪命中数）。
     * 单独暴露出来是为了判据能直接断言"宽松规则的分不会赢过精确规则"。
     */
    fun score(text: String, id: Int): Pair<Int, Int>? {
        val regex = compile(id) ?: return null
        var start = 0
        var titles = 0
        var volumes = 0
        for (match in regex.findAll(text)) {
            val gap = match.range.first - start
            if (start == 0 || gap > 1000) {
                if (match.value.isNotBlank()) titles++
                start = match.range.last + 1
            } else if (gap < 100) {
                volumes++
            }
        }
        return titles to volumes
    }

    /**
     * 给这本书挑一条规则；一条都不合格时返回 null，由调用方回落到内置那条。
     *
     * 关于 `EARLY_ACCEPT` 提前定案：它的目的是少跑几条正则，但它原来**无条件生效**，
     * 而自建规则的 `serialNumber = max+1`（见 [save]）必然排在整张表末尾 ——
     * 于是长篇书在前面的随包规则就凑满 70 条命中、当场定案，
     * **用户新建的那条精准规则永远得不到打分机会**，界面上"已新建、已启用"却毫无效果
     * （用户报「txt目录规则有问题」的第二条真因）。
     *
     * 修法要守住一条：随包那 26 条之间的选择行为不能变，否则全部存量书的目录都可能漂。
     * 自建段既然一定排在表尾，那就只把"已经进入自建段"当成**不许提前定案**的条件 ——
     * 早停只会发生在随包段内部，随包段的行为逐字节与原来一致。
     */
    fun suggest(text: String): TxtTocRule? {
        val head = if (text.length > SNIFF_CHARS) text.substring(0, SNIFF_CHARS) else text
        val pool = candidates
        val firstCustomSerial = pool.firstOrNull { it.id >= CUSTOM_ID_BASE }?.serialNumber ?: Int.MAX_VALUE
        var best: TxtTocRule? = null
        var maxNum = -1
        for (rule in pool) {
            val regex = compile(rule.id) ?: continue
            if (missesFirstHeading(head, regex)) continue
            val (titles, volumes) = score(head, rule.id) ?: continue
            if (titles >= volumes * 3 && titles > maxNum + OVER_RULE_COUNT) {
                maxNum = titles
                best = rule
                if (maxNum > EARLY_ACCEPT && rule.serialNumber < firstCustomSerial) break
            }
        }
        return best
    }

    /**
     * 用给定规则把正文切成章。标题取命中本身，正文取到下一个命中之前。
     * 返回空列表表示"这条规则在这本书上切不出章"，调用方该回落而不是硬用。
     *
     * 偏移一律用命中的**原始末尾**：上游标题不 trim，所以它按 `matcher.group()` 的长度切正文
     * （TextFile.kt:212 / :278 / :305）。我们显示的是 trim 过的标题（前导空白在 TXT 里是排版，不是标题的一部分），
     * 但那是显示层的事 —— 拿 trim 后的长度去推末尾，差几个空白字符就有几个字从标题漏进上一章的正文。
     */
    fun split(text: String, regex: Regex): List<ParsedChapter> {
        val hits = regex.findAll(text)
            .map { Triple(it.range.first, it.range.last + 1, it.value.trim()) }
            .filter { it.third.isNotEmpty() }
            .toList()
        if (hits.isEmpty()) return emptyList()
        val chapters = mutableListOf<ParsedChapter>()
        val prologue = text.substring(0, hits.first().first).trim()
        // 第一章之前还散着内容：与内置路径同一处理，不丢字。
        if (prologue.isNotBlank()) chapters.add(ParsedChapter("前言", prologue.take(2000)))
        chapters.add(ParsedChapter(hits.first().third, ""))
        for (index in 1 until hits.size) {
            val title = hits[index].third
            val body = text.substring(hits[index - 1].second, hits[index].first).trim()
            chapters[chapters.lastIndex] = ParsedChapter(chapters.last().title, body)
            chapters.add(ParsedChapter(title, ""))
        }
        chapters[chapters.lastIndex] = ParsedChapter(
            chapters.last().title,
            text.substring(hits.last().second).trim(),
        )
        return chapters.filter { it.title.isNotBlank() }
    }

    private fun loadPackaged(): List<TxtTocRule> {
        val text = runCatching {
            TocRules::class.java.classLoader.getResourceAsStream("assets/txtTocRule.json")
                ?.readBytes()?.toString(Charsets.UTF_8)
        }.getOrNull()
        if (text.isNullOrBlank()) {
            // 资源没进包（打包环节出错）：只剩内置那一条规则，导入功能不该因此整个死掉。
            Unit.logSystem("没读到随包的 TXT 目录规则表，只剩内置规则可用", mapOf("资源" to "assets/txtTocRule.json"))
            return emptyList()
        }
        return runCatching { json.decodeFromString<List<TxtTocRule>>(text) }
            .onFailure { Unit.logSystem("TXT 目录规则表解析失败", mapOf("原因" to (it.message ?: ""))) }
            .getOrNull()
            ?.sortedBy { it.serialNumber }
            ?: emptyList()
    }
}
