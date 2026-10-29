package io.legado.data

import io.legado.model.CookieBucket
import io.legado.source.WebViewProxy
import java.nio.file.Path
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * `Database` 的按注册域归桶的登录凭据：取、存、合并与 Set-Cookie 解析面（0.8.2 结构重排从 `Database.kt` 逐字拆出）。
 * 写成同包扩展函数：调用点 `database.foo()` 与成员写法逐字一致；连接、`connect`/`write`（internal）、
 * 建表与迁移留在 `Database.kt`。跨包调用这些面需 `import io.legado.data.<方法>`（顶层扩展不是成员）。
 */
/** 书源模板里的地址常带 `{{key}}` / 中文路径，URI 解析会失败，所以裸域名要单独抓。 */
internal val HOST_IN_URL = Regex("""https?://([^/\s"'<>\\:?#]+)""", RegexOption.IGNORE_CASE)

/**
 * 凭据桶的键：注册域（eTLD+1），与上游 `NetworkUtils.getSubDomain(url)` 同口径。
 * `www.a.com` 与 `m.a.com` 因此是同一个桶 —— 「登录一次、同域全都带」就是这么来的。
 */
fun Database.cookieBucket(urlOrHost: String): String {
    val host = runCatching { java.net.URI(urlOrHost).host }.getOrNull()?.takeIf { it.isNotBlank() }
        ?: HOST_IN_URL.find(urlOrHost)?.groupValues?.get(1)?.lowercase()?.trim('.', ' ')
        ?: urlOrHost.trim().lowercase().trim('/').substringBefore('/').substringBefore(':')
    return WebViewProxy.registrableDomain(host)
}

/**
 * 一条 `Cookie` 请求头的字符上限。浏览器与多数网关都在 4 KB 附近截断，
 * 超了不是"少带几个键"而是**整个请求被站点拒掉**（常见表现是 400，且不告诉你为什么）。
 * 借自 legado-with-MD3 的 `CookieStore.getCookie`：它在拼头时同样按 4096 淘汰。
 */
const val MAX_COOKIE_HEADER_CHARS = 4096

/** 库里存的持久凭据（按写入先后）；没有则空。 */
private fun persistentCookiesIn(db: java.sql.Connection, bucket: String): Map<String, String> =
    db.prepareStatement("select cookie from cookie where url = ?").use { stmt ->
        stmt.setString(1, bucket)
        stmt.executeQuery().use { rs ->
            if (rs.next()) parseCookiePairs(rs.getString(1) ?: "") else emptyMap()
        }
    }

/**
 * 合并两层：持久（库里）+ 会话（内存）。**会话覆盖持久** —— 会话层只可能是本次运行里
 * 站点刚发的，比库里那条同名的更该被带出去。
 */
private fun mergedCookieMap(bucket: String, persistent: Map<String, String>): LinkedHashMap<String, String> {
    val merged = LinkedHashMap<String, String>()
    merged.putAll(persistent)
    merged.putAll(SessionCookies.get(bucket))
    return merged
}

/**
 * 按 [MAX_COOKIE_HEADER_CHARS] 淘汰：**保留能装下的那段最新的连续后缀**，返回（要发出的键序, 被丢下的键序）。
 *
 * 为什么留新丢旧：键序就是"最后写入顺序"（见 `setCookieForUrl`），所以头部是最久没被站点
 * 重新发过的。反过来若像第一版那样从头部开始装、装不下就砍尾巴，被砍掉的恰好是刚拿到的
 * 登录态 —— 那比超长本身更糟。
 *
 * 为什么按 MD3 的"随机丢一个"不可取：随机淘汰会让同一个域在两次请求里带出不一致的凭据，
 * 对登录态来说等于偶发掉线，而且复现不了。
 *
 * 最新那一条即使单条就超限也照发：全丢等于必然没有登录态，带着至少还有一次成功的机会；
 * 这种桶会被标成 [CookieBucketState.oversized]，不静默。
 */
private fun composeCookieHeader(map: LinkedHashMap<String, String>): Pair<List<String>, List<String>> {
    val entries = map.entries.toList()
    val newestFirst = ArrayList<String>(entries.size)
    var length = 0
    for (index in entries.indices.reversed()) {
        val key = entries[index].key
        val value = entries[index].value
        // "k=v" 本身，加上与前一条之间的分隔符 "; "。
        val cost = key.length + value.length + 2 + if (newestFirst.isEmpty()) 0 else 2
        if (newestFirst.isNotEmpty() && length + cost > MAX_COOKIE_HEADER_CHARS) break
        newestFirst += key
        length += cost
    }
    val kept = newestFirst.reversed()
    return kept to map.keys.filterNot { kept.contains(it) }
}

