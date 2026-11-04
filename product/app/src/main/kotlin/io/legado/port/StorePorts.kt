package io.legado.port

import io.legado.model.BookshelfItem
import io.legado.model.Chapter
import io.legado.model.CookieBucket
import io.legado.model.ReplaceRule
import io.legado.model.SourceLoginStateRecord
import io.legado.model.SourceRecord

/**
 * 书源 Cookie 存储端口 —— 规则内核（`rules/`）按能力向宿主索取，而不是直接 import
 * `io.legado.data` 的 `Database` 扩展函数。这是 `docs/architecture-audit.md` §3.1 里
 * `rules → data` 23 条横穿的「Cookie 组」（6 条）的收口点。
 *
 * 方法集只声明 `rules` 真正用到的 6 个能力（与 `java` 桥白名单同纪律：不多声明一个），
 * 具体落地由 `data` 侧的 `DatabaseCookieStore` 适配器委托给既有 DAO 扩展实现。
 * 留在 `rules` 里的 `getSource/shelfBook/…` 等读取仍是 data 直连（端口化后续批次再收）。
 */
interface CookieStore {
    /** url/主机 → 所属桶 id（CookieDao.cookieBucket）。 */
    fun cookieBucket(urlOrHost: String): String

    /** 读某 url 的 Cookie 串（CookieDao.getCookieForUrl）。 */
    fun getCookieForUrl(url: String): String?

    /** 写某 url 的 Cookie 串（CookieDao.setCookieForUrl）。 */
    fun setCookieForUrl(url: String, cookie: String): Boolean

    /** 删某 url 所属桶（CookieDao.removeCookieBucket）。 */
    fun removeCookieBucket(url: String): Boolean

    /** 用响应头的 Set-Cookie 归档（CookieDao.setCookieFromSetCookie）。 */
    fun setCookieFromSetCookie(url: String, setCookieHeader: String): Boolean

    /** 一批主机各自的桶，登录判定热路径用（CookieDao.cookieBucketsForHosts）。 */
    fun cookieBucketsForHosts(hosts: List<String>): List<CookieBucket>
}

/**
 * 书源变量 / 键值存储端口 —— `rules → data` 横穿的「变量组」（4 条）的收口点。
 * 承载 `@put/@get`、`source.putVariable`、`java.getString/put` 这类跨调用存活的脚本变量，
 * 语义必须与 `LoginDao` 的 `saveSourceVariable/getSourceVariable/saveSourceKv/getSourceKv` 一致，
 * 否则跨页规则会静默失效（漫画源「目录取 0 章」老 bug 即源于变量表语义不齐）。
 */
interface VariableStore {
    /** 整份变量写回（BaseSource.putVariable 那份存储）。 */
    fun saveSourceVariable(sourceId: String, variable: String?): Boolean

    /** 读整份变量。 */
    fun getSourceVariable(sourceId: String): String?

    /** 单个键值写。 */
    fun saveSourceKv(sourceId: String, key: String, value: String?): Boolean

    /** 单个键值读。 */
    fun getSourceKv(sourceId: String, key: String): String?
}

/**
 * 书源脚本全局 `cache`（上游 CacheManager）的落盘层端口 —— `rules → data` 的「脚本缓存组」（3 条）。
 * `now` 由调用方显式传入（deadline 判定口径归调用方，接口不 baked 系统时钟）。
 */
interface ScriptCacheStore {
    fun getScriptCache(sourceId: String, key: String, now: Long): String?
    fun putScriptCache(sourceId: String, key: String, value: String, deadline: Long): Boolean
    fun deleteScriptCache(sourceId: String, key: String): Boolean
}

/**
 * 书源登录态（loginInfo / loginHeader）存储端口 —— `rules → data` 的「登录态组」（5 条）。
 * 返回的 [SourceLoginStateRecord] 是 model 纯数据类，端口不引入 data 类型。
 */
interface LoginStateStore {
    fun getSourceLoginState(sourceId: String): SourceLoginStateRecord?
    fun saveSourceLoginInfo(sourceId: String, loginInfo: Map<String, String>): Boolean
    fun saveSourceLoginHeader(sourceId: String, header: String?): Boolean
    fun removeSourceLoginHeader(sourceId: String): Boolean
    fun removeSourceLoginInfo(sourceId: String): Boolean
}

/**
 * 只读投影端口 —— `rules → data` 的「读取组」（4 条）。规则内核按需读源/书架/目录缓存/净化规则，
 * 全部返回 model 纯数据类，端口不引入 data 类型。
 */
interface KernelReader {
    fun getSource(id: String): SourceRecord?
    fun shelfBook(sourceId: String, bookUrl: String): BookshelfItem?
    fun getTocCache(sourceId: String, tocUrl: String): List<Chapter>?
    fun getEnabledReplaceRulesForScope(bookName: String?, sourceUrl: String?, sourceName: String?): List<ReplaceRule>
}
