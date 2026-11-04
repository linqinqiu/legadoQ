package io.legado.data.db

import io.legado.data.parseCookiePairs
import io.legado.source.WebViewProxy
import java.net.URI
import java.util.regex.Pattern

/**
 * Cookie 桶与解析工具：从 `Database.kt` / `CookieDao.kt` 拆出的纯函数，
 * 不依赖 `Database` 实例，可被 `Migration.kt` 直接调用。
 */

/** URL 中的主机名正则。 */
private val HOST_IN_URL = Pattern.compile("https?://([^/\\s\"'<>\\\\:?#]+)", Pattern.CASE_INSENSITIVE)

/**
 * 从 URL 或裸域名推断注册域桶名。
 *
 * 与 `Database.cookieBucket(urlOrHost)` 逐字一致，但不依赖 `Database` 扩展函数：
 * 只依赖 `WebViewProxy.registrableDomain`。
 */
fun cookieBucket(urlOrHost: String): String {
    val host = runCatching { URI(urlOrHost).host }.getOrNull()?.takeIf { it.isNotBlank() }
        ?: HOST_IN_URL.matcher(urlOrHost).run {
            if (find()) group(1).lowercase().trim('.', ' ') else null
        }
        ?: urlOrHost.trim().lowercase().trim('/').substringBefore('/').substringBefore(':')
    return WebViewProxy.registrableDomain(host)
}

/**
 * 解析 Cookie 字符串为键值映射。
 *
 * 与 `Database.parseCookieString(cookieStr)` 逐字一致，但不依赖 `Database`：
 * 直接复用 `parseCookiePairs`。
 */
fun parseCookieString(cookieStr: String): Map<String, String> =
    parseCookiePairs(cookieStr)
