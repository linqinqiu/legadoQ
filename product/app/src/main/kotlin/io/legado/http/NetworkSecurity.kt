package io.legado.http

import java.net.InetAddress
import java.net.URI
import java.net.http.HttpClient
import java.time.Duration
import java.util.concurrent.ConcurrentHashMap

object NetworkSecurity {
    private const val DNS_CACHE_TTL_MS = 5 * 60 * 1000L // 5 minutes
    private const val MAX_DNS_CACHE_SIZE = 2000

    /**
     * 「这个地址被安全策略拒绝」—— 地址填错了/越界了，是**客户端可修**的问题（HTTP 层该回 4xx）。
     *
     * 与下面那个的区分是本轮修复的核心：从前两者都抛裸的 `IllegalArgumentException`，
     * 上层只能一把抓，于是"域名打错一个字母"被报成"你的请求非法"（实测 500 + invalid_request），
     * 而"填了内网地址"在另一条路径上又被报成"连不上"（502）——
     * 两件修法完全不同的事互相顶包，用户照着报错去查网络，真相是他自己填的地址。
     */
    class BlockedAddressException(message: String) : IllegalArgumentException(message)

    /**
     * 「地址本身没问题，但这台机器到不了它 / 域名解析不了」—— 上游/网络问题（HTTP 层该回 502）。
     *
     * 故意**不是** [BlockedAddressException] 的子类：所有按"被拒绝"来 catch 的既有代码
     * （AI 外呼、书源、订阅、封面、媒体代理）都不该再把 DNS 失败当拒绝处理。
     * 也不继承 IllegalArgumentException：那样"catch 非法参数"的旧写法会继续把它吞成 4xx。
     */
    class UnreachableTargetException(message: String, cause: Throwable? = null) : java.io.IOException(message, cause)

    private data class CachedDns(val addresses: Array<InetAddress>, val expiresAt: Long)
    private val dnsCache = ConcurrentHashMap<String, CachedDns>()

    fun clearCache() {
        dnsCache.clear()
    }

    fun cacheSize(): Int = dnsCache.size

    /**
     * 受控出站 client 工厂：模块要发请求只能拿这里构造的实例，
     * 每个请求在真正发包前都要过 [resolveAndValidateSafeHttpTarget]，并对解析后的 IP 复查私网/回环
     * （防 DNS 重绑定）。[GuardedHttpClient] 负责在 send/sendAsync 前施加这道闸门。
     */
    fun newHttpClient(
        connectTimeout: Duration = Duration.ofSeconds(10),
        followRedirects: HttpClient.Redirect = HttpClient.Redirect.NEVER,
    ): HttpClient = GuardedHttpClient(
        HttpClient.newBuilder()
            .connectTimeout(connectTimeout)
            .followRedirects(followRedirects)
            .build(),
    )

    /**
     * Resolves host IP addresses with in-memory caching and validates that the target
     * is not a local/private network address (preventing SSRF).
     *
     * @throws BlockedAddressException scheme 不对，或解析结果落在内网/本机/保留段
     * @throws UnreachableTargetException 域名解析不了 —— 那是"到不了"，不是"被拒绝"
     */
    fun resolveAndValidateSafeHttpTarget(uri: URI, serviceName: String = "目标") {
        if (uri.scheme !in setOf("http", "https") || uri.host.isNullOrBlank()) {
            throw BlockedAddressException("仅允许 HTTP(S) $serviceName 地址")
        }
        val host = uri.host.lowercase()
        val now = System.currentTimeMillis()
        val cached = dnsCache[host]
        val addresses = if (cached != null && cached.expiresAt > now) {
            cached.addresses
        } else {
            val resolved = runCatching { InetAddress.getAllByName(host) }.getOrElse {
                throw UnreachableTargetException("无法解析 $serviceName 域名: $host（${it.message ?: "DNS解析失败"}）", it)
            }
            if (dnsCache.size > MAX_DNS_CACHE_SIZE) {
                dnsCache.clear()
            }
            dnsCache[host] = CachedDns(resolved, now + DNS_CACHE_TTL_MS)
            resolved
        }
        for (address in addresses) {
            if (address.isAnyLocalAddress || address.isLoopbackAddress || address.isLinkLocalAddress || address.isSiteLocalAddress || address.hostAddress == "169.254.169.254") {
                throw BlockedAddressException("拒绝访问内网或本机地址")
            }
            // 上面 JDK 内建的判定有洞（0.6.23 补齐）：siteLocal 只认 fec0::/10 旧 site-local，
            // fc00::/7 ULA、CGNAT 100.64/10、基准测试 198.18/15、组播与保留段都会漏进内网。
            if (isSpecialV4(address) || isSpecialV6(address)) {
                throw BlockedAddressException("拒绝访问内网或本机地址")
            }
        }
    }

    private val V4 = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$")

    internal fun isSpecialV4(address: InetAddress): Boolean {
        val host = address.hostAddress ?: return false
        val m = V4.find(host) ?: return false
        val g = m.groupValues
        val a = g.getOrNull(1)?.toIntOrNull() ?: return false
        val b = g.getOrNull(2)?.toIntOrNull() ?: return false
        if (a > 255 || b > 255) return false
        return a == 0 || a == 10 || a == 127 ||
            (a == 100 && b in 64..127) ||          // CGNAT 100.64.0.0/10
            (a == 172 && b in 16..31) ||           // RFC1918
            (a == 192 && b == 168) ||              // RFC1918
            (a == 169 && b == 254) ||              // 链路本地（JDK 已判，双保险）
            (a == 198 && (b == 18 || b == 19)) ||  // 基准测试 198.18.0.0/15
            (a >= 224)                             // 组播 224/4 与保留 240/4
    }

    internal fun isSpecialV6(address: InetAddress): Boolean {
        if (address.hostAddress?.contains(':') != true) return false
        val bytes = address.address
        if (bytes.size != 16) return false
        val first = bytes[0].toInt() and 0xFF
        val second = bytes[1].toInt() and 0xFF
        // fc00::/7（ULA，fd00::/8 实际在用）、ff00::/8（组播）、2001:db8::/32（文档保留）
        if (first == 0xfc || first == 0xfd || first == 0xff) return true
        if (first == 0x20 && second == 0x01 && bytes[2].toInt() == 0x0d && bytes[3].toInt() == 0xb8) return true
        return false
    }
}
