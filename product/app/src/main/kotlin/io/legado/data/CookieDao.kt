package io.legado.data

import io.legado.model.CookieBucket
import io.legado.source.WebViewProxy
import java.nio.file.Path
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

/** 读该请求地址所属注册域的凭据；没有则 null。跨书源共享，与上游一致。 */
fun Database.getCookieForUrl(url: String): String? = connect { db ->
    val bucket = cookieBucket(url)
    if (bucket.isBlank()) return@connect null
    db.prepareStatement("select cookie from cookie where url = ?").use { stmt ->
        stmt.setString(1, bucket)
        stmt.executeQuery().use { rs -> if (rs.next()) rs.getString(1)?.takeIf { it.isNotBlank() } else null }
    }
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
 * 写入凭据：**按键合并**（同名覆盖、其余保留），与上游 `CookieStore.mergeCookies` /
 * `restoreCookie` 同语义。整桶替换会让"先粘 Cookie 再补一个 token"丢掉前一次的结果。
 */
fun Database.setCookieForUrl(url: String, cookie: String): Boolean {
    val bucket = cookieBucket(url)
    if (bucket.isBlank()) return false
    val incoming = parseCookieString(cookie)
    if (incoming.isEmpty()) return false
    return write { db ->
        val existing = db.prepareStatement("select cookie from cookie where url = ?").use { stmt ->
            stmt.setString(1, bucket)
            stmt.executeQuery().use { rs -> if (rs.next()) rs.getString(1) else null }
        }
        val merged = linkedMapOf<String, String>()
        if (!existing.isNullOrBlank()) merged.putAll(parseCookieString(existing))
        merged.putAll(incoming)
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

/** 删掉某个域（传地址或裸域名都行）的整桶凭据。 */
fun Database.removeCookieBucket(url: String): Boolean = write { db ->
    db.prepareStatement("delete from cookie where url = ?").use { stmt ->
        stmt.setString(1, cookieBucket(url))
        stmt.executeUpdate() > 0
    }
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

fun Database.setCookieFromSetCookie(url: String, setCookieHeader: String): Boolean {
    val pair = extractCookiePair(setCookieHeader) ?: return false
    return setCookieForUrl(url, pair)
}

/**
 * 某些地址里已经存了凭据 —— 用来回答「这本书源带得出凭据吗」。传入的是该书源
 * 实际会访问的主机（`WebViewProxy.credentialDomains`），逐域去全局表里查桶。
 * 注意语义：**有凭据 ≠ 已登录**，上游也没有"判定登录态"这回事，所以调用方只能说"有/无凭据"。
 */
fun Database.cookieBucketsForHosts(hosts: List<String>): List<CookieBucket> {
    if (hosts.isEmpty()) return emptyList()
    val buckets = listCookieBuckets().associateBy { it.domain }
    return hosts.mapNotNull { host -> buckets[cookieBucket(host)] }
}

fun Database.parseCookieString(cookieStr: String): Map<String, String> {
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
                if (!c.isNullOrBlank()) return parseCookieString(c)
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
