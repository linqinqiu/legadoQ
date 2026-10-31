package io.legado.rules

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.jsoup.Jsoup
import org.mozilla.javascript.BaseFunction
import org.mozilla.javascript.ClassShutter
import org.mozilla.javascript.Context
import org.mozilla.javascript.NativeJSON
import org.mozilla.javascript.NativeObject
import org.mozilla.javascript.Scriptable
import org.mozilla.javascript.ScriptableObject
import java.security.MessageDigest
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Base64
import java.util.Date
import java.util.Locale
import java.util.SimpleTimeZone
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import io.legado.data.Database
import io.legado.data.cookieBucket
import io.legado.data.getCookieForUrl
import io.legado.data.getSource
import io.legado.data.getSourceKv
import io.legado.data.getSourceLoginState
import io.legado.data.getSourceVariable
import io.legado.data.removeCookieBucket
import io.legado.data.removeSourceLoginHeader
import io.legado.data.removeSourceLoginInfo
import io.legado.data.saveSourceKv
import io.legado.data.saveSourceLoginHeader
import io.legado.data.saveSourceLoginInfo
import io.legado.data.saveSourceVariable
import io.legado.data.setCookieForUrl
import io.legado.source.WebViewProxy

data class JsExecutionContext(
    val sourceId: String? = null,
    val sourceName: String? = null,
    val sourceComment: String? = null,
    val database: Database? = null,
    val initialLoginInfo: MutableMap<String, String> = mutableMapOf(),
    val isLongClick: Boolean = false,
    val toastMessages: MutableList<String> = mutableListOf(),
    var openUrl: String? = null,
    var copyText: String? = null,
    var reRenderUi: Boolean = false,
    /**
     * 登录脚本用 `java.startBrowserAwait('data:text/html;base64,…')` 打开的书源自带设置页。
     * 这种页面没有远端地址，交给界面 iframe 本地渲染；关闭时把整页 HTML 交回来，
     * 下一轮以 `browserCompleted` 重跑时就能从 body 里读到用户选的值。
     */
    var inlineHtml: String? = null,
    var inlineTitle: String? = null,
    /** 界面交回的本地页面 HTML（上一轮 `inlineHtml` 的渲染结果）。 */
    var browserBody: String? = null,
    /**
     * 正文 JS 里给 `yp_url` 赋值 = "这一章的内容是一个媒体地址"（音频/EPUB 直链）。
     * 音频源（如懒人听书）大量这么写；不认的话正文规则返回空、整章取不到。
     */
    var mediaUrl: String? = null,
    /**
     * `java.setContent(...)` 存下的内容。上游把脚本里的 `java` 绑成 `AnalyzeRule` 实例本身
     * （`AnalyzeRule.evalJS`：`bindings["java"] = this`），`setContent` 换掉的就是它手上的 content，
     * 之后的 `java.getString` / `java.getElements` / `java.getStringList` 都改成解析这一份内容。
     * 挂在执行上下文（不是沙箱全局）上：一次调用一份，不会跨书源、跨调用互相污染。
     */
    var bridgeContent: String? = null,
    var bridgeBaseUrl: String? = null,
    /** 脚本执行失败的原始原因，供登录动作回传给前端展示（否则按钮会「假成功」） */
    var lastError: String? = null,
    /**
     * 用户已经在上一次调用里被要求打开内置浏览器、并且那一轮已经结束了。
     * 登录脚本普遍写成 `var r = java.startBrowserAwait(登录页); 从 r.body 里取 token`，
     * 上游是真 Android WebView 阻塞等页面关掉再返回响应；我们做不到阻塞，就靠客户端在
     * 「浏览器关掉」之后带这个标记重跑一次，第二次让服务端带着已落库的 Cookie 自己抓那一页。
     */
    var browserCompleted: Boolean = false,
    /** 当前书籍上下文，供 book 桥接对象读取 */
    val bookUrl: String? = null,
    val bookName: String? = null,
    val bookAuthor: String? = null,
    val bookTocUrl: String? = null,
    val bookType: Int? = null,
    val bookVariables: MutableMap<String, String> = mutableMapOf(),
    /** 当前章节上下文，供 chapter 桥接对象读取 */
    val chapterUrl: String? = null,
    val chapterIndex: Int? = null,
    val chapterTitle: String? = null,
    /** 该书源的 jsLib：所有规则 JS 都应能调用其中的工具函数 */
    val jsLib: String? = null,
)

/**
 * `Reload(url)` 真正交给抓取通道的地址。
 *
 * 外站规则脚本托管（qyyuapi.com 等）会**按 User-Agent 拦**默认抓取的 `legadoQ/0.1`，
 * 直接回 403。所以不能朴素抓取，必须在 URL 尾巴挂上浏览器级 UA / Referer / Accept。
 * `RuleRunner.splitUrlOptions` 已支持 `,<json headers>` 这种写法，所以这里只拼字符串，
 * 不去改 `buildRequest`（那会影响普通书源抓取的 UA 策略）。
 *
 * 抽成顶层函数是为了能直接单测：抓取通道被 `fetch()` 里的 `splitUrlOptions` 拆过之后，
 * 桩只会看到裸 URL，headers 在桩里不可见 —— 唯一能钉住"UA 到底挂没挂"的位置就是这里。
 */
internal fun reloadFetchUrl(url: String): String {
    val browserHeaders = """{"headers":{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36","Referer":"$url","Accept":"*/*"}}"""
    return "$url,$browserHeaders"
}

/**
 * 解开 `data:text/html;base64,…` / `data:text/html;charset=utf-8,…` 里的页面正文。
 * 聚合书源把设置页整页塞进 `java.startBrowserAwait` 的地址里（实测「光遇聚合」的
 * 线路/书源/段评三个设置页都这么做），没有远端地址可开；返回 null 表示不是可解码的数据地址。
 */
internal fun decodeDataUrlText(url: String): String? {
    if (!url.startsWith("data:", ignoreCase = true)) return null
    val comma = url.indexOf(',')
    if (comma < 0) return null
    val header = url.substring(5, comma)
    val payload = url.substring(comma + 1)
    return runCatching {
        if (header.contains(";base64", ignoreCase = true)) {
            String(Base64.getMimeDecoder().decode(payload), Charsets.UTF_8)
        } else {
            // data URL 里的 `+` 是字面量，不是表单编码的空格。
            java.net.URLDecoder.decode(payload.replace("+", "%2B"), Charsets.UTF_8)
        }
    }.getOrNull()
}

class JsSandbox(private val runner: RuleRunner? = null) {
    private val sessionStore = ConcurrentHashMap<String, Any>()

    /** `java.put` / `java.get` 的临时 KV 必须按书源隔离：整个沙箱只有一份，之前所有书源共用一个键空间。 */
    private fun sessionKey(sourceId: String?, key: String): String = (sourceId ?: "-") + "\u0000" + key

    /**
     * 当前线程正在求值的书源上下文。
     *
     * 规则的 `<js>` 片段（NodeValue）无法方便地把执行上下文逐层透传，但书源 JS 普遍依赖
     * `source.getVariable()` 与 jsLib 里的工具函数，因此由 RuleRunner 的入口方法设置本线程上下文，
     * eval 在未显式传入 execContext 时回退到它。
     */
    @PublishedApi
    internal val threadContext = ThreadLocal<JsExecutionContext?>()

    /** 在指定的书源上下文内执行 block（inline 以便调用方直接 return）。 */
    inline fun <T> withSourceContext(context: JsExecutionContext?, block: () -> T): T {
        val previous = threadContext.get()
        threadContext.set(context)
        try {
            return block()
        } finally {
            threadContext.set(previous)
        }
    }

