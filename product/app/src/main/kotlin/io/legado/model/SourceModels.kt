package io.legado.model

import kotlinx.serialization.Serializable

@Serializable data class SourceSummary(
    val id: String,
    val name: String,
    val url: String,
    val group: String? = null,
    val enabled: Boolean,
    val isJsSource: Boolean,
    val hasLogin: Boolean = false,
    /**
     * 有没有任何可执行的规则。false = 只剩元数据：搜不到书、取不到目录与正文。
     * 列表据此打「无规则」标并可筛出来清理（兄弟包备份里真实存在这种条目）。
     */
    val hasRules: Boolean = true,
    val updatedAt: Long,
    val version: Long,
    /** 自定义排序位（1 起）；null = 没拖过，按名称排在有序段之后。 */
    val sortOrder: Int? = null,
)

@Serializable
data class FlexChildStyle(
    val layout_flexGrow: Float = 0f,
    val layout_flexShrink: Float = 1f,
    val layout_alignSelf: String = "auto",
    val layout_flexBasisPercent: Float = -1f,
    val layout_wrapBefore: Boolean = false,
    val layout_justifySelf: String = "auto",
)

@Serializable
data class SourceLoginUiItem(
    val name: String = "",
    val type: String = "text",
    val action: String? = null,
    val chars: List<String?>? = null,
    val default: String? = null,
    val viewName: String? = null,
    val style: FlexChildStyle? = null,
    val key: String? = null,
    val hint: String? = null,
    val value: String? = null,
    val options: List<String>? = null,
    val countdown: Int? = null,
)

@Serializable
data class SourceLoginUiResponse(
    val sourceId: String,
    val sourceName: String,
    val hasLogin: Boolean,
    val loginUi: List<SourceLoginUiItem>,
    val loginUrl: String? = null,
    val loginInfo: Map<String, String> = emptyMap(),
    val loginHeader: String? = null,
    val sourceVariable: String? = null,
    /** `loginUrl` 不是网址而是整段登录 JS（聚合源普遍如此），界面要按这个改文案与动作。 */
    val loginIsScript: Boolean = false,
    /**
     * 这本书源有没有「能替你打开」的登录入口：网址型 / 相对路径型 `loginUrl`，
     * 或 `loginUrl`、`jsLib` 里那套 `login()` + `java.startBrowserAwait`。
     * 界面据此决定「保存并登录」是开真浏览器，还是只保存输入。
     */
    val loginCanOpenBrowser: Boolean = false,
    /** 这份书源实际会带凭据去访问的域名，登录页那个排最前（粘贴 Cookie 要能选对地方）。 */
    val cookieDomains: List<String> = emptyList(),
    /**
     * 登录表单位于书源本地渲染的版本：1 = 上游 `loginUi` 数组；2 = `{"version":2}` +
     * `loginUrl` 里的 `loginUi(state)` / `loginAction(action,state,form)` 脚本（上游 v2 协议）。
     */
    val loginUiVersion: Int = 1,
    /** v2 表单首次渲染失败时的原因（脚本抛错 / 返回结构不合法），界面要如实显示。 */
    val loginUiError: String? = null,
)

@Serializable
data class SourceLoginUiRenderRequest(
    val state: String = "{}",
)

/** v2 表单的一次渲染结果：rows 是脚本给的字段，loginInfo 是库里已存的键值（界面用来回填）。 */
@Serializable
data class SourceLoginUiRenderResponse(
    val rows: List<SourceLoginUiItem> = emptyList(),
    val state: String = "{}",
    val loginInfo: Map<String, String> = emptyMap(),
    val error: String? = null,
)

@Serializable
data class SourceLoginUiActionRequest(
    val action: String,
    val state: String = "{}",
    val form: Map<String, String> = emptyMap(),
    /** 界面已经展示过一次 `startBrowserAwait` 的本地页面并把整页 HTML 交回来了。 */
    val browserCompleted: Boolean = false,
    val browserBody: String? = null,
)