/** 读该请求地址所属注册域的凭据（持久 + 会话合并，并按 4096 淘汰）；没有则 null。跨书源共享，与上游一致。 */
fun Database.getCookieForUrl(url: String): String? {
    val bucket = cookieBucket(url)
    if (bucket.isBlank()) return null
    val persistent = connect { db -> persistentCookiesIn(db, bucket) }
    val merged = mergedCookieMap(bucket, persistent)
    if (merged.isEmpty()) return null
    val (kept, _) = composeCookieHeader(merged)
    return kept.joinToString("; ") { "$it=${merged[it]}" }.takeIf { it.isNotBlank() }
}

/**
 * 一个凭据桶的完整状态，给「凭据管理」界面如实交代：哪些来自库里、哪些只是本次会话、
 * 实际会发出哪几条、哪几条因为超过 4096 被丢下。
 */
@Serializable
data class CookieBucketState(
    val domain: String,
    val persistentKeys: List<String> = emptyList(),
    val sessionKeys: List<String> = emptyList(),
    val sentKeys: List<String> = emptyList(),
    val droppedKeys: List<String> = emptyList(),
    /** 实际会发出去的那条 `Cookie` 头有多少字符。 */
    val headerChars: Int = 0,
    /** 只剩一条仍然超过 [MAX_COOKIE_HEADER_CHARS]（照发，但要告诉用户）。 */
    val oversized: Boolean = false,
)

/** 算一个桶的状态。持久层由调用方给（列表接口一次扫全表，不逐桶查库）。 */
private fun bucketState(domain: String, persistent: Map<String, String>): CookieBucketState {
    val session = SessionCookies.get(domain)
    val merged = mergedCookieMap(domain, persistent)
    val (kept, dropped) = composeCookieHeader(merged)
    val header = kept.joinToString("; ") { "$it=${merged[it]}" }
    return CookieBucketState(
        domain = domain,
        persistentKeys = persistent.keys.toList(),
        sessionKeys = session.keys.toList(),
        sentKeys = kept,
        droppedKeys = dropped,
        headerChars = header.length,
        oversized = kept.size <= 1 && header.length > MAX_COOKIE_HEADER_CHARS,
    )
}

/** 全部凭据桶的状态（含只有会话凭据的域）。一次读表，不逐桶查。 */
fun Database.listCookieBucketStates(): List<CookieBucketState> = connect { db ->
    val persistent = LinkedHashMap<String, Map<String, String>>()
    db.prepareStatement("select url, cookie from cookie order by url").use { stmt ->
        stmt.executeQuery().use { rs ->
            while (rs.next()) {
                val domain = rs.getString(1)?.takeIf { it.isNotBlank() } ?: continue
                persistent[domain] = parseCookiePairs(rs.getString(2) ?: "")
            }
        }
    }
    // 只有会话凭据的域也要出现在列表里 —— 否则用户在界面上看不见它，也就撤不掉它。
    (persistent.keys + SessionCookies.domains()).sorted().map { domain ->
        bucketState(domain, persistent[domain] ?: emptyMap())
    }
}

/** 单个域的凭据状态。 */
fun Database.cookieBucketState(urlOrHost: String): CookieBucketState {
    val bucket = cookieBucket(urlOrHost)
    val persistent = if (bucket.isBlank()) emptyMap() else connect { db -> persistentCookiesIn(db, bucket) }
    return bucketState(bucket, persistent)
}

/** 全部凭据桶（域名 + 键数），给「凭据管理」列表用；不返回 Cookie 值本身。 */
fun Database.listCookieBuckets(): List<CookieBucket> = connect { db ->
    db.prepareStatement("select url, cookie from cookie order by url").use { stmt ->
        stmt.executeQuery().use { rs ->
            generateSequence { if (rs.next()) rs.getString(1) to (rs.getString(2) ?: "") else null }
                .map { (domain, value) -> CookieBucket(domain = domain, keys = parseCookieString(value).keys.toList()) }
                .toList()
        }
    }
}

