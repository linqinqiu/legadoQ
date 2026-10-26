package io.legado.content

/**
 * 把书源里手写的 JS 对象字面量 `,{...}` 转成严格 JSON。
 *
 * 上游 Legado 的做法是先 `GSONStrict`、失败再退回宽松 `GSON` 并打一行
 * 「链接参数 JSON 格式不规范，请改为规范格式」（`model/analyzeRule/AnalyzeUrl.kt:253-259`）。
 * 服务端用的 kotlinx.serialization 没有宽松模式，所以这里自己把常见的非规范写法规范化，
 * 覆盖库内实测到的形态（4,876 源里严格 JSON 失败 1,571 处）：
 * - 单引号键值：`{'method':'POST','body':'kw={{key}}'}` —— 最大一桶（335 + 64 + …处）
 * - 裸标识符键：`{webView: true}`
 * - 全角引号：`{webView:“true”}`（46 处，中文输入法下写出来的）
 * - 字符串里裸换行/裸制表符
 * - 尾随逗号：`{"method":"POST",}`
 * - `//` 与 `/* */` 注释
 *
 * 只做规范化，不做求值：里面出现的 `{{key}}` 之类的占位符原样留在字符串里，交给后续 renderUrl。
 */
object LooseJson {

    private const val MAX_LENGTH = 8_192

    /** 解析不出来时返回 null，由调用方决定「丢掉参数尾巴」还是「整串当 URL」。 */
    fun toStrict(text: String): String? {
        if (text.isBlank() || text.length > MAX_LENGTH) return null
        val out = StringBuilder(text.length + 16)
        var index = 0
        // 记录最后一个逗号在 out 里的位置，遇到 } ] 时回删，用来吃掉尾随逗号
        var pendingComma = -1
        while (index < text.length) {
            val ch = text[index]
            when {
                ch == '"' -> { index = appendString(text, index, '"', out); pendingComma = -1 }
                ch == '\'' -> { index = appendString(text, index, '\'', out); pendingComma = -1 }
                ch == '“' || ch == '”' || ch == '‘' || ch == '’' -> {
                    index = appendFullWidthString(text, index, out); pendingComma = -1
                }
                ch == '/' && index + 1 < text.length && text[index + 1] == '/' -> {
                    while (index < text.length && text[index] != '\n') index++
                }
                ch == '/' && index + 1 < text.length && text[index + 1] == '*' -> {
                    val end = text.indexOf("*/", index + 2)
                    index = if (end < 0) text.length else end + 2
                }
                isIdentifierStart(ch) -> {
                    val start = index
                    while (index < text.length && isIdentifierPart(text[index])) index++
                    val word = text.substring(start, index)
                    // 后面紧跟 `:` 才是键；否则是 true/false/null/undefined 这类字面量
                    val next = skipSpace(text, index)
                    if (next < text.length && text[next] == ':') {
                        out.append('"').append(word.replace("\"", "\\\"")).append('"')
                        // 回到标识符末尾，让冒号与它后面的空白按原样走普通分支，规范化结果只改必要部分
                        index = start + word.length
                    } else {
                        out.append(
                            when (word) {
                                "true", "false", "null" -> word
                                "undefined" -> "null"
                                else -> "\"" + word.replace("\"", "\\\"") + "\""
                            }
                        )
                    }
                    pendingComma = -1
                }
                ch == ',' -> {
                    pendingComma = out.length
                    out.append(ch); index++
                }
                ch == '}' || ch == ']' -> {
                    if (pendingComma >= 0) out.deleteCharAt(pendingComma)
                    pendingComma = -1
                    out.append(ch); index++
                }
                else -> { out.append(ch); index++ }
            }
        }
        val strict = out.toString()
        return if (runCatching { kotlinx.serialization.json.Json.parseToJsonElement(strict) }.isSuccess) strict else null
    }

    /** 从 [start] 处的引号开始抄一个字符串，输出成双引号 JSON 串；引号没闭合则走到结尾。 */
    private fun appendString(text: String, start: Int, quote: Char, out: StringBuilder): Int {
        var index = start + 1
        out.append('"')
        while (index < text.length) {
            val ch = text[index]
            when (ch) {
                '\\' -> {
                    val next = if (index + 1 < text.length) text[index + 1] else ' '
                    // JS 的 `\'` 在 JSON 里是多余的转义，`\/` 同理；其余转义原样保留
                    if (next == quote || next == '/') { out.append(next); index += 2 }
                    else { out.append(ch).append(next); index += 2 }
                }
                quote -> { out.append('"'); return index + 1 }
                '"' -> { out.append("\\\""); index++ }
                '\n' -> { out.append("\\n"); index++ }
                '\r' -> { out.append("\\r"); index++ }
                '\t' -> { out.append("\\t"); index++ }
                else -> { out.append(ch); index++ }
            }
        }
        out.append('"')
        return index
    }

    /** 全角引号成对出现（“…”），也可能左右符号混着用，所以按「遇到另一种全角引号或半角引号结束」处理。 */
    private fun appendFullWidthString(text: String, start: Int, out: StringBuilder): Int {
        var index = start + 1
        out.append('"')
        while (index < text.length) {
            val ch = text[index]
            if (ch in "“”‘’\"'") { out.append('"'); return index + 1 }
            when (ch) {
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                '"' -> out.append("\\\"")
                else -> out.append(ch)
            }
            index++
        }
        out.append('"')
        return index
    }

    private fun skipSpace(text: String, from: Int): Int {
        var index = from
        while (index < text.length && text[index].isWhitespace()) index++
        return index
    }

    // 只认 ASCII 标识符：全角引号 “ ” ‘ ’ 的码点也 > 127，若一并放行会把 `{webView:“true”}` 
    // 整个吞成一个「键名」，反而解析不出来。
    private fun isIdentifierStart(ch: Char) = ch.isLetter() || ch == '_' || ch == '$'

    private fun isIdentifierPart(ch: Char) = isIdentifierStart(ch) || ch.isDigit()

    /**
     * 按花括号配对切出 `,` 之后的参数尾巴。
     * 返回 `Pair(去掉尾巴的 URL, 尾巴文本)`；没有 `,{` 或括号不闭合时尾巴为 null。
     *
     * 逗号前后**允许空白**：上游 `AnalyzeUrl.paramPattern` 是 `Regex("\\s*,\\s*(?=\\{)")`，
     * 而这里原来用 `indexOf(",{")` 只认逗号后紧跟 `{` —— 源里手写成 `地址 , {"method":"POST"}`
     * （逗号后带个空格很常见）就切不开，整串被当成 URL 带着 `,{...}` 上路。
     *
     * 仍只认「逗号后是 `{`」：普通 URL 里带逗号极常见（路径段、多值参数），不能一律当选项切。
     */
    fun extractTail(value: String): Pair<String, String?> {
        // 从后往前找最后一个「,{」—— 尾巴在后面，从后往前可以避开地址里可能出现的 `,{` 形态
        var start = -1
        var scan = 0
        while (scan < value.length) {
            val comma = value.indexOf(',', scan)
            if (comma < 0) break
            var after = comma + 1
            while (after < value.length && value[after].isWhitespace()) after++
            if (after < value.length && value[after] == '{') {
                start = comma
                break
            }
            scan = comma + 1
        }
        if (start < 0) return value to null
        var depth = 0
        var quote: Char? = null
        var index = start + 1
        while (index < value.length) {
            val ch = value[index]
            if (quote != null) {
                when (ch) {
                    '\\' -> index++
                    quote -> quote = null
                }
            } else when (ch) {
                '"', '\'' -> quote = ch
                '{' -> depth++
                '}' -> {
                    depth--
                    if (depth == 0) {
                        // 地址段要切到逗号为止：逗号与 `{` 之间的空白不属于地址
                        return value.substring(0, start).trimEnd() to
                            value.substring(indexOfTailStart(value, start), index + 1)
                    }
                }
            }
            index++
        }
        // 括号不闭合：地址照切（上游 `paramPattern.find` 也切，只是 option 解析失败后不用它），
        // 但**不返回半截 JSON 当选项** —— 交给上层 splitUrlOptions 时它还会再解析一次。
        return value.substring(0, start).trimEnd() to null
    }

    /** 尾巴正文的起点：跳过逗号与其后的空白，落到 `{` 上。 */
    private fun indexOfTailStart(value: String, comma: Int): Int {
        var index = comma + 1
        while (index < value.length && value[index].isWhitespace()) index++
        return index
    }
}
