package io.legado.ops

import java.io.IOException
import java.net.InetAddress
import java.net.URI
import java.net.UnknownHostException
import java.net.http.HttpClient
import java.time.Duration

/**
 * 自定义 TTS 的专用出站签发点（阶段 3.5 方案 A）。
 *
 * 为什么不能直接用 [NetworkSecurity]：自定义 TTS 的常见用法就是指向本机或局域网的
 * 自建合成服务（`product/docs/ARCHITECTURE.md` 明确写了"有意放行内网"）。严格闸门
 * 会把 `192.168.x.x` / `10.x.x.x` 一起拒掉，等于砍功能。
 *
 * 但"放行内网"不等于"什么都放"：这里仍然封掉**云元数据与链路本地段**——
 * `169.254.0.0/16`（含 `169.254.169.254`）、`fe80::/10`、CGNAT、组播、保留段。
 * 本机与局域网 TTS 照常可用，被诱导填成元数据地址的请求发不出去。
 *
 * 边界：本类只做**发送前**的地址判定，不复用 PinnedProxy，所以仍有 DNS TOCTOU 窗口；
 * 自定义 TTS 是用户自己填的地址，风险面远小于书源/登录页，这个取舍是刻意的。
 */
object CustomTtsClient {

    fun newClient(
        connectTimeout: Duration,
        followRedirects: HttpClient.Redirect = HttpClient.Redirect.NEVER,
    ): HttpClient = HttpClient.newBuilder()
        .connectTimeout(connectTimeout)
        .followRedirects(followRedirects)
        .build()

    /**
     * 每次发请求（含每一跳重定向）前调用。
     *
     * @throws IllegalArgumentException 地址被策略拒绝
     * @throws IOException 域名解析不了
     */
    fun requireAllowed(uri: URI) {
        val scheme = uri.scheme?.lowercase()
        require(scheme == "http" || scheme == "https") { "自定义 TTS 只支持 HTTP(S) 地址" }
        val host = uri.host?.takeIf { it.isNotBlank() }
            ?: throw IllegalArgumentException("自定义 TTS 地址缺少主机名")
        val addresses = try {
            InetAddress.getAllByName(host)
        } catch (error: UnknownHostException) {
            throw IOException("自定义 TTS 域名解析失败：$host", error)
        }
        for (address in addresses) {
            if (isBlocked(address)) {
                throw IllegalArgumentException(
                    "自定义 TTS 拒绝访问链路本地/元数据/保留地址：${address.hostAddress}",
                )
            }
        }
    }

    private fun isBlocked(address: InetAddress): Boolean {
        val bytes = address.address
        if (bytes.size == 16) {
            // IPv4-mapped IPv6 按它代表的 IPv4 判
            val mapped = (0..9).all { bytes[it] == 0.toByte() } &&
                bytes[10] == 0xff.toByte() && bytes[11] == 0xff.toByte()
            if (mapped) {
                return isBlocked(InetAddress.getByAddress(bytes.copyOfRange(12, 16)))
            }
            if (address.isAnyLocalAddress) return true // ::
            if (address.isMulticastAddress) return true
            if (address.isLinkLocalAddress) return true // fe80::/10
            val first = bytes[0].toInt() and 0xFF
            val second = bytes[1].toInt() and 0xFF
            if (first == 0x20 && second == 0x01 &&
                (bytes[2].toInt() and 0xFF) == 0x0d && (bytes[3].toInt() and 0xFF) == 0xb8
            ) {
                return true // 2001:db8::/32 文档保留
            }
            return false // fc00::/7 ULA、::1、公网 IPv6 都放行
        }
        if (address.isAnyLocalAddress || address.isLinkLocalAddress || address.isMulticastAddress) return true
        val host = address.hostAddress ?: return true
        val parts = host.split('.')
        if (parts.size != 4) return true
        val a = parts[0].toIntOrNull() ?: return true
        val b = parts[1].toIntOrNull() ?: return true
        return a == 0 ||                       // 0.0.0.0/8
            (a == 100 && b in 64..127) ||      // CGNAT 100.64/10
            (a == 169 && b == 254) ||          // 链路本地 / 云元数据
            (a == 198 && (b == 18 || b == 19)) || // 基准测试 198.18/15
            a >= 224                            // 组播 224/4 与保留 240/4
    }
}
