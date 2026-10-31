package io.legado.rules

/**
 * 脚本 `java.htmlFormat(html)` 的实现，逐条对齐上游 `HtmlFormatter.formatKeepImg`。
 *
 * 用途：视频源（红牛资源、U酷资源）把播放页 HTML 喂进来，它去标签后正则抠出
 * 页面里 `var player_aaaa={...}` 这类配置文本 —— 所以**标签要去掉、script 里的文本要留下**。
 * 与"给用户看的正文清洗"（formatDisplayText）不是一回事，别拿那个替换：那个会把 script 内容删掉。
 *
 * 与上游的差别只有一处：图片地址里的 `,参数` 后缀（阅读自己的图片参数语法）原样保留，
 * 不拆成 `src="…"+param` 的上古写法 —— 服务端没有 `NetworkUtils.getAbsoluteURL(null, …)` 语境。
 */
internal object ScriptHtml {
    private val nbspRegex = Regex("(&nbsp;)+")
    private val espRegex = Regex("(&ensp;|&emsp;)")
    private val noPrintRegex = Regex("(&thinsp;|&zwnj;|&zwj;|\u2009|\u200C|\u200D)")
    private val wrapHtmlRegex = Regex("</?(?:div|p|br|hr|h\\d|article|dd|dl)[^>]*>")
    private val commentRegex = Regex("<!--[^>]*-->")
    private val notImgHtmlRegex = Regex("</?(?!img)[a-zA-Z]+(?=[ >])[^<>]*>")
    private val indent1Regex = Regex("\\s*\\n+\\s*")
    private val indent2Regex = Regex("^[\\n\\s]+")
    private val lastRegex = Regex("[\\n\\s]+$")

    /**
     * 三段式：模板图片 `src="…{…}…"`、正常 `src`/`data-src`、任意 `data-*`。
     * 第一段必须排在前面，否则花括号地址会被第三段当成普通地址截断。
     */
    private val formatImagePattern = Regex(
        "<img[^>]*\\ssrc\\s*=\\s*['\"]([^'\">{]*\\{(?:[^{}]|\\{[^}>]+\\})+\\})['\"][^>]*>" +
            "|<img[^>]*\\s(?:data-src|src)\\s*=\\s*['\"]([^'\">]+)['\"][^>]*>" +
            "|<img[^>]*\\sdata-[^=>]*=\\s*['\"]([^'\">]*)['\"][^>]*>",
        RegexOption.IGNORE_CASE,
    )

    private const val PARAGRAPH_INDENT = "　　"

    fun formatKeepImg(html: String?): String {
        html ?: return ""
        val text = format(html)
        var appendPos = 0
        val sb = StringBuilder()
        for (match in formatImagePattern.findAll(text)) {
            val src = match.groups[1]?.value
                ?: match.groups[2]?.value
                ?: match.groups[3]?.value
                ?: continue
            sb.append(text, appendPos, match.range.first)
            sb.append("<img src=\"").append(src).append("\">")
            appendPos = match.range.last + 1
        }
        if (appendPos < text.length) sb.append(text, appendPos, text.length)
        return sb.toString()
    }

    /** 上游 `format(html, notImgHtmlRegex)`：只去标签，img 留着（后面统一重写）。 */
    private fun format(html: String): String = html
        .replace(nbspRegex, " ")
        .replace(espRegex, " ")
        .replace(noPrintRegex, "")
        .replace(wrapHtmlRegex, "\n")
        .replace(commentRegex, "")
        .replace(notImgHtmlRegex, "")
        .replace(indent1Regex, "\n$PARAGRAPH_INDENT")
        .replace(indent2Regex, PARAGRAPH_INDENT)
        .replace(lastRegex, "")
}
