package io.legado.data.db

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Cookie 桶名与 Cookie 串解析。
 *
 * 这两个函数决定「哪份凭据属于哪个站」—— 判错的表现不是报错，而是**登录态莫名其妙丢了**
 * 或者更糟：A 站的 Cookie 被写进 B 站的桶。所以桶名规则要逐条钉住。
 *
 * 它们与 `Database.cookieBucket` / `Database.parseCookieString` 逐字一致（那份是给扩展函数用的），
 * 这里测的是 `Migration` 直接调用的纯函数版本。
 */
class CookieUtilTest {

    @Test
    fun `URL 取注册域，子域折叠到主域`() {
        assertEquals("a.test", cookieBucket("https://a.test/book/1"))
        assertEquals("a.test", cookieBucket("https://sub.a.test/book/1"))
        assertEquals("a.test", cookieBucket("https://deep.sub.a.test/x"))
    }

    @Test
    fun `裸域名也能认，带端口与路径要剥掉`() {
        assertEquals("a.test", cookieBucket("a.test"))
        assertEquals("a.test", cookieBucket("a.test:8080"))
        assertEquals("a.test", cookieBucket("  A.TEST/  "))
    }

    @Test
    fun `IP 原样保留，不按点切`() {
        assertEquals("127.0.0.1", cookieBucket("http://127.0.0.1:1234/x"))
        // IPv6 会带方括号（`URI.host` 就长这样）：桶名只要前后一致即可，不做规范化
        assertEquals("[::1]", cookieBucket("http://[::1]:1234/x"))
    }

    @Test
    fun `多段后缀取三段，避免把 co_uk 这类当成主域`() {
        // 只要结果不是 "co.uk" 就说明走了 MULTI_PART_TLDS 分支
        assertTrue(cookieBucket("https://shop.example.co.uk/x") != "co.uk")
    }

    @Test
    fun `Cookie 串解析成键值对，分号与空格都能切`() {
        assertEquals(
            mapOf("token" to "aaa", "uid" to "123"),
            parseCookieString("token=aaa; uid=123"),
        )
        assertEquals(mapOf("k" to "v"), parseCookieString("k=v"))
        assertEquals("空串不该抛", emptyMap<String, String>(), parseCookieString(""))
    }

    @Test
    fun `同名键后者覆盖前者`() {
        assertEquals(mapOf("k" to "2"), parseCookieString("k=1; k=2"))
    }
}
