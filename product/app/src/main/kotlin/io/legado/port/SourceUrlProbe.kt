package io.legado.port

import java.net.URI
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject

/**
 * 书源地址探针 —— 纯函数簇：从书源 JSON 里解析出登录页地址与凭据域清单。
 *
 * 放在 `port`（零 io.legado 依赖的底座）而非 `source/WebViewProxy`，是为了切断
 * `rules ↔ source` 的成环：规则内核此前 import `source.WebViewProxy` 只为拿这两个纯函数，
 * 而 `source` 又反向依赖 `rules`（用它解析）。把纯解析下移到端口层后，`rules` 不再 import `source`。
 *
 * 实现是从 `WebViewProxy` 逐字搬来的，`WebViewProxy.credentialDomains/loginPageUrl` 现委托到这里
 * （单一实现、防漂移）。WebViewProxy 其余方法（allowedDomains / defaultStartUrl 等 Cookie 域名闸）
 * 一律没动，行为不变。
 */
object SourceUrlProbe {
    private val URL_PATTERN = Regex("""https?://[^\s"'<>\\]+""", RegexOption.IGNORE_CASE)
    /** 直接抓主机名，避免书源模板（如 {{key}}）或中文路径导致 URI 解析失败 */
    private val HOST_PATTERN = Regex("""https?://([^/\s"'<>\\:?#]+)""", RegexOption.IGNORE_CASE)
    /** 协议相对地址（`//accounts.example.com/login`），只认确实像主机名那种。 */
    private val PROTOCOL_RELATIVE = Regex("""^//[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?::\d+)?(?:[/?#].*)?$""")

    /** 宽容地取出主机名：先试标准 URI，失败则退回正则（书源 URL 常含 {{}} 模板）。 */
    private fun hostOf(raw: String): String? {
        val value = raw.trim()
        if (value.isEmpty()) return null
        runCatching { URI(value) }.getOrNull()?.host?.takeIf { it.isNotBlank() }?.let { return it }
        return HOST_PATTERN.find(value)?.groupValues?.get(1)?.takeIf { it.isNotBlank() }
    }

    /**
     * 书源静态 `loginUrl` 指向的登录页；`loginUrl` 是 JS 脚本或为空时返回 null。
     * 库内 12 份源把登录地址写成相对路径，按 `bookSourceUrl` 解析；协议相对补 scheme；`/*…*/` 块注释让开。
     */
    fun loginPageUrl(sourceJson: String): String? {
        val obj = runCatching { Json.parseToJsonElement(sourceJson).jsonObject }.getOrNull() ?: return null
        val raw = (obj["loginUrl"] as? JsonPrimitive)?.contentOrNull?.trim().orEmpty()
        if (raw.isEmpty()) return null
        if (raw.startsWith("http://", true) || raw.startsWith("https://", true)) return raw
        val base = (obj["bookSourceUrl"] as? JsonPrimitive)?.contentOrNull?.trim()
            ?.takeIf { it.startsWith("http://", true) || it.startsWith("https://", true) }
            ?: return null
        if (raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/*")) {
            return runCatching { URI(base).resolve(raw).toString() }.getOrNull()
        }
        if (raw.startsWith("./") || raw.startsWith("../")) {
            return runCatching { URI(base).resolve(raw).toString() }.getOrNull()
        }
        if (PROTOCOL_RELATIVE.matches(raw)) {
            return runCatching { URI(base).scheme?.let { scheme -> "$scheme:$raw" } }.getOrNull()
        }
        return null
    }

    /**
     * 这份书源实际会带凭据去访问的主机（完整主机键，非注册域），按「最该登录的排前」：
     * loginUrl 主机 → bookSourceUrl 主机 → 书源里其余地址出现顺序。
     */
    fun credentialDomains(sourceJson: String): List<String> {
        val ordered = linkedSetOf<String>()
        fun add(host: String?) {
            val normalized = host?.trim()?.lowercase()?.trimEnd('.')?.takeIf { it.isNotBlank() && it.contains('.') } ?: return
            ordered.add(normalized)
        }
        val obj = runCatching { Json.parseToJsonElement(sourceJson).jsonObject }.getOrNull()
        listOf("loginUrl", "bookSourceUrl").forEach { key ->
            add((obj?.get(key) as? JsonPrimitive)?.contentOrNull?.let { hostOf(it.trim()) })
        }
        URL_PATTERN.findAll(sourceJson).forEach { match -> add(hostOf(match.value)) }
        return ordered.toList()
    }
}