/**
 * 写入持久凭据：**按键合并**（同名覆盖、其余保留），与上游 `CookieStore.mergeCookies` /
 * `restoreCookie` 同语义。整桶替换会让"先粘 Cookie 再补一个 token"丢掉前一次的结果。
 *
 * 合并时把**重设的键挪到尾部**，让存储顺序就是"最后写入顺序"。这不只是为了好看：
 * 超过 [MAX_COOKIE_HEADER_CHARS] 时要从头部丢最旧的，顺序错了就会把刚拿到的登录态丢掉、
 * 留下一堆早没人用的旧值。
 */
fun Database.setCookieForUrl(url: String, cookie: String): Boolean {
    val bucket = cookieBucket(url)
    if (bucket.isBlank()) return false
    val incoming = parseCookieString(cookie)
    if (incoming.isEmpty()) return false
    return write { db ->
        val existing = persistentCookiesIn(db, bucket)
        val merged = LinkedHashMap<String, String>()
        merged.putAll(existing)
        for ((key, value) in incoming) {
            merged.remove(key)
            merged[key] = value
        }
        val value = merged.entries.joinToString("; ") { "${it.key}=${it.value}" }
        db.prepareStatement("""
            insert into cookie(url, cookie, updated_at) values(?, ?, ?)
            on conflict(url) do update set cookie=excluded.cookie, updated_at=excluded.updated_at
        """).use { stmt ->
            stmt.setString(1, bucket)
            stmt.setString(2, value)
            stmt.setLong(3, System.currentTimeMillis())
            stmt.executeUpdate() > 0
        }
    }
}

/**
 * 删掉某个域（传地址或裸域名都行）的整桶凭据 —— **两层一起删**。
 *
 * 只删库会留下一个诡异现象：界面上点了"删除"，列表里这桶还在（会话层没动），
 * 或者下一次请求照样带着那条会话凭据。用户只能重启进程才清干净，那这个按钮就是坏的。
 */
fun Database.removeCookieBucket(url: String): Boolean {
    val bucket = cookieBucket(url)
    if (bucket.isBlank()) return false
    val hadSession = SessionCookies.has(bucket)
    SessionCookies.remove(bucket)
    val removed = write { db ->
        db.prepareStatement("delete from cookie where url = ?").use { stmt ->
            stmt.setString(1, bucket)
            stmt.executeUpdate() > 0
        }
    }
    return removed || hadSession
}

/**
 * 有多少本书源的配置里**写到过**这个域（SQL `instr` 的粗筛，不解析 JSON）。
 * 全局凭据列表用它提示"删掉这桶会影响面有多大" —— 措辞必须是"提到"，
 * 不能说成"会访问"：真正会带的域要解析每本书源才准，代价不该摊到一次列表请求上。
 */
/**
 * 「每个凭据桶被多少书源真正用得上」——一次扫描算出全部桶。
 *
 * 以前是每个桶跑一遍 `instr(lower(payload), ?)`：213 个桶 × 4,876 源（payload 合计 37 MB）
 * 等于把全表小写化 213 遍，实测 `GET /api/cookies` 要 2 分 27 秒，凭据明细界面等于卡死。
 * 现在反过来：每个源的 payload 只扫一次，抽出其中出现过的 http(s) 主机名，归一到注册域再按桶累加。
 * 口径也顺带变准了 —— 老的子串匹配会把「注释里提了一句该域」的源也算进去，
 * 而这里数的是「配置里真有指向该域的地址」，与 `getCookieForUrl` 实际会不会发出去一致。
 */
fun Database.cookieBucketMentions(): Map<String, Int> = connect { db ->
    val counts = HashMap<String, Int>()
    db.prepareStatement("select payload from source").use { statement ->
        statement.executeQuery().use { rs ->
            while (rs.next()) {
                rs.getString(1)
                    .let { text -> HOST_IN_URL.findAll(text).map { it.groupValues[1].substringBefore(':').lowercase() }.toSet() }
                    .map { cookieBucket(it) }
                    .distinct()
                    .forEach { bucket -> counts.merge(bucket, 1, Int::plus) }
            }
        }
    }
    counts
}

/**
 * 从 Set-Cookie 响应头中提取第一个 name=value 对。
 * 整行入库会把 Path / Expires / HttpOnly 等属性误当成 Cookie 一并发送。
 */
fun Database.extractCookiePair(setCookieHeader: String): String? {
    val first = setCookieHeader.substringBefore(';').trim()
    val separator = first.indexOf('=')
    if (separator <= 0) return null
    if (first.substring(0, separator).isBlank()) return null
    return first
}

/** 一条 `Set-Cookie` 该落到哪一层。 */
internal sealed class SetCookieOutcome {
    /** 站点明确给了未来有效期（`Max-Age>0` 或未到的 `Expires`）→ 进库，跨重启留着。 */
    data class Persistent(val pair: String) : SetCookieOutcome()

