package io.legado.rules

/**
 * 简繁转换 —— 书源 JS 里的 `java.t2s(text)` / `java.s2t(text)`。
 *
 * 上游这两个函数在 `JsExtensions.kt`（t2s）与 `ChineseUtils.kt` 里，本服务端原来一个都没绑。
 * 后果不是"少转几个字"：Rhino 里调用 undefined 抛 TypeError，而 `ruleContent.content` 那条路径
 * **不包 runCatching**（见 `RuleRunner`），所以正文整章取不到 —— 本机库实测 30 条源用 `java.t2s`
 * （11 条在 ruleContent）、7 条用 `java.s2t`。
 *
 * 表与前端「简繁转换」设置**同一份**：`web/src/features/reader/dict/openccData.ts` 与这里的
 * `/dict/opencc.txt` 都由 `tools/gen-script-dict.mjs` 从 OpenCC 数据生成（Apache-2.0），
 * 裁剪口径也一样（词组只留字表转不对的）。这样同一段文字在阅读器里和书源脚本里转出来一致。
 *
 * 三个决定：
 * 1. **懒加载**：238 KB 的表只在真有书源调用时才解析，不进启动路径。
 * 2. **词组优先、长的先试**：简繁不是一一对应（发→發/髮、干→乾/幹），只查字表会出
 *    "头发→頭發"这种读得出来但错的转换。
 * 3. **s2t 最后过一遍台港字形表**（爲→為、裏→裡）—— 与前端 `scriptConvert.ts` 同一条规矩；
 *    t2s 不需要（繁→简没有这个分叉）。
 */
internal object ScriptConvert {

    private const val RESOURCE = "/dict/opencc.txt"

    private class Table(
        val chars: Map<Int, String>,
        val phrases: Map<Int, List<Pair<String, String>>>,
        /** s2t 专用：通用繁体 → 台港字形。 */
        val tailChars: Map<Int, String> = emptyMap(),
    )

    private class Dict(val s2t: Table, val t2s: Table)

    private val dict: Dict by lazy { load() }

    /** 繁 → 简。 */
    fun t2s(text: String): String = if (text.isEmpty()) text else convert(text, dict.t2s)

    /** 简 → 繁（收尾过台港字形表）。 */
    fun s2t(text: String): String {
        if (text.isEmpty()) return text
        val table = dict.s2t
        return applyChars(convert(text, table), table.tailChars)
    }

    private fun load(): Dict {
        val stream = ScriptConvert::class.java.getResourceAsStream(RESOURCE)
            ?: error("缺少 $RESOURCE —— 跑 `node tools/gen-script-dict.mjs` 生成")
        val sections = LinkedHashMap<String, StringBuilder>()
        var current: StringBuilder? = null
        stream.bufferedReader(Charsets.UTF_8).useLines { lines ->
            for (line in lines) {
                when {
                    line.startsWith("#") -> {
                        val name = line.substring(1).trim()
                        current = StringBuilder()
                        sections[name] = current!!
                    }
                    // 每行是 CHUNK 条 `原文 译文`，行内与行间都用 `|` 分隔（生成端保证值里没有空格）
                    line.isNotBlank() -> current?.append(line)?.append('|')
                }
            }
        }
        val s2tChars = toChars(entries(sections, "s2t_chars"))
        val t2sChars = toChars(entries(sections, "t2s_chars"))
        return Dict(
            s2t = Table(
                chars = s2tChars,
                phrases = toPhrases(entries(sections, "s2t_phrases")),
                tailChars = toChars(entries(sections, "s2t_tw_chars")),
            ),
            t2s = Table(
                chars = t2sChars,
                phrases = toPhrases(entries(sections, "t2s_phrases")),
            ),
        )
    }

    private fun entries(sections: Map<String, StringBuilder>, name: String): List<Pair<String, String>> {
        val packed = sections[name]?.toString() ?: return emptyList()
        val out = ArrayList<Pair<String, String>>(packed.length / 6)
        for (entry in packed.split('|')) {
            val gap = entry.indexOf(' ')
            if (gap <= 0 || gap == entry.length - 1) continue
            out += entry.substring(0, gap) to entry.substring(gap + 1)
        }
        return out
    }

    /** 键是**码点**：扩展 B 区的字在 UTF-16 里是两个码元，按码元建表会永远命不中。 */
    private fun toChars(entries: List<Pair<String, String>>): Map<Int, String> {
        val map = HashMap<Int, String>(entries.size * 2)
        for ((key, value) in entries) map[key.codePointAt(0)] = value
        return map
    }

    private fun toPhrases(entries: List<Pair<String, String>>): Map<Int, List<Pair<String, String>>> {
        val map = HashMap<Int, MutableList<Pair<String, String>>>()
        for (entry in entries) {
            map.getOrPut(entry.first.codePointAt(0)) { ArrayList(4) } += entry
        }
        // 长的先试：`一干二净` 必须赢过 `一干`
        for (bucket in map.values) {
            bucket.sortByDescending { it.first.codePointCount(0, it.first.length) }
        }
        return map
    }

    /** 词组最长匹配 → 落空则逐字查表。 */
    private fun convert(text: String, table: Table): String {
        val out = StringBuilder(text.length + 8)
        var index = 0
        while (index < text.length) {
            val codePoint = text.codePointAt(index)
            var matched = false
            val bucket = table.phrases[codePoint]
            if (bucket != null) {
                for ((key, value) in bucket) {
                    if (text.startsWith(key, index)) {
                        out.append(value)
                        index += key.length
                        matched = true
                        break
                    }
                }
            }
            if (matched) continue
            val char = String(Character.toChars(codePoint))
            out.append(table.chars[codePoint] ?: char)
            index += char.length
        }
        return out.toString()
    }

    private fun applyChars(text: String, chars: Map<Int, String>): String {
        if (chars.isEmpty() || text.isEmpty()) return text
        val out = StringBuilder(text.length)
        var index = 0
        while (index < text.length) {
            val codePoint = text.codePointAt(index)
            val char = String(Character.toChars(codePoint))
            out.append(chars[codePoint] ?: char)
            index += char.length
        }
        return out.toString()
    }
}
