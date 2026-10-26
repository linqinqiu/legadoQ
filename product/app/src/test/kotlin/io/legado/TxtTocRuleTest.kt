package io.legado

import org.junit.Assert.*
import org.junit.Test
import java.nio.charset.StandardCharsets
import io.legado.localbook.LocalBookParser
import io.legado.localbook.TocRules
import io.legado.localbook.TxtTocRule

/**
 * TXT 目录规则表（用户 2026-10-02：「txt目录规则，这个可以放到阅读设置里」）。
 *
 * 这组用例的目的不是"规则多"，而是**证明那 26 条从上游搬来的正则在 JVM 里真的能用**：
 * 它们要能在 Kotlin/Java 的 `Pattern` 下编译、能按正文打分、切完不丢字。
 * 上游用的是 Android 的 `java.util.regex`，看着同一套其实差在调用方式
 * （`MULTILINE` + `find()` 全文找标题，不是逐行 `matches`），照错语义比抄错字符更隐蔽。
 */
class TxtTocRuleTest {

    /** 一本规规矩矩的书：八个章标题，每章正文一千多字（远超打分里的 1000 字间隔线）。 */
    private fun wellMarkedBook(): String = buildString {
        append("这是一段没有章节标记的开篇散稿，用来验证前言不会被吞掉。\n")
        for (index in 1..8) {
            append("第").append(chinese(index)).append("章 第").append(index).append("回标题\n")
            repeat(30) { append("这是第${index}章的正文内容，讲一些情节推进与人物对话。\n") }
        }
        append("全书完\n")
    }

    private fun chinese(index: Int): String =
        listOf("一", "二", "三", "四", "五", "六", "七", "八", "九", "十")[index - 1]

    /** 没有章节标记的散文：任何规则都不该硬切出一堆章。 */
    private fun plainProse(): String = buildString {
        repeat(60) { append("他沿着河堤走了很久，水声一直跟着他，像一句不肯说完的话。\n") }
    }

    @Test
    fun `packaged rule table loads with the upstream shape`() {
        assertEquals("上游这份表是 26 条", 26, TocRules.all.size)
        assertEquals("默认启用 12 条", 12, TocRules.all.count { it.enable })
        assertTrue("一条都编译不出来就是资源或正则方言出了问题", TocRules.candidates.isNotEmpty())
        // 启用的规则必须全部编译得出来：编不出来会被静默跳过，用户看到的是"选了没用"
        assertEquals(
            "有启用的规则编译失败：" + TocRules.all.filter { it.enable && it.rule.isNotBlank() && TocRules.regexFor(it.id.toString()) == null }
                .joinToString { it.name },
            TocRules.all.count { it.enable && it.rule.isNotBlank() },
            TocRules.candidates.size,
        )
    }

    @Test
    fun `suggest picks a rule that actually carves the book`() {
        val text = wellMarkedBook()
        val picked = TocRules.suggest(text)
        assertNotNull("规规矩矩的「第一章 …」不该选不出规则", picked)
        val regex = TocRules.regexFor(picked!!.id.toString())!!
        val chapters = TocRules.split(text, regex)
        assertTrue("切出的章数不该少于 8（实际 ${chapters.size}，规则「${picked.name}」）", chapters.size >= 8)
        assertTrue("章名里要能看见中文数字章", chapters.any { it.title.contains("第一章") })
        // 入选条件本身就是可断言的性质：有效标题数 ≥ 伪命中数 × 3
        val (titles, volumes) = TocRules.score(text.take(512_000), picked.id)!!
        assertTrue("入选规则没满足打分条件：titles=$titles volumes=$volumes", titles >= volumes * 3)
    }

    @Test
    fun `auto selection never eats the very first chapter`() {
        val text = buildString {
            for (index in 1..8) {
                append("第").append(chinese(index)).append("章 第").append(index).append("回标题\n")
                // 正文里刻意不出现"第X章"这种字样，也不给开头的散稿 —— 这本书的第一行就是第一章
                repeat(50) { append("这是${index}号船员的正文内容，讲一些情节推进与人物对话。\n") }
            }
        }
        // 反向对照：随包里确实有条规则"开头没有换行就命不中"。它不存在的话这条用例就是空判。
        val misses = TocRules.candidates.filter { rule ->
            val regex = TocRules.regexFor(rule.id.toString()) ?: return@filter false
            (regex.findAll(text).firstOrNull()?.range?.first ?: 0) > 0
        }
        assertTrue("随包规则里没有漏掉第一条标题的样本，判据失去意义", misses.isNotEmpty())

        val picked = TocRules.suggest(text)
        assertNotNull("规规矩矩的书不该选不出规则", picked)
        val chapters = TocRules.split(text, TocRules.regexFor(picked!!.id.toString())!!)
        assertEquals("第一章整章被吞成了「前言」（选中的规则是「${picked.name}」）", "第一章 第1回标题", chapters.first().title)
        assertEquals("八章就该切出八章（实际 ${chapters.size}）", 8, chapters.size)
    }

