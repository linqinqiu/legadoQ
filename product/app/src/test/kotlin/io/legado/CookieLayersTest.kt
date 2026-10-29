package io.legado

import io.legado.data.MAX_COOKIE_HEADER_CHARS
import io.legado.data.SessionCookies
import io.legado.data.SetCookieOutcome
import io.legado.data.classifySetCookie
import io.legado.data.cookieBucketState
import io.legado.data.getCookieForUrl
import io.legado.data.listCookieBucketStates
import io.legado.data.parseCookieString
import io.legado.data.removeCookieBucket
import io.legado.data.removeCookieKey
import io.legado.data.setCookieForUrl
import io.legado.data.setCookieFromSetCookie
import io.legado.data.Database
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * 凭据的**两层存储**（持久 / 会话）与 4096 淘汰。
 *
 * 借自 legado-with-MD3 的 `CookieManager` + `CookieStore`，两处刻意不一样：
 * - MD3 超长时 `cookieMap.keys.random()` 随机丢 —— 我们保留"能装下的那段最新后缀"，
 *   随机淘汰会让同一个域两次请求带出不一致的凭据，对登录态等于偶发掉线；
 * - 会话层做进 `getCookieForUrl` 这个**唯一出口**，规则引擎、封面、媒体代理自动同口径。
 *
 * 判据都打在"实际会发出去的那条头"上，而不是内部字段：用户能观察到的只有这一件事。
 */
class CookieLayersTest {

    private val url = "https://book.example.com/search"

    private fun tempDatabase() =
        Database(Files.createTempFile("legado-cookie-layers", ".sqlite").toString()).also { it.initialize() }

    @Before
    @After
    fun clearSessionLayer() = SessionCookies.clear()

    private fun filler(char: Char) = char.toString().repeat(2_000)

    // ===== 分流 =====

    @Test
    fun `Set-Cookie 没带有效期就只进会话层，重启即失效`() {
        val db = tempDatabase()
        try {
            assertTrue(db.setCookieFromSetCookie(url, "csrf=abc123; Path=/; HttpOnly"))
            assertEquals("请求时确实要带着它", "csrf=abc123", db.getCookieForUrl(url))

            SessionCookies.clear()   // 等价于重启进程
            assertNull("会话凭据不该活过一次重启", db.getCookieForUrl(url))
            assertTrue("库里也不该留这一桶", db.listCookieBucketStates().isEmpty())
        } finally { db.close() }
    }

    @Test
    fun `带 Max-Age 或未到的 Expires 才进库`() {
        val db = tempDatabase()
        try {
            db.setCookieFromSetCookie(url, "uid=42; Max-Age=3600; Path=/")
            db.setCookieFromSetCookie(url, "sid=7; Expires=Wed, 21 Oct 2099 07:28:00 GMT")

            SessionCookies.clear()
            assertEquals(setOf("uid", "sid"), db.parseCookieString(db.getCookieForUrl(url) ?: "").keys)
        } finally { db.close() }
    }

    @Test
    fun `读不懂的 Expires 按会话处理，不凭猜永久化`() {
        val db = tempDatabase()
        try {
            db.setCookieFromSetCookie(url, "tmp=1; Expires=下周二")
            SessionCookies.clear()
            assertNull("日期读不懂时不该落库", db.getCookieForUrl(url))
        } finally { db.close() }
    }

    @Test
    fun `Max-Age 为 0 表示这条作废，只撤它、其余保留`() {
        val db = tempDatabase()
        try {
            db.setCookieForUrl(url, "token=t1; theme=dark")
            assertTrue(db.setCookieFromSetCookie(url, "token=; Max-Age=0; Path=/"))
            assertEquals("theme=dark", db.getCookieForUrl(url))
        } finally { db.close() }
    }

    @Test
    fun `手动粘贴的凭据一律算持久`() {
        val db = tempDatabase()
        try {
            // 界面上贴进来的串没有任何属性信息 —— 用户就是要它留下来，不能当会话丢掉。
            db.setCookieForUrl(url, "token=abc")
            SessionCookies.clear()
            assertEquals("token=abc", db.getCookieForUrl(url))
        } finally { db.close() }
    }

    @Test
    fun `会话层覆盖持久层的同名键`() {
        val db = tempDatabase()
        try {
            db.setCookieForUrl(url, "token=旧值")
            db.setCookieFromSetCookie(url, "token=新值; Path=/")
            assertEquals("本次站点刚发的更该被带出去", "token=新值", db.getCookieForUrl(url))
        } finally { db.close() }
    }

    // ===== 4096 淘汰 =====

