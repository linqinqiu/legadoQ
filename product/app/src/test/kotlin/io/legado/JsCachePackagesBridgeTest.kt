package io.legado

import io.legado.rules.JsExecutionContext
import io.legado.rules.JsSandbox
import io.legado.rules.RuleRunner
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * 0.2.9 补的几块 JS 桥：全局 `cache`、Map 语义、`Packages`/`JavaImporter` 白名单、`java.ajaxAll`
 * 与小工具（getUserAgent/htmlFormat/toURL/importScript/cacheFile）。
 *
 * 每条都对着真实书源的写法，而不是"能调通就行"：
 * - 番茄系/书山/蓝批用 `cache` 存 token 与批量结果，取出来要 `JSON.parse` 得动；
 * - 洋柿子/轻说/城堡对登录信息写 `.get('token')`、`.containsKey(...)`（上游回真 HashMap）；
 * - 120 处 `JavaImporter` + 116 处 `importPackage`，形状是 `with (imp) { Cipher.getInstance(...) }`；
 * - 蓝批用 `java.getUserAgent() === java.getWebViewUA()` 判断宿主；
 * - 蓝海搜书用 `java.toURL(baseUrl).host` 按域名分支；
 * - 哔哩轻小说用 `java.cacheFile` / `java.importScript` 取远端加密脚本。
 */
class JsCachePackagesBridgeTest {

    private val sandbox = JsSandbox()

    private fun context(
        id: String,
        jsLib: String? = null,
        login: Map<String, String> = emptyMap(),
    ) = JsExecutionContext(
        sourceId = id,
        jsLib = jsLib,
        initialLoginInfo = LinkedHashMap(login),
    )

    private fun evalOrFail(sandbox: JsSandbox, script: String, ctx: JsExecutionContext): String {
        val out = sandbox.eval(script, emptyMap(), ctx)
        assertTrue("脚本执行失败：${ctx.lastError}\n脚本：$script", ctx.lastError == null)
        return out ?: ""
    }

    // ── 全局 cache ─────────────────────────────────────────────

    @Test
    fun `cache put 与 get 字符串闭环`() {
        val ctx = context("https://cache.example/basic")
        assertEquals("v1", evalOrFail(sandbox, """cache.put("k","v1",60); cache.get("k")""", ctx))
    }

    @Test
    fun `cache put 的对象能被 JSON parse 还原`() {
        val ctx = context("https://cache.example/object")
        val out = evalOrFail(
            sandbox,
            """cache.put("o",{a:1,b:[2,3]},0); JSON.stringify(JSON.parse(cache.get("o")))""",
            ctx,
        )
        assertEquals("""{"a":1,"b":[2,3]}""", out)
    }

    @Test
    fun `putMemory 保留对象形状，缺失键回 null`() {
        val ctx = context("https://cache.example/memory")
        val out = evalOrFail(
            sandbox,
            """cache.putMemory("t",{v:"x"}); var m=cache.getFromMemory("t");
               m.v+"|"+String(cache.getFromMemory("none"))""",
            ctx,
        )
        assertEquals("x|null", out)
    }

    @Test
    fun `putFile 与 put 分键，delete 两个都清`() {
        val ctx = context("https://cache.example/file")
        assertEquals(
            "plain|file",
            evalOrFail(sandbox, """cache.put("f","plain",0); cache.putFile("f","file",0); cache.get("f")+"|"+cache.getFile("f")""", ctx),
        )
        assertEquals(
            "null|null",
            evalOrFail(sandbox, """cache.delete("f"); String(cache.get("f"))+"|"+String(cache.getFile("f"))""", ctx),
        )
    }

    @Test
    fun `getInt 能把缓存文本转成数字`() {
        val ctx = context("https://cache.example/int")
        assertEquals("42", evalOrFail(sandbox, """cache.put("n","42",0); String(cache.getInt("n"))""", ctx))
    }

