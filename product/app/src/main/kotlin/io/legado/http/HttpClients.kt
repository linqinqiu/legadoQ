package io.legado.http

import io.legado.ops.NetworkSecurity
import java.net.URI
import java.net.http.HttpClient
import java.time.Duration

/**
 * 统一出站 HTTP 客户端层：**所有外部请求必须经过这里**。
 *
 * 设计目标:
 * 1. 强制 SSRF 校验 - 每个请求在发包前必过闸门口径
 * 2. 统一配置中心 - 连接超时、重定向策略集中管理
 * 3. DNS 缓存复用 - NetworkSecurity 已有缓存，避免重复解析
 *
 * 使用规则:
 * - **禁止** 直接调用 `HttpClient.newClient()` 或 `NetworkSecurity.newHttpClient()`
 * - **必须** 通过 [create] 工厂方法创建新客户端（隐式经过 SSRF 校验）
 * - **必须** 对 URI 先调用 [validate] 再发起请求
 *
 * 例外情况（需注释理由）:
 * - 内置浏览器代理 (`WebViewProxy`) - 允许访问同源站点
 * - Edge TTS 服务 - 有意放行内网（常见部署场景）
 * - AI 外呼且 `LEGADO_AI_ALLOW_LOOPBACK_BASEURL=1` - 本机模型支持
 */
object HttpClients {
    
    /**
     * 创建受控 HTTP 客户端：**自动集成 NetworkSecurity 闸门**
     * 
     * 配置:
     * - 连接超时：10 秒
     * - 重定向：不自动跟随（防 302 跳内网）
     * - DNS 缓存：5 分钟 TTL（NetworkSecurity 共享）
     * 
     * @param allowLoopback 是否允许访问回环地址（本机模型需要）
     * @return 全新的 HttpClient 实例（建议短生命周期使用）
     */
    fun create(allowLoopback: Boolean = false): HttpClient {
        return NetworkSecurity.newHttpClient(
            connectTimeout = Duration.ofSeconds(10),
            followRedirects = HttpClient.Redirect.NEVER,
            allowLoopback = allowLoopback
        )
    }
    
    /**
     * 验证目标地址安全性
     * 
     * @param uri 要访问的 URI
     * @param serviceName 服务名称（便于日志定位）
     * @throws NetworkSecurity.BlockedAddressException 地址被拒绝（内网/回环/保留段）
     * @throws NetworkSecurity.UnreachableTargetException DNS 解析失败
     */
    fun validate(uri: URI, serviceName: String = "目标") {
        NetworkSecurity.resolveAndValidateSafeHttpTarget(uri, serviceName)
    }
    
    /**
     * 验证并构建完整 URI（含查询参数）
     * 
     * @param baseUrl 基础 URL（不含查询参数）
     * @param params 查询参数
     * @param serviceName 服务名称（便于日志定位）
     * @return 已验证的 URI
     * @throws NetworkSecurity.BlockedAddressException 地址被拒绝
     * @throws NetworkSecurity.UnreachableTargetException DNS 解析失败
     */
    fun validateAndBuildUri(
        baseUrl: String,
        params: Map<String, String>,
        serviceName: String = "目标"
    ): URI {
        val uri = buildUri(baseUrl, params)
        validate(uri, serviceName)
        return uri
    }
    
    /**
     * 构建带查询参数的完整 URI
     */
    private fun buildUri(baseUrl: String, params: Map<String, String>): URI {
        return if (params.isEmpty()) {
            URI.create(baseUrl)
        } else {
            val queryString = params.entries.joinToString("&") { (k, v) ->
                "${java.net.URLEncoder.encode(k, Charsets.UTF_8)}=${java.net.URLEncoder.encode(v, Charsets.UTF_8)}"
            }
            URI.create("$baseUrl?$queryString")
        }
    }
}