    @Test
    fun `超过 4096 时留最新的两条，最旧那条如实报出`() {
        val db = tempDatabase()
        try {
            val big = filler('x')
            db.setCookieForUrl(url, "a=$big; b=$big; c=$big")

            val header = db.getCookieForUrl(url) ?: error("该有凭据")
            assertTrue("拼出来的头必须不超上限，实际 ${header.length}", header.length <= MAX_COOKIE_HEADER_CHARS)
            assertEquals("丢的是最旧的 a", listOf("b", "c"), db.parseCookieString(header).keys.toList())

            val state = db.cookieBucketState(url)
            assertEquals(listOf("a"), state.droppedKeys)
            assertEquals(header.length, state.headerChars)
            assertFalse("不是只剩一条的极端情况", state.oversized)
        } finally { db.close() }
    }

    @Test
    fun `刚重设过的那条算最新，不该被当成最旧的丢掉`() {
        val db = tempDatabase()
        try {
            val big = filler('y')
            db.setCookieForUrl(url, "login=$big; b=$big; c=$big")
            assertEquals("一开始 login 最旧，被丢下", listOf("b", "c"), db.cookieBucketState(url).sentKeys)

            db.setCookieForUrl(url, "login=$big")   // 重新登录：login 挪到最新
            val sent = db.cookieBucketState(url).sentKeys
            assertTrue("重设过的登录态必须发得出去，实际发出 $sent", sent.contains("login"))
            assertEquals("该换最旧的 b 被丢下", listOf("b"), db.cookieBucketState(url).droppedKeys)
        } finally { db.close() }
    }

    @Test
    fun `单条就超 4096 时照发并标出异常，不静默清空`() {
        val db = tempDatabase()
        try {
            // 长度直接按上限推导：单条 "only=<value>" 就要超过 4096。
            val huge = "z".repeat(MAX_COOKIE_HEADER_CHARS)
            db.setCookieForUrl(url, "only=$huge")

            val header = db.getCookieForUrl(url)
            assertNotNull("全丢等于必然没有登录态，宁可带着试一次", header)
            assertTrue("内容原样", header!!.startsWith("only="))
            assertTrue("但这种桶必须被标出来", db.cookieBucketState(url).oversized)
        } finally { db.close() }
    }

    // ===== 删除与列表 =====

    @Test
    fun `删除整桶会把会话层一起清掉`() {
        val db = tempDatabase()
        try {
            db.setCookieFromSetCookie(url, "uid=1; Max-Age=3600")
            db.setCookieFromSetCookie(url, "csrf=2; Path=/")
            assertEquals(2, db.parseCookieString(db.getCookieForUrl(url) ?: "").size)

            assertTrue(db.removeCookieBucket(url))
            assertNull("会话层没删干净就是删除按钮坏了", db.getCookieForUrl(url))
            assertTrue("库里也不该留", db.listCookieBucketStates().none { it.domain == "example.com" })
        } finally { db.close() }
    }

    @Test
    fun `只有会话凭据的域也要出现在列表里，否则撤不掉`() {
        val db = tempDatabase()
        try {
            db.setCookieFromSetCookie(url, "temp=1; Path=/")
            val row = db.listCookieBucketStates().firstOrNull { it.domain == "example.com" }
            assertNotNull("看不见就等于删不掉", row)
            assertEquals(listOf("temp"), row!!.sessionKeys)
            assertTrue("库里没有", row.persistentKeys.isEmpty())
        } finally { db.close() }
    }

    @Test
    fun `撤掉单个键支持按地址或裸域名传入`() {
        val db = tempDatabase()
        try {
            db.setCookieForUrl(url, "a=1; b=2")
            assertTrue(db.removeCookieKey("example.com", "a"))
            assertEquals("b=2", db.getCookieForUrl(url))
            assertFalse("不存在的键返回 false，别让调用方以为删成功了", db.removeCookieKey(url, "nope"))
        } finally { db.close() }
    }

    // ===== 判定函数本身 =====

    @Test
    fun `分类器按 Max-Age 优先于 Expires`() {
        assertTrue(classifySetCookie("k=v; Max-Age=60; Expires=Wed, 21 Oct 2015 07:28:00 GMT") is SetCookieOutcome.Persistent)
        assertTrue(classifySetCookie("k=v; Expires=Wed, 21 Oct 2099 07:28:00 GMT") is SetCookieOutcome.Persistent)
        assertTrue(classifySetCookie("k=v; Expires=Wed, 21 Oct 2015 07:28:00 GMT") is SetCookieOutcome.Expired)
        assertTrue(classifySetCookie("k=v; Path=/; HttpOnly") is SetCookieOutcome.Session)
        assertNull("光秃秃一个名字不算一条凭据", classifySetCookie("novalue"))
    }

    @Test
    fun `归桶口径不变：www 与 m 是同一个桶`() {
        val db = tempDatabase()
        try {
            db.setCookieForUrl("https://www.example.com/x", "u=1")
            assertEquals("u=1", db.getCookieForUrl("https://m.example.com/y"))
        } finally { db.close() }
    }
}
