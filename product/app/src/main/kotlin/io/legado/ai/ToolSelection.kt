package io.legado.ai

/**
 * 按当前对话只挑相关的工具组下发给模型。
 *
 * 为什么需要：内置工具已经 55 个，`Agent` 原来每次都把全部定义塞进请求 ——
 * token 成本高、模型容易挑错工具、上下文被工具定义挤占。
 *
 * 规则刻意简单可测：
 * ① 永远带上 [ALWAYS] 里的组（程序目录是模型了解"我能做什么"的入口）；
 * ② 用户这句话里出现某组的关键词，就把该组带上；
 * ③ 一个都没命中时退回 [DEFAULT_GROUPS]（阅读主链路最常用的几组），
 *    而不是退回"全部"——退回全部等于没做这件事；
 * ④ 选出来的组为空（清单里连这些组都没有）时，退回完整清单，保证功能不会因过滤而消失。
 *
 * 这是"按需下发"的第一层（分组）。第二层「两段式发现」（先 `tool.search` 再按需拉定义）
 * 依赖协议层改动，留待后续。
 */
object ToolSelection {

    /** 任何对话都需要的组：`program.catalog` 是模型的能力地图。 */
    private val ALWAYS = setOf("program")

    /** 没命中任何关键词时的默认组：阅读主链路（找书 → 书架 → 正文）。 */
    private val DEFAULT_GROUPS = setOf("program", "sources", "bookshelf", "search")

    /** 关键词 → 工具组。命中任意一个词就带上整组。 */
    private val KEYWORDS: Map<String, List<String>> = mapOf(
        "sources" to listOf("书源", "source", "规则", "导入", "校验", "调试"),
        "bookshelf" to listOf("书架", "收藏", "分组", "封面", "进度", "读完"),
        "search" to listOf("搜索", "搜书", "找书", "关键词"),
        "explore" to listOf("发现", "榜单", "推荐"),
        "rss" to listOf("rss", "订阅源", "文章"),
        "subscriptions" to listOf("订阅", "书源订阅"),
        "notes" to listOf("笔记", "划线", "备注", "书签"),
        "replace-rules" to listOf("净化", "替换", "正则", "广告"),
        "tts" to listOf("朗读", "语音", "tts", "发音"),
        "backup" to listOf("备份", "恢复", "导出", "zip"),
        "health" to listOf("体检", "健康", "可用"),
        "debug" to listOf("调试", "诊断", "排查"),
    )

    /**
     * 选出本次请求要下发的工具。
     *
     * @param manifest 当前注册的全部工具元信息
     * @param userText 用户这一轮说的话（只用于关键词匹配）
     * @returns 要下发的工具；过滤后为空时退回完整清单
     */
    fun select(manifest: List<ToolMeta>, userText: String): List<ToolMeta> {
        if (manifest.isEmpty()) return manifest
        val text = userText.lowercase()
        val groups = LinkedHashSet<String>()
        groups += ALWAYS
        var hit = false
        for ((group, words) in KEYWORDS) {
            if (words.any { text.contains(it.lowercase()) }) {
                groups += group
                hit = true
            }
        }
        if (!hit) groups += DEFAULT_GROUPS
        val selected = manifest.filter { it.group in groups }
        return selected.ifEmpty { manifest }
    }
}
