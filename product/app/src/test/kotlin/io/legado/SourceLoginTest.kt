package io.legado

import io.ktor.client.call.*
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.client.plugins.cookies.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import java.net.URI
import java.nio.file.Files
import io.legado.data.Database
import io.legado.data.clearSourceLoginState
import io.legado.data.deleteSource
import io.legado.data.getCookieForUrl
import io.legado.data.getSource
import io.legado.data.getSourceKv
import io.legado.data.getSourceLoginState
import io.legado.data.getSourceVariable
import io.legado.data.listCookieBuckets
import io.legado.data.parseCookieString
import io.legado.data.removeCookieBucket
import io.legado.data.removeSourceLoginHeader
import io.legado.data.saveSource
import io.legado.data.saveSourceKv
import io.legado.data.saveSourceLoginHeader
import io.legado.data.saveSourceLoginInfo
import io.legado.data.saveSourceVariable
import io.legado.data.setCookieForUrl
import io.legado.model.ImportRequest
import io.legado.model.SourceLoginActionRequest
import io.legado.model.SourceLoginActionResult
import io.legado.model.SourceLoginCookieUpdateRequest
import io.legado.model.SourceLoginInfoUpdateRequest
import io.legado.model.SourceLoginUiResponse
import io.legado.model.SourceSummary
import io.legado.rules.RuleRunner
import io.legado.source.SourceCodec
import io.legado.source.WebViewProxy

class SourceLoginTest {

    @Test
    fun `SourceCodec correctly identifies hasLogin`() {
        val noLoginJson = """{"bookSourceUrl":"https://example.com","bookSourceName":"无登录源"}"""
        val parsedNoLogin = SourceCodec.parse(noLoginJson)
        assertFalse(parsedNoLogin.hasLogin)

        val uiLoginJson = """{"bookSourceUrl":"https://example.com","bookSourceName":"UI登录源","loginUi":"[{\"name\":\"用户名\",\"type\":\"text\"}]"}"""
        val parsedUi = SourceCodec.parse(uiLoginJson)
        assertTrue(parsedUi.hasLogin)

        val urlLoginJson = """{"bookSourceUrl":"https://example.com","bookSourceName":"URL登录源","loginUrl":"https://example.com/login"}"""
        val parsedUrl = SourceCodec.parse(urlLoginJson)
        assertTrue(parsedUrl.hasLogin)

        val checkLoginJson = """{"bookSourceUrl":"https://example.com","bookSourceName":"Check登录源","loginCheckJs":"cookie.getCookie(baseUrl) != ''"}"""
        val parsedCheck = SourceCodec.parse(checkLoginJson)
        assertTrue(parsedCheck.hasLogin)
    }

    @Test
    fun `Database source_login_state CRUD works as expected`() {
        val dbPath = Files.createTempFile("legado-login-test", ".sqlite").toString()
        val db = Database(dbPath)
        db.initialize()

        val sourceId = "https://test-source.com"

        // 1. Initial state is null
        assertNull(db.getSourceLoginState(sourceId))

        // 2. Save loginInfo
        val info = mapOf("username" to "alice", "password" to "secret123")
        assertTrue(db.saveSourceLoginInfo(sourceId, info))
        val state1 = db.getSourceLoginState(sourceId)
        assertNotNull(state1)
        assertEquals("alice", state1!!.loginInfo["username"])
        assertEquals("secret123", state1.loginInfo["password"])

        // 3. Save loginHeader
        val header = """{"Authorization":"Bearer test-token-123"}"""
        assertTrue(db.saveSourceLoginHeader(sourceId, header))
        assertEquals(header, db.getSourceLoginState(sourceId)?.loginHeader)

        // 4. Save variable
        assertTrue(db.saveSourceVariable(sourceId, "var-val-999"))
        assertEquals("var-val-999", db.getSourceVariable(sourceId))

        // 5. Save KV
        assertTrue(db.saveSourceKv(sourceId, "token", "kv-token-abc"))
        assertEquals("kv-token-abc", db.getSourceKv(sourceId, "token"))

        // 6. Cookie operations
        assertTrue(db.setCookieForUrl("https://test-source.com/api", "session_id=sess123; user_id=uid456"))
        val cookie = db.getCookieForUrl("https://test-source.com/api/user")
        assertNotNull(cookie)
        assertTrue(cookie!!.contains("session_id=sess123"))

        // 7. Remove login header
        assertTrue(db.removeSourceLoginHeader(sourceId))
        assertNull(db.getSourceLoginState(sourceId)?.loginHeader)

        // 8. Clear all state
        assertTrue(db.clearSourceLoginState(sourceId))
        assertNull(db.getSourceLoginState(sourceId))
    }