/** v2 `loginAction` 的返回命令；语义与上游 `LoginUiV2.parseActionResult` 一致。 */
@Serializable
data class SourceLoginUiActionResponse(
    val ok: Boolean = true,
    val state: String? = null,
    val error: Map<String, String> = emptyMap(),
    val close: Boolean = false,
    val unknownKeys: List<String> = emptyList(),
    val malformed: Boolean = false,
    val message: String? = null,
    val toastMessages: List<String> = emptyList(),
    val updatedLoginInfo: Map<String, String>? = null,
    val openUrl: String? = null,
    val inlineHtml: String? = null,
    val inlineTitle: String? = null,
)

@Serializable
data class SourceLoginInfoUpdateRequest(
    val loginInfo: Map<String, String> = emptyMap(),
    val loginHeader: String? = null,
    val sourceVariable: String? = null,
)

@Serializable
data class SourceLoginActionRequest(
    val action: String,
    val loginData: Map<String, String> = emptyMap(),
    val isLongClick: Boolean = false,
    /** 内置浏览器那一轮已经关掉：让 startBrowserAwait 改为服务端自己抓页面 */
    val browserCompleted: Boolean = false,
    /**
     * 本地渲染的 `data:text/html` 设置页关闭时，界面交回来的整页 HTML。
     * 登录脚本靠 `startBrowserAwait(...).body()` 从页面里读用户选的值，没这一项就永远拿到空串。
     */
    val browserBody: String? = null,
)

/** 删掉某个域名下的 Cookie 后，把剩下的罐子概况一起回给界面，省一次往返。 */
@Serializable
data class SourceCookieRemoveResponse(
    val ok: Boolean,
    val removed: Boolean,
    val count: Int,
    val domains: List<String> = emptyList(),
)

@Serializable
data class SourceLoginActionResult(
    val success: Boolean,
    val toastMessages: List<String> = emptyList(),
    val openUrl: String? = null,
    val copyText: String? = null,
    val updatedLoginInfo: Map<String, String>? = null,
    val updatedLoginHeader: String? = null,
    val updatedVariable: String? = null,
    val reRenderUi: Boolean = false,
    val error: String? = null,
    /** 登录动作要求打开一个 `data:text/html` 本地页面（书源自己拼的设置页），界面用 iframe 渲染。 */
    val inlineHtml: String? = null,
    val inlineTitle: String? = null,
)

@Serializable
data class SourceLoginCheckResult(
    val loggedIn: Boolean,
    val message: String? = null,
    /** 是否已捕获到任意凭据（Cookie / 登录头 / 登录信息）。有凭据 ≠ 已登录。 */
    val hasCredential: Boolean = false,
    /** 是否经书源 loginCheckJs 主动验证通过。无 loginCheckJs 时恒为 false（无法验证）。 */
    val verified: Boolean = false,
)

@Serializable
data class SourceLoginHeaderUpdateRequest(
    val loginHeader: String?,
)

@Serializable
data class SourceLoginCookieUpdateRequest(
    val cookie: String,
    val url: String? = null,
)

@Serializable
data class SourceLoginCookieResponse(
    val ok: Boolean,
    val message: String? = null,
    val count: Int = 0,
)

@Serializable
data class SourceBrowserSessionResponse(
    val token: String,
    val startUrl: String,
    val expiresInSeconds: Int,
    /** true 表示入口是书源脚本生成的内置页面，由服务端托管，startUrl 为空 */
    val inlineOnly: Boolean = false,
)

@Serializable
data class SourceBrowserSessionRequest(
    val url: String? = null,
)

@Serializable
data class SourceBrowserInlineRequest(
    val token: String,
    val url: String,
)

@Serializable
data class SourceBrowserInlineResponse(
    val key: String,
)

@Serializable
data class SourceBrowserCookieResponse(
    val count: Int,
    val domains: List<String>,
    val cookies: Map<String, String>,
)

/** 全局凭据表里的一桶：注册域 + 它上面的 Cookie 键名（不含值，值不进列表接口）。 */
data class CookieBucket(
    val domain: String,
    val keys: List<String>,
    /** 其中属于**会话层**的键（内存里，重启即失效）；其余来自库。 */
    val sessionKeys: List<String> = emptyList(),
)