    @Test
    fun `applying a backup table adopts enable choices by rule text and keeps unknown rules`() {
        val dir = java.nio.file.Files.createTempDirectory("toc-rule-merge")
        val json = kotlinx.serialization.json.Json
        val payloadOf = { rules: List<TxtTocRule> -> json.encodeToString(kotlinx.serialization.builtins.ListSerializer(TxtTocRule.serializer()), rules) }
        val enabled = TocRules.packaged.filter { it.enable }
        val target = enabled.first()
        val payload = payloadOf(listOf(
            // 同一条规则、手机上取消了勾选：按 `rule` 字面匹配，不看 id（手机端 id 与本机对不上）
            target.copy(id = 777, enable = false),
            // 用户在手机上自己加的一条：随包没有，收下为新规则
            TxtTocRule(id = 778, name = "我自己加的规则", rule = "^第[0-9]+[章节].*$", serialNumber = 99, enable = true),
            // 编不出来的正则不该入库（入库会让"这条切不出章"变成随机现象）
            TxtTocRule(id = 779, name = "坏正则", rule = "([unclosed", serialNumber = 98, enable = true),
        ))
        try {
            TocRules.useStore(dir.resolve("txt_toc_rules.json"))
            val report = TocRules.applyBackup(payload)
            assertEquals("匹配上的只有一条", 1, report["matched"])
            assertEquals("启用状态被改动一条", 1, report["flipped"])
            assertEquals("收下 1 条新规则（实际 ${report["added"]}）", 1, report["added"])
            assertEquals("坏正则 1 条被跳过", 1, report["unusable"])
            assertFalse("手机上取消勾选的那条在本机应变为停用", TocRules.byId(target.id)!!.enable)
            assertTrue("新规则要能被查到", TocRules.all.any { it.name == "我自己加的规则" })
            assertNull("坏正则不入库", TocRules.all.firstOrNull { it.name == "坏正则" })
            // 覆盖文件写的是**整张表**：只写"改动的那几条"时，重新装载会把停用冲掉
            // （第一版就是这里露馅的：`ArrayList(容量)` 造出来是空表，匹配到的那条根本没被改到）
            val rows = json.decodeFromString(kotlinx.serialization.builtins.ListSerializer(TxtTocRule.serializer()),
                java.nio.file.Files.readString(dir.resolve("txt_toc_rules.json")))
            assertTrue("覆盖文件里应有整张表（实际 ${rows.size} 条，随包 ${TocRules.packaged.size} 条）",
                rows.size >= TocRules.packaged.size + 1)
            assertFalse("文件里那一条也记着停用", rows.first { it.id == target.id }.enable)
            assertEquals("来自备份的条数要说得出来", 1, TocRules.customCount)
            assertTrue("随包那份不许被写坏（改动只在覆盖层）", TocRules.packaged.first { it.id == target.id }.enable)
            // 换一个 store 再读回来，等价于重启进程：改动必须落在文件里而不是只在内存
            TocRules.useStore(dir.resolve("txt_toc_rules.json"))
            assertFalse("重新装载后停用状态还在", TocRules.byId(target.id)!!.enable)
        } finally {
            // 收尾必须把全局表倒回去，否则同一 JVM 里后面的用例会读到这份测试的启用改动
            TocRules.useStore(dir.resolve("nothing-here.json"))
            java.nio.file.Files.deleteIfExists(dir.resolve("txt_toc_rules.json"))
            java.nio.file.Files.deleteIfExists(dir)
        }
        assertEquals("倒回之后随包多少条就是多少条", TocRules.packaged.size, TocRules.all.size)
        assertTrue("倒回之后那条又启用着", TocRules.byId(target.id)!!.enable)
    }

