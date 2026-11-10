package io.legado

import io.legado.data.Database
import io.legado.data.getScriptCacheEntry
import io.legado.data.putScriptCache
import io.legado.rules.ResponseBody
import io.legado.rules.RuleExecutionException
import io.legado.rules.ScriptCache
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.nio.file.Files

/**
 * 书源脚本 `cache` 的过期口径 + 响应体上限的异常类型。
 *
 * 为什么单独立一份：这两处出错都**不会**在界面上报错 ——
 * 缓存回填丢了 deadline，表现是「源换了 token 但一直用旧的」，重启服务才好；
 * 响应超限抛成 `IllegalArgumentException`，表现是用户看到 `400 invalid_request`，
 * 于是去改自己的书源。
 */
class ScriptCacheTtlTest {

    private fun freshDb(): Database =
        Database(Files.createTempFile("legado-script-cache", ".sqlite").toString()).apply { initialize() }

    @Test
    fun `从库里回填的内存条目也认 deadline`() {
        val db = freshDb()
        val source = "https://ttl.example.com"
        ScriptCache.put(source, "token", "v1", 1, db)

        // 模拟进程重启之后内存层为空、只能从库里的那份回填。
        ScriptCache.deleteMemory(source, "token")
        assertEquals("v1", ScriptCache.get(source, "token", db))

        // 回填时若把 deadline 洗成 0（永不过期），这里仍会返回旧值 —— 那正是这条判据要拦的。
        Thread.sleep(1100)
        assertNull(ScriptCache.get(source, "token", db))
    }

    @Test
    fun `库里的 deadline 原样带出来供回填`() {
        val db = freshDb()
        val source = "https://ttl2.example.com"
        val deadline = System.currentTimeMillis() + 60_000
        db.putScriptCache(source, "k", "v", deadline)

        val entry = db.getScriptCacheEntry(source, "k")
        assertEquals("v", entry?.value)
        assertEquals(deadline, entry?.deadline)
    }

    @Test
    fun `响应体超限抛规则异常，不是参数非法`() {
        val oversized = ByteArray(ResponseBody.MAX_BODY_BYTES + 1) { 'a'.code.toByte() }
        try {
            ResponseBody.readLimited(oversized.inputStream())
            fail("超过 2 MiB 必须中止读取")
        } catch (error: RuleExecutionException) {
            assertTrue("消息要说明是上游太大：${error.message}", error.message.orEmpty().contains("2 MiB"))
        }
    }
}