    fun eval(
        script: String,
        bindings: Map<String, Any?> = emptyMap(),
        execContext: JsExecutionContext? = null,
    ): String? {
        val context = execContext ?: threadContext.get()
        val rawScript = script.trim().removePrefix("@js:").removePrefix("js:").trim()
        if (rawScript.isBlank()) return null
        // 书源的 jsLib 对所有规则 JS 可见（Legado 语义），集中在这里注入，
        // 避免每个调用点各自拼接、漏拼一处就整段脚本 ReferenceError。
        val library = context?.jsLib?.takeIf { it.isNotBlank() }
        // jsLib 必须先在**全局作用域**单独求值，动作脚本再在同一个 scope 里跑：
        // 书源库把工具函数写成顶层 `function getVariable(k){…}`，动作里却用 `this.getVariable('线路')`
        // 去调（this 在全局函数里指全局对象）。过去把库和动作拼成一段再包 IIFE，函数声明
        // 只在**顶层**有 return 时才包 IIFE（判断见 JsScriptShape）：按文本搜 return 会吞掉
        // "只在嵌套函数里 return、末尾是表达式"这类脚本的结果（详见该文件注释，210 份源受影响）。
        val executableScript = if (JsScriptShape.hasTopLevelReturn(rawScript)) {
            "(function(){\n$rawScript\n})()"
        } else {
            rawScript
        }

        val cx = BoundedJs.enter()
        try {
            cx.optimizationLevel = -1
            cx.setClassShutter(ClassShutter { false }) // Sandbox: block all Java reflection
            val scope = cx.initSafeStandardObjects()

            // 书源规则里 `JSON.parse(result)` 和 `result.属性` 两种写法都有：沙箱把 JSON 条目作为**对象**注入
            // result（否则属性访问取不到值），于是前者会把对象转成 "[object Object]" 再解析失败，
            // 规则里的 try/catch 把它吞掉后整条记录消失，表现为「搜索完成：0 项」。让 JSON.parse 接受已解析对象即可两全。
            // 但"是对象"不等于"已经解析过"：`java.get/post` 现在回的是**字符串形状的响应对象**
            //（Rhino 的 `new String(正文)` 再挂 `.body()` / `.statusCode()`），`typeof` 一样是 "object"。
            // 所以先问 `valueOf()`：能拿到字符串就按文本解析，只有真对象（我们注入的 Map/List）才原样返回。
            runCatching {
                cx.evaluateString(
                    scope,
                    "if (typeof JSON !== 'undefined' && typeof JSON.parse === 'function') {" +
                        "var __legadoOrigParse = JSON.parse;" +
                        "JSON.parse = function(value) {" +
                        "if (value !== null && typeof value === 'object') {" +
                        "if (typeof value.valueOf === 'function' && typeof value.valueOf() === 'string')" +
                        "return __legadoOrigParse.call(JSON, value.valueOf());" +
                        "return value;}" +
                        "try { return __legadoOrigParse.call(JSON, value); } catch (e) {" +
                            "throw new Error('脚本里的 JSON.parse 解析失败：内容不是合法 JSON（常见原因是没先 decodeURIComponent）—— '" +
                            "(e && e.message ? e.message : e));}}}",
                    "sandbox-compat", 1, null,
                )
            }

            // 书源脚本里的 `org.jsoup.Jsoup.parse(...)`：给白名单包装（只解析、不给网络出口）。
            // 不给的话 292 份源第一行就 ReferenceError: “org” 未定义，整源用不了。
            ScriptableObject.putProperty(scope, "org", JsoupBridge.install(cx, scope))

            // Inject bindings (e.g. result, src, baseUrl, key, page, book, chapter, isLongClick)
            bindings.forEach { (key, value) ->
                ScriptableObject.putProperty(scope, key, toJsValue(value, scope))
            }

            // Inject standard Legado 'java' bridge object
            ScriptableObject.putProperty(scope, "java", createJavaBridge(scope, context))

            // Legado 全局 `Reload(url)`：从远端把一段 JS 抓回来当**字符串**返回，书源再用 `eval(String(Reload('…')))`
            // 把它跑起来。社区漫画源（包子漫画、追樱漫画等）把 searchUrl / ruleSearch 整段都写在外站的
            // qyyuapi.com JS 里，靠这个函数把脚本拉回本地执行。沙箱原来没实现它，于是 `eval(String(Reload(…)))`
            // 抛 ReferenceError → 整条搜索地址算不出来（"searchUrl JS 计算未返回有效地址：在语句前面缺少 ';'"）。
            // 这里直接复用 java.ajax 的抓取通道（同一套重定向/超时/Cookie 处理），只把结果当纯文本回传、
            // 不执行，执行权仍然交给书源自己的 eval —— 满足"只导入信任书源"的安全前提。
            ScriptableObject.putProperty(scope, "Reload", object : BaseFunction() {
                override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                    val url = args.firstOrNull()?.toString() ?: return ""
                    return runCatching {
                        runner?.fetch(reloadFetchUrl(url), execContext?.sourceId, execContext?.database) ?: ""
                    }.getOrDefault("")
                }
            })

            // Legado 书源的 jsLib 惯用 `new JavaImporter()` + `with(importer){ ... }` 组织工具函数库。
            // 沙箱禁用了真实 Java 反射，此处提供空实现的安全替身：只要不再抛 ReferenceError，
            // 整个 with 块就能正常完成函数定义，后续登录动作才可能执行。
            ScriptableObject.putProperty(scope, "JavaImporter", createJavaImporterStub(scope))

            // Inject 'source' and 'cookie' bridge objects if sourceId is available
            val sourceId = context?.sourceId ?: bindings["sourceId"]?.toString() ?: bindings["baseUrl"]?.toString() ?: bindings["bookSourceUrl"]?.toString()
            if (!sourceId.isNullOrBlank()) {
                val db = context?.database ?: runner?.database
                ScriptableObject.putProperty(scope, "source", createSourceBridge(scope, sourceId, db, context))
                // 凭据改成全局按域共享之后，`cookie.getCookie(任意 url)` 就等于"任何源的登录态都能读"。
                // 上游是单机 App 不防这个，我们防一道软的：脚本只能读到这本书源配置里出现过的域，
                // 外加它自己的主域（源没入库时也能读到自己那份）。注意这是**文本**判定 ——
                // 一个铁了心的恶意源把域名写进规则串就能越过这条线，真正的底线仍然是"只导入信任书源"。
                val storedJson = db?.getSource(sourceId)?.json
                val scriptHosts = ((storedJson?.let(WebViewProxy::credentialDomains) ?: emptyList()) + listOfNotNull(
                    sourceId,
                    bindings["baseUrl"]?.toString(),
                    bindings["bookSourceUrl"]?.toString(),
                )).filter { it.isNotBlank() }
                ScriptableObject.putProperty(scope, "cookie", createCookieBridge(scope, sourceId, db, scriptHosts))
            }

            // Legado 的 book 对象：书源 JS 会用 book.getVariable('custom') 读取书籍级变量
            ScriptableObject.putProperty(scope, "book", createBookBridge(scope, context))
            // chapter 对象：正文规则会引用 chapter.index / chapter.title
            ScriptableObject.putProperty(scope, "chapter", createChapterBridge(scope, context))

            // 先求值书源脚本库；顶层 `function`/`let` 声明落成全局属性，动作里的 this.xxx 才解析得到。
            if (library != null) {
                cx.evaluateString(scope, library, "jsLib.js", 1, null)
            }

            val result = cx.evaluateString(scope, executableScript, "rule.js", 1, null)
            // 音频 / EPUB 直链：书源正文 JS 会给全局 `yp_url` 赋媒体地址（无 `var`），脚本本身不 `return`。
            // 不认这个约定，这类源的正文就恒为空。
            runCatching {
                val media = ScriptableObject.getProperty(scope, "yp_url")
                if (media is CharSequence && media.isNotBlank()) context?.mediaUrl = media.toString()
            }
            if (result == null || result == Context.getUndefinedValue()) {
                val globalResult = ScriptableObject.getProperty(scope, "result")
                if (globalResult != null && globalResult != Context.getUndefinedValue()) {
                    return jsValueToString(cx, scope, globalResult)
                }
                return null
            }
            return jsValueToString(cx, scope, result)
        } catch (e: Exception) {
            // 不能静默吞掉：否则登录按钮全部「执行成功」却毫无动作，用户无从判断原因。
            // 记录到执行上下文，由调用方决定是展示还是忽略。
            val detail = e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName
            context?.lastError = detail
            lastError = detail
            return null
        } finally {
            BoundedJs.exit()
        }
    }

    /** 最近一次 eval 的失败原因，供无法拿到执行上下文的调用方读取。 */
    @Volatile
    var lastError: String? = null
        private set

    /** `chapter` 桥接对象：正文规则会引用 chapter.index / chapter.title，缺失会让整段脚本中断。 */
    private fun createChapterBridge(scope: Scriptable, execContext: JsExecutionContext?): NativeObject {
        val chapter = NativeObject()
        chapter.parentScope = scope
        ScriptableObject.putProperty(chapter, "index", execContext?.chapterIndex ?: 0)
        ScriptableObject.putProperty(chapter, "title", execContext?.chapterTitle ?: "")
        ScriptableObject.putProperty(chapter, "url", execContext?.chapterUrl ?: "")
        ScriptableObject.putProperty(chapter, "start", 0)
        ScriptableObject.putProperty(chapter, "end", 0)
        return chapter
    }

    /**
     * `book` 桥接对象。     *
     * Legado 书源 JS 经常通过 `book.getVariable('custom')` 读取书籍级变量来决定请求参数；
     * 这里提供真实可存取的变量表，而不是让它抛错中断整段脚本。
     */
    private fun createBookBridge(scope: Scriptable, execContext: JsExecutionContext?): NativeObject {
        val book = NativeObject()
        book.parentScope = scope
        ScriptableObject.putProperty(book, "type", execContext?.bookType ?: 0)
        ScriptableObject.putProperty(book, "name", execContext?.bookName ?: "")
        ScriptableObject.putProperty(book, "author", execContext?.bookAuthor ?: "")
        ScriptableObject.putProperty(book, "bookUrl", execContext?.bookUrl ?: "")
        ScriptableObject.putProperty(book, "tocUrl", execContext?.bookTocUrl ?: "")
        ScriptableObject.putProperty(book, "durChapterIndex", execContext?.chapterIndex ?: 0)
        ScriptableObject.putProperty(book, "durChapterTitle", execContext?.chapterTitle ?: "")
        ScriptableObject.putProperty(book, "durChapterPos", 0)
        ScriptableObject.putProperty(book, "order", 0)
        // 上游 Book.origin 就是书源域名，46 个源用它拼请求地址；以前这个属性根本不存在，
        // 脚本里 `book.origin` 取到 undefined 再拼进 URL，表现为"抓回来一个 about:blank"。
        ScriptableObject.putProperty(book, "origin", execContext?.sourceId ?: "")
        ScriptableObject.putProperty(book, "coverUrl", "")
        ScriptableObject.putProperty(book, "kind", "")
        ScriptableObject.putProperty(book, "wordCount", "")
        ScriptableObject.putProperty(book, "lastChapter", "")
        ScriptableObject.putProperty(book, "intro", "")
        ScriptableObject.putProperty(book, "readMeUrl", "")
        val readConfig = NativeObject()
        readConfig.parentScope = scope
        ScriptableObject.putProperty(book, "readConfig", readConfig)

        val putVariable = object : BaseFunction() {
            override fun call(cx: Context, s: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val key = args.firstOrNull()?.toString()
                if (key != null) {
                    execContext?.bookVariables?.put(key, args.getOrNull(1)?.toString() ?: "")
                }
                return Context.getUndefinedValue()
            }
        }
        ScriptableObject.putProperty(book, "getVariable", object : BaseFunction() {
            override fun call(cx: Context, s: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val key = args.firstOrNull()?.toString() ?: return "null"
                return execContext?.bookVariables?.get(key) ?: "null"
            }
        })
        // 上游 Book 实现 RuleDataInterface，方法名是 putVariable；setVariable 是它的别名。
        // 只给 setVariable 的话，54 个写 `book.putVariable('k',v)` 的源直接抛 TypeError。
        ScriptableObject.putProperty(book, "putVariable", putVariable)
        ScriptableObject.putProperty(book, "setVariable", putVariable)
        val noop = object : BaseFunction() {
            override fun call(cx: Context, s: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any =
                Context.getUndefinedValue()
        }
        ScriptableObject.putProperty(book, "setUseReplaceRule", noop)
        return book
    }

    /**
     * `JavaImporter` 的安全替身。     *
     * Legado 的 Rhino 环境提供 `JavaImporter`，大量书源的 jsLib 用它配合 `with` 语句组织工具函数库。
     * 沙箱出于安全禁用真实 Java 反射，因此这里只返回一个**空的**导入器：importClass/importPackage
     * 为空操作，不暴露任何 Java 能力，但足以让脚本不再抛 ReferenceError、正常完成函数定义。
     */
    private fun createJavaImporterStub(scope: Scriptable): BaseFunction = object : BaseFunction() {
        override fun call(cx: Context, s: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
            val importer = NativeObject()
            importer.parentScope = scope
            val noop = object : BaseFunction() {
                override fun call(cx: Context, s: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any =
                    Context.getUndefinedValue()
            }
            ScriptableObject.putProperty(importer, "importClass", noop)
            ScriptableObject.putProperty(importer, "importPackage", noop)
            return importer
        }

        override fun construct(cx: Context, s: Scriptable, args: Array<out Any?>): Scriptable =
            call(cx, s, s, args) as Scriptable
    }

    /**
     * 「当属性读也当方法调」的对象。
     *
     * 上游递给脚本的是 `StrResponse` / OkHttp `Response` / Jsoup `Connection.Response` 这些
     * **真对象**，它们的 `raw`、`request`、`body` 既可能是字段也可能是同名方法，社区源两种写法都有。
     * 我们不放 Java 对象进沙箱（`setClassShutter { false }` 是 RCE 防线），于是用这个替身：
     * 调用时返回自己，读属性时按挂上去的成员取，转成字符串时给 [text]。
     */
    private class ChainedObject(scope: Scriptable, private val text: String = "") : BaseFunction() {
        init {
            parentScope = scope
        }

        override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any = this

        override fun getDefaultValue(typeHint: Class<*>?): Any = text
    }

    /**
     * 「既是字符串、又是响应对象」的替身。
     *
     * 为什么两边都要：`java.get/post` 的结果，启用库里有 **116 处**接着调字符串方法
     *（`.split()`、`.indexOf()`、`.replace()`），另有 **115 处**接着调响应方法
     *（`.body()`、`.statusCode()`、`.headers('Location')`）。上游回的是真对象
     *（Jsoup `Connection.Response` / `StrResponse`，后者的 `body`、`url` 还是字段与方法同名）：
     * 只回字符串，后一批就报"未找到函数"；只回对象，前一批就碎。
     *
     * 做法是让 Rhino 自己 `new String(正文)`（Rhino 的 `NativeString` 是包内私有、也不允许继承，
     * 走构造函数是唯一干净的路），再把响应成员挂在这个实例上：
     * 字符串该有的一切仍走 `String.prototype`（`length`、`indexOf`、拼接、`String(x)`），
     * 响应成员由我们补。**不往沙箱里放任何 Java / OkHttp 对象**（`setClassShutter { false }` 是 RCE 底线）。
     */
    private fun responseView(cx: Context, scope: Scriptable, fetched: RuleRunner.Fetched): Scriptable {
        val top = topScope(scope)
        val view = cx.newObject(top, "String", arrayOf<Any?>(fetched.body))
        fun fn(read: (List<Any?>) -> Any?) = object : BaseFunction() {
            override fun call(c: Context?, s: Scriptable?, t: Scriptable?, a: Array<out Any?>): Any {
                return runCatching { read(a.toList()) }.getOrElse { Context.getUndefinedValue() } ?: Context.getUndefinedValue()
            }
        }
        // 链节点：`.raw()` 与 `.raw.request` 都要能读，所以"调用返回自己、属性另外挂"
        fun chained(text: String): BaseFunction = object : BaseFunction() {
            init {
                parentScope = top
            }

            override fun call(c: Context, s: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any = this

            override fun getDefaultValue(typeHint: Class<*>?): Any = text
        }
        val headerTable = NativeObject().also { table ->
            table.parentScope = top
            fetched.headers.forEach { (header, value) -> ScriptableObject.putProperty(table, header, value) }
        }
        fun lookup(args: List<Any?>): Any? {
            val key = args.firstOrNull()?.toString()?.trim()?.lowercase()?.ifEmpty { null }
            return key?.let { fetched.headers[it] ?: "" } ?: headerTable
        }
        val requestNode = chained(fetched.url).also { node ->
            ScriptableObject.putProperty(node, "url", CallableBody(top, fetched.url))
        }
        val rawNode = chained(fetched.url).also { node ->
            ScriptableObject.putProperty(node, "request", requestNode)
            ScriptableObject.putProperty(node, "body", CallableBody(top, fetched.body))
        }
        ScriptableObject.putProperty(view, "body", CallableBody(top, fetched.body))
        ScriptableObject.putProperty(view, "url", CallableBody(top, fetched.url))
        ScriptableObject.putProperty(view, "contentType", CallableBody(top, fetched.headers["content-type"] ?: ""))
        ScriptableObject.putProperty(view, "statusCode", fn { fetched.status })
        ScriptableObject.putProperty(view, "statusMessage", fn { if (fetched.status in 200..299) "OK" else "" })
        ScriptableObject.putProperty(view, "isSuccessful", fn { fetched.status in 200..299 })
        // `header(名)` / `headers()` / `headers(名)` 三种写法库里都有：不带名字给全表，带名字给那一个
        ScriptableObject.putProperty(view, "header", fn { lookup(it) })
        ScriptableObject.putProperty(view, "headers", fn { lookup(it) })
        ScriptableObject.putProperty(view, "raw", rawNode)
        return view
    }

    /** Rhino 建数组、查原型都要**顶层作用域**；BaseFunction 收到的 `scope` 是函数自己的激活作用域。 */
    private fun topScope(scope: Scriptable): Scriptable = ScriptableObject.getTopLevelScope(scope)

    /** 脚本显式传了内容就用它，没传才用 setContent/src（上游 `getString(rule, mContent)` 的口径）。 */
    private fun contentOf(context: Context, scope: Scriptable, explicit: Any?, fallback: String): String {
        if (explicit == null || explicit == Context.getUndefinedValue()) return fallback
        return jsValueToString(context, scope, explicit) ?: fallback
    }

    /** JS 传进来的 true 在 Rhino 里可能是 Boolean、数字或字符串，判"真"要三种都认。 */
    private fun truthy(value: Any?): Boolean = when (value) {
        null, Context.getUndefinedValue() -> false
        is Boolean -> value
        is Number -> value.toDouble() != 0.0
        is CharSequence -> value.toString().trim().let { it.isNotBlank() && it != "false" && it != "0" && it != "null" }
        else -> true
    }

    /** `isUrl=true` 时把取值按 baseUrl 补成绝对地址；补不上就原样给回（与 RuleRunner 的绝对化同一口径）。 */
    private fun absolute(base: String?, href: String): String {
        if (base.isNullOrBlank() || href.isBlank()) return href
        return runCatching { java.net.URI(base).resolve(href.trim()).toString() }.getOrDefault(href)
    }

    private fun jsValueToString(context: Context, scope: Scriptable, value: Any?): String? = when (value) {
        null, Context.getUndefinedValue() -> null
        is CallableBody -> value.text
        is CharSequence -> value.toString()
        // Rhino 的 number 一律是 double：不处理的话 `@js: a.length`、`size()`、`页码*10`
        // 这类结果会被印成 "2.0"，而它会**直接当字段值**显示到界面上（字数、页数最明显）。
        // JS 的写法是整数不带小数点，这里对齐。
        is Number -> value.toString().removeSuffix(".0")
        is Boolean -> value.toString()
        else -> runCatching {
            NativeJSON.stringify(context, scope, value, null, null).toString()
        }.getOrNull() ?: value.toString()
    }

    /**
     * 上游 `java.startBrowserAwait(...)` 返回 `StrResponse`，`body` 同时是字段和方法：
     * 库内 6 处真实用法都写 `.body()`（光遇聚合的设置页就是其一），而按字段读 `String(r.body)` 也合理。
     * 这里给一个"可调用的字符串"替身——调用返回正文，`String(...)`/拼接也取正文。
     */
    internal class CallableBody(scope: Scriptable, val text: String) : BaseFunction() {
        init {
            parentScope = scope
            // 上游拿 `r.body` 当字符串用：`(r.body || '').length` 也要是正文长度，而不是函数形参数。
            ScriptableObject.putProperty(this, "length", text.length)
        }

        override fun get(name: String, start: Scriptable): Any? {
            // 函数自带的 length 是形参数；这里按字符串语义返回正文长度。
            if (name == "length") return text.length
            return super.get(name, start)
        }

        override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any = text

        override fun getDefaultValue(typeHint: Class<*>?): Any = text
    }

    private fun createSourceBridge(
        scope: Scriptable,
        sourceId: String,
        db: Database?,
        execContext: JsExecutionContext?,
    ): NativeObject = NativeObject().also { api ->
        api.parentScope = scope

        // source.bookSourceUrl / source.getKey() / source.key
        val keyFn = object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any = sourceId
        }
        ScriptableObject.putProperty(api, "getKey", keyFn)
        ScriptableObject.putProperty(api, "bookSourceUrl", sourceId)
        ScriptableObject.putProperty(api, "key", sourceId)
        ScriptableObject.putProperty(api, "bookSourceName", execContext?.sourceName ?: sourceId)
        ScriptableObject.putProperty(api, "bookSourceComment", execContext?.sourceComment ?: "")

        // source.getLoginInfo() -> JSON string
        ScriptableObject.putProperty(api, "getLoginInfo", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val current = execContext?.initialLoginInfo?.takeIf { it.isNotEmpty() }
                    ?: db?.getSourceLoginState(sourceId)?.loginInfo
                    ?: emptyMap()
                return Json.encodeToString(current)
            }
        })

        // source.getLoginInfoMap() -> NativeObject
        ScriptableObject.putProperty(api, "getLoginInfoMap", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val current = execContext?.initialLoginInfo?.takeIf { it.isNotEmpty() }
                    ?: db?.getSourceLoginState(sourceId)?.loginInfo
                    ?: emptyMap()
                return toJsValue(current, scope) ?: NativeObject().also { it.parentScope = scope }
            }
        })

        // source.putLoginInfo(info)
        ScriptableObject.putProperty(api, "putLoginInfo", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val arg = args.firstOrNull() ?: return false
                val map = parseJsMapOrJson(arg)
                if (execContext != null) {
                    execContext.initialLoginInfo.putAll(map)
                }
                db?.saveSourceLoginInfo(sourceId, execContext?.initialLoginInfo ?: map)
                return true
            }
        })

        // source.removeLoginInfo()
        ScriptableObject.putProperty(api, "removeLoginInfo", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                execContext?.initialLoginInfo?.clear()
                db?.removeSourceLoginInfo(sourceId)
                return true
            }
        })

        // source.getLoginHeader()
        ScriptableObject.putProperty(api, "getLoginHeader", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                return db?.getSourceLoginState(sourceId)?.loginHeader ?: ""
            }
        })

        // source.getLoginHeaderMap()
        ScriptableObject.putProperty(api, "getLoginHeaderMap", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val header = db?.getSourceLoginState(sourceId)?.loginHeader ?: ""
                val map = runCatching { Json.decodeFromString<Map<String, String>>(header) }.getOrDefault(emptyMap())
                return toJsValue(map, scope) ?: NativeObject().also { it.parentScope = scope }
            }
        })

        // source.putLoginHeader(header)
        ScriptableObject.putProperty(api, "putLoginHeader", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val h = args.firstOrNull()?.toString() ?: ""
                db?.saveSourceLoginHeader(sourceId, h)
                return true
            }
        })

        // source.removeLoginHeader()
        ScriptableObject.putProperty(api, "removeLoginHeader", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                db?.removeSourceLoginHeader(sourceId)
                return true
            }
        })

        // source.getVariable()
        ScriptableObject.putProperty(api, "getVariable", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                return db?.getSourceVariable(sourceId) ?: ""
            }
        })

        // source.setVariable(val)
        ScriptableObject.putProperty(api, "setVariable", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val v = args.firstOrNull()?.toString() ?: ""
                db?.saveSourceVariable(sourceId, v)
                return v
            }
        })

        // source.put(key, val)
        ScriptableObject.putProperty(api, "put", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val k = args.getOrNull(0)?.toString() ?: return Context.getUndefinedValue()
                val v = args.getOrNull(1)?.toString()
                db?.saveSourceKv(sourceId, k, v)
                return v ?: Context.getUndefinedValue()
            }
        })

        // source.get(key)
        ScriptableObject.putProperty(api, "get", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val k = args.firstOrNull()?.toString() ?: return Context.getUndefinedValue()
                return db?.getSourceKv(sourceId, k) ?: Context.getUndefinedValue()
            }
        })
    }

    private fun createCookieBridge(
        scope: Scriptable,
        sourceId: String,
        db: Database?,
        allowedHosts: List<String>,
    ): NativeObject = NativeObject().also { api ->
        api.parentScope = scope

        // 只放行这本书源配置里真正会访问的域（按注册域比对，与存桶键同一口径）
        fun allowed(url: String): Boolean {
            val bucket = db?.cookieBucket(url) ?: return false
            return allowedHosts.any { host -> db.cookieBucket(host) == bucket }
        }

        // cookie.getCookie(url)
        ScriptableObject.putProperty(api, "getCookie", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val url = args.firstOrNull()?.toString() ?: return ""
                if (!allowed(url)) return ""
                return db?.getCookieForUrl(url) ?: ""
            }
        })

        // cookie.setCookie(url, cookie)
        val setFn = object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val url = args.getOrNull(0)?.toString() ?: return ""
                val c = args.getOrNull(1)?.toString() ?: return ""
                if (allowed(url)) db?.setCookieForUrl(url, c)
                return c
            }
        }
        ScriptableObject.putProperty(api, "setCookie", setFn)
        ScriptableObject.putProperty(api, "replaceCookie", setFn)
        ScriptableObject.putProperty(api, "setWebCookie", setFn)

        // cookie.removeCookie(url)
        ScriptableObject.putProperty(api, "removeCookie", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val url = args.firstOrNull()?.toString() ?: return true
                if (allowed(url)) db?.removeCookieBucket(url)
                return true
            }
        })

        // cookie.getKey(url, key)
        ScriptableObject.putProperty(api, "getKey", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val url = args.getOrNull(0)?.toString() ?: return ""
                val key = args.getOrNull(1)?.toString() ?: return ""
                if (!allowed(url)) return ""
                val cookieStr = db?.getCookieForUrl(url) ?: ""
                val map = parseCookieString(cookieStr)
                return map[key] ?: ""
            }
        })

        // cookie.mapToCookie(map)
        ScriptableObject.putProperty(api, "mapToCookie", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val arg = args.firstOrNull() ?: return ""
                val map = parseJsMapOrJson(arg)
                return map.entries.joinToString("; ") { "${it.key}=${it.value}" }
            }
        })
    }

    private fun createJavaBridge(
        scope: Scriptable,
        execContext: JsExecutionContext?,
    ): NativeObject = NativeObject().also { api ->
        api.parentScope = scope

        // java.ajax(url)
        ScriptableObject.putProperty(api, "ajax", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val url = args.firstOrNull()?.toString() ?: return ""
                if (url.startsWith("data:text/html;base64,")) {
                    val encoded = url.removePrefix("data:text/html;base64,")
                    return runCatching { String(Base64.getDecoder().decode(encoded), Charsets.UTF_8) }.getOrDefault("")
                }
                // 上游 AnalyzeRule.ajax 把异常收成 stackTrace 字符串再交给脚本（脚本自己 JSON.parse 失败后会走
                // 自己的错误提示）。Java 异常直接穿过 Rhino 会让 `catch (e) { '…' + e }` 变成
                // ClassCastException 文案，登录界面只剩「服务器错误」都算好的。
                return runCatching { runner?.fetch(url, execContext?.sourceId, execContext?.database) ?: "" }
                    .getOrElse { it.stackTraceToString() }
            }
        })

        // java.post(url, body, headers)
        ScriptableObject.putProperty(api, "post", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val url = args.getOrNull(0)?.toString() ?: return ""
                val body = args.getOrNull(1)?.toString() ?: ""
                val headers = args.getOrNull(2)?.let { parseJsMapOrJson(it) } ?: emptyMap()
                val fetched = runCatching {
                    runner?.fetchResponse(
                        url = url,
                        method = "POST",
                        headers = headers,
                        body = body,
                        sourceId = execContext?.sourceId,
                    )
                }.getOrElse { RuleRunner.Fetched(url, it.stackTraceToString(), 0, emptyMap()) }
                    ?: RuleRunner.Fetched(url, "", 0, emptyMap())
                return responseView(cx, scope, fetched)
            }
        })

        // java.get(...) 在 Legado 里有两种用法：`java.get(key)` 读 KV，`java.get(url[, headers])` 发 HTTP GET。
        // 这里必须一个函数同时兼顾：曾经两个注册都写在同一个 bridge 上，后注册的 KV 版把 HTTP 版静默覆盖，
        // 于是所有用 java.get 抓页面的书源都拿到 undefined（表现为“执行成功但内容为空”）。
        ScriptableObject.putProperty(api, "get", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val first = args.firstOrNull()?.toString() ?: return Context.getUndefinedValue()
                val looksLikeUrl = first.startsWith("http://", ignoreCase = true) || first.startsWith("https://", ignoreCase = true)
                if (args.size >= 2 || looksLikeUrl) {
                    val headers = args.getOrNull(1)?.let { parseJsMapOrJson(it) } ?: emptyMap()
                    val fetched = runCatching {
                        runner?.fetchResponse(url = first, headers = headers, sourceId = execContext?.sourceId)
                    }.getOrElse { RuleRunner.Fetched(first, it.stackTraceToString(), 0, emptyMap()) }
                    return responseView(cx, scope, fetched ?: RuleRunner.Fetched(first, "", 0, emptyMap()))
                }
                return sessionStore[sessionKey(execContext?.sourceId, first)] ?: Context.getUndefinedValue()
            }
        })

        // java.toast(msg) / java.longToast(msg)
        val toastFn = object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val msg = args.firstOrNull()?.toString()?.trim() ?: return Context.getUndefinedValue()
                if (msg.isNotBlank()) {
                    execContext?.toastMessages?.add(msg)
                }
                return Context.getUndefinedValue()
            }
        }
        ScriptableObject.putProperty(api, "toast", toastFn)
        ScriptableObject.putProperty(api, "longToast", toastFn)

        // java.log(msg)
        ScriptableObject.putProperty(api, "log", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                return Context.getUndefinedValue()
            }
        })

        // java.startBrowser(url, title) / java.openWeb(url)：只请求打开，无返回体
        val browserFn = object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val url = args.firstOrNull()?.toString() ?: ""
                execContext?.openUrl = url
                val resObj = NativeObject()
                resObj.parentScope = scope
                ScriptableObject.putProperty(resObj, "url", url)
                ScriptableObject.putProperty(resObj, "body", "")
                return resObj
            }
        }
        ScriptableObject.putProperty(api, "startBrowser", browserFn)
        // java.startBrowserAwait(url, title)：上游返回 `StrResponse{url, body}`，登录脚本会去读
        // `r.body` 拿 token。第一次调用只把地址交给界面去开浏览器；用户在浏览器里登录完、界面带
        // `browserCompleted` 重跑时，这里改成**服务端自己带着已落库的 Cookie 抓这一页**，
        // 把 HTML 放进 body —— 否则脚本永远拿到空串，登录等于没做完。
        ScriptableObject.putProperty(api, "startBrowserAwait", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val url = args.firstOrNull()?.toString() ?: ""
                val title = args.getOrNull(1)?.toString()?.trim()?.takeIf { it.isNotEmpty() }
                val resObj = NativeObject()
                resObj.parentScope = scope
                ScriptableObject.putProperty(resObj, "url", url)
                val inline = if (url.startsWith("data:", ignoreCase = true)) decodeDataUrlText(url) else null
                val body = when {
                    // 页面这一轮已经关掉：优先用界面交回来的整页 HTML（本地 data 页没有远端可再抓），
                    // 远端地址则按已落库的 Cookie 重新抓一次。
                    execContext?.browserCompleted == true -> {
                        execContext?.browserBody
                            ?: if (url.startsWith("http")) {
                                runCatching { runner?.fetch(url, execContext?.sourceId, execContext?.database) }.getOrNull()
                            } else null
                    }
                    // 书源自拼的设置页（data:text/html）：地址没法交给真浏览器，界面用 iframe 渲染。
                    inline != null -> {
                        execContext?.inlineHtml = inline
                        execContext?.inlineTitle = title
                        null
                    }
                    else -> {
                        execContext?.openUrl = url
                        null
                    }
                } ?: ""
                ScriptableObject.putProperty(resObj, "body", CallableBody(scope, body))
                return resObj
            }
        })
        ScriptableObject.putProperty(api, "openWeb", browserFn)
        // 上游 `JsExtensions.getCookie(tag[, key])`：tag 是地址或域名，实测 15 个源在用 `java.getCookie(...)`，
        // 我们只有 `cookie.getCookie(...)`，于是这些脚本直接 TypeError。两个名字都要有。
        val javaGetCookie = object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val tag = args.getOrNull(0)?.toString() ?: return ""
                val db = execContext?.database ?: return ""
                val ownId = execContext?.sourceId ?: return ""
                // 与 cookie 桥同一道软闸：配置里出现过的域 + 它自己的主域。
                val stored = db.getSource(ownId)?.json?.let(WebViewProxy::credentialDomains) ?: emptyList()
                val bucket = db.cookieBucket(tag)
                if ((stored + ownId).none { host -> db.cookieBucket(host) == bucket }) return ""
                val cookie = db.getCookieForUrl(tag) ?: ""
                val key = args.getOrNull(1)?.toString()?.takeIf { it.isNotBlank() } ?: return cookie
                return cookie.split(';').map { it.trim() }.firstOrNull { it.startsWith("$key=") }?.substringAfter('=') ?: ""
            }
        }
        ScriptableObject.putProperty(api, "getCookie", javaGetCookie)
        ScriptableObject.putProperty(api, "getKey", javaGetCookie)
        // 聚合类书源常用的其它打开网页别名
        ScriptableObject.putProperty(api, "showBrowser", browserFn)
        ScriptableObject.putProperty(api, "showReadingBrowser", browserFn)
        ScriptableObject.putProperty(api, "startBrowserDp", browserFn)

        // java.getWebViewUA()：部分书源用它给站点请求伪装 WebView 的 UA
        ScriptableObject.putProperty(api, "getWebViewUA", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any =
                "Mozilla/5.0 (Linux; Android 13; Pixel 5 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 " +
                    "(KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36"
        })

        // java.copyText(text)
        ScriptableObject.putProperty(api, "copyText", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                execContext?.copyText = args.firstOrNull()?.toString() ?: ""
                return Context.getUndefinedValue()
            }
        })

        // java.upLoginData(data)
        ScriptableObject.putProperty(api, "upLoginData", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val arg = args.firstOrNull()
                if (arg != null) {
                    val map = parseJsMapOrJson(arg)
                    execContext?.initialLoginInfo?.putAll(map)
                }
                execContext?.reRenderUi = true
                return Context.getUndefinedValue()
            }
        })

        // java.reLoginView(deltaUp) / java.reUiView()
        val reUiFn = object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                execContext?.reRenderUi = true
                return Context.getUndefinedValue()
            }
        }
        ScriptableObject.putProperty(api, "reLoginView", reUiFn)
        ScriptableObject.putProperty(api, "reUiView", reUiFn)
        ScriptableObject.putProperty(api, "refreshExplore", reUiFn)
        ScriptableObject.putProperty(api, "refreshBookInfo", reUiFn)
        ScriptableObject.putProperty(api, "refreshBookToc", reUiFn)
        ScriptableObject.putProperty(api, "refreshContent", reUiFn)

        // java.base64Decode(str)
        ScriptableObject.putProperty(api, "base64Decode", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val input = args.firstOrNull()?.toString() ?: return ""
                return runCatching {
                    val clean = input.trim()
                    val bytes = try {
                        Base64.getDecoder().decode(clean)
                    } catch (_: Exception) {
                        Base64.getUrlDecoder().decode(clean)
                    }
                    String(bytes, Charsets.UTF_8)
                }.getOrDefault("")
            }
        })

        // java.base64Encode(str)
        ScriptableObject.putProperty(api, "base64Encode", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val input = args.firstOrNull()?.toString() ?: return ""
                return Base64.getEncoder().encodeToString(input.toByteArray(Charsets.UTF_8))
            }
        })

        /**
         * java.aesBase64DecodeToString(base64, key, transformation, iv) —— Legado 的标准 API。
         *
         * 为什么必须有：一批聚合源/漫画源把正文用 AES 加密后塞进 JSON 的 `data` 字段，
         * 规则里先用它解出真正的 JSON 再取路径（`ruleBookInfo.init` 就是干这个的）。
         * 少了这个函数，`init` 抛错后引擎会把那段**密文**当 JSON 解析，报出来的是
         * `Unexpected End Of File position 36020` —— 一个和真正原因（缺加密能力）
         * 毫无关系的错误，排查时能把人带到完全相反的方向。
         *
         * 语义与 Legado 保持一致：key / iv 按**原始字节**用（不是十六进制字符串），
         * 密文是标准 Base64。解不出来返回空串（与 base64Decode 的容错口径一致）。
         */
        ScriptableObject.putProperty(api, "aesBase64DecodeToString", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val encoded = args.getOrNull(0)?.toString() ?: return ""
                val key = args.getOrNull(1)?.toString() ?: return ""
                val transformation = args.getOrNull(2)?.toString()?.takeIf { it.isNotBlank() }
                    ?: "AES/CBC/PKCS5Padding"
                val iv = args.getOrNull(3)?.toString()
                return runCatching {
                    val cipher = javax.crypto.Cipher.getInstance(transformation)
                    val secretKey = javax.crypto.spec.SecretKeySpec(key.toByteArray(Charsets.UTF_8), "AES")
                    if (iv.isNullOrEmpty()) {
                        cipher.init(javax.crypto.Cipher.DECRYPT_MODE, secretKey)
                    } else {
                        cipher.init(
                            javax.crypto.Cipher.DECRYPT_MODE,
                            secretKey,
                            javax.crypto.spec.IvParameterSpec(iv.toByteArray(Charsets.UTF_8)),
                        )
                    }
                    val raw = encoded.trim().let { text ->
                        try {
                            Base64.getDecoder().decode(text)
                        } catch (_: Exception) {
                            Base64.getUrlDecoder().decode(text)
                        }
                    }
                    String(cipher.doFinal(raw), Charsets.UTF_8)
                }.getOrDefault("")
            }
        })

        /**
         * java.aesDecodeToBase64(base64, key, transformation, iv) —— 与上面那个同族，但**返回 Base64**。
         *
         * 为什么另开一个：图片解密要的是**字节**，转成 UTF-8 字符串会把二进制烧掉。
         * 书源的 `ruleContent.imageDecode` 拿到 `result`（原图 Base64），用这个函数解出
         * 解密后的 Base64 返回，服务端再还原成图片字节（见 `ImageDecode.parse`）。
         */
        ScriptableObject.putProperty(api, "aesDecodeToBase64", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val encoded = args.getOrNull(0)?.toString() ?: return ""
                val key = args.getOrNull(1)?.toString() ?: return ""
                val transformation = args.getOrNull(2)?.toString()?.takeIf { it.isNotBlank() }
                    ?: "AES/CBC/PKCS5Padding"
                val iv = args.getOrNull(3)?.toString()
                return runCatching {
                    val cipher = javax.crypto.Cipher.getInstance(transformation)
                    val secretKey = javax.crypto.spec.SecretKeySpec(key.toByteArray(Charsets.UTF_8), "AES")
                    if (iv.isNullOrEmpty()) {
                        cipher.init(javax.crypto.Cipher.DECRYPT_MODE, secretKey)
                    } else {
                        cipher.init(
                            javax.crypto.Cipher.DECRYPT_MODE,
                            secretKey,
                            javax.crypto.spec.IvParameterSpec(iv.toByteArray(Charsets.UTF_8)),
                        )
                    }
                    val raw = encoded.trim().let { text ->
                        try {
                            Base64.getDecoder().decode(text)
                        } catch (_: Exception) {
                            Base64.getUrlDecoder().decode(text)
                        }
                    }
                    Base64.getEncoder().encodeToString(cipher.doFinal(raw))
                }.getOrDefault("")
            }
        })

        // java.hexDecodeToString(hex) / java.hexEncodeToString(str)
        // 聚合类书源用 data:;hex,... 之类的载荷在搜索→详情→目录→正文之间传递参数
        ScriptableObject.putProperty(api, "hexDecodeToString", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val input = args.firstOrNull()?.toString() ?: return ""
                val clean = input.trim().removePrefix("0x")
                // 载荷可能是十六进制，也可能已经被上层解码成普通文本（如 JSON），
                // 非十六进制时原样返回，避免把正确的数据破坏成乱码。
                if (clean.isEmpty() || clean.length % 2 != 0 || !clean.all { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' }) {
                    return input
                }
                return runCatching {
                    String(ByteArray(clean.length / 2) { index ->
                        clean.substring(index * 2, index * 2 + 2).toInt(16).toByte()
                    }, Charsets.UTF_8)
                }.getOrDefault(input)
            }
        })
        ScriptableObject.putProperty(api, "hexEncodeToString", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val input = args.firstOrNull()?.toString() ?: return ""
                return input.toByteArray(Charsets.UTF_8).joinToString("") { "%02x".format(it) }
            }
        })

        // java.md5Encode(str) / java.md5(str)
        val md5Fn = object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val input = args.firstOrNull()?.toString() ?: return ""
                return MessageDigest.getInstance("MD5").digest(input.toByteArray(Charsets.UTF_8))
                    .joinToString("") { "%02x".format(it) }
            }
        }
        ScriptableObject.putProperty(api, "md5Encode", md5Fn)
        ScriptableObject.putProperty(api, "md5", md5Fn)

        // java.md5Encode16(str)
        ScriptableObject.putProperty(api, "md5Encode16", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val input = args.firstOrNull()?.toString() ?: return ""
                val full = MessageDigest.getInstance("MD5").digest(input.toByteArray(Charsets.UTF_8))
                    .joinToString("") { "%02x".format(it) }
                return if (full.length >= 24) full.substring(8, 24) else full
            }
        })

        // java.randomUUID()
        ScriptableObject.putProperty(api, "randomUUID", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                return UUID.randomUUID().toString()
            }
        })

        // java.deviceID() / java.androidId()
        val deviceIdFn = object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                return "legado-headless-client-001"
            }
        }
        ScriptableObject.putProperty(api, "deviceID", deviceIdFn)
        ScriptableObject.putProperty(api, "androidId", deviceIdFn)

        // java.timeFormat(timestamp[, format])：默认格式与 Legado 一致（到分钟，不带秒）
        ScriptableObject.putProperty(api, "timeFormat", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val arg = args.firstOrNull() ?: return ""
                val millis = when (arg) {
                    is Number -> arg.toLong()
                    is Date -> arg.time
                    else -> arg.toString().toLongOrNull() ?: System.currentTimeMillis()
                }
                val pattern = (args.getOrNull(1) as? CharSequence)?.toString()?.takeIf { it.isNotBlank() }
                    ?: "yyyy-MM-dd HH:mm"
                return runCatching { SimpleDateFormat(pattern, Locale.getDefault()).format(Date(millis)) }
                    .getOrDefault("")
            }
        })

        // java.encodeURI(值[, 字符集])：上游就是 URLEncoder.encode(str, enc)，默认 UTF-8。
        // 启用库里有 91 处写在 searchUrl 的脚本里（把关键词拼进地址那一步），缺它整条搜索地址算不出来。
        ScriptableObject.putProperty(api, "encodeURI", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val text = args.getOrNull(0)?.toString() ?: return ""
                val charset = args.getOrNull(1)?.toString()?.takeIf { it.isNotBlank() } ?: "UTF-8"
                return runCatching { URLEncoder.encode(text, charset) }.getOrDefault("")
            }
        })

        // java.toNumChapter(标题)：「第一千二百三十四章」→「第1234章」，146 处在用。
        // 算法逐分支照上游（见 ChapterNumbers）：差一点就跟上游 App 的目录顺序不一样。
        ScriptableObject.putProperty(api, "toNumChapter", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val text = args.getOrNull(0)?.toString() ?: return ""
                return ChapterNumbers.toNumChapter(text) ?: text
            }
        })

        // java.timeFormatUTC(毫秒, 格式[, 时区偏移小时])：上游用 SimpleTimeZone(sh, "UTC") 格式化。
        ScriptableObject.putProperty(api, "timeFormatUTC", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val arg = args.getOrNull(0) ?: return ""
                val millis = when (arg) {
                    is Number -> arg.toLong()
                    is Date -> arg.time
                    else -> arg.toString().toLongOrNull() ?: return ""
                }
                val pattern = args.getOrNull(1)?.toString()?.takeIf { it.isNotBlank() } ?: return ""
                val format = SimpleDateFormat(pattern, Locale.getDefault())
                // 第三个参数书源写的是**小时**（实测有 0 / 8 / 12 三种），而 SimpleTimeZone 要的是偏移毫秒。
                // 上游 `SimpleTimeZone(sh, "UTC")` 把小时直接当毫秒传，等于永远按 UTC 出结果
                //（番茄系那些 `timeFormatUTC(ts, 'yyyy-MM-dd HH:mm:ss', 8)` 在上游其实没生效）。
                // 这里按作者意图换算成毫秒 —— 界面显示的时间错八小时，比"和上游一样"更糟。
                val offsetHours = (args.getOrNull(2) as? Number)?.toInt() ?: 0
                format.timeZone = SimpleTimeZone(offsetHours * 60 * 60 * 1000, "UTC")
                return runCatching { format.format(Date(millis)) }.getOrDefault("")
            }
        })

        // ── 规则再入 ────────────────────────────────────────────────
        // 上游把脚本里的 `java` 绑成 AnalyzeRule 实例本身（`AnalyzeRule.evalJS`：
        // `bindings["java"] = this`），所以书源 JS 能用同一套规则方言再解析一次内容。
        // 启用库里：java.getElements 170 处、java.getElement 226 处、java.getStringList 72 处、
        // java.setContent 72 处（城堡小说 init、太极小说 init、镇魂小说网 bookList 都是这形状）。
        // 这几个方法原来完全没有：脚本一调用就 TypeError，界面上只剩「搜索失败」四个字。
        val bridgeSource = { scope: Scriptable ->
            execContext?.bridgeContent ?: ScriptableObject.getProperty(scope, "src")?.toString() ?: ""
        }
        val bridgeBase = { scope: Scriptable ->
            execContext?.bridgeBaseUrl ?: ScriptableObject.getProperty(scope, "baseUrl")?.toString()
        }

        // java.setContent(内容[, 地址])：之后的 java.getXxx 都改成解析这份内容
        ScriptableObject.putProperty(api, "setContent", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                execContext?.bridgeContent = jsValueToString(cx, scope, args.getOrNull(0))
                (args.getOrNull(1) as? CharSequence)?.toString()?.takeIf { it.isNotBlank() }
                    ?.let { url -> execContext?.bridgeBaseUrl = url }
                return api
            }
        })

        // java.getElements / java.getStringList：条目文本数组（HTML 给 outerHtml、JSON 给 JSON 文本）
        val listItemsFn = object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                // `newArray` 要在**顶层作用域**上找 Array 原型：BaseFunction 收到的 `scope` 是函数自己的
                // 激活作用域，直接拿去建数组会抛 IllegalArgumentException
                //（表现又是那句「未找到对象默认值」—— 桥方法加了却照样红，最难查的一种）。
                val top = ScriptableObject.getTopLevelScope(scope)
                val rule = args.getOrNull(0)?.toString() ?: return cx.newArray(top, emptyArray<Any>())
                val items = runCatching {
                    runner?.listItemsByRule(bridgeSource(scope), rule, bridgeBase(scope)) ?: emptyList()
                }.getOrDefault(emptyList())
                return cx.newArray(top, items.map { toJsValue(it, top) }.toTypedArray())
            }
        }
        ScriptableObject.putProperty(api, "getElements", listItemsFn)

        // java.getElement：社区脚本把它当 jQuery 用，最常写 .exists / .text() / .html() / .attr()
        ScriptableObject.putProperty(api, "getElement", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val rule = args.getOrNull(0)?.toString() ?: ""
                val first = runCatching {
                    runner?.listItemsByRule(bridgeSource(scope), rule, bridgeBase(scope))?.firstOrNull()
                }.getOrNull()
                val element = first?.let { html ->
                    runCatching { Jsoup.parseBodyFragment(html).body().firstElementChild() }.getOrNull()
                }
                return NativeObject().also { obj ->
                    obj.parentScope = scope
                    ScriptableObject.putProperty(obj, "exists", element != null)
                    ScriptableObject.putProperty(obj, "length", if (element == null) 0 else 1)
                    fun putMethod(name: String, read: (org.jsoup.nodes.Element, String?) -> String) {
                        ScriptableObject.putProperty(obj, name, object : BaseFunction() {
                            override fun call(c: Context, s: Scriptable, t: Scriptable, a: Array<out Any?>): Any {
                                val target = element ?: return ""
                                return read(target, a.getOrNull(0)?.toString())
                            }
                        })
                    }
                    putMethod("text") { el, _ -> el.text() }
                    putMethod("html") { el, _ -> el.outerHtml() }
                    putMethod("attr") { el, name -> el.attr(name ?: "") }
                }
            }
        })

        // java.getString(规则[, 内容[, 是否当地址]])：上游签名 `getString(rule, mContent, isUrl)`，
        // 100 处调用真的传第二个参数（`java.getString("text", r)` 这类）。
        // 不接就等于把脚本明确指定的内容忽略，取到的是别的地方的值 —— 静默错比报错更难查。
        ScriptableObject.putProperty(api, "getString", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val rule = args.firstOrNull()?.toString() ?: return ""
                val text = NodeValue.document(contentOf(cx, scope, args.getOrNull(1), bridgeSource(scope))).value(rule) ?: return ""
                return if (truthy(args.getOrNull(2))) absolute(bridgeBase(scope), text) else text
            }
        })

        // java.getStringList(规则[, 内容[, 是否当地址]])：上游给的是**每个元素的取值**列表
        //（末段是属性名时逐个取属性、去重、按行拼），正好等于我们 value() 结果按行拆开
        // —— 与 getElements（给条目本身）不是一回事：`.dropDown@li@data-p` 要的是 data-p 的列表。
        ScriptableObject.putProperty(api, "getStringList", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val rule = args.getOrNull(0)?.toString() ?: return cx.newArray(topScope(scope), emptyArray<Any>())
                val content = contentOf(cx, scope, args.getOrNull(1), bridgeSource(scope))
                val base = bridgeBase(scope)
                val asUrl = truthy(args.getOrNull(2))
                // 两种形状要分开：
                // - 规则带取值尾段（`option@value`、`#b@a@href`）→ 上游给的是**每个元素的取值**列表；
                // - 纯 JSONPath（`$.data.list[*]`）没有尾段可拆，上游给的是条目本身 → 保持条目文本（JSON），
                //   脚本拿到后自己 `JSON.parse`。走上面那条路会把对象拼成没法解析的 Java toString。
                val bareJsonPath = rule.startsWith("$") || isJsonPrefixedRule(rule)
                val values = if (bareJsonPath) {
                    runCatching { runner?.listItemsByRule(content, rule, base) ?: emptyList() }.getOrDefault(emptyList())
                } else {
                    runCatching { NodeValue.document(content).value(rule) ?: "" }
                        .getOrDefault("")
                        .lines().filter { it.isNotBlank() }
                }
                val out = if (asUrl) values.map { absolute(base, it) } else values
                return cx.newArray(topScope(scope), out.map { toJsValue(it, topScope(scope)) }.toTypedArray())
            }
        })

        // ── 响应对象 ───────────────────────────────────────────────
        // `java.connect(地址[, 头JSON])`、`java.getStrResponse(地址)`、`java.head(地址[, 头对象])`：
        // 上游回的是**响应对象**（`StrResponse` / Jsoup `Connection.Response`），脚本拿到后接着链式取
        // `.body()`、`.url()`、`.statusCode()`、`.headers("Location")`，还有
        // `String(x.raw().request().url())` —— 重定向落地的真实接口地址。
        // 启用库份数：connect 53、head 13、getStrResponse 9。实测样本 奇书网络（导入）
        // 就停在 `java.connect(url).raw().request().url()` 这一句上（rule.js#7）。
        // 这里给的是**字段名一致的 JS 替身**：不把任何 Java / OkHttp 对象递进沙箱
        //（`setClassShutter { false }` 那道防线不为几个源开口子）。
        // 响应对象统一用 responseView（字符串形状的实例 + 挂上去的响应成员），见该函数的注释。

        // java.connect(地址[, 头JSON[, 超时]])：上游默认 GET；失败时上游把异常收成
        // `StrResponse(url, stackTrace)`，所以这里也**不抛**给脚本 —— 脚本自己判 `.body()` 空不空。
        val connectFn = object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val url = args.getOrNull(0)?.toString() ?: return ""
                val headers = args.getOrNull(1)?.let { parseJsMapOrJson(it) } ?: emptyMap()
                val fetched = runCatching {
                    runner?.fetchResponse(url = url, headers = headers, sourceId = execContext?.sourceId)
                }.getOrElse {
                    return responseView(cx, scope, RuleRunner.Fetched(url.substringBefore(','), it.stackTraceToString(), 0, emptyMap()))
                }
                return responseView(cx, scope, fetched ?: RuleRunner.Fetched(url, "", 0, emptyMap()))
            }
        }
        ScriptableObject.putProperty(api, "connect", connectFn)
        ScriptableObject.putProperty(api, "getStrResponse", connectFn)
        ScriptableObject.putProperty(api, "getStrResponseAwait", connectFn)

        // java.head(地址[, 头对象[, 超时]])：只要头与落地地址（拿文件大小、验重定向链），
        // 所以正文一律给空串 —— 别让它看起来像"读到了空页面"。
        ScriptableObject.putProperty(api, "head", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val url = args.getOrNull(0)?.toString() ?: return ""
                val headers = args.getOrNull(1)?.let { parseJsMapOrJson(it) } ?: emptyMap()
                val fetched = runCatching {
                    runner?.fetchResponse(url = url, method = "HEAD", headers = headers, sourceId = execContext?.sourceId)?.copy(body = "")
                }.getOrNull() ?: RuleRunner.Fetched(url, "", 0, emptyMap())
                return responseView(cx, scope, fetched)
            }
        })

        // ── 加密族（上游 help/crypto 那一套，参数顺序照 JsEncodeUtils）─────────────
        // 启用库份数：base64DecodeToByteArray 115、createSymmetricCrypto 44、HMacHex 21、
        // digestHex 12、strToBytes 7、hexDecodeToByteArray 4、HMacBase64 3、bytesToStr 2。
        // 缺它们时脚本半路抛错，连带 jsLib 里后面赋值的 `sign`/`flag` 全部变成 ReferenceError，
        // 看着像"源写了未定义变量"（实测 5 份源就是这个假象）。
        fun simpleCrypto(name: String, block: (Array<out Any?>) -> Any?) = object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val result = runCatching { block(args) }
                if (result.isFailure) {
                    val detail = result.exceptionOrNull()?.let { it.message ?: it.javaClass.simpleName }
                    execContext?.lastError = "java.$name 失败：${detail ?: "未知原因"}"
                    lastError = "java.$name 失败：${detail ?: "未知原因"}"
                    return ""
                }
                return result.getOrNull() ?: ""
            }
        }
        ScriptableObject.putProperty(api, "digestHex", simpleCrypto("digestHex") { args ->
            ScriptCrypto.digestHex(args.getOrNull(0)?.toString() ?: "", args.getOrNull(1)?.toString() ?: "MD5")
        })
        ScriptableObject.putProperty(api, "digestBase64Str", simpleCrypto("digestBase64Str") { args ->
            ScriptCrypto.digestBase64(args.getOrNull(0)?.toString() ?: "", args.getOrNull(1)?.toString() ?: "MD5")
        })
        ScriptableObject.putProperty(api, "HMacHex", simpleCrypto("HMacHex") { args ->
            ScriptCrypto.hmacHex(
                args.getOrNull(0)?.toString() ?: "",
                args.getOrNull(1)?.toString() ?: "HmacMD5",
                args.getOrNull(2)?.toString() ?: "",
            )
        })
        ScriptableObject.putProperty(api, "HMacBase64", simpleCrypto("HMacBase64") { args ->
            ScriptCrypto.hmacBase64(
                args.getOrNull(0)?.toString() ?: "",
                args.getOrNull(1)?.toString() ?: "HmacMD5",
                args.getOrNull(2)?.toString() ?: "",
            )
        })
        // 字节族：脚本会 `.slice(0,16)` 取 iv、按下标比对，所以给的是**真 JS 数组**，不是 Java 数组
        fun bytesResult(name: String, read: (Array<out Any?>) -> ByteArray) = object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val bytes = runCatching { read(args) }
                    .getOrElse {
                        val detail = it.message ?: it.javaClass.simpleName
                        execContext?.lastError = "java.$name 失败：$detail"
                        lastError = "java.$name 失败：$detail"
                        return cx.newArray(topScope(scope), emptyArray<Any>())
                    }
                return cx.newArray(topScope(scope), ScriptCrypto.unsigned(bytes).map { it as Any }.toTypedArray())
            }
        }
        ScriptableObject.putProperty(api, "base64DecodeToByteArray", bytesResult("base64DecodeToByteArray") { args ->
            ScriptCrypto.base64ToBytes(args.getOrNull(0)?.toString() ?: "")
        })
        ScriptableObject.putProperty(api, "hexDecodeToByteArray", bytesResult("hexDecodeToByteArray") { args ->
            ScriptCrypto.hexToBytes(args.getOrNull(0)?.toString() ?: "")
        })
        ScriptableObject.putProperty(api, "strToBytes", bytesResult("strToBytes") { args ->
            val text = args.getOrNull(0)?.toString() ?: ""
            val charset = args.getOrNull(1)?.toString()?.takeIf { it.isNotBlank() }
            text.toByteArray(charset?.let { runCatching { java.nio.charset.Charset.forName(it) }.getOrNull() } ?: Charsets.UTF_8)
        })
        // java.bytesToStr(字节数组[, 字符集])：把上面那三类数组还原成文本
        ScriptableObject.putProperty(api, "bytesToStr", simpleCrypto("bytesToStr") { args ->
            val charset = args.getOrNull(1)?.toString()?.takeIf { it.isNotBlank() }
            String(
                ScriptCrypto.toBytes(args.getOrNull(0)),
                charset?.let { runCatching { java.nio.charset.Charset.forName(it) }.getOrNull() } ?: Charsets.UTF_8,
            )
        })

        // java.createSymmetricCrypto(变换, 密钥[, iv]) —— 上游 `SymmetricCryptoAndroid` 的等价物。
        // 启用库里有 44 处在用（蓝海、猫眼看书、书山聚合、同人小说…），脚本拿到对象后接着调
        // `.decryptStr(...)` / `.encryptBase64(...)`；配套的 `java.base64DecodeToByteArray` 有 115 处
        //（常见形状是先 base64 解码、`.slice(0,16)` 取 iv，再把剩下的喂给 decrypt）。
        // 语义逐条照上游：变换里没有 `/` 就补成 `ALG/ECB/PKCS5Padding`、DES/DESede 超长密钥截断、
        // `decrypt(String)` 先判十六进制再判 base64、hex 一律小写。
        ScriptableObject.putProperty(api, "createSymmetricCrypto", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val transformation = args.getOrNull(0)?.toString()?.takeIf { it.isNotBlank() }
                    ?: "AES/CBC/PKCS5Padding"
                val crypto = ScriptCrypto.Symmetric(
                    transformation,
                    ScriptCrypto.toBytes(args.getOrNull(1)),
                    args.getOrNull(2)?.let { ScriptCrypto.toBytes(it) }?.takeIf { it.isNotEmpty() },
                )

                // 失败要说得出是哪一步失败的：上游把加密数据当明文用、界面显示"正文为空"，
                // 没人会想到是密钥不对。
                fun describe(error: Throwable): String {
                    val detail = "java.createSymmetricCrypto(…) 失败：${error.message ?: error.javaClass.simpleName}"
                    execContext?.lastError = detail
                    lastError = detail
                    return ""
                }
                fun stringArg(a: Array<out Any?>): String = a.getOrNull(0)?.toString() ?: ""
                // 文本入参按 UTF-8 取字节（上游 `encrypt(data: String)`），数组/列表入参按字节取
                //（脚本会把 `base64DecodeToByteArray` 的结果原样传回来）。
                fun byteArg(a: Array<out Any?>): ByteArray {
                    val raw = a.getOrNull(0) ?: return ByteArray(0)
                    return if (raw is CharSequence) raw.toString().toByteArray(Charsets.UTF_8)
                    else ScriptCrypto.toBytes(raw)
                }
                fun textMethod(read: (String) -> Any?) = object : BaseFunction() {
                    override fun call(c: Context?, s: Scriptable?, t: Scriptable?, a: Array<out Any?>): Any =
                        runCatching { read(stringArg(a)) }.getOrElse { describe(it) } ?: ""
                }
                fun bytesMethod(read: (ByteArray) -> ByteArray) = object : BaseFunction() {
                    // 成功路径给的是非空数组，所以这里不再挂 `?: ""`（挂了也是死分支，编译器会提醒）。
                    override fun call(c: Context?, s: Scriptable?, t: Scriptable?, a: Array<out Any?>): Any =
                        runCatching { ScriptCrypto.unsigned(read(byteArg(a))) }.getOrElse { describe(it) }
                }
                // `decryptStr` / `decrypt` 的入参两种形状都要收：
                // 传字符串走上游的「十六进制优先、否则 base64」判别，传字节数组就直接用。
                fun smartMethod(readString: (String) -> Any?, readBytes: (ByteArray) -> Any?) = object : BaseFunction() {
                    override fun call(c: Context?, s: Scriptable?, t: Scriptable?, a: Array<out Any?>): Any {
                        val raw = a.getOrNull(0)
                        return runCatching {
                            if (raw == null || raw is CharSequence) readString(stringArg(a)) else readBytes(ScriptCrypto.toBytes(raw))
                        }.getOrElse { describe(it) } ?: ""
                    }
                }
                return NativeObject().also { obj ->
                    obj.parentScope = scope
                    ScriptableObject.putProperty(obj, "setIv", object : BaseFunction() {
                        override fun call(c: Context?, s: Scriptable?, t: Scriptable?, a: Array<out Any?>): Any =
                            runCatching { crypto.setIv(byteArg(a)); "ok" }.getOrElse { describe(it) }
                    })
                    ScriptableObject.putProperty(obj, "encrypt", bytesMethod { crypto.encrypt(it) })
                    ScriptableObject.putProperty(obj, "decrypt", smartMethod(
                        readString = { crypto.decrypt(it) },
                        readBytes = { bytes -> crypto.decrypt(bytes) },
                    ))
                    ScriptableObject.putProperty(obj, "decryptStr", smartMethod(
                        readString = { crypto.decryptStr(it) },
                        readBytes = { bytes -> String(crypto.decrypt(bytes), Charsets.UTF_8) },
                    ))
                    ScriptableObject.putProperty(obj, "encryptBase64", textMethod { crypto.encryptBase64(it) })
                    ScriptableObject.putProperty(obj, "encryptHex", textMethod { crypto.encryptHex(it) })
                    ScriptableObject.putProperty(obj, "encryptStr", textMethod { crypto.encryptStr(it) })
                    ScriptableObject.putProperty(obj, "decryptBase64", textMethod {
                        ScriptCrypto.unsigned(crypto.decryptBase64(it))
                    })
                    ScriptableObject.putProperty(obj, "decryptHex", textMethod {
                        ScriptCrypto.unsigned(crypto.decryptHex(it))
                    })
                }
            }
        })


        // ── 上游标了 @Deprecated、但社区源还在调的具名便捷函数 ──────────
        // 实测启用库里真在用的只有 `java.desEncodeToBase64String`（8 处，全在阅友小说那两家
        // goway.reader.yueyouxs.com —— 整条搜索地址的签名与参数就是这一行算出来的）。
        // 参数顺序照上游原样收（数据、密钥、变换、iv），实现复用 ScriptCrypto.Symmetric；
        // 3DES 那一对上游签名多两段（模式、补码），变换拼成 DESede/模式/补码。
        fun symmetricOf(transformation: String, key: String, iv: String): ScriptCrypto.Symmetric =
            ScriptCrypto.Symmetric(
                transformation,
                key.toByteArray(Charsets.UTF_8),
                iv.toByteArray(Charsets.UTF_8).takeIf { it.isNotEmpty() },
            )
        fun desLike(name: String, read: (String, String, String, String) -> Any?) = object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val result = runCatching {
                    read(
                        args.getOrNull(0)?.toString() ?: "",
                        args.getOrNull(1)?.toString() ?: "",
                        args.getOrNull(2)?.toString()?.takeIf { it.isNotBlank() } ?: "DES/CBC/PKCS5Padding",
                        args.getOrNull(3)?.toString() ?: "",
                    )
                }
                if (result.isFailure) {
                    val message = "java.$name 失败：${result.exceptionOrNull()?.let { it.message ?: it.javaClass.simpleName }}"
                    execContext?.lastError = message
                    lastError = message
                    return ""
                }
                return result.getOrNull() ?: ""
            }
        }
        ScriptableObject.putProperty(api, "desEncodeToBase64String", desLike("desEncodeToBase64String") { d, k, t, iv ->
            symmetricOf(t, k, iv).encryptBase64(d)
        })
        ScriptableObject.putProperty(api, "desEncodeToString", desLike("desEncodeToString") { d, k, t, iv ->
            symmetricOf(t, k, iv).encryptStr(d)
        })
        // 上游 `desDecodeToString` 与 `desBase64DecodeToString` 是同一句 `decryptStr(data)`
        //（decrypt(String) 自己会先判十六进制再判 base64），这里保持一样，不自己"纠正"成两套。
        ScriptableObject.putProperty(api, "desDecodeToString", desLike("desDecodeToString") { d, k, t, iv ->
            symmetricOf(t, k, iv).decryptStr(d)
        })
        ScriptableObject.putProperty(api, "desBase64DecodeToString", desLike("desBase64DecodeToString") { d, k, t, iv ->
            symmetricOf(t, k, iv).decryptStr(d)
        })
        // 3DES 那一对（tripleDESEncodeBase64Str / tripleDESDecodeStr）没做：启用库里 0 处在用，
        // 且上游签名是**五参**（数据、密钥、模式、补码、iv）；照上面四参的形状顺手写会留下
        // "签名看着对、其实错了"的坑，等真有源要用再按五参补。

        // java.put(key, val)：读取由上面那个 java.get 分发器负责（KV 分支）。
        ScriptableObject.putProperty(api, "put", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val key = args.getOrNull(0)?.toString() ?: return Context.getUndefinedValue()
                val value = args.getOrNull(1) ?: return Context.getUndefinedValue()
                sessionStore[sessionKey(execContext?.sourceId, key)] = value
                return value
            }
        })
    }

    /**
     * 拼 `url,{options}` 形态的请求描述。
     * 不能写成 `Json.encodeToString(mapOf("method" to ..., "headers" to ...))`：kotlinx 在运行期
     * 找不到 `Any` 的序列化器会直接抛异常，`java.get(url)` / `java.post(url, body)` 于是静默失败。
     */
    private fun urlOptionsJson(method: String, headers: Map<String, String>, body: String?): String {
        val fields = mutableMapOf<String, kotlinx.serialization.json.JsonElement>()
        fields["method"] = JsonPrimitive(method)
        if (headers.isNotEmpty()) fields["headers"] = JsonObject(headers.mapValues { JsonPrimitive(it.value) })
        if (body != null) fields["body"] = JsonPrimitive(body)
        return JsonObject(fields).toString()
    }

    private fun parseJsMapOrJson(value: Any?): Map<String, String> {
        if (value == null) return emptyMap()
        if (value is NativeObject) {
            val result = mutableMapOf<String, String>()
            value.ids.forEach { id ->
                val k = id.toString()
                val v = ScriptableObject.getProperty(value, k)
                if (v != null && v != Context.getUndefinedValue()) {
                    result[k] = v.toString()
                }
            }
            return result
        }
        if (value is Map<*, *>) {
            return value.entries.filter { it.key != null && it.value != null }
                .associate { it.key.toString() to it.value.toString() }
        }
        val str = value.toString().trim()
        if (str.startsWith("{")) {
            return runCatching { Json.decodeFromString<Map<String, String>>(str) }.getOrDefault(emptyMap())
        }
        return emptyMap()
    }

    private fun parseCookieString(cookieStr: String): Map<String, String> {
        val result = linkedMapOf<String, String>()
        cookieStr.split(';').forEach { part ->
            val trimmed = part.trim()
            val eq = trimmed.indexOf('=')
            if (eq > 0) {
                val key = trimmed.substring(0, eq).trim()
                val value = trimmed.substring(eq + 1).trim()
                result[key] = value
            }
        }
        return result
    }

    private fun toJsValue(value: Any?, scope: Scriptable): Any? = when (value) {
        null -> null
        is Map<*, *> -> NativeObject().also { obj ->
            obj.parentScope = scope
            value.forEach { (k, v) -> if (k is String) ScriptableObject.putProperty(obj, k, toJsValue(v, scope)) }
        }
        is List<*> -> Context.getCurrentContext().newArray(scope, value.map { toJsValue(it, scope) }.toTypedArray())
        else -> Context.javaToJS(value, scope)
    }
}