    @Test
    fun `split keeps the prologue and the tail instead of eating text`() {
        val text = wellMarkedBook()
        val picked = TocRules.suggest(text)!!
        val chapters = TocRules.split(text, TocRules.regexFor(picked.id.toString())!!)
        assertEquals("第一章之前的散稿要成节", "前言", chapters.first().title)
        assertTrue(chapters.first().content.contains("没有章节标记的开篇散稿"))
        val joined = chapters.joinToString("\n") { "${it.title}\n${it.content}" }
        assertTrue("正文不能丢", joined.contains("水声") || joined.contains("情节推进"))
        assertTrue("结尾散句要归最后一章", chapters.last().content.contains("全书完"))
        assertTrue("每章都得有正文", chapters.filter { it.title != "前言" }.all { it.content.isNotBlank() })
    }

    @Test
    fun `a book without headings falls back to the builtin path and loses nothing`() {
        val prose = plainProse()
        val parsed = LocalBookParser.parseTxt("散文集.txt", prose.toByteArray(StandardCharsets.UTF_8))
        assertEquals("切不出章就该老实说用的是内置", TocRules.BUILTIN, parsed.tocRuleUsed)
        assertTrue(parsed.chapters.isNotEmpty())
        val joined = parsed.chapters.joinToString("\n") { it.content }
        assertTrue("内置路径也不许丢正文", joined.contains("他沿着河堤走了很久"))
    }

    @Test
    fun `explicit builtin key never consults the table`() {
        val text = wellMarkedBook()
        val parsed = LocalBookParser.parseTxt("规整书.txt", text.toByteArray(StandardCharsets.UTF_8), TocRules.BUILTIN)
        assertEquals(TocRules.BUILTIN, parsed.tocRuleUsed)
        // 内置那条是逐行匹配的，八章都在
        assertTrue(parsed.chapters.count { it.title.startsWith("第") } >= 8)
    }

    @Test
    fun `unknown rule id is refused, not silently ignored`() {
        assertNull(TocRules.regexFor("999999"))
        assertNull(TocRules.regexFor(TocRules.AUTO))
        assertNull(TocRules.regexFor(null))
        assertTrue(TocRules.label("999999").contains("未知规则"))
        // 显式指定一条不存在的规则：不报错也不生效，回落内置 —— 但 tocRuleUsed 必须说实话
        val parsed = LocalBookParser.parseTxt(
            "规整书.txt", wellMarkedBook().toByteArray(StandardCharsets.UTF_8), "999999",
        )
        assertEquals(TocRules.BUILTIN, parsed.tocRuleUsed)
    }

    @Test
    fun `labels for the two special keys read as sentences`() {
        assertEquals("自动选择（按正文打分）", TocRules.label(TocRules.AUTO))
        assertEquals("内置规则", TocRules.label(TocRules.BUILTIN))
        val real = TocRules.candidates.first()
        assertEquals(real.name, TocRules.label(real.id.toString()))
        assertTrue(TocRules.isAuto(null))
        assertTrue(TocRules.isAuto(TocRules.AUTO))
        assertFalse(TocRules.isAuto(real.id.toString()))
    }

    /**
     * 「txt目录规则没有做好」（用户 2026-10-03）。根因是一个旗标兼两职：
     * 选择清单只发 `candidates`（启用 ∩ 可编译）= 26 条里的 14 条，另外 12 条
     * 既看不见也选不了 —— 而 `byId` 走的是全表，解析层其实一直支持它们。
     * 拆成两件事：**能不能手动选**看编不编得出来，**是否参与自动打分**才看 enable。
     */
    @Test
    fun `停用的规则仍然可以手动选，只是不参与自动打分`() {
        val disabled = TocRules.all.filter { !it.enable }
        assertTrue("随包 26 条里默认停用 14 条（实际 ${disabled.size}），这个用例才有东西可判", disabled.size >= 10)
        val compilable = disabled.filter { TocRules.compiles(it.id) }
        assertTrue("停用的那些里得有能编译的，否则下面无从断言", compilable.isNotEmpty())
        val pool = TocRules.candidates.map { it.id }.toSet()
        compilable.forEach { rule ->
            assertFalse("「自动」的候选池里不许有停用的规则（${rule.name}）", pool.contains(rule.id))
            assertNotNull("手动按 id 查得到停用的规则（${rule.name}）", TocRules.byId(rule.id))
            assertTrue("可选手册必须包含它，否则用户根本选不到（${rule.name}）", TocRules.selectable.any { it.id == rule.id })
        }
        assertEquals("可选 = 全表减掉编不出正则的", TocRules.all.count { TocRules.compiles(it.id) }, TocRules.selectable.size)
        assertTrue("随包这份里没有坏正则", TocRules.brokenCount == 0)
        // id -100 是随包表里的"内置逐行匹配"：它没有正则，`compile` 返回 null 只是因为没东西可编译。
        // 把它算成"坏规则"会让界面上出现一条写着「正则在本机编译不出来」的内置项 —— 那是谎话。
        assertTrue("内置那条没有正则，但不许被算成坏规则", TocRules.compiles(TocRules.PACKAGED_BUILTIN_ID))
        assertTrue("内置那条也要在可选手册里", TocRules.selectable.any { it.id == TocRules.PACKAGED_BUILTIN_ID })
        assertFalse("它不参与自动打分（没有正则可打分）", TocRules.candidates.any { it.id == TocRules.PACKAGED_BUILTIN_ID })
    }

