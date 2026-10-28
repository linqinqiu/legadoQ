package io.legado.ai

/**
 * 连接档案里 `options` 字段的约定 —— 让那个字段**真的有用**。
 *
 * 背景：`AgentProfileStore.Profile.options` 一直是死字段（只被写、从没被读）。
 * 上游 `legado-with-MD3` 有两件事做得比我们细，正好都落在"每个连接自己的配置"上：
 * - **AI 供应商支持自定义请求头**（中转站、自建服务常要额外鉴权头）
 * - **模型思考强度五档**（OpenAI 标准的 low / medium / high / xhigh / max，
 *   并对 DeepSeek 等做了映射）
 *
 * 这两件都不该写死在 provider 里 —— 它们因连接而异。所以统一收在 `options`，
 * 用下面这组约定读出来。**key 是契约**：改了就要一起改 `docs/plugin-framework.md`。
 *
 * 为什么用 Map 而不是给 Profile 加结构化字段：`options` 本来就是给"这家连接的特有配置"
 * 留的口子，加字段会让契约变硬；而这里的解析对缺失/写错一律宽容（回退默认），
 * 不会因为一个 key 拼错就让整个连接不可用。
 */
object ProfileOptions {

    /** 自定义请求头。key 形如 `header.X-Api-Key`，值是头内容。 */
    const val HEADER_PREFIX = "header."

    /** 思考强度。值是下面 [THINKING_LEVELS] 之一（大小写不敏感）。 */
    const val THINKING = "thinking"

    /** 请求超时（毫秒）。没设就用 provider 的默认值。 */
    const val TIMEOUT_MS = "timeoutMs"

    /**
     * 「默认走这条」的标记。多个连接时由用户选一条生效，存在连接自己的 options 里
     * （`default=1`），选择策略据此优先，不必再开一个"当前连接"的全局设置。
     */
    const val DEFAULT = "default"

    /** 这条连接是否被用户设为默认。 */
    fun isDefault(options: Map<String, String>): Boolean =
        options[DEFAULT]?.trim()?.lowercase() in setOf("1", "true", "yes")

    /**
     * 思考强度档位 —— 沿用 OpenAI 的命名，不自己发明。
     *
     * 顺序即强弱：LOW < MEDIUM < HIGH < XHIGH < MAX。
     */
    enum class Thinking(val wire: String) {
        LOW("low"),
        MEDIUM("medium"),
        HIGH("high"),
        XHIGH("xhigh"),
        MAX("max");

        companion object {
            fun parse(raw: String?): Thinking? =
                entries.firstOrNull { it.wire.equals(raw?.trim(), ignoreCase = true) }
        }
    }

    /**
     * 取出自定义请求头。
     *
     * 会挡掉几个**不该由用户覆盖**的头，避免把框架自己的关键头改坏：
     * - `Content-Type`：body 永远是 JSON，改了会让服务端解析失败
     * - `Authorization`：用 apiKey 字段表达，混着写两处必然漂移
     * - `Host` / `Content-Length`：由 JDK HttpClient 自己算，硬写会出错
     */
    fun headers(options: Map<String, String>): Map<String, String> {
        val blocked = setOf("content-type", "authorization", "host", "content-length")
        return options.entries
            .filter { it.key.startsWith(HEADER_PREFIX) }
            .map { it.key.removePrefix(HEADER_PREFIX).trim() to it.value }
            .filter { (name, _) -> name.isNotEmpty() && name.lowercase() !in blocked }
            .toMap()
    }

    /** 取思考强度；没设或写错返回 null（不改变请求体）。 */
    fun thinking(options: Map<String, String>): Thinking? = Thinking.parse(options[THINKING])

    /** 取超时毫秒；没设或不是正数返回 null（用 provider 默认值）。 */
    fun timeoutMs(options: Map<String, String>): Long? =
        options[TIMEOUT_MS]?.trim()?.toLongOrNull()?.takeIf { it > 0 }
}
