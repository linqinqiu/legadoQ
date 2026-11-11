package io.legado.rules

import io.legado.model.FlexChildStyle
import io.legado.model.SourceLoginActionResult
import io.legado.model.SourceLoginCheckResult
import io.legado.model.SourceLoginUiActionResponse
import io.legado.model.SourceLoginUiItem
import io.legado.model.SourceLoginUiRenderResponse
import io.legado.port.SourceUrlProbe
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/**
 * 登录界面 v2 协议（`renderLoginUiV2` / `executeLoginUiActionV2` 及其行校验）从 `RuleRunner` 抽出
 * （2026-11-11）。逻辑一字未改，只是搬到同包顶层扩展函数；调用点仍是 `runner.renderLoginUiV2(...)`。
 * 行为判据见 `SourceLoginTest`、`GoldenRuleTest`、`RuleLoginGuardTest`。
 */

/** v2 命令词表：动作返回里认识的键；其余只回传给调用方记录，不执行。 */
internal val LOGIN_UI_V2_COMMANDS = setOf("state", "error", "login", "close")

/** v2 里需要 key 的输入型行（text/password/select/toggle）。 */
internal val LOGIN_UI_V2_INPUT_TYPES = setOf("text", "password", "select", "toggle")

internal fun RuleRunner.loginUiVersion(sourceJson: String): Int {
    val raw = sourceJson.objectValue().string("loginUi")?.trim() ?: return 1
    if (!raw.startsWith("{")) return 1
    val obj = runCatching { Json.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return 1
    return if ((obj["version"] as? JsonPrimitive)?.intOrNull == 2) 2 else 1
}

/**
 * 按 v2 协议渲染一次登录表单。脚本契约（上游 `BaseSource.evalLoginUiV2`）：
 * `loginUi(state)` 返回 `{rows:[…]}`，每行与 v1 的 RowUi 同形，另有 `key/options/countdown`。
 * 结构不合法时**整份拒绝**（返回 error），不拿半套字段去渲染 —— 否则坏脚本会变成一张看着正常、
 * 点了没反应的假表单。
 */
internal fun RuleRunner.renderLoginUiV2(sourceJson: String, stateJson: String = "{}"): SourceLoginUiRenderResponse {
    val source = sourceJson.objectValue()
    val sourceUrl = source.string("bookSourceUrl") ?: ""
    if (loginUiVersion(sourceJson) != 2) {
        return SourceLoginUiRenderResponse(error = "这本书源不是登录界面 v2")
    }
    val state = stateJson.trim().takeIf { it.startsWith("{") } ?: "{}"
    val execContext = sourceContext(source, sourceUrl)
        .copy(
            sourceName = source.string("bookSourceName") ?: sourceUrl,
            // v2 的 loginUi/loginAction 就定义在 loginUrl 的 JS 里，必须一起求值。
            includeLoginScript = true,
        )
    val raw = runCatching {
        // 必须 `return`：执行器遇到脚本里有 return 就把整段包成 IIFE，
        // 只有显式 return 才能把表单对象带出来（否则最后一行表达式的值会被丢掉）。
        jsSandbox.eval(
            "return loginUi(JSON.parse(String(__loginState)))",
            mapOf("__loginState" to state, "sourceId" to sourceUrl, "baseUrl" to sourceUrl),
            execContext,
        )
    }.getOrNull()
    val stored = database?.asLoginStateStore()?.getSourceLoginState(sourceUrl)?.loginInfo ?: emptyMap()
    val rows = parseLoginUiV2Rows(raw)
    if (rows == null) {
        // 把实际返回截一段带上：字段名写错/忘了 rows 时，只给一句"格式错误"没法排。
        val actual = raw?.take(200)?.let { "，实际返回：$it" }.orEmpty()
        return SourceLoginUiRenderResponse(
            state = state,
            loginInfo = stored,
            error = execContext.lastError ?: "登录界面脚本没有返回合法的 {rows:[…]}$actual",
        )
    }
    return SourceLoginUiRenderResponse(rows = rows, state = state, loginInfo = stored)
}

/**
 * 执行一次 v2 登录动作。返回命令与上游一致：`state` 换下一屏、`error` 标到字段上、
 * `login` 直接落库、`close` 关掉浮层；未知键只记录不执行。
 */
internal fun RuleRunner.executeLoginUiActionV2(
    sourceJson: String,
    action: String,
    stateJson: String = "{}",
    form: Map<String, String> = emptyMap(),
    browserCompleted: Boolean = false,
    browserBody: String? = null,
): SourceLoginUiActionResponse {
    val source = sourceJson.objectValue()
    val sourceUrl = source.string("bookSourceUrl") ?: ""
    if (loginUiVersion(sourceJson) != 2) {
        return SourceLoginUiActionResponse(ok = false, message = "这本书源不是登录界面 v2")
    }
    val state = stateJson.trim().takeIf { it.startsWith("{") } ?: "{}"
    val formJson = Json.encodeToString(form)
    val execContext = sourceContext(source, sourceUrl)
        .copy(
            sourceName = source.string("bookSourceName") ?: sourceUrl,
            // loginAction 与 loginUi 同在 loginUrl 的 JS 里。
            includeLoginScript = true,
            browserCompleted = browserCompleted,
            browserBody = browserBody,
        )
    val raw = runCatching {
        // 与 render 同理：显式 return 才能拿到命令对象。
        jsSandbox.eval(
            "return loginAction(String(__loginAction), JSON.parse(String(__loginState)), JSON.parse(String(__loginForm)))",
            mapOf(
                "__loginAction" to action,
                "__loginState" to state,
                "__loginForm" to formJson,
                "sourceId" to sourceUrl,
                "baseUrl" to sourceUrl,
            ),
            execContext,
        )
    }.getOrNull()
    val toasts = execContext.toastMessages.toList()
    val failure = execContext.lastError
    if (failure != null) {
        return SourceLoginUiActionResponse(ok = false, message = failure, toastMessages = toasts)
    }
    if (raw.isNullOrBlank()) {
        return SourceLoginUiActionResponse(ok = false, message = "登录动作没有返回值", toastMessages = toasts)
    }
    val obj = runCatching { Json.parseToJsonElement(raw) as? JsonObject }.getOrNull()
        ?: return SourceLoginUiActionResponse(
            ok = false,
            malformed = true,
            message = "登录动作返回的不是 JSON 对象",
            toastMessages = toasts,
        )
    val stateEl = obj["state"]?.takeIf { it !is JsonNull }
    val errorEl = obj["error"]?.takeIf { it !is JsonNull }
    val loginEl = obj["login"]?.takeIf { it !is JsonNull }
    val closeEl = obj["close"]?.takeIf { it !is JsonNull }
    if ((stateEl != null && stateEl !is JsonObject) ||
        (errorEl != null && errorEl !is JsonObject) ||
        (loginEl != null && loginEl !is JsonObject) ||
        (closeEl != null && (closeEl !is JsonPrimitive || closeEl.booleanOrNull == null))
    ) {
        return SourceLoginUiActionResponse(
            ok = false,
            malformed = true,
            message = "登录动作返回命令类型不合法",
            toastMessages = toasts,
        )
    }
    val errors = errorEl?.let { element ->
        runCatching { json.decodeFromString<Map<String, String>>(element.toString()) }.getOrNull()
            ?: return SourceLoginUiActionResponse(
                ok = false,
                malformed = true,
                message = "error 必须是 {字段: 提示}",
                toastMessages = toasts,
            )
    }.orEmpty()
    val close = (closeEl as? JsonPrimitive)?.booleanOrNull ?: false
    val loginInfo = (loginEl as? JsonObject)?.let(::loginInfoFromJson)
    if (loginInfo != null) {
        database?.asLoginStateStore()?.saveSourceLoginInfo(sourceUrl, loginInfo)
    }
    return SourceLoginUiActionResponse(
        ok = true,
        state = stateEl?.toString(),
        error = errors,
        close = close,
        unknownKeys = obj.keys.filterNot { it in LOGIN_UI_V2_COMMANDS },
        toastMessages = toasts,
        updatedLoginInfo = loginInfo,
        openUrl = execContext.openUrl,
        inlineHtml = execContext.inlineHtml,
        inlineTitle = execContext.inlineTitle,
    )
}

/** v2 行结构校验：字段/动作必须唯一，类型对应的必填项不能缺。判据对齐上游 `LoginUiV2.parseRender`。 */
private fun RuleRunner.parseLoginUiV2Rows(raw: String?): List<SourceLoginUiItem>? {
    if (raw.isNullOrBlank()) return null
    val obj = runCatching { Json.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return null
    val rows = obj["rows"] as? JsonArray ?: return null
    val items = runCatching {
        rows.map { json.decodeFromString<SourceLoginUiItem>(it.toString()) }
    }.getOrNull() ?: return null
    if (items.isEmpty() || items.any { !it.isValidLoginUiV2Row() }) return null
    val keys = items.filter { it.type in LOGIN_UI_V2_INPUT_TYPES }.mapNotNull { it.key }
    val actions = items.filter { it.type == "button" || it.type == "toggle" }.mapNotNull { it.action }
    if (keys.size != keys.distinct().size || actions.size != actions.distinct().size) return null
    return items
}

private fun SourceLoginUiItem.isValidLoginUiV2Row(): Boolean {
    if (name.isBlank() || (countdown ?: 0) < 0) return false
    return when (type) {
        "text", "password" -> !key.isNullOrBlank()
        "label" -> true
        "select" -> !key.isNullOrBlank() && !options.isNullOrEmpty()
        "toggle" -> !key.isNullOrBlank() &&
            (value == null || value == "true" || value == "false") &&
            (action == null || action.isNotBlank())
        "button" -> !action.isNullOrBlank()
        else -> false
    }
}

/** `login` 命令是 JSON 对象；落库口径与 v1 的 loginInfo 一样，最终都存成字符串键值。 */
private fun loginInfoFromJson(obj: JsonObject): Map<String, String> = buildMap {
    obj.forEach { (key, element) ->
        put(
            key,
            when (element) {
                is JsonNull -> ""
                is JsonPrimitive -> element.contentOrNull ?: ""
                else -> element.toString()
            },
        )
    }
}

/** 登录动作是不是一次 `login(...)` 调用：`login`、`login()`、`login(true)`、`login(true, false)` 都算。 */
internal val LOGIN_CALL = Regex("""^\s*login\s*(?:\((.*)\))?\s*;?\s*$""", RegexOption.IGNORE_CASE)

/** jsLib 里到底有没有定义 login 函数（没有 loginUrl 脚本时用它兜底判断）。 */
internal val LOGIN_FUNCTION = Regex("""(?:function\s+login\s*\(|login\s*=\s*function\b)""")

internal fun RuleRunner.parseLoginUi(sourceJson: String): List<SourceLoginUiItem> {
    val source = sourceJson.objectValue()
    val sourceUrl = source.string("bookSourceUrl") ?: ""
    val loginUiStr = source.string("loginUi")?.trim()

    if (loginUiStr.isNullOrBlank()) {
        // 网址型 loginUrl（含相对路径 / 协议相对地址）都生成按钮；纯 JS 脚本没有可直开的页面。
        val loginPage = SourceUrlProbe.loginPageUrl(sourceJson)
        if (loginPage != null) {
            return listOf(
                SourceLoginUiItem(
                    name = "打开登录网页",
                    type = "button",
                    action = loginPage,
                    style = FlexChildStyle(layout_flexBasisPercent = 1.0f),
                ),
            )
        }
        return emptyList()
    }

    val rawJson = if (loginUiStr.startsWith("@js:") || loginUiStr.startsWith("js:") || loginUiStr.contains("<js>")) {
        val jsCode = if (loginUiStr.contains("<js>")) loginUiStr.substringAfter("<js>").substringBefore("</js>") else loginUiStr.removePrefix("@js:").removePrefix("js:")
        val execContext = sourceContext(source, sourceUrl)
            .copy(
                sourceName = source.string("bookSourceName") ?: sourceUrl,
                // v1 的 loginUi 脚本常直接调用 loginUrl 里定义的辅助函数。
                includeLoginScript = true,
            )
        jsSandbox.eval(jsCode, mapOf("sourceId" to sourceUrl, "baseUrl" to sourceUrl), execContext) ?: "[]"
    } else {
        loginUiStr
    }

    return runCatching {
        json.decodeFromString<List<SourceLoginUiItem>>(rawJson)
    }.getOrElse { emptyList() }
}

internal fun RuleRunner.executeLoginAction(
    sourceJson: String,
    actionCode: String,
    loginData: Map<String, String>,
    isLongClick: Boolean = false,
    browserCompleted: Boolean = false,
    browserBody: String? = null,
): SourceLoginActionResult {
    val source = sourceJson.objectValue()
    val sourceUrl = source.string("bookSourceUrl") ?: ""
    val sourceName = source.string("bookSourceName") ?: sourceUrl

    // 脚本库（jsLib + loginUrl 形式的 JS）由执行上下文统一注入，这里只拼动作本身
    val execContext = sourceContext(source, sourceUrl).copy(
        sourceName = sourceName,
        // 登录动作要跑 loginUrl 里定义的 `login()`；普通规则求值不会预跑它。
        includeLoginScript = true,
        initialLoginInfo = loginData.toMutableMap(),
        isLongClick = isLongClick,
        browserCompleted = browserCompleted,
        browserBody = browserBody,
    )

    val trimmedAction = actionCode.trim()
    if (trimmedAction.startsWith("http://") || trimmedAction.startsWith("https://")) {
        return SourceLoginActionResult(
            success = true,
            openUrl = trimmedAction,
        )
    }

    // 上游两条路径要分清：菜单「确定」走 `BaseSource.login()`，那是 `login.apply(this)`（不带实参）；
    // 而 loginUi 按钮的 action 是**原样执行的 JS**，`login(true,false)` 这类带实参的调用必须保留实参，
    // 否则脚本里靠 `checkMode` 分支的源会被当成"打开浏览器"那条路走。
    //
    // 但 `login(...)` 不是每个源都定义得起：番茄 v3.4.2 这类源的 loginUrl 只是一个网址，
    // 没有 loginUi/loginCheckJs，更没有 `login()` 函数。旧逻辑把 `login(true)` 直接丢给 Rhino，
    // 只会得到 "login is not defined"，界面报「书源脚本执行失败」而实际什么都没发生。
    // 没有登录脚本时按上游语义退到「打开登录页」；有脚本但没定义 login() 时给中文错误。
    val loginArgs = LOGIN_CALL.matchEntire(trimmedAction)?.groupValues?.getOrNull(1)
    val hasLoginFunction = loginScript(source) != null ||
        source.string("jsLib")?.let { LOGIN_FUNCTION.containsMatchIn(it) } == true
    if (loginArgs != null && !hasLoginFunction) {
        // 网址型 loginUrl（含相对路径）交给统一的入口解析；纯 JS 脚本已在 hasLoginFunction 里算过。
        val loginPage = SourceUrlProbe.loginPageUrl(sourceJson)
        return SourceLoginActionResult(
            success = true,
            toastMessages = listOf(
                if (loginPage != null) "这本书源没有登录脚本，已改为打开登录页"
                else "这本书源没有登录脚本，无需执行登录",
            ),
            openUrl = loginPage,
            updatedLoginInfo = if (loginData.isEmpty()) null else loginData,
        )
    }
    val fullScript = if (loginArgs != null) {
        "if (typeof login === 'function') { login($loginArgs); } else { throw new Error('该书源脚本没有定义 login()，无法执行登录') }"
    } else {
        trimmedAction
    }

    val bindings = mapOf(
        "result" to loginData,
        "baseUrl" to sourceUrl,
        "sourceId" to sourceUrl,
        "bookSourceUrl" to sourceUrl,
        "isLongClick" to isLongClick,
    )

    jsSandbox.eval(fullScript, bindings, execContext)
    val state = database?.asLoginStateStore()?.getSourceLoginState(sourceUrl)
    val failure = execContext.lastError

    return SourceLoginActionResult(
        success = failure == null,
        error = failure,
        toastMessages = execContext.toastMessages,
        openUrl = execContext.openUrl,
        copyText = execContext.copyText,
        updatedLoginInfo = execContext.initialLoginInfo.ifEmpty { state?.loginInfo ?: emptyMap() },
        updatedLoginHeader = state?.loginHeader,
        updatedVariable = state?.sourceVariable,
        reRenderUi = execContext.reRenderUi,
        inlineHtml = execContext.inlineHtml,
        inlineTitle = execContext.inlineTitle,
    )
}

internal fun RuleRunner.checkLoginStatus(sourceJson: String): SourceLoginCheckResult {
    val source = sourceJson.objectValue()
    val sourceUrl = source.string("bookSourceUrl") ?: ""
    val loginCheckJs = source.string("loginCheckJs")?.trim()
    val loginUrl = source.string("loginUrl") ?: ""
    val jsLib = source.string("jsLib") ?: ""

    if (loginCheckJs.isNullOrBlank()) {
        val jar = database?.asCookieStore()?.cookieBucketsForHosts(SourceUrlProbe.credentialDomains(sourceJson)).orEmpty()
        val state = database?.asLoginStateStore()?.getSourceLoginState(sourceUrl)
        val hasCookie = jar.isNotEmpty()
        val hasInfo = state?.loginInfo?.isNotEmpty() == true
        val hasHeader = state?.loginHeader?.isNotEmpty() == true
        val hasCredential = hasCookie || hasInfo || hasHeader
        // 无 loginCheckJs 时只能"以有无凭据"判断，无法真正验证登录是否有效；
        // 保持 loggedIn 的既有语义（有凭据即视为可用，兼容测试），但如实标注未验证。
        return SourceLoginCheckResult(
            loggedIn = hasCredential,
            hasCredential = hasCredential,
            verified = false,
            message = if (hasCredential) "已捕获登录凭据（未能自动验证有效性）" else "未登录",
        )
    }

    val execContext = sourceContext(source, sourceUrl)
    val result = jsSandbox.eval(loginCheckJs, mapOf("sourceId" to sourceUrl, "baseUrl" to sourceUrl), execContext)?.trim()
    val isSuccess = result == "true" || (result != null && result.isNotBlank() && result != "false" && result != "0" && !result.contains("未登录"))
    val jar = database?.asCookieStore()?.cookieBucketsForHosts(SourceUrlProbe.credentialDomains(sourceJson)).orEmpty()
    val state = database?.asLoginStateStore()?.getSourceLoginState(sourceUrl)
    val hasCredential = isSuccess || jar.isNotEmpty() || state?.loginInfo?.isNotEmpty() == true || state?.loginHeader?.isNotEmpty() == true
    return SourceLoginCheckResult(
        loggedIn = isSuccess,
        hasCredential = hasCredential,
        verified = isSuccess,
        // 上游的 loginCheckJs 是**响应改写器**（`WebBook.kt:77` 拿它处理正文响应，顺带识别掉登录），
        // 不是"登录状态查询"。我们把它当布尔判定用是一种借用，措辞上不能说得比这更肯定。
        message = if (isSuccess) "按书源 loginCheckJs 试判为已登录" else (result ?: "未登录"),
    )
}
