package io.legado.data

import io.legado.model.BookshelfItem
import io.legado.model.Chapter
import io.legado.model.CookieBucket
import io.legado.model.ReplaceRule
import io.legado.model.SourceLoginStateRecord
import io.legado.model.SourceRecord
import io.legado.port.CookieStore
import io.legado.port.KernelReader
import io.legado.port.LoginStateStore
import io.legado.port.ScriptCacheStore
import io.legado.port.ScriptCacheValue
import io.legado.port.VariableStore

/**
 * [CookieStore] 的 `Database` 落地：把端口方法委托给 `CookieDao` 里既有的 `Database` 扩展函数。
 *
 * 刻意**不删**那些扩展函数（`getCookieForUrl` 等）——它们仍被 http/ai 直接调用，删了波及一片。
 * 这层适配器只是给规则内核一个「按端口索取」的入口，让 `rules/` 不再 import 这些扩展，
 * 从而消掉 `rules → data` 的 Cookie 组横穿（见 docs/architecture-audit.md §3.1）。
 */
internal class DatabaseCookieStore(private val db: Database) : CookieStore {
    override fun cookieBucket(urlOrHost: String): String = db.cookieBucket(urlOrHost)
    override fun getCookieForUrl(url: String): String? = db.getCookieForUrl(url)
    override fun setCookieForUrl(url: String, cookie: String): Boolean = db.setCookieForUrl(url, cookie)
    override fun removeCookieBucket(url: String): Boolean = db.removeCookieBucket(url)
    override fun setCookieFromSetCookie(url: String, setCookieHeader: String): Boolean =
        db.setCookieFromSetCookie(url, setCookieHeader)
    override fun cookieBucketsForHosts(hosts: List<String>): List<CookieBucket> = db.cookieBucketsForHosts(hosts)
}

/**
 * [VariableStore] 的 `Database` 落地：委托 `LoginDao` 里既有的变量/键值扩展函数。
 * 同上，扩展函数保留，只是给规则内核一个端口入口。
 */
internal class DatabaseVariableStore(private val db: Database) : VariableStore {
    override fun saveSourceVariable(sourceId: String, variable: String?): Boolean =
        db.saveSourceVariable(sourceId, variable)
    override fun getSourceVariable(sourceId: String): String? = db.getSourceVariable(sourceId)
    override fun saveSourceKv(sourceId: String, key: String, value: String?): Boolean =
        db.saveSourceKv(sourceId, key, value)
    override fun getSourceKv(sourceId: String, key: String): String? = db.getSourceKv(sourceId, key)
}

/**
 * [ScriptCacheStore] 的 `Database` 落地：委托 `ScriptCacheDao` 里既有的脚本缓存扩展函数。
 * `now` 由调用方传入，适配器原样透传。
 */
internal class DatabaseScriptCacheStore(private val db: Database) : ScriptCacheStore {
    override fun getScriptCache(sourceId: String, key: String, now: Long): String? =
        db.getScriptCache(sourceId, key, now)
    override fun getScriptCacheEntry(sourceId: String, key: String, now: Long): ScriptCacheValue? =
        db.getScriptCacheEntry(sourceId, key, now)
    override fun putScriptCache(sourceId: String, key: String, value: String, deadline: Long): Boolean =
        db.putScriptCache(sourceId, key, value, deadline)
    override fun deleteScriptCache(sourceId: String, key: String): Boolean = db.deleteScriptCache(sourceId, key)
}

/**
 * [LoginStateStore] 的 `Database` 落地：委托 `LoginDao` 里既有的登录态扩展函数。
 */
internal class DatabaseLoginStateStore(private val db: Database) : LoginStateStore {
    override fun getSourceLoginState(sourceId: String): SourceLoginStateRecord? = db.getSourceLoginState(sourceId)
    override fun saveSourceLoginInfo(sourceId: String, loginInfo: Map<String, String>): Boolean =
        db.saveSourceLoginInfo(sourceId, loginInfo)
    override fun saveSourceLoginHeader(sourceId: String, header: String?): Boolean =
        db.saveSourceLoginHeader(sourceId, header)
    override fun removeSourceLoginHeader(sourceId: String): Boolean = db.removeSourceLoginHeader(sourceId)
    override fun removeSourceLoginInfo(sourceId: String): Boolean = db.removeSourceLoginInfo(sourceId)
}

/**
 * [KernelReader] 的 `Database` 落地：委托 SourcesDao/ShelfDao/CacheDao/ReplaceRuleDao 里既有的只读扩展。
 */
internal class DatabaseKernelReader(private val db: Database) : KernelReader {
    override fun getSource(id: String): SourceRecord? = db.getSource(id)
    override fun shelfBook(sourceId: String, bookUrl: String): BookshelfItem? = db.shelfBook(sourceId, bookUrl)
    override fun getTocCache(sourceId: String, tocUrl: String): List<Chapter>? = db.getTocCache(sourceId, tocUrl)
    override fun getEnabledReplaceRulesForScope(bookName: String?, sourceUrl: String?, sourceName: String?): List<ReplaceRule> =
        db.getEnabledReplaceRulesForScope(bookName, sourceUrl, sourceName)
}
