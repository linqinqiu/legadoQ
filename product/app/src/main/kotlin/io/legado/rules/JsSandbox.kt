package io.legado.rules

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.mozilla.javascript.BaseFunction
import org.mozilla.javascript.ClassShutter
import org.mozilla.javascript.Context
import org.mozilla.javascript.NativeJSON
import org.mozilla.javascript.NativeObject
import org.mozilla.javascript.Scriptable
import org.mozilla.javascript.ScriptableObject
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Base64
import java.util.Date
import java.util.Locale
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
     * 正文 JS 里给 `yp_url` 赋值 = "这一章的内容是一个媒体地址"（音频/EPUB 直链）。
     * 音频源（如懒人听书）大量这么写；不认的话正文规则返回空、整章取不到。
     */
    var mediaUrl: String? = null,
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
        val cleanScript = if (library == null) rawScript else "$library\n$rawScript"

        val executableScript = if (Regex("""\breturn\b""").containsMatchIn(cleanScript)) {
            "(function(){\n$cleanScript\n})()"
        } else {
            cleanScript
        }

        val cx = BoundedJs.enter()
        try {
            cx.optimizationLevel = -1
            cx.setClassShutter(ClassShutter { false }) // Sandbox: block all Java reflection
            val scope = cx.initSafeStandardObjects()

            // 书源规则里 `JSON.parse(result)` 和 `result.属性` 两种写法都有：沙箱把 JSON 条目作为**对象**注入
            // result（否则属性访问取不到值），于是前者会把对象转成 "[object Object]" 再解析失败，
            // 规则里的 try/catch 把它吞掉后整条记录消失，表现为「搜索完成：0 项」。让 JSON.parse 接受已解析对象即可两全。
            runCatching {
                cx.evaluateString(
                    scope,
                    "if (typeof JSON !== 'undefined' && typeof JSON.parse === 'function') {" +
                        "var __legadoOrigParse = JSON.parse;" +
                        "JSON.parse = function(value) {" +
                        "if (value !== null && typeof value === 'object') return value;" +
                        "return __legadoOrigParse.call(JSON, value);};}",
                    "sandbox-compat", 1, null,
                )
            }

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

    private fun jsValueToString(context: Context, scope: Scriptable, value: Any?): String? = when (value) {        null, Context.getUndefinedValue() -> null
        is CharSequence -> value.toString()
        is Number, is Boolean -> value.toString()
        else -> runCatching {
            NativeJSON.stringify(context, scope, value, null, null).toString()
        }.getOrNull() ?: value.toString()
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
                return runner?.fetch(url, execContext?.sourceId, execContext?.database) ?: ""
            }
        })

        // java.post(url, body, headers)
        ScriptableObject.putProperty(api, "post", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val url = args.getOrNull(0)?.toString() ?: return ""
                val body = args.getOrNull(1)?.toString() ?: ""
                val headers = args.getOrNull(2)?.let { parseJsMapOrJson(it) } ?: emptyMap()
                val fullUrl = "$url,${urlOptionsJson("POST", headers, body)}"
                return runner?.fetch(fullUrl, execContext?.sourceId, execContext?.database) ?: ""
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
                    return runner?.fetch("$first,${urlOptionsJson("GET", headers, null)}", execContext?.sourceId, execContext?.database) ?: ""
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
                val resObj = NativeObject()
                resObj.parentScope = scope
                ScriptableObject.putProperty(resObj, "url", url)
                val body = if (execContext?.browserCompleted == true && url.startsWith("http")) {
                    runCatching { runner?.fetch(url, execContext?.sourceId, execContext?.database) }.getOrNull()
                } else {
                    execContext?.openUrl = url
                    null
                } ?: ""
                ScriptableObject.putProperty(resObj, "body", body)
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

        // java.getString(rule)
        ScriptableObject.putProperty(api, "getString", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any {
                val rule = args.firstOrNull()?.toString() ?: return ""
                val src = ScriptableObject.getProperty(scope, "src")?.toString() ?: ""
                return NodeValue.document(src).value(rule) ?: ""
            }
        })

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