    @Test
    fun `RuleRunner parses static and dynamic loginUi correctly`() {
        val dbPath = Files.createTempFile("legado-login-ui-test", ".sqlite").toString()
        val db = Database(dbPath)
        db.initialize()
        val runner = RuleRunner(database = db)

        // Static UI
        val staticJson = """
        {
            "bookSourceUrl": "https://source1.com",
            "bookSourceName": "静态源",
            "loginUi": "[{\"name\":\"邮箱\",\"type\":\"text\",\"style\":{\"layout_flexBasisPercent\":0.5}},{\"name\":\"登录\",\"type\":\"button\",\"action\":\"login()\"}]"
        }
        """.trimIndent()
        val staticItems = runner.parseLoginUi(staticJson)
        assertEquals(2, staticItems.size)
        assertEquals("邮箱", staticItems[0].name)
        assertEquals("text", staticItems[0].type)
        assertEquals(0.5f, staticItems[0].style?.layout_flexBasisPercent ?: 0f, 0.001f)
        assertEquals("登录", staticItems[1].name)
        assertEquals("button", staticItems[1].type)

        // Dynamic @js: UI
        val dynamicJson = """
        {
            "bookSourceUrl": "https://source2.com",
            "bookSourceName": "动态源",
            "loginUi": "@js:JSON.stringify([{name:'动态字段1',type:'password'},{name:'点击',type:'button',action:'doClick()'}])"
        }
        """.trimIndent()
        val dynamicItems = runner.parseLoginUi(dynamicJson)
        assertEquals(2, dynamicItems.size)
        assertEquals("动态字段1", dynamicItems[0].name)
        assertEquals("password", dynamicItems[0].type)

        // Fallback when only loginUrl is present
        val fallbackJson = """
        {
            "bookSourceUrl": "https://source3.com",
            "bookSourceName": "网页登录源",
            "loginUrl": "https://source3.com/login.html"
        }
        """.trimIndent()
        val fallbackItems = runner.parseLoginUi(fallbackJson)
        assertEquals(1, fallbackItems.size)
        assertEquals("button", fallbackItems[0].type)
        assertEquals("https://source3.com/login.html", fallbackItems[0].action)
    }

    @Test
    fun `RuleRunner executes login action with Legado JS bridges`() {
        val dbPath = Files.createTempFile("legado-login-act-test", ".sqlite").toString()
        val db = Database(dbPath)
        db.initialize()
        val runner = RuleRunner(database = db)

        val sourceJson = """
        {
            "bookSourceUrl": "https://mock-source.com",
            "bookSourceName": "大灰狼测试源",
            "loginUrl": "function login(isVip) { var info = source.getLoginInfoMap(); if (info['user'] == 'admin') { source.putLoginHeader(JSON.stringify({Token:'tok-999'})); cookie.setCookie(source.bookSourceUrl, 'uid=100; auth=true'); java.toast('登录成功！'); java.upLoginData({'status':'已登录'}); } else { java.toast('密码错误'); } }"
        }
        """.trimIndent()

        // 1. Execute login with valid credentials
        val res = runner.executeLoginAction(
            sourceJson = sourceJson,
            actionCode = "login(true)",
            loginData = mapOf("user" to "admin", "pwd" to "123456"),
        )
        assertTrue(res.success)
        assertTrue(res.toastMessages.contains("登录成功！"))
        assertTrue(res.reRenderUi)
        assertEquals("已登录", res.updatedLoginInfo?.get("status"))

        // Check persistence in database
        val state = db.getSourceLoginState("https://mock-source.com")
        assertNotNull(state)
        assertEquals("""{"Token":"tok-999"}""", state!!.loginHeader)
        val cookie = db.getCookieForUrl("https://mock-source.com")
        assertNotNull(cookie)
        assertTrue(cookie!!.contains("uid=100"))

        // 2. Check login check status
        val checkJson = """
        {
            "bookSourceUrl": "https://mock-source.com",
            "loginCheckJs": "cookie.getKey(source.bookSourceUrl, 'auth') == 'true'"
        }
        """.trimIndent()
        val checkRes = runner.checkLoginStatus(checkJson)
        assertTrue(checkRes.loggedIn)
    }

