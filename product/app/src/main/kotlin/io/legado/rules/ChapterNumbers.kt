package io.legado.rules

/**
 * 章节序号文本 → 数字（上游 `StringUtils.stringToInt` / `chineseNumToInt` / `fullToHalf`
 * 与 `JsExtensions.toNumChapter` 的等价实现）。
 *
 * 为什么要照上游写而不是自己发挥：社区书源里有 **146 处** 调用 `java.toNumChapter(...)`
 * （天天小说（优+++）、格格党⑥、笔趣阁80、独步小说…），用来把「第一千二百三十四章」这类
 * 标题归一化成「第1234章」。上游的算法就是「`第(.+?)章` 抓中间 → 中文/全角数字转阿拉伯数字
 * → 前后缀原样拼回」，行为差一点，这些源的目录就跟上游 App 不一样；而目录排序错了比取不到更难看。
 *
 * 逐条对齐上游：字符表、"一零二五" 逐字式、"一千零二十五/一千二" 进位式、
 * 以及**解不出来返回 -1**（不是 0 —— 调用方靠 -1 判断「这个标题里没有编号」）。
 */
internal object ChapterNumbers {

    /** 上游 `AppPattern.titleNumPattern`。 */
    private val TITLE_NUM = Regex("(第)(.+?)(章)")

    /** 上游 `ChnMap`：数字字与单位字在同一张表里，单位就是它的值。 */
    private val CN: Map<Char, Int> = buildMap {
        for ((value, ch) in "零一二三四五六七八九十".withIndex()) put(ch, value)
        for ((value, ch) in "〇壹贰叁肆伍陆柒捌玖拾".withIndex()) put(ch, value)
        put('两', 2)
        put('百', 100)
        put('佰', 100)
        put('千', 1000)
        put('仟', 1000)
        put('万', 10000)
        put('亿', 100000000)
    }

    /** 「第X章」里的 X 转成阿拉伯数字；不是这种形状就原样返回（上游行为）。 */
    fun toNumChapter(text: String?): String? {
        if (text == null) return null
        val match = TITLE_NUM.find(text) ?: return text
        val number = stringToInt(match.groupValues[2])
        return "${match.groupValues[1]}$number${match.groupValues[3]}"
    }

    /**
     * 上游 `stringToInt`：全角转半角 → 去掉所有空白 → 能按整数解析就解析 → 否则按中文数字解析。
     * 任何一步都不猜：解不出就是 -1。
     */
    fun stringToInt(value: String?): Int {
        if (value == null) return -1
        val normalized = fullToHalf(value).replace(WHITESPACE, "")
        return normalized.toIntOrNull() ?: chineseNumToInt(normalized)
    }

    private val WHITESPACE = Regex("\\s+")

    /** 上游 `fullToHalf`：全角空格 12288 → 32；65281..65374 → 各自减 65248。 */
    fun fullToHalf(input: String): String {
        val chars = input.toCharArray()
        for (index in chars.indices) {
            when (chars[index].code) {
                12288 -> chars[index] = ' '
                in 65281..65374 -> chars[index] = (chars[index].code - 65248).toChar()
            }
        }
        return String(chars)
    }

    /**
     * 上游 `chineseNumToInt`，逐分支照搬（含每个分支结算后把 `tmp` 清零这一步，
     * 少一步就会把「一百二十三」算成别的数）：
     * - 个位先攒在 `tmp`；
     * - 遇到十/百/千：`tmp` 为 0 时按 1 算（「十二」这种省掉的「一」），结算后 `tmp` 清零；
     * - 万、亿再分一段；
     * - 末位是「X十Y」之外的写法（如「一千二」）按上游那样补成 200；
     * - 表里没有的字符（英文、括号、「章」字…）→ 解析失败返回 -1。
     *
     * 注：上游开头那段「"一零二五" 逐字式」用的是**单字符**正则
     * （`^[〇零一二三四五六七八九壹贰叁肆伍陆柒捌玖]$`），多字串永远匹配不上，
     * 实际是走下面的进位式算出来的（结果一样）。这里保持同样行为，不去"顺手修好"——
     * 改了就和上游不一样，而出入口径一致比多支持一种写法更值钱。
     */
    fun chineseNumToInt(text: String): Int = runCatching {
        val chars = text.toCharArray()
        var result = 0
        var tmp = 0
        var billion = 0

        if (chars.size > 1 && text.matches("^[〇零一二三四五六七八九壹贰叁肆伍陆柒捌玖]$".toRegex())) {
            for (index in chars.indices) {
                chars[index] = (48 + CN.getValue(chars[index])).toChar()
            }
            return@runCatching String(chars).toInt()
        }

        for (index in chars.indices) {
            val value = CN.getValue(chars[index])
            when {
                value == 100000000 -> {
                    result += tmp
                    result *= value
                    billion = billion * 100000000 + result
                    result = 0
                    tmp = 0
                }
                value == 10000 -> {
                    result += tmp
                    result *= value
                    tmp = 0
                }
                value >= 10 -> {
                    if (tmp == 0) tmp = 1
                    result += value * tmp
                    tmp = 0
                }
                else -> {
                    tmp = if (index >= 2 && index == chars.size - 1 && CN.getValue(chars[index - 1]) > 10) {
                        value * CN.getValue(chars[index - 1]) / 10
                    } else {
                        tmp * 10 + value
                    }
                }
            }
        }
        result + tmp + billion
    }.getOrDefault(-1)
}
