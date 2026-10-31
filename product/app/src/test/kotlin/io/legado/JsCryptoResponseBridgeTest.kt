package io.legado

import io.legado.rules.JsExecutionContext
import io.legado.rules.JsSandbox
import io.legado.rules.RuleRunner
import io.legado.rules.ScriptCrypto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 书源脚本的加密桥与响应对象。
 *
 * 两条都来自实跑：
 * - 加密：`java.createSymmetricCrypto` 启用库 44 处、`java.base64DecodeToByteArray` 115 处、
 *   `java.HMacHex` 21 处、`java.digestHex` 12 处。缺的时候脚本半路抛错，
 *   后面 jsLib 里赋值的 `sign` / `flag` 全变成 `ReferenceError`，看着像"源写错变量"。
 * - 响应对象：`java.connect` 53 处、`java.head` 13 处、`java.getStrResponse` 9 处。
 *   上游回的是响应对象，脚本接着取 `.raw().request().url()` / `.headers("Location")`；
 *   我们原来只回正文字符串，于是 `TypeError: 在对象 …中未找到函数`。
 *   实测样本：奇书网络（导入）停在 `rule.js#7` 的 `java.connect(url).raw().request().url()`。
 */
class JsCryptoResponseBridgeTest {
    private val body = """{"code":0,"data":{"list":[{"id":7,"title":"第一章"}]}}"""

    private fun runner(): RuleRunner = RuleRunner { url ->
        when {
            url.startsWith("http://crypto.example/api") -> body
            else -> error("不该去抓这个地址：$url")
        }
    }

    private fun eval(script: String): String? {
        val sandbox = JsSandbox(runner())
        val out = sandbox.eval(
            script,
            mapOf("baseUrl" to "http://crypto.example/api/1"),
            JsExecutionContext(sourceId = "http://crypto.example"),
        )
        assertTrue("脚本报错：${sandbox.lastError ?: "（无，就是返回了 null）"}", out != null)
        return out
    }

    // ── 摘要 / HMAC ────────────────────────────────────────────────
    // 期望值是**独立算出来的**（python hashlib/hmac），不是拿我们自己的实现回推，
    // 否则参数顺序写反了也测不出来。
    @Test
    fun `digestHex 与 HMacHex 对上独立算出的向量`() {
        assertEquals("c5a4200e155dd17b41ecf837699d8977f6dde8f0", eval("java.digestHex('st20211010233045t', 'SHA-1')"))
        assertEquals(
            "99d2456e4da4a41e87b6a862244daa98e1cadd4fbee358af6d42f13099dbd836",
            eval("java.digestHex('st20211010233045t', 'SHA-256')"),
        )
        // 上游签名是 (数据, 算法, 密钥)，顺序写错就等于换了个 MAC
        assertEquals("a1bf1acda13190664f3fcbdb1a72fb20ebd5bcad", eval("java.HMacHex('st20211010233045t', 'HmacSHA1', 'key12345')"))
        assertEquals("dea603342fefcb0adb75f6aa8e17ee81", eval("java.HMacHex('id123', 'HmacMD5', 'id123')"))
    }

    @Test
    fun `digestBase64Str 给的是 base64 而不是 hex`() {
        assertEquals("W83oAWXCRhUAecK/8RcVAA==".take(22), eval("java.digestBase64Str('st20211010233045t', 'MD5')")?.take(22))
    }

    // ── 对称加解密 ────────────────────────────────────────────────
    @Test
    fun `AES-CBC 加解密成对得上`() {
        val script = """
            var c = java.createSymmetricCrypto('AES/CBC/PKCS5Padding', '0123456789abcdef', 'fedcba9876543210');
            var enc = c.encryptBase64('剑来第一章');
            var back = java.createSymmetricCrypto('AES/CBC/PKCS5Padding', '0123456789abcdef', 'fedcba9876543210').decryptStr(enc);
            enc.length > 0 ? back : '解密失败';
        """.trimIndent()
        assertEquals("剑来第一章", eval(script))
    }

    @Test
    fun `没写模式的变换按上游补成 ECB`() {
        // 上游：`algorithm.contains('/')` 为假时用 `ALG/ECB/PKCS5Padding`。
        val hex = eval(
            """java.createSymmetricCrypto('AES', '0123456789abcdef').encryptHex('abc')"""
        )
        val plain = ScriptCrypto.Symmetric("AES", "0123456789abcdef".toByteArray(Charsets.UTF_8)).encryptHex("abc")
        assertEquals(plain, hex)
        assertTrue("ECB 不带 iv，密文应该完全由密钥决定：$hex", (hex?.length ?: 0) == 32)
    }

    @Test
    fun `DES 密钥超长按上游截成 8 字节`() {
        val shortKey = eval("""java.createSymmetricCrypto('DES/CBC/PKCS5Padding','0123456789abcdef','abcdefgh').encryptBase64('x')""")
        val longKey = eval("""java.createSymmetricCrypto('DES/CBC/PKCS5Padding','01234567','abcdefgh').encryptBase64('x')""")
        assertEquals("两个密钥长度不同就解不出同一份数据，说明上游的截断没照做", shortKey, longKey)
    }