    @Test
    fun `HTTP Login endpoints integration test`() = testApplication {
        val dbPath = Files.createTempFile("legado-routes-login-test", ".sqlite").toString()
        val tempDir = Files.createTempDirectory("legado-routes-login-covers")
        val config = ServerConfig(
            host = "0.0.0.0", port = 8080, databasePath = dbPath, allowExternalBind = true,
            coverCacheDirectory = tempDir
        )

        application {
            legadoApplication(config)
        }

        val client = createClient {
            install(HttpCookies)
            install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
        }

        // 不设身份：直接调用后面的接口

        // Insert a source with loginUi
        val sourceJson = """
        {
            "bookSourceUrl": "https://api-source.com",
            "bookSourceName": "API测试源",
            "loginUi": "[{\"name\":\"用户名\",\"type\":\"text\"},{\"name\":\"登录\",\"type\":\"button\",\"action\":\"login()\"}]",
            "loginUrl": "function login() { source.putLoginHeader('{\"X-Auth\":\"tok-123\"}'); java.toast('API登录成功'); }"
        }
        """.trimIndent()
        val saveRes = client.post("/api/sources/import") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody(ImportRequest(listOf(sourceJson)))
        }
        assertEquals(HttpStatusCode.OK, saveRes.status)

        val sourcesListRes = client.get("/api/sources")
        assertEquals(HttpStatusCode.OK, sourcesListRes.status)
        val sourcesList = sourcesListRes.body<List<SourceSummary>>()
        val sourceRecord = sourcesList.first { it.url == "https://api-source.com" }
        assertTrue(sourceRecord.hasLogin)

        val encodedId = java.net.URLEncoder.encode(sourceRecord.id, "UTF-8")

        // 1. GET /api/sources/{id}/login-ui
        val uiRes = client.get("/api/sources/$encodedId/login-ui")
        assertEquals(HttpStatusCode.OK, uiRes.status)
        val uiBody = uiRes.body<SourceLoginUiResponse>()
        assertEquals("API测试源", uiBody.sourceName)
        assertTrue(uiBody.hasLogin)
        assertEquals(2, uiBody.loginUi.size)

