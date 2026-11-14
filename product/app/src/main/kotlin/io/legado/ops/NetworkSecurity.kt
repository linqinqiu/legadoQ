package io.legado.ops

import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ProxySelector
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
     * 受控出站 client 工厂：模块要发请求只能拿这里构造的实例。
     *
     * 两道闸叠在一起，互不依赖：
     * 1. [GuardedHttpClient] 在 send/sendAsync 前做解析期校验（含私网/回环/保留段判定）；
     * 2. 所有请求都经本进程的 [PinnedProxy]（只绑回环）—— 由代理**解析一次并连同一个地址**，
     *    客户端不再自己解析目标域名，DNS TOCTOU 窗口因此关闭。
     *
     * 两个代理实例按 [allowLoopback] 区分：本机模型（Ollama / LM Studio）走放行回环的那个，
     * 其余出站永远走严格那个。不能用全局开关——同一进程里两类调用会互相污染。
     */
    fun newHttpClient(
        connectTimeout: Duration = Duration.ofSeconds(10),
        followRedirects: HttpClient.Redirect = HttpClient.Redirect.NEVER,
        /** 仅 AI 外呼在 `LEGADO_AI_ALLOW_LOOPBACK_BASEURL=1` 时会传 true（本机模型）。 */
        allowLoopback: Boolean = false,
    ): HttpClient {
        val proxy = if (allowLoopback) loopbackProxy else strictProxy
        return GuardedHttpClient(
            HttpClient.newBuilder()
                .proxy(ProxySelector.of(InetSocketAddress(InetAddress.getLoopbackAddress(), proxy.port)))
                .connectTimeout(connectTimeout)
                .followRedirects(followRedirects)
                .build(),
            allowLoopback,
        )
    }

    /** 严格代理：拒一切内网/回环/保留段。懒启动，随进程存活。 */
    private val strictProxy: PinnedProxy by lazy { PinnedProxy(allowLoopback = false).start() }

    /** 放行回环的代理：只给本机模型那条路径用。 */
    private val loopbackProxy: PinnedProxy by lazy { PinnedProxy(allowLoopback = true).start() }

    /**
     * Resolves host IP addresses with in-memory caching and validates that the target
     * is not a local/private network address (an SSRF defense-in-depth check).
     *
     * @throws BlockedAddressException scheme 不对，或解析结果落在内网/本机/保留段
     * @throws UnreachableTargetException 域名解析不了 —— 那是"到不了"，不是"被拒绝"
     */
    fun resolveAndValidateSafeHttpTarget(
        uri: URI,
        serviceName: String = "目标",
        /**
         * 允许回环（本机模型）。打开后**只**放过 127.0.0.0/8 与 ::1，
         * 私网 / 链路本地 / CGNAT / 保留段照旧拒绝。
         */
        allowLoopback: Boolean = false,
    ) {
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
        validateResolvedAddresses(addresses, allowLoopback)
    }

    internal fun validateResolvedAddresses(addresses: Array<InetAddress>, allowLoopback: Boolean = false) {
        if (addresses.isEmpty()) throw UnreachableTargetException("域名没有可用的 DNS 地址")
        for (address in addresses) {
            val loopback = address.isLoopbackAddress ||
                (address.hostAddress?.startsWith("127.") == true)
            if (loopback && allowLoopback) continue
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
        // Treat IPv4-mapped IPv6 as the IPv4 destination it represents. Some resolvers
        // return these as Inet6Address while others normalize them to Inet4Address.
        val mappedV4 = (0..9).all { bytes[it] == 0.toByte() } &&
            bytes[10] == 0xff.toByte() && bytes[11] == 0xff.toByte()
        if (mappedV4) {
            return isSpecialV4(InetAddress.getByAddress(bytes.copyOfRange(12, 16)))
        }
        val first = bytes[0].toInt() and 0xFF
        val second = bytes[1].toInt() and 0xFF
        // fc00::/7（ULA，fd00::/8 实际在用）、ff00::/8（组播）、2001:db8::/32（文档保留）
        if (first == 0xfc || first == 0xfd || first == 0xff) return true
        if (first == 0x20 && second == 0x01 && bytes[2].toInt() == 0x0d && bytes[3].toInt() == 0xb8) return true
        return false
    }
}