    @Test
    fun `cache 的键按书源隔离`() {
        val a = context("https://cache.example/source-a")
        val b = context("https://cache.example/source-b")
        evalOrFail(sandbox, """cache.put("iso","A",60); "ok"""", a)
        assertEquals("null", evalOrFail(sandbox, """String(cache.get("iso"))""", b))
    }

    @Test
    fun `jsLib 里的函数也能用 cache`() {
        val ctx = context(
            "https://cache.example/lib",
            jsLib = """function keep(k,v){ cache.put(k,v,60); return cache.get(k); }""",
        )
        assertEquals("stored", evalOrFail(sandbox, """keep("lib-key","stored")""", ctx))
    }

    // ── Packages / JavaImporter ─────────────────────────────────

    @Test
    fun `Packages 白名单的 Cipher 加出来的东西 JVM 能解`() {
        val keyBytes = ByteArray(16) { it.toByte() }
        val ivBytes = ByteArray(16) { (it + 16).toByte() }
        val keyJs = keyBytes.joinToString(",") { (it.toInt() and 0xFF).toString() }
        val ivJs = ivBytes.joinToString(",") { (it.toInt() and 0xFF).toString() }
        val ctx = context("https://packages.example/cipher")
        val encoded = evalOrFail(
            sandbox,
            """
            var c = Packages.javax.crypto.Cipher.getInstance("AES/CBC/PKCS5Padding");
            c.init(Packages.javax.crypto.Cipher.ENCRYPT_MODE,
                new Packages.javax.crypto.spec.SecretKeySpec([$keyJs], "AES"),
                new Packages.javax.crypto.spec.IvParameterSpec([$ivJs]));
            Packages.android.util.Base64.encodeToString(c.doFinal([123,34,97,34,58,49,125]))
            """.trimIndent(),
            ctx,
        )
        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(keyBytes, "AES"), IvParameterSpec(ivBytes))
        assertEquals("""{"a":1}""", String(cipher.doFinal(Base64.getDecoder().decode(encoded))))
    }