    @Test
    fun `开关一条规则只改它是否参与自动，且落在文件里`() {
        val dir = java.nio.file.Files.createTempDirectory("legado-toc-toggle")
        val store = dir.resolve("txt_toc_rules.json")
        val target = TocRules.packaged.first { it.enable }
        try {
            TocRules.useStore(store)
            assertNotNull("关掉之后还在表里（关掉 ≠ 删掉）", TocRules.setEnable(target.id, false))
            assertFalse("启用位改了", TocRules.byId(target.id)!!.enable)
            assertFalse("它退出了自动候选池", TocRules.candidates.any { it.id == target.id })
            assertTrue("手动仍然选得到", TocRules.selectable.any { it.id == target.id })
            // 换一个 store 再读回来 = 重启进程：改动必须在文件里，不能只在内存
            TocRules.useStore(store)
            assertFalse("重新装载后停用还在", TocRules.byId(target.id)!!.enable)
            assertTrue("写的是整张表，不是只有改动那几条",
                java.nio.file.Files.readString(store).length > 200)
            TocRules.setEnable(target.id, true)
            TocRules.useStore(store)
            assertTrue("再开回来", TocRules.byId(target.id)!!.enable)
            assertNull("不存在的 id 要说没有，不能默默成功", TocRules.setEnable(424242, true))
        } finally {
            TocRules.useStore(dir.resolve("nothing-here.json"))
            java.nio.file.Files.deleteIfExists(store)
            java.nio.file.Files.deleteIfExists(dir)
        }
        assertTrue("倒回之后又回到随包那份", TocRules.byId(target.id)!!.enable)
    }

    /**
     * 「txt目录规则可新建可编辑」（用户 2026-10-03）。三条口径各有一条断言：
     * 新建要拿到一个没占过的 id；改随包那条只动本机这份、能被「恢复随包那份」还原；
     * 编不出来的正则不许入库（入库就等于界面上留一条"选了切不出章"的骗人选项）。
     */
    @Test
    fun `新建与修改分章规则都落在文件里，坏正则进不来`() {
        val dir = java.nio.file.Files.createTempDirectory("legado-toc-save")
        val store = dir.resolve("txt_toc_rules.json")
        val packaged = TocRules.packaged.first { it.enable }
        try {
            TocRules.useStore(store)
            val before = TocRules.all.size

            val created = TocRules.save(null, "自造：第N话", """^\s*第[0-9]+话.*""", "第1话 起", true)
            assertNotNull("新建要回一条带 id 的规则", created)
            assertTrue("id 是自建段（10000 起），不会撞上随包那 26 条", created!!.id >= 10_000)
            assertEquals("表里多了一条", before + 1, TocRules.all.size)
            assertTrue("新建的这条能选", TocRules.selectable.any { it.id == created.id })
            assertTrue("新建的这条能参与打分", TocRules.candidates.any { it.id == created.id })

            // 改随包那一条：只改本机这一份
            val renamed = TocRules.save(packaged.id, "改过的名字", packaged.rule, packaged.example, false)
            assertNotNull("随包那条也能改（改的是覆盖文件里的这一份）", renamed)
            assertEquals("名字改了", "改过的名字", TocRules.byId(packaged.id)?.name)
            assertFalse("启用位跟着存", TocRules.byId(packaged.id)!!.enable)
            assertEquals("改一条不会多出一条", before + 1, TocRules.all.size)

            TocRules.useStore(store)
            assertEquals("重启进程之后改动还在", "改过的名字", TocRules.byId(packaged.id)?.name)
            assertNotNull("自建那条也在文件里", TocRules.byId(created.id))

            assertNull("空名字不收", TocRules.save(null, "   ", """^\d+""", null, true))
            assertNull("空正则不收（那等于整本一章）", TocRules.save(null, "空的", "  ", null, true))
            assertNull("编不出来的正则不收", TocRules.save(null, "坏括号", """^(\d+""", null, true))
            assertEquals("三次失败都没往表里写", before + 1, TocRules.all.size)
            assertNull("不认识的 id 不当成新建", TocRules.save(424242, "别处来的", """^\d+""", null, true))
        } finally {
            TocRules.clearOverrides()
            TocRules.useStore(dir.resolve("nothing-here.json"))
            java.nio.file.Files.deleteIfExists(store)
            java.nio.file.Files.deleteIfExists(dir)
        }
        assertEquals("清掉本机改动就回到随包那份", TocRules.packaged.size, TocRules.all.size)
        assertEquals("随包那条的名字也还原了", packaged.name, TocRules.byId(packaged.id)?.name)
    }

