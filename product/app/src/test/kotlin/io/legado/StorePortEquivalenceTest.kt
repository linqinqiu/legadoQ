package io.legado

import io.legado.data.Database
import io.legado.data.cookieBucket
import io.legado.data.deleteScriptCache
import io.legado.data.getCookieForUrl
import io.legado.data.getScriptCache
import io.legado.data.getSourceKv
import io.legado.data.getSourceLoginState
import io.legado.data.getSourceVariable
import io.legado.data.putScriptCache
import io.legado.data.saveSourceKv
import io.legado.data.saveSourceLoginHeader
import io.legado.data.saveSourceLoginInfo
import io.legado.data.saveSourceVariable
import io.legado.data.setCookieForUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

/**
 * 端口化行为等值契约测试（legado-with-MD3 的「contract test 锁语义」手法）。
 *
 * `ArchitectureBoundaryTest` 证明的是**结构**：rules 不再 import 这些 data 扩展、基线条目单调缩。
 * 本测试补上另一维：**行为** —— 对同一份 `Database` 状态，走旧的 `Database` 扩展函数与走新的
 * 端口适配器（`asCookieStore()/asVariableStore()/asScriptCacheStore()/asLoginStateStore()`），
 * 返回值与副作用必须逐一对齐。
 *
 * 今天的适配器是**纯委托**（`DatabaseCookieStore.getCookieForUrl = db.getCookieForUrl`），所以等值
 * 由构造保证；正因如此本测试当前的价值是**回归网**：一旦有人把某个端口实现从"纯委托"改成"独立实现"
 * （例如为了换存储后端而重写适配器方法体），签名顺序、空值语义、副作用口径的任何漂移都会在这里立刻红，
 * 而不是等书源在社区真实运行时才暴露。这与桥白名单同属"锁住现状、变更需举证"的思路。
 *
 * 构造签名不动、49 个 RuleRunner(db) 测试点不改 —— 本测试直接拿 `Database` 断言，不碰 RuleRunner。
 */
class StorePortEquivalenceTest {

    private fun freshDb(): Database =
        Database(Files.createTempFile("legado-port-equiv", ".sqlite").toString()).apply { initialize() }

    @Test
    fun `CookieStore 端口与 Database 扩展读写一致`() {
        val db = freshDb()
        val url = "https://example.com/read"
        assertTrue(db.setCookieForUrl(url, "token=abc; sid=1"))
        // 写走扩展、读分别走两条路径，结果必须相同。
        assertEquals(db.getCookieForUrl(url), db.asCookieStore().getCookieForUrl(url))
        assertEquals(db.cookieBucket(url), db.asCookieStore().cookieBucket(url))
        // 反向：写走端口、读走扩展，也应一致。
        db.asCookieStore().setCookieForUrl(url, "token=xyz")
        assertEquals(db.getCookieForUrl(url), db.asCookieStore().getCookieForUrl(url))
    }

    @Test
    fun `VariableStore 端口与 Database 扩展读写一致`() {
        val db = freshDb()
        val id = "https://src.example"
        db.saveSourceVariable(id, "lineName=默认")
        assertEquals(db.getSourceVariable(id), db.asVariableStore().getSourceVariable(id))
        db.asVariableStore().saveSourceVariable(id, "lineName=备用")
        assertEquals(db.getSourceVariable(id), db.asVariableStore().getSourceVariable(id))
        db.saveSourceKv(id, "bid", "123")
        assertEquals(db.getSourceKv(id, "bid"), db.asVariableStore().getSourceKv(id, "bid"))
    }

    @Test
    fun `ScriptCacheStore 端口与 Database 扩展读写删一致`() {
        val db = freshDb()
        val id = "https://src.example"
        val now = System.currentTimeMillis()
        val deadline = now + 60_000
        db.putScriptCache(id, "k", "v", deadline)
        assertEquals(db.getScriptCache(id, "k", now), db.asScriptCacheStore().getScriptCache(id, "k", now))
        db.deleteScriptCache(id, "k")
        assertEquals(db.getScriptCache(id, "k", now), db.asScriptCacheStore().getScriptCache(id, "k", now))
    }

    @Test
    fun `LoginStateStore 端口与 Database 扩展读写一致`() {
        val db = freshDb()
        val id = "https://src.example"
        db.saveSourceLoginInfo(id, mapOf("token" to "t1"))
        assertEquals(db.getSourceLoginState(id)?.loginInfo, db.asLoginStateStore().getSourceLoginState(id)?.loginInfo)
        db.asLoginStateStore().saveSourceLoginHeader(id, "{\"Authorization\":\"Bearer x\"}")
        assertEquals(db.getSourceLoginState(id)?.loginHeader, db.asLoginStateStore().getSourceLoginState(id)?.loginHeader)
    }
}
