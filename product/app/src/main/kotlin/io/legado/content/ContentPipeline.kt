package io.legado.content


/**
 * 正文清洗层：对应上游 help/book 与 BatchContentContext —— replaceRegex 字段按 ## 语义生效的地方。
 */

/**
 * `ruleContent.replaceRegex` 这个**字段**走的是上游同一套解析：它被当成一条规则字符串喂给
 * `SourceRule`，而 SourceRule 是按 `##` 切分的 —— `##正则` 删掉全部匹配、`##正则##替换` 换成替换串、
 * `##正则##替换###` 只取第一个匹配再替换；正则编译不过时上游退化成字面量替换，这里照抄。
 *
 * 以前整条（连开头的 `##`）被当成正则去 replace 成空串，等于什么都没删：
 * 库里 1,285 个配了该字段的源中 1,230 个是 `##` 开头形状（普查见 tools/verify/replace-regex-census.mjs）。
 * `<js>` / `@js:` 包起来的（55 个）不在这里处理 —— 那要先能把正文喂进 JS 桥（任务 #24）。
 */
internal fun applyReplaceEntry(entry: String, text: String): String {
    if (entry.isBlank()) return text
    val head = entry.trimStart()
    if (!head.startsWith("##")) {
        // 上游在这种形状下会把整条当**取值规则**去跑（结果通常是空，等于把正文清空），这里故意不跟：
        // 库里确有源写成「纯正则 + 换行分隔」，按「删掉匹配」才有实用价值（既有测试锁住这条）。
        return runCatching { text.replace(Regex(entry.trim()), "") }.getOrDefault(text)
    }
    // 只 trim 左侧：上游对 replacement 一个字符都不动，`##时间## ` 这种结尾空格是要留的
    val parts = head.split("##")
    val pattern = parts.getOrNull(1)?.takeIf { it.isNotBlank() } ?: return text
    val replacement = parts.getOrNull(2) ?: ""
    val regex = runCatching { Regex(pattern) }.getOrNull()
        ?: return text.replace(pattern, replacement)
    return if (parts.size > 3) {
        val match = regex.find(text) ?: return ""
        match.value.replaceFirst(regex, replacement)
    } else {
        regex.replace(text, replacement)
    }
}