    /**
     * 「txt目录规则有问题」第一条真因：Java 的 `\s` 只认 ASCII 空白，**不含全角空格 U+3000**，
     * 而中文 TXT 的章节标题普遍用全角空格缩进。铁证是随包那 26 条里有 23 条手工补了 `　`
     * （写成 `[ 　\t]{0,4}`）—— 上游作者被迫绕开这个局限，可这个约定用户看不见。
     * 用户按浏览器直觉写 `^\s*第\d+章`：JS 里能匹配「　　第一章」，存进 Java 引擎就是 0 命中，
     * 于是「规则已保存、也启用了，但整本书切不出章」。
     * 修法是给编译统一加 `(?U)`（UNICODE_CHARACTER_CLASS），让 `\s` 认 Unicode 空白。
     */
    @Test
    fun `用户按 JS 直觉写的 s 和 d 能认出全角空格缩进的标题`() {
        val dir = java.nio.file.Files.createTempDirectory("legado-toc-unicode")
        val store = dir.resolve("txt_toc_rules.json")
        // 每章正文一千多字：远超打分里的 1000 字间隔线，标题也不会被当成"伪命中"。
        val body = "这是讲情节推进与人物对话的正文内容，够长以免被打分当成噪声。".repeat(40) + "\n"
        val text = buildString {
            append("　　第1章 起风了\n").append(body)
            append("　　第2章 落雨了\n").append(body)
            append("　　第3章 天晴了\n").append(body)
        }
        try {
            TocRules.useStore(store)
            // 用户按浏览器直觉写的一条：`^\s*第\d+章.*`。全角空格（U+3000）缩进 + 阿拉伯数字序号。
            val created = TocRules.save(null, "自造：全角缩进", """^\s*第\d+章.*""", "　　第1章 起风了", true)
            assertNotNull("新建规则要成功", created)
            val regex = TocRules.regexFor(created!!.id.toString())
            assertNotNull("这条规则要能编译", regex)
            // 直接量正则：不经过切分，判据才只盯「(?U) 让 \s 吃到全角空格」这一件事。
            // 实测对照（tools 诊断过）：不带 (?U) 时 \s 在 U+3000 前 0 命中，带了是 3 命中。
            val hits = regex!!.findAll(text).toList()
            assertEquals("三条全角缩进的标题应全部命中（实际 ${hits.size}）", 3, hits.size)
            val chapters = TocRules.split(text, regex)
            assertEquals("切不出三章就是没生效（实际 ${chapters.size}）", 3, chapters.size)
            assertTrue("第一章标题要认出来", chapters.first().title.contains("第1章"))
        } finally {
            TocRules.clearOverrides()
            TocRules.useStore(dir.resolve("nothing-here.json"))
            java.nio.file.Files.deleteIfExists(store)
            java.nio.file.Files.deleteIfExists(dir)
        }
    }