        // 2. POST /api/sources/{id}/login-info
        val infoRes = client.post("/api/sources/$encodedId/login-info") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody(SourceLoginInfoUpdateRequest(loginInfo = mapOf("username" to "user888")))
        }
        assertEquals(HttpStatusCode.OK, infoRes.status)

        // 3. POST /api/sources/{id}/login-action
        val actionRes = client.post("/api/sources/$encodedId/login-action") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody(SourceLoginActionRequest(action = "login()", loginData = mapOf("username" to "user888")))
        }
        assertEquals(HttpStatusCode.OK, actionRes.status)
        val actionOutcome = actionRes.body<SourceLoginActionResult>()
        assertTrue(actionOutcome.success)
        assertTrue(actionOutcome.toastMessages.contains("API登录成功"))

        // 4. DELETE /api/sources/$encodedId/login-header
        val delHeaderRes = client.delete("/api/sources/$encodedId/login-header") {
        }
        assertEquals(HttpStatusCode.OK, delHeaderRes.status)

        // 5. POST /api/sources/{id}/login-cookie with JSON Array format (Cookie-Editor format)
        val cookieJsonArray = """[{"name":"token","value":"xyz999"},{"name":"session_id","value":"sess888"}]"""
        val cookieRes = client.post("/api/sources/$encodedId/login-cookie") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            setBody(SourceLoginCookieUpdateRequest(cookie = cookieJsonArray, url = sourceRecord.url))
        }
        assertEquals(HttpStatusCode.OK, cookieRes.status)
        val updatedUiRes = client.get("/api/sources/$encodedId/login-ui")
        val updatedUi = updatedUiRes.body<SourceLoginUiResponse>()
        assertNotNull(updatedUi.loginHeader)
        assertTrue(updatedUi.loginHeader!!.contains("token=xyz999"))
        assertTrue(updatedUi.loginHeader!!.contains("session_id=sess888"))

        // 5b. 跨站来源的 Cookie 同步被拒 —— 防止任意网页往用户书源 Cookie 罐注入（原 ACAO:* 漏洞的回归防线）
        val foreignOrigin = client.post("/api/sources/$encodedId/login-cookie") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            header(HttpHeaders.Origin, "https://evil.example")
            setBody(SourceLoginCookieUpdateRequest(cookie = "inject=1", url = sourceRecord.url))
        }
        assertEquals(HttpStatusCode.Forbidden, foreignOrigin.status)

        // 5c. 同站来源放行，并回显该 Origin（不再用 *）
        val sameOrigin = client.post("/api/sources/$encodedId/login-cookie") {
            header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
            header(HttpHeaders.Origin, "https://api-source.com")
            setBody(SourceLoginCookieUpdateRequest(cookie = "siteonly=1", url = sourceRecord.url))
        }
        assertEquals(HttpStatusCode.OK, sameOrigin.status)
        assertTrue(sameOrigin.headers[HttpHeaders.AccessControlAllowOrigin]?.contains("api-source.com") == true)

        // 6. DELETE /api/sources/{id}/login-info
        val delInfoRes = client.delete("/api/sources/$encodedId/login-info") {
        }
        assertEquals(HttpStatusCode.OK, delInfoRes.status)
    }

    @Test
    fun `Database parseCookieString handles all major cookie formats`() {
        val dbPath = Files.createTempFile("legado-cookie-parse-test", ".sqlite").toString()
        val db = Database(dbPath)
        db.initialize()

        // 1. Standard cookie string
        val stdMap = db.parseCookieString("name1=val1; name2=val2=with=eq; name3=val3")
        assertEquals(3, stdMap.size)
        assertEquals("val1", stdMap["name1"])
        assertEquals("val2=with=eq", stdMap["name2"])
        assertEquals("val3", stdMap["name3"])

        // 2. Cookie-Editor JSON array
        val jsonArray = """
        [
            {"name": "token", "value": "secret-abc-123", "domain": ".example-reader.test"},
            {"name": "uid", "value": "10086", "path": "/"}
        ]
        """.trimIndent()
        val jsonArrayMap = db.parseCookieString(jsonArray)
        assertEquals(2, jsonArrayMap.size)
        assertEquals("secret-abc-123", jsonArrayMap["token"])
        assertEquals("10086", jsonArrayMap["uid"])

        // 3. JSON Object format
        val jsonObj = """{"Cookie": "sess=xyz; auth=true"}"""
        val jsonObjMap = db.parseCookieString(jsonObj)
        assertEquals(2, jsonObjMap.size)
        assertEquals("xyz", jsonObjMap["sess"])
        assertEquals("true", jsonObjMap["auth"])

        // 4. Netscape format
        val netscape = """
        # Netscape HTTP Cookie File
        .example.com	TRUE	/	FALSE	1999999999	session_key	netscape_val_1
        .example.com	TRUE	/	FALSE	1999999999	account_id	998877
        """.trimIndent()
        val netscapeMap = db.parseCookieString(netscape)
        assertEquals(2, netscapeMap.size)
        assertEquals("netscape_val_1", netscapeMap["session_key"])
        assertEquals("998877", netscapeMap["account_id"])
    }

    /**
     * 登录留下的凭据必须真的跟着请求出去。下面这组断言盯的是修掉前的真实缺口：
     * Cookie 以前按**书源主页域名**查，而真实抓取打的是另一台主机 —— 同一份凭据永远取不到；
     * 而阅读类站点的接口域名和书页域名经常不是一个，于是内置浏览器登录成功、库里也存了 Cookie，
     * 搜索/详情/正文却仍然按未登录发请求。上游 `AnalyzeUrl.setCookie()` 一直是按**本次要访问的地址**查的。
     */
    @Test
    fun `stored cookie is looked up by the host actually being requested`() {
        val dbPath = Files.createTempFile("legado-cookie-send", ".sqlite").toString()
        val db = Database(dbPath)
        db.initialize()
        val sourceId = "https://www.readsite.com"
        db.setCookieForUrl("https://api.readsite.com/login", "token=abc; uid=42")
        val runner = RuleRunner(database = db)

        val headers = runner.effectiveHeaders(URI("https://api.readsite.com/search?q=x"), null, sourceId, db)
        assertEquals("token=abc; uid=42", headers["Cookie"])
    }

    @Test
    fun `login header and jar cookie merge per key instead of overwriting each other`() {
        val dbPath = Files.createTempFile("legado-cookie-merge", ".sqlite").toString()
        val db = Database(dbPath)
        db.initialize()
        val sourceId = "https://www.readsite.com"
        db.saveSourceLoginHeader(sourceId, """{"Authorization":"Bearer t1","Cookie":"legacy=1; token=old"}""")
        db.setCookieForUrl("https://api.readsite.com/x", "token=abc; uid=42")
        val runner = RuleRunner(database = db)

        val headers = runner.effectiveHeaders(URI("https://api.readsite.com/x"), null, sourceId, db)
        assertEquals("Bearer t1", headers["Authorization"])
        // 同名键后写的库内 Cookie 覆盖登录头，不同名键都要留着
        assertEquals("legacy=1; token=abc; uid=42", headers["Cookie"])
    }

    @Test
    fun `url option cookie outranks stored cookie but keeps the other keys`() {
        val dbPath = Files.createTempFile("legado-cookie-option", ".sqlite").toString()
        val db = Database(dbPath)
        db.initialize()
        val sourceId = "https://www.readsite.com"
        db.setCookieForUrl("https://api.readsite.com/x", "token=abc; uid=42")
        val runner = RuleRunner(database = db)
        val options = RuleRunner.UrlOptions(headers = mapOf("Cookie" to "token=tmp", "Referer" to "https://www.readsite.com"))

        val headers = runner.effectiveHeaders(URI("https://api.readsite.com/x"), options, sourceId, db)
        // 同名键覆盖值、不挪位置：临时 cookie 换掉 token，但 uid 不能被抹掉
        assertEquals("token=tmp; uid=42", headers["Cookie"])
        assertEquals("https://www.readsite.com", headers["Referer"])
    }

    @Test
    fun `request without a source still carries its own headers and nothing invented`() {
        val runner = RuleRunner { "" }
        val headers = runner.effectiveHeaders(
            URI("https://api.readsite.com/x"),
            RuleRunner.UrlOptions(headers = mapOf("User-Agent" to "Legado")),
            null,
            null,
        )
        assertEquals(mapOf("User-Agent" to "Legado"), headers)
    }

    /**
     * 删掉一本书源要带走**它私有**的那部分凭据：登录头与登录表单值在上游也是按书源存的
     * （`loginHeader_${getKey()}` 落在 cache 表），所以它们必须跟着源一起消失。
     *
     * 域 Cookie 则是全局一张表（上游 `Cookie.kt` 里没有书源字段），删源**不动**它 ——
     * 别的书源只要也会访问同一个域，用的就是同一份登录态，跟着删等于替用户做决定。
     * 这条口径在能力波 v17 改过：早先我们"删源顺手清罐"，看着干净，其实和上游不一致，
     * 而且会把同域其他源的登录态一起打掉。现在撤销走全局凭据管理列表，看得见也删得掉。
     */
    @Test
    fun `deleting a source clears its private login state but keeps shared domain cookies`() {
        val dbPath = Files.createTempFile("legado-source-delete", ".sqlite").toString()
        val db = Database(dbPath)
        db.initialize()
        val sourceId = "https://probe.example"
        db.saveSourceLoginHeader(sourceId, """{"Cookie":"session=leak-me"}""")
        db.setCookieForUrl("https://probe.example/login", "session=leak-me")
        db.saveSourceLoginInfo(sourceId, mapOf("username" to "someone"))
        assertTrue(db.getCookieForUrl("https://probe.example/x")!!.contains("session=leak-me"))

        val json = """{"bookSourceUrl":"$sourceId","bookSourceName":"探针源","loginUrl":"$sourceId/login"}"""
        db.saveSource(SourceCodec.parse(json), null)
        assertTrue(db.deleteSource(sourceId))

        assertNull(db.getSource(sourceId))
        assertNull(db.getSourceLoginState(sourceId))
        // 域桶是全局的：删源不牵连它，但它必须出现在全局列表里（否则就成了"看不见又删不掉"）
        assertEquals(listOf("probe.example"), db.listCookieBuckets().map { it.domain })
        assertTrue(db.removeCookieBucket("https://probe.example/x"))
        assertNull(db.getCookieForUrl("https://probe.example/x"))
    }

    /**
     * 番茄官方接口直连源的真实形状：书源主域是代理站，需要登录的「番茄书架」分栏打在
     * fanqienovel.com 上，搜索又走 api-lf.fanqiesdk.com。凭据必须能按请求域名取到，
     * 否则用户登录完、Cookie 也存了，书架那条请求仍然是匿名。
     */
    @Test
    fun `cookie captured for the login domain is sent to that domain even though the source lives elsewhere`() {
        val dbPath = Files.createTempFile("legado-fanqie-shape", ".sqlite").toString()
        val db = Database(dbPath)
        db.initialize()
        val source = """{
            "bookSourceUrl":"https://fq-book.netsite.cc",
            "bookSourceName":"番茄小说 v3.4.2",
            "loginUrl":"https://fanqienovel.com/",
            "searchUrl":"https://api-lf.fanqiesdk.com/api/novel/channel/homepage/search/search/v1/?aid=1967&q={{key}}"
        }"""
        val sourceId = "https://fq-book.netsite.cc"
        db.setCookieForUrl("https://fanqienovel.com/reading/bookapi/bookshelf/info", "sessionid=s-1; uid=42")
        val runner = RuleRunner(database = db)

        val bookshelf = runner.effectiveHeaders(
            URI("https://fanqienovel.com/reading/bookapi/bookshelf/info/v2/?aid=1967"),
            null,
            sourceId,
            db,
        )
        assertEquals("sessionid=s-1; uid=42", bookshelf["Cookie"])

        // 同一个源、另一个域名的请求不该拿到这份 Cookie（上游也是按注册域隔离的）
        val search = runner.effectiveHeaders(
            URI("https://api-lf.fanqiesdk.com/api/novel/channel/homepage/search/search/v1/"),
            null,
            sourceId,
            db,
        )
        assertNull(search["Cookie"])

        // 粘贴 Cookie 的候选主机要把「该登录的那个」排在最前，否则用户默认存到代理域。
        // 列的是完整主机（与 Cookie 罐的键、与浏览器 devtools 看到的一致）；库里存注册域
        // netsite.cc 依然能命中 fq-book 子域 —— 读取时逐级回退，比上游只认注册域更宽松可用。
        val domains = WebViewProxy.credentialDomains(source)
        assertEquals("fanqienovel.com", domains.first())
        assertTrue(domains.joinToString(","), domains.contains("fq-book.netsite.cc"))
        assertTrue(domains.joinToString(","), domains.contains("api-lf.fanqiesdk.com"))
        // 同一个主机在书源里出现多次（大小写不同也算）不能列两遍
        assertEquals(domains.size, domains.toSet().size)
        db.setCookieForUrl("https://netsite.cc/", "proxy=p-1")
        assertEquals(
            "proxy=p-1",
            runner.effectiveHeaders(URI("https://fq-book.netsite.cc/api/books/details"), null, sourceId, db)["Cookie"],
        )
    }

    @Test
    fun `loginUrl that is a script decides the browser address itself`() {
        val dbPath = Files.createTempFile("legado-login-script", ".sqlite").toString()
        val db = Database(dbPath)
        db.initialize()
        val runner = RuleRunner(database = db)
        val scriptSource = """{
            "bookSourceUrl":"https://agg.example",
            "bookSourceName":"聚合源",
            "loginUrl":"function login(openBrowser, checkMode) { if (!checkMode) { java.startBrowserAwait('https://agg.example/qr?tk=7', '扫码登录'); } }"
        }"""
        assertTrue(runner.loginIsScript(scriptSource))
        assertEquals("https://agg.example/qr?tk=7", runner.loginBrowserStartUrl(scriptSource))

        // `@js:` 包起来的形态（上游 extractInlineJs 认这种）也要能取到地址
        val wrapped = """{"bookSourceUrl":"https://agg2.example","loginUrl":"@js:\nfunction login(){ java.startBrowserAwait('https://agg2.example/login'); }"}"""
        assertTrue(runner.loginIsScript(wrapped))
        assertEquals("https://agg2.example/login", runner.loginBrowserStartUrl(wrapped))

        // 纯网址的 loginUrl 不是脚本，界面要照直打开它
        val plain = """{"bookSourceUrl":"https://plain.example","loginUrl":"https://plain.example/login"}"""
        assertFalse(runner.loginIsScript(plain))
        assertNull(runner.loginBrowserStartUrl(plain))
    }

    @Test
    fun `login action keeps explicit arguments and java bridge can read cookies`() {
        val dbPath = Files.createTempFile("legado-login-args", ".sqlite").toString()
        val db = Database(dbPath)
        db.initialize()
        val sourceId = "https://args.example"
        db.setCookieForUrl("https://args.example/login", "token=t-1; uid=9")
        val source = """{
            "bookSourceUrl":"$sourceId",
            "bookSourceName":"实参探针",
            "loginUrl":"function login(openBrowser, checkMode) { java.toast('ob=' + (openBrowser === true) + ';cm=' + (checkMode === false)); java.toast('ck=' + java.getCookie('https://args.example/x')); }"
        }"""
        val runner = RuleRunner(database = db)
        val outcome = runner.executeLoginAction(source, "login(true, false)", emptyMap())
        assertTrue(outcome.error ?: "脚本失败", outcome.success)
        // 上游按钮 action 是原样执行的 JS，`login(true,false)` 的实参不能被我们的包装吞掉
        // （脚本里打印的就是「openBrowser 是否为 true」「checkMode 是否为 false」，所以两个都该是 true）
        assertTrue(outcome.toastMessages.joinToString("|"), outcome.toastMessages.contains("ob=true;cm=true"))
        // java.getCookie 是上游 JsExtensions 的成员，实测 15 个源在用
        assertTrue(outcome.toastMessages.joinToString("|"), outcome.toastMessages.contains("ck=token=t-1; uid=9"))
    }

    /**
     * 凭据改成全局按域共享（能力波 v17）之后，请求路径带上同域 Cookie 是我们要的效果；
     * 但脚本侧的 `java.getCookie(url)` / `cookie.getCookie(url)` 因此变成"能读任意域的登录态"，
     * 一个恶意书源可以借此把用户所有站的凭据捞走。上游是单机 App、书源都是用户自己导的，
     * 没防这一手；我们加了一道**软闸**：脚本只能读这本书源配置里出现过的域（外加它自己的主域）。
     *
     * 说清楚它的限度：判定是拿整份 JSON 做文本扫描的，所以源只要在规则串里写出那个域名就能越过去。
     * 真正的底线仍然是「只导入信任来源」（见 docs §8）。这条测试因此用**运行时拼出来**的地址 ——
     * 这才是"没在配置里出现过的域"的可判定形状。
     */
    @Test
    fun `sandbox cookie bridges cannot read a domain absent from the source config`() {
        val dbPath = Files.createTempFile("legado-cookie-gate", ".sqlite").toString()
        val db = Database(dbPath)
        db.initialize()
        // 别人的登录态：一个和本探针源毫无关系的注册域
        db.setCookieForUrl("https://victim.example/", "session=steal-me")
        val sourceId = "https://gate.example"
        db.setCookieForUrl("https://gate.example/login", "mine=own-value")
        val source = """{
            "bookSourceUrl":"$sourceId",
            "bookSourceName":"越域读探针",
            "loginUrl":"function login() { var elsewhere = 'https://' + 'vic' + 'tim.example/'; java.toast('own=' + java.getCookie('https://gate.example/x')); java.toast('victim=' + java.getCookie(elsewhere)); java.toast('jar=' + cookie.getCookie(elsewhere)); }"
        }"""
        db.saveSource(SourceCodec.parse(source), null)
        val runner = RuleRunner(database = db)
        val outcome = runner.executeLoginAction(source, "login()", emptyMap())
        assertTrue(outcome.error ?: "脚本失败", outcome.success)
        val toasts = outcome.toastMessages.joinToString("|")
        // 自己的域照旧读得到（15 个真实源靠这个）
        assertTrue(toasts, toasts.contains("own=mine=own-value"))
        // 配置里没出现过的域：两个入口都必须回空串
        assertTrue(toasts, toasts.contains("victim="))
        assertTrue(toasts, toasts.contains("jar="))
        assertFalse(toasts, toasts.contains("steal-me"))
    }

    /**
     * 上游 `startBrowserAwait` 返回 `StrResponse{url, body}`，登录脚本靠 `r.body` 里的页面继续往下走
     * （取 token、拼下一步请求）。我们没法像 Android WebView 那样阻塞等用户，所以约定：
     * 第一次调用只交出要打开的地址；用户在内置浏览器里关掉之后，界面带 `browserCompleted` 重跑，
     * 这一次由服务端**带着已落库的 Cookie 自己抓那一页**，把 HTML 放进 body。
     */
    @Test
    fun `startBrowserAwait hands back the page body once the browser round is over`() {
        val dbPath = Files.createTempFile("legado-browser-await", ".sqlite").toString()
        val db = Database(dbPath)
        db.initialize()
        val sourceId = "https://await.example"
        val source = """{
            "bookSourceUrl":"$sourceId",
            "bookSourceName":"回体探针",
            "loginUrl":"function login() { var r = java.startBrowserAwait('https://await.example/qr?tk=1', '扫码'); java.toast('len=' + (r.body || '').length); if (r.body) { source.putLoginHeader(JSON.stringify({ Cookie: 'tk=' + r.body })); } }"
        }"""
        var fetched = 0
        val runner = RuleRunner({ url ->
            if (url.contains("/qr")) { fetched++; "<html>token-abc</html>" } else ""
        }, db)

        val first = runner.executeLoginAction(source, "login(true, false)", emptyMap())
        assertTrue(first.error ?: "第一次执行应当成功", first.success)
        assertEquals("https://await.example/qr?tk=1", first.openUrl)
        assertTrue(first.toastMessages.joinToString("|"), first.toastMessages.contains("len=0"))
        assertEquals("浏览器没关之前不该去抓页面", 0, fetched)

        val second = runner.executeLoginAction(source, "login(true, false)", emptyMap(), browserCompleted = true)
        assertTrue(second.error ?: "第二次执行应当成功", second.success)
        assertNull("这一轮不再要求打开浏览器", second.openUrl)
        assertTrue(second.toastMessages.joinToString("|"), second.toastMessages.contains("len=22"))
        assertEquals(1, fetched)
        assertEquals("""{"Cookie":"tk=<html>token-abc</html>"}""", db.getSourceLoginState(sourceId)?.loginHeader)
    }

    @Test
    fun `bare login header text is treated as a cookie while json stays a header map`() {
        val runner = RuleRunner { "" }
        assertEquals(mapOf("Cookie" to "a=1; b=2"), runner.parseHeaderJson("a=1; b=2"))
        assertEquals(
            mapOf("Authorization" to "Bearer x", "Cookie" to "a=1"),
            runner.parseHeaderJson("""{"Authorization":"Bearer x","Cookie":"a=1"}"""),
        )
        assertTrue(runner.parseHeaderJson(null).isEmpty())
        assertTrue(runner.parseHeaderJson("   ").isEmpty())
    }
}