    /** 没给有效期（或日期读不懂）→ 会话层，进程重启即失效。 */
    data class Session(val pair: String) : SetCookieOutcome()

    /** `Max-Age<=0` 或 `Expires` 已过 —— 站点在说"这条作废"，两层都要撤掉它。 */
    data class Expired(val key: String) : SetCookieOutcome()
}

/**
 * 按 RFC 6265 的属性判定一条 `Set-Cookie` 的归属。
 *
 * 为什么值得为这件事多写一层判定：我们此前把所有 Set-Cookie 一律落库，等于把
 * 站点的"这只是本次会话的临时状态"读成了"永久记住"。CSRF token、登录中间态、
 * 风控一次性 nonce 都是这一类 —— 它们被永久留下之后，下一次访问带着一个早该失效的值，
 * 站点要么回 400，要么把会话踢回未登录。用户看到的就是"昨天还好，今天突然要重新登录"。
 *
 * `Max-Age` 优先于 `Expires`（RFC 也是这个顺序）；`Expires` 读不懂时**按会话处理** ——
 * 宁可少留一条，也不要凭猜把临时状态永久化。
 */
internal fun classifySetCookie(header: String, nowMillis: Long = System.currentTimeMillis()): SetCookieOutcome? {
    val pair = header.substringBefore(';').trim()
    val separator = pair.indexOf('=')
    if (separator <= 0) return null
    val key = pair.substring(0, separator).trim()
    if (key.isBlank()) return null
    val attributes = header.split(';').drop(1).associate { part ->
        val chunk = part.trim()
        val eq = chunk.indexOf('=')
        if (eq > 0) chunk.substring(0, eq).trim().lowercase() to chunk.substring(eq + 1).trim()
        else chunk.lowercase() to ""
    }

    attributes["max-age"]?.toLongOrNull()?.let { maxAge ->
        return if (maxAge <= 0) SetCookieOutcome.Expired(key) else SetCookieOutcome.Persistent(pair)
    }
    attributes["expires"]?.let { raw ->
        val instant = runCatching {
            java.time.ZonedDateTime.parse(raw.trim(), java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME).toInstant()
        }.getOrNull() ?: return SetCookieOutcome.Session(pair)
        return if (instant.toEpochMilli() <= nowMillis) SetCookieOutcome.Expired(key) else SetCookieOutcome.Persistent(pair)
    }
    return SetCookieOutcome.Session(pair)
}

fun Database.setCookieFromSetCookie(url: String, setCookieHeader: String): Boolean {
    val bucket = cookieBucket(url)
    if (bucket.isBlank()) return false
    return when (val outcome = classifySetCookie(setCookieHeader)) {
        null -> false
        is SetCookieOutcome.Persistent -> setCookieForUrl(url, outcome.pair)
        // 会话层：只进内存，重启即失效。返回 true 让调用方的"吸收到几条"照实计数。
        is SetCookieOutcome.Session -> {
            val (key, value) = outcome.pair.substringBefore('=').trim() to outcome.pair.substringAfter('=', "").trim()
            if (key.isBlank()) false else { SessionCookies.put(bucket, mapOf(key to value)); true }
        }
        is SetCookieOutcome.Expired -> removeCookieKey(url, outcome.key)
    }
}

/**
 * 撤掉某个域里的**一个键**（站点用 `Max-Age=0` 表达"这条过期"时走这里）。
 * 两层都撤 —— 只撤一层会留下"删掉了但还在发"的假象。
 */
fun Database.removeCookieKey(url: String, key: String): Boolean {
    val bucket = cookieBucket(url)
    if (bucket.isBlank() || key.isBlank()) return false
    val hadSession = SessionCookies.removeKey(bucket, key)
    val removedPersistent = write { db ->
        val existing = persistentCookiesIn(db, bucket)
        if (!existing.containsKey(key)) return@write false
        val rest = existing.filterKeys { it != key }
        if (rest.isEmpty()) {
            db.prepareStatement("delete from cookie where url = ?").use { stmt ->
                stmt.setString(1, bucket)
                stmt.executeUpdate() > 0
            }
        } else {
            val value = rest.entries.joinToString("; ") { "${it.key}=${it.value}" }
            db.prepareStatement("""
                insert into cookie(url, cookie, updated_at) values(?, ?, ?)
                on conflict(url) do update set cookie=excluded.cookie, updated_at=excluded.updated_at
            """).use { stmt ->
                stmt.setString(1, bucket)
                stmt.setString(2, value)
                stmt.setLong(3, System.currentTimeMillis())
                stmt.executeUpdate() > 0
            }
        }
    }
    return removedPersistent || hadSession
}