    @Test
    fun `脚本能把 base64 解码成字节数组再切片当 iv`() {
        // 蓝海那类源的写法：先 base64 解码、`.slice(0,16)` 取 iv、剩下的当密文。
        val script = """
            var bytes = java.base64DecodeToByteArray('AAECAwQFBgcICQoLDA0ODw==');
            bytes.length + '|' + bytes[0] + ',' + bytes[15] + '|' + bytes.slice(0, 4).join(',');
        """.trimIndent()
        assertEquals("16|0,15|0,1,2,3", eval(script))
    }

    @Test
    fun `desEncodeToBase64String 与 desDecodeToString 成对得上`() {
        // 阅友小说（goway.reader.yueyouxs.com）就是这一行算搜索签名：
        // `java.desEncodeToBase64String(参数串, 密钥, "DES/ECB/PKCS5Padding", "")`
        val script = """
            var p = 'utId=996&userId=y764&st=2';
            var enc = java.desEncodeToBase64String(p, 'snY%169j', 'DES/ECB/PKCS5Padding', '');
            var back = java.desDecodeToString(enc, 'snY%169j', 'DES/ECB/PKCS5Padding', '');
            enc.length > 0 ? back : '解密失败';
        """.trimIndent()
        assertEquals("utId=996&userId=y764&st=2", eval(script))
    }

    @Test
    fun `strToBytes 与 bytesToStr 互为逆运算`() {
        assertEquals("剑来", eval("java.bytesToStr(java.strToBytes('剑来'))"))
    }

    // ── 响应对象 ──────────────────────────────────────────────────
    @Test
    fun `get 的结果既当字符串用也能当响应对象用`() {
        // 库里两种写法各一百多处，只能同时满足：
        // - 字符串用法：`.split()`、`String(x)`、拼接
        val asText = eval(
            "var r = java.get('http://crypto.example/api/1', {}); JSON.parse(r).data.list[0].title + '|' + String(r).length + '|' + r.split('list').length;"
        )
        assertEquals("第一章|${body.length}|2", asText)
        // - 响应对象用法：`.body()`、`.statusCode()`、`.headers()`
        val asResponse = eval(
            "var r = java.get('http://crypto.example/api/1', {}); [JSON.parse(r.body()).code, r.statusCode(), typeof r.headers()].join('|');"
        )
        assertEquals("0|200|object", asResponse)
    }

    @Test
    fun `post 的结果同样两种用法都能读`() {
        val out = eval(
            "var r = java.post('http://crypto.example/api/1', 'k=1', {});" +
                "[r.body() === String(r), JSON.parse(String(r)).data.list[0].id].join('|');"
        )
        assertEquals("true|7", out)
    }

    @Test
    fun `读键用法不受影响`() {
        // `java.get("token")` 这种 KV 读法必须原样可用（URL 分支与键分支共用一个函数，历史上覆盖过一次）
        val out = eval("java.put('token', 'T-1'); java.get('token')")
        assertEquals("T-1", out)
    }

    @Test
    fun `connect 给的对象能按上游那几种写法取值`() {
        val script = """
            var r = java.connect('http://crypto.example/api/1');
            [r.url(), r.body().length > 0, String(r.raw().request().url()), r.statusCode(), typeof r.headers()].join('|');
        """.trimIndent()
        assertEquals("http://crypto.example/api/1|true|http://crypto.example/api/1|200|object", script.let(::eval))
    }

    @Test
    fun `body 既能当属性也能当方法用`() {
        // 上游 `StrResponse.body` 是字段，而 Jsoup 的 `Response.body()` 是方法 —— 库里两种写法都有。
        val script = """var r = java.getStrResponse('http://crypto.example/api/1');
            (r.body === r.body()) || String(r.body).length === String(r.body()).length;""".trimIndent()
        assertEquals("true", eval(script))
    }

    @Test
    fun `head 只给头与地址不给正文`() {
        val script = """var r = java.head('http://crypto.example/api/1'); r.body() === '' ? 'no-body' : 'has-body';""".trimIndent()
        assertEquals("no-body", eval(script))
    }

    @Test
    fun `connect 失败时按上游把异常收成文本而不是抛给脚本`() {
        // 上游 `connect` 内部 runCatching，失败回 `StrResponse(url, stackTrace)`；
        // 脚本普遍自己判空。我们原来把异常直接穿出去，源里的 try/catch 只能收到一句没头没尾的东西。
        val sandbox = JsSandbox(RuleRunner { url -> error("连不上：$url") })
        val out = sandbox.eval(
            "var r = java.connect('http://crypto.example/down'); String(r.body()).indexOf('连不上') >= 0 ? '收到错误文本' : '不是错误文本';",
            emptyMap(),
            JsExecutionContext(sourceId = "http://crypto.example"),
        )
        assertEquals("收到错误文本", out)
    }
}