    @Test
    fun `JavaImporter 的 with 作用域能按导入的包找类`() {
        val keyJs = ByteArray(16) { it.toByte() }.joinToString(",") { (it.toInt() and 0xFF).toString() }
        val ctx = context("https://packages.example/importer")
        val encoded = evalOrFail(
            sandbox,
            """
            var imp = new JavaImporter(Packages.javax.crypto, Packages.javax.crypto.spec, Packages.android.util);
            var out = "";
            with (imp) {
                var c = Cipher.getInstance("AES/ECB/PKCS5Padding");
                c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec([$keyJs], "AES"));
                out = Base64.encodeToString(c.doFinal([104,105]));
            }
            out
            """.trimIndent(),
            ctx,
        )
        val cipher = Cipher.getInstance("AES/ECB/PKCS5Padding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(ByteArray(16) { it.toByte() }, "AES"))
        assertEquals("hi", String(cipher.doFinal(Base64.getDecoder().decode(encoded))))
    }

    @Test
    fun `全局 importPackage 不覆盖 JS 内置，但补上 Java 类`() {
        val ctx = context("https://packages.example/import-package")
        val out = evalOrFail(
            sandbox,
            """
            importPackage(Packages.java.lang);
            typeof String + "|" + new StringBuilder("ab").append("c").toString() + "|" + Integer.parseInt("2a", 16)
            """.trimIndent(),
            ctx,
        )
        assertEquals("function|abc|42", out)
    }

    @Test
    fun `importClass 把单个类挂到全局`() {
        val ctx = context("https://packages.example/import-class")
        assertEquals(
            "36",
            evalOrFail(
                sandbox,
                """importClass(Packages.java.util.UUID); String(UUID.randomUUID()).length""",
                ctx,
            ),
        )
    }

    @Test
    fun `白名单之外的包仍然是 undefined`() {
        val ctx = context("https://packages.example/denied")
        assertEquals(
            "undefined|undefined|undefined",
            evalOrFail(
                sandbox,
                """typeof Packages.com + "|" + typeof Packages.io + "|" + typeof Packages.java.nio""",
                ctx,
            ),
        )
    }

    @Test
    fun `Packages 的 HashMap 同时有 Map 方法与属性访问`() {
        val ctx = context("https://packages.example/hashmap")
        val out = evalOrFail(
            sandbox,
            """
            var m = new Packages.java.util.HashMap();
            m.put("a", "1");
            m.get("a")+"|"+m.a+"|"+m.size()+"|"+m.containsKey("a")+"|"+String(m.get("none"))
            """.trimIndent(),
            ctx,
        )
        assertEquals("1|1|1|true|null", out)
    }

    @Test
    fun `Packages 的 ArrayList 读写数字元素`() {
        val ctx = context("https://packages.example/arraylist")
        val out = evalOrFail(
            sandbox,
            """
            var list = new Packages.java.util.ArrayList();
            list.add(65); list.add("b");
            list.get(0)+"|"+list.get(1)+"|"+list.size()+"|"+list.toString()
            """.trimIndent(),
            ctx,
        )
        assertEquals("65|b|2|65, b", out)
    }

    // ── okhttp3 贴片 ───────────────────────────────────────────

    @Test
    fun `okhttp3 同步调用走统一抓取通道`() {
        val seen = java.util.concurrent.CopyOnWriteArrayList<String>()
        val runner = RuleRunner().apply {
            fetchedFetcher = { url ->
                seen.add(url)
                RuleRunner.Fetched(
                    url = url,
                    body = """{"ok":true}""",
                    status = 200,
                    headers = mapOf("content-type" to "application/json", "x-token" to "t1"),
                )
            }
        }
        val box = JsSandbox(runner)
        val ctx = JsExecutionContext(sourceId = "https://okhttp.example")
        val out = evalOrFail(
            box,
            """
            var builder = new Packages.okhttp3.Request.Builder();
            builder.url("https://api.example/v1/list")
                .post(Packages.okhttp3.RequestBody.create("{\"page\":1}", Packages.okhttp3.MediaType.parse("application/json")))
                .addHeader("X-Token", "t1");
            var resp = new Packages.okhttp3.OkHttpClient().newCall(builder.build()).execute();
            resp.code()+"|"+resp.isSuccessful()+"|"+resp.header("x-token")+"|"+resp.body().string()
            """.trimIndent(),
            ctx,
        )
        assertEquals("200|true|t1|{\"ok\":true}", out)
        assertEquals("https://api.example/v1/list", seen.single())
    }

    @Test
    fun `okhttp3 的 HttpUrl 能拼查询参数`() {
        val ctx = context("https://okhttp.example/url")
        val out = evalOrFail(
            sandbox,
            """
            var u = Packages.okhttp3.HttpUrl.parse("https://h.com/a?x=1")
                .newBuilder().addQueryParameter("k", "中").build();
            u.host+"|"+u.path+"|"+u.toString()
            """.trimIndent(),
            ctx,
        )
        assertEquals("h.com|/a|https://h.com/a?x=1&k=%E4%B8%AD", out)
    }

    // ── 登录信息的 Map 语义 ─────────────────────────────────────

    @Test
    fun `登录信息支持 get 与 containsKey`() {
        val ctx = context("https://login.example/map", login = mapOf("token" to "abc"))
        val out = evalOrFail(
            sandbox,
            """
            var m = source.getLoginInfoMap();
            m.get("token")+"|"+m.token+"|"+m.containsKey("token")+"|"+m.containsKey("nope")+"|"+String(m.get("nope"))
            """.trimIndent(),
            ctx,
        )
        assertEquals("abc|abc|true|false|null", out)
    }

    // ── ajaxAll ────────────────────────────────────────────────

    @Test
    fun `ajaxAll 按入参顺序回响应对象`() {
        val runner = RuleRunner { url -> "body:$url" }
        val box = JsSandbox(runner)
        val ctx = JsExecutionContext(sourceId = "https://ajax.example/order")
        val out = evalOrFail(
            box,
            """
            var rs = java.ajaxAll(["https://api.example/1","https://api.example/2","https://api.example/3"]);
            rs.map(function(r){ return r.body()+"@"+r.statusCode(); }).join("|")
            """.trimIndent(),
            ctx,
        )
        assertEquals(
            "body:https://api.example/1@200|body:https://api.example/2@200|body:https://api.example/3@200",
            out,
        )
    }

    @Test
    fun `ajaxAll 单条失败不影响其它条`() {
        val runner = RuleRunner { url -> if (url.endsWith("/2")) error("boom") else "ok" }
        val box = JsSandbox(runner)
        val ctx = JsExecutionContext(sourceId = "https://ajax.example/failure")
        val out = evalOrFail(
            box,
            """
            var rs = java.ajaxAll(["https://api.example/1","https://api.example/2"]);
            rs[0].body()+"|"+rs[1].statusCode()+"|"+(rs[1].body().length > 0)
            """.trimIndent(),
            ctx,
        )
        assertEquals("ok|0|true", out)
    }

    // ── 小工具 ─────────────────────────────────────────────────

    @Test
    fun `getUserAgent 与 getWebViewUA 同串（蓝批据此判宿主）`() {
        val ctx = context("https://helper.example/ua")
        assertEquals("true", evalOrFail(sandbox, """String(java.getUserAgent() === java.getWebViewUA())""", ctx))
    }

    @Test
    fun `htmlFormat 去标签但保留 img 与 script 文本`() {
        val ctx = context("https://helper.example/html")
        val html = """<div>第一段</div><p>第二段<img src="/a.jpg"></p><script>var a=1;</script>"""
        val out = evalOrFail(sandbox, """java.htmlFormat('$html')""", ctx)
        assertTrue("应保留正文：$out", out.contains("第一段") && out.contains("第二段"))
        assertTrue("应把图片重写成 img 标签：$out", out.contains("""<img src="/a.jpg">"""))
        assertTrue("script 里的配置文本要留下：$out", out.contains("var a=1;"))
        assertTrue("普通标签应去掉：$out", !out.contains("<div>") && !out.contains("<script>"))
    }

    @Test
    fun `toURL 给出 host origin pathname 与 searchParams`() {
        val ctx = context("https://helper.example/url")
        val out = evalOrFail(
            sandbox,
            """
            var u = java.toURL("https://www.example.com/a/b?x=1&y=%E4%B8%AD");
            u.host+"|"+u.origin+"|"+u.pathname+"|"+u.searchParams.get("y")
            """.trimIndent(),
            ctx,
        )
        assertEquals("www.example.com|https://www.example.com|/a/b|中", out)
    }

    @Test
    fun `toURL 能按 baseUrl 解析相对地址，origin 带端口`() {
        val ctx = context("https://helper.example/url-base")
        val out = evalOrFail(
            sandbox,
            """
            java.toURL("c","https://h.com/a/b").pathname+"|"+java.toURL("https://h.com:8443/x").origin
            """.trimIndent(),
            ctx,
        )
        assertEquals("/a/c|https://h.com:8443", out)
    }

    @Test
    fun `importScript 对同一地址只抓一次，相对路径按书源地址补全`() {
        val hits = AtomicInteger()
        val urls = CopyOnWriteArrayList<String>()
        val runner = RuleRunner { url ->
            hits.incrementAndGet()
            urls.add(url)
            "var tool=1;"
        }
        val box = JsSandbox(runner)
        val ctx = JsExecutionContext(sourceId = "https://site.example/book/1")
        assertEquals("var tool=1;", evalOrFail(box, """java.importScript("js/tool.js")""", ctx))
        assertEquals("var tool=1;", evalOrFail(box, """java.importScript("js/tool.js")""", ctx))
        assertEquals(1, hits.get())
        assertEquals("https://site.example/book/js/tool.js", urls.single())
    }

    @Test
    fun `importScript 拿到空内容时抛错而不是回空串`() {
        val box = JsSandbox(RuleRunner { "" })
        val ctx = JsExecutionContext(sourceId = "https://site.example/book/1")
        val out = evalOrFail(
            box,
            """
            try { java.importScript("js/empty.js"); "no-throw" }
            catch (e) { String(e).indexOf("内容获取失败") >= 0 ? "threw" : String(e) }
            """.trimIndent(),
            ctx,
        )
        assertEquals("threw", out)
    }

    @Test
    fun `cacheFile 抓下来的文本会进缓存`() {
        val hits = AtomicInteger()
        val runner = RuleRunner { url ->
            hits.incrementAndGet()
            "var crypt=1;$url"
        }
        val box = JsSandbox(runner)
        val ctx = JsExecutionContext(sourceId = "https://site.example/book/2")
        assertEquals("var crypt=1;https://cdn.example/x.js", evalOrFail(box, """java.cacheFile("https://cdn.example/x.js")""", ctx))
        assertEquals("var crypt=1;https://cdn.example/x.js", evalOrFail(box, """java.cacheFile("https://cdn.example/x.js")""", ctx))
        assertEquals(1, hits.get())
    }

    /** 数字数组（`[65,66,67]`）必须按 int 下标读出元素 —— Rhino 1.8 稠密数组用字符串下标会整串变 0。 */
    @Test
    fun `数字数组能被桥当作字节读出`() {
        val ctx = context("https://packages.example/bytes")
        val out = evalOrFail(
            sandbox,
            """
            var lit = [65,66,67];
            var fromBridge = java.strToBytes("ABC");
            Packages.android.util.Base64.encodeToString(lit)
                + "|" + Packages.android.util.Base64.encodeToString(fromBridge)
                + "|" + String(lit.length) + "|" + String(fromBridge.length)
            """.trimIndent(),
            ctx,
        )
        assertEquals("QUJD|QUJD|3|3", out)
    }
}