/**
 * 某些地址里已经存了凭据 —— 用来回答「这本书源带得出凭据吗」。传入的是该书源
 * 实际会访问的主机（`WebViewProxy.credentialDomains`），逐域去全局表里查桶。
 * 注意语义：**有凭据 ≠ 已登录**，上游也没有"判定登录态"这回事，所以调用方只能说"有/无凭据"。
 */
fun Database.cookieBucketsForHosts(hosts: List<String>): List<CookieBucket> {
    if (hosts.isEmpty()) return emptyList()
    // 会话层也算"有凭据"：只看库会让发现页在明明带着会话凭据时误报"这一栏要登录"。
    val buckets = listCookieBucketStates().associateBy { it.domain }
    return hosts.mapNotNull { host ->
        val state = buckets[cookieBucket(host)] ?: return@mapNotNull null
        CookieBucket(
            domain = state.domain,
            keys = (state.persistentKeys + state.sessionKeys).distinct(),
            sessionKeys = state.sessionKeys,
        )
    }
}

/**
 * 解析任意形态的 Cookie 串（顶层实现）。
 *
 * 为什么不直接是 `Database` 扩展：会话层与合并逻辑（`persistentCookiesIn`、
 * `listCookieBucketStates`）都在数据库之外，它们也要解析同一套格式 —— 两套解析器
 * 迟早对同一个串的判定不一致（本仓库在 Cookie 上栽过一次：登录弹层与落库用的解析不同）。
 */
internal fun parseCookiePairs(cookieStr: String): Map<String, String> {
    val trimmed = cookieStr.trim()
    if (trimmed.isEmpty()) return emptyMap()

    // 1. JSON Array (e.g. Cookie-Editor / EditThisCookie export format)
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        val fromArray = runCatching {
            val array = Json.parseToJsonElement(trimmed).jsonArray
            val map = linkedMapOf<String, String>()
            for (item in array) {
                val obj = item.jsonObject
                val name = (obj["name"] as? JsonPrimitive)?.contentOrNull
                val value = (obj["value"] as? JsonPrimitive)?.contentOrNull
                if (!name.isNullOrBlank() && value != null) {
                    map[name] = value
                }
            }
            map
        }.getOrNull()
        if (!fromArray.isNullOrEmpty()) return fromArray
    }

    // 2. JSON Object (e.g. {"Cookie": "..."} or {"token": "..."})
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        val fromObj = runCatching {
            val obj = Json.parseToJsonElement(trimmed).jsonObject
            if (obj.containsKey("Cookie") || obj.containsKey("cookie")) {
                val c = (obj["Cookie"] ?: obj["cookie"])?.jsonPrimitive?.contentOrNull
                if (!c.isNullOrBlank()) return parseCookiePairs(c)
            }
            val map = linkedMapOf<String, String>()
            for ((k, v) in obj) {
                val value = (v as? JsonPrimitive)?.contentOrNull ?: v.toString()
                if (k.isNotBlank()) map[k] = value
            }
            map
        }.getOrNull()
        if (!fromObj.isNullOrEmpty()) return fromObj
    }

    // 3. Netscape format lines (tab separated)
    val lines = trimmed.lines().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("#") }
    if (lines.isNotEmpty() && lines.any { it.contains("\t") }) {
        val map = linkedMapOf<String, String>()
        for (line in lines) {
            val parts = line.split("\t")
            if (parts.size >= 7) {
                val name = parts[5].trim()
                val value = parts[6].trim()
                if (name.isNotEmpty()) map[name] = value
            }
        }
        if (map.isNotEmpty()) return map
    }

    // 4. Standard key=value; key2=value2 format
    val result = linkedMapOf<String, String>()
    trimmed.split(';').forEach { part ->
        val p = part.trim()
        val eq = p.indexOf('=')
        if (eq > 0) {
            val key = p.substring(0, eq).trim()
            val value = p.substring(eq + 1).trim()
            result[key] = value
        }
    }
    return result
}

/** 既有调用点（登录弹层、JsSandbox、凭据路由）沿用的写法，实现见 [parseCookiePairs]。 */
fun Database.parseCookieString(cookieStr: String): Map<String, String> = parseCookiePairs(cookieStr)
