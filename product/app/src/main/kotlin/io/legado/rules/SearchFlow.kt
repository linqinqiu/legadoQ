package io.legado.rules

import io.legado.model.SearchResult
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject

/**
 * 搜索链路的编排（第一步：只搬编排，不搬解析）。
 *
 * ## 现在负责什么
 *
 * - 判断是不是 JS 书源（`mainJs`），走哪条分支；
 * - 缺 `searchUrl` / `bookSourceUrl` / `ruleSearch` 时报哪句话；
 * - 把「取页面 → 解析列表 → 生成响应线索」串起来，并保证整段在书源上下文内执行。
 *
 * ## 为什么 Host 只有 6 个方法
 *
 * 搜索编排真正需要的**原语**都在 [RuleRunner] 里（URL 脚本、选项拆分、渲染、抓取、列表解析、
 * 响应线索）。如果把它们逐个传进来，Host 会膨胀到 12 个方法 —— 那说明切分点还不在这一层。
 * 这里先把 Host 收成**粗粒度步骤**：每个方法对应流程上的一站，而不是一个工具函数。
 * 后续要接 `RuleDispatcher` 时，替换的是 Host 的 `parseSearchItems`，不是整个 SearchFlow。
 *
 * ## 不负责什么
 *
 * 不解析 HTML/JSON、不拼 URL、不发请求、不读写变量表。这些仍在 [RuleRunner]，
 * 等 `RuleProcessor` 接入时再逐个迁走。
 */
internal class SearchFlow(private val host: Host) {

    internal interface Host {
        /** 是否 `mainJs` 书源（条目由脚本组装，不走 searchUrl）。 */
        fun isJsSource(source: JsonObject): Boolean

        /** JS 书源分支：交给 `JsSourceRunner`。 */
        fun jsSourceSearch(source: JsonObject, keyword: String): List<SearchResult>

        /** 在书源上下文内执行：规则里的 `<js>` 依赖 `source.getVariable()` 与 jsLib。 */
        fun <T> inSourceContext(source: JsonObject, sourceUrl: String?, block: () -> T): T

        /** 渲染搜索地址并抓回正文（URL 脚本、选项、headers 都在实现侧）。 */
        fun fetchSearchPage(source: JsonObject, sourceUrl: String, rawSearchUrl: String, keyword: String): String

        /** 把响应正文按 `ruleSearch` 解析成条目。 */
        fun parseSearchItems(body: String, rule: JsonObject, sourceUrl: String, sourceType: Int): List<SearchResult>

        /** 给失败/空结果用的一行线索（HTML 取 title，JSON 取 msg）。 */
        fun describeResponse(body: String): String

        /** 书源类型（0 文本 / 1 音频 / 2 漫画 …）。 */
        fun sourceType(source: JsonObject): Int
    }

    private val json = Json { ignoreUnknownKeys = true }

    fun search(sourceJson: String, keyword: String): Pair<List<SearchResult>, String> {
        val source = json.parseToJsonElement(sourceJson).jsonObject
        if (host.isJsSource(source)) {
            return host.jsSourceSearch(source, keyword) to "JS 书源：条目由 mainJs 组装，响应线索不适用"
        }
        val rawSearchUrl = source.string("searchUrl")
            ?: throw RuleExecutionException("该书源未配置 searchUrl")
        val sourceUrl = source.string("bookSourceUrl")
            ?: throw RuleExecutionException("书源缺少 bookSourceUrl")

        // 整个搜索流程都在书源上下文内执行：规则里的 <js> 依赖 source.getVariable() 与 jsLib 工具函数
        return host.inSourceContext(source, sourceUrl) {
            val body = host.fetchSearchPage(source, sourceUrl, rawSearchUrl, keyword)
            val rule = source["ruleSearch"] as? JsonObject
                ?: throw RuleExecutionException("该书源未配置 ruleSearch")
            host.parseSearchItems(body, rule, sourceUrl, host.sourceType(source)) to host.describeResponse(body)
        }
    }

    private fun JsonObject.string(key: String): String? = (get(key) as? JsonPrimitive)?.contentOrNull
}