@Serializable
data class GlobalCookieEntry(
    val domain: String,
    val keys: List<String>,
    /** 有多少本书源的配置里**写到过**这个域（粗筛，不等于"会访问"）。 */
    val mentionedBy: Int,
    /** 只是本次会话的键：重启就没了，也不会进备份包。 */
    val sessionKeys: List<String> = emptyList(),
    /** 因为整条 `Cookie` 头超过 4096 字符而**不会发出去**的键（最旧的先丢）。 */
    val droppedKeys: List<String> = emptyList(),
    /** 实际会发出去的那条头的字符数。 */
    val headerChars: Int = 0,
    /** 只剩一条仍然超过 4096：照发，但要告诉用户这桶不正常。 */
    val oversized: Boolean = false,
)

@Serializable
data class GlobalCookieListResponse(
    val count: Int,
    val cookies: List<GlobalCookieEntry>,
)

/**
 * 某个地址所属注册域上**有没有**凭据 —— 发现页拿它把"这一栏要登录"和"站点真的返回空"分开。
 * 只回答有/无：上游没有任何"是否已登录"的判定机制（`loginCheckJs` 只是响应改写器），
 * 所以这里也不能说得比"有凭据/没凭据"更肯定。
 */
@Serializable
data class SourceCredentialStatus(
    val domain: String,
    val has: Boolean,
)

/** 「重取这一张」的成功回执：新落盘的键与类型。前端拿到后把图片地址上的代次换掉，浏览器才会真去重新请求。 */
@Serializable
data class RefreshedImage(
    val key: String,
    val contentType: String,
)

@Serializable
data class ExternalLoginStatus(
    /** 我们拉起来的那个真浏览器还在不在。 */
    val opened: Boolean,
    val browser: String = "",
    val port: Int = 0,
    val pid: Long = 0,
    /** 这本书源会带凭据去访问的域（按登录优先级排序）。 */
    val hosts: List<String> = emptyList(),
    /** 浏览器里**已经出现**这些域的 Cookie —— 也就是"登录已经发生过"的事实依据。 */
    val seen: List<String> = emptyList(),
    /** 本轮真正写进凭据表的域。 */
    val stored: List<String> = emptyList(),
    /** 该书源当前能带出去的凭据桶数量。 */
    val count: Int = 0,
)

data class SourceLoginStateRecord(
    val sourceId: String,
    val loginInfo: Map<String, String>,
    val loginHeader: String?,
    val sourceVariable: String?,
    val sourceKv: Map<String, String>,
    val cookieJar: Map<String, String>,
    val updatedAt: Long,
)

@Serializable data class SourceRecord(
    val id: String,
    val json: String,
    val version: Long,
    val updatedAt: Long,
    /**
     * 兄弟包的 `weight`：值越大越优先。只影响**搜索发车顺序**，不影响能不能用 ——
     * 体检结论仍然排在它前面（见 `orderByHealth`）。
     * 缺省 0 表示"没设过"，与兄弟包里未设权重的源同义。
     */
    val weight: Int = 0,
)

@Serializable data class SourceWriteRequest(val json: String, val version: Long? = null)
@Serializable data class SourceValidateRequest(val json: String? = null)
@Serializable data class ImportRequest(val sources: List<String>, val overwrite: Boolean = true)
@Serializable data class ImportResponse(val imported: Int, val updated: Int = 0, val skipped: Int, val errors: List<String>)
@Serializable data class SubscriptionWriteRequest(val url: String, val enabled: Boolean = true)
@Serializable data class SourceSubscription(
    val id: Long,
    val url: String,
    val enabled: Boolean,
    val createdAt: Long,
    val updatedAt: Long,
    val lastSuccessAt: Long? = null,
    val lastAttemptAt: Long? = null,
    val lastError: String? = null,
    val lastImported: Int = 0,
    val contentHash: String? = null,
)
@Serializable data class ValidateResponse(val valid: Boolean, val errors: List<String>, val warnings: List<String>)
@Serializable data class DebugRequest(val keyword: String = "测试")
@Serializable data class SearchRequest(val keyword: String, val sourceIds: List<String>? = null)
@Serializable data class ExploreTab(val title: String, val url: String, val supportsPaging: Boolean = true)
@Serializable data class ExploreRequest(val sourceId: String, val url: String, val page: Int = 1)