    /** `(?U)` 只加语义、不许改行为：随包那 26 条的编译与自动选择必须与加旗标前一致。 */
    @Test
    fun `加 Unicode 旗标后随包规则照常编译且仍能选出章`() {
        assertEquals("随包这份里仍不许有坏正则", 0, TocRules.brokenCount)
        assertEquals("启用条数不变", 12, TocRules.all.count { it.enable })
        val text = wellMarkedBook()
        val picked = TocRules.suggest(text)
        assertNotNull("规整的书仍然选得出规则", picked)
        val chapters = TocRules.split(text, TocRules.regexFor(picked!!.id.toString())!!)
        assertTrue("切出的章数不退化（实际 ${chapters.size}）", chapters.size >= 8)
        // 这本的开头那段散稿是**真前言**（既有基线，见上面 split keeps the prologue），
        // 加旗标后必须还是前言；变成别的就说明随包规则的选择被改动了。
        assertEquals("前言位不变", "前言", chapters.first().title)
    }

    /**
     * 「txt目录规则有问题」第二条真因：新建规则的 `serialNumber = max+1` 必然排在整张表末尾，
     * 而自动打分命中够 `EARLY_ACCEPT` 条就**提前定案** —— 于是用户新建的精准规则可能
     * 永远得不到评分机会：界面上"已新建、已启用"，实际一点作用没有。
     *
     * 这条用例证明的范围要说清楚：它钉的是**自建段必须参与打分并能够被选中**
     * （构造一种随包 26 条都识别不了、只有自建规则识别得了的标题形状，
     * 「第N节课」——随包那几条「第N节」规则都带 `节(?!课)` 负向排除，正好全都避开）。
     * 配套修复是 [TocRules.suggest] 只在"已经进入自建段"时不再提前定案，
     * 随包段之间的相对行为一字不动。
     */
    @Test
    fun `自建规则能参与自动打分并被选中`() {
        val dir = java.nio.file.Files.createTempDirectory("legado-toc-order")
        val store = dir.resolve("txt_toc_rules.json")
        val body = "这是讲情节推进与人物对话的正文内容，够长以免被打分当成噪声。".repeat(40) + "\n"
        // 120 章，标题一律是「第N节课」——随包那几条第N节类规则都用 `节(?!课)` 排除了它。
        val text = buildString {
            for (index in 1..120) {
                append("第").append(index).append("节课 ").append(index).append(". ").append(body)
            }
        }
        try {
            TocRules.useStore(store)
            val custom = TocRules.save(null, "自造：第N节课", """^第\d+节课.{0,20}""", "第1节课", true)
            assertNotNull("要建得起自建规则", custom)
            assertTrue("自建规则的序号必然排在表尾（否则这条用例没东西可判）",
                custom!!.serialNumber > TocRules.packaged.maxOf { it.serialNumber })

            val picked = TocRules.suggest(text)
            assertNotNull("打分要能选出规则", picked)
            assertEquals(
                "这种形状的标题只有自建那条认得，必须落在它上（实际选中「${picked!!.name}」）",
                custom.id, picked.id,
            )
        } finally {
            TocRules.clearOverrides()
            TocRules.useStore(dir.resolve("nothing-here.json"))
            java.nio.file.Files.deleteIfExists(store)
            java.nio.file.Files.deleteIfExists(dir)
        }
    }

    @Test
    fun `只有自建的规则能删，随包那 26 条删不掉`() {
        val dir = java.nio.file.Files.createTempDirectory("legado-toc-remove")
        val store = dir.resolve("txt_toc_rules.json")
        try {
            TocRules.useStore(store)
            val packagedId = TocRules.packaged.first().id
            assertFalse("随包条目不可删（要还原用「恢复随包那份」）", TocRules.removable(packagedId))
            assertFalse("remove 也拒绝", TocRules.remove(packagedId))
            assertEquals("表一条没少", TocRules.packaged.size, TocRules.all.size)

            val created = TocRules.save(null, "要删掉的这条", """^\s*第[0-9]+回""", null, true)!!
            assertTrue("自建的可以删", TocRules.removable(created.id))
            val total = TocRules.all.size
            assertTrue("remove 回报成功", TocRules.remove(created.id))
            assertEquals("删掉之后少一条", total - 1, TocRules.all.size)
            assertNull("表里真没了", TocRules.byId(created.id))
            TocRules.useStore(store)
            assertNull("文件里也没了（重启不复活）", TocRules.byId(created.id))
            assertFalse("删一条不存在的要说没删", TocRules.remove(424242))
        } finally {
            TocRules.clearOverrides()
            TocRules.useStore(dir.resolve("nothing-here.json"))
            java.nio.file.Files.deleteIfExists(store)
            java.nio.file.Files.deleteIfExists(dir)
        }
    }
}
