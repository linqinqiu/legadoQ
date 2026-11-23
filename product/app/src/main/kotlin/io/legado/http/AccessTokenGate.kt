package io.legado.http

import io.ktor.http.HttpHeaders
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.createApplicationPlugin
import io.legado.ServerConfig
import io.legado.port.logGuard
import java.security.MessageDigest

/**
 * 鉴权失败：由 `StatusPages` 转成 401 + `ApiError("unauthorized", …)`。
 *
 * 刻意继承 `RuntimeException` 而不是在插件里直接 `respond` —— Ktor 的 `onCall` 不阻断后续
 * pipeline（见 `RequestBodyLimit` 的结论），respond 之后路由处理器仍会跑、写操作照做。
 * 抛异常才真正中止请求。装在 `StatusPages` 之后，异常才会被那条 handler 接走。
 */
internal class UnauthorizedException : RuntimeException("需要访问令牌")

/**
 * 可选的对外访问令牌闸（阶段 3.6 / S3-B）。
 *
 * 语义（未设 token 时**完全无感**，这是"不设身份"产品决策的硬承诺）：
 * - `token == null` / 空：插件 no-op，所有请求零变化 —— 现有全量测试逐字节通过即为证明。
 * - 设了 token：来源 IP 是回环（`isLoopback`）→ 放行（本机界面、容器内自连）；
 *   否则必须带正确凭据 → 放行；缺失/错误 → 抛 [UnauthorizedException] 转 401。
 *
 * 凭据两种形态：
 * - `Authorization: Bearer <token>`（前端 fetch 封装走这条）；
 * - `?token=<token>` 查询参数（EventSource / WebSocket 原生不能自定义请求头，只能走 query；
 *   S1 的 LogRedaction 会把 `?token=` 打码，故不会落进访问日志）。
 *
 * 来源判定用 `call.request.local.remoteHost`（TCP 对端 IP，不可伪造），注入而非现读全局变量，
 * 便于判据喂一个"假装非回环"的判定来端到端验证 401/放行分支；生产用 [ServerConfig.isLoopbackRemote]。
 */
val AccessTokenGate = createApplicationPlugin(
    name = "AccessTokenGate",
    createConfiguration = ::AccessTokenGateConfiguration,
) {
    val token = pluginConfig.token?.takeIf { it.isNotEmpty() }
    val isLoopback = pluginConfig.isLoopback

    // 未设 token：不注册任何拦截器，插件退化成空操作，连请求头都不读，
    // 保证历史行为逐字节不变（"不设身份"产品决策的硬承诺）。
    if (token != null) {
        onCall { call ->
            val remote = call.request.local.remoteHost
            if (isLoopback(remote)) return@onCall
            if (call.hasValidToken(token)) return@onCall
            // 只记"谁/哪个路径被拒"，绝不把 token 值（头或 query）写进日志。
            logGuard(
                "缺少或错误的访问令牌，非回环请求被拒绝",
                mapOf("remote" to remote, "path" to call.request.local.uri.substringBefore('?')),
            )
            throw UnauthorizedException()
        }
    }
}

class AccessTokenGateConfiguration {
    /** null / 空 = 不鉴权。 */
    var token: String? = null

    /** 来源 IP 是否本机；生产注入 [ServerConfig.isLoopbackRemote]，判据可注入假判定。 */
    var isLoopback: (String?) -> Boolean = ServerConfig::isLoopbackRemote
}

/** Bearer 头或 ?token= 命中其一即可；比较用常量时间，避免按响应耗时逐字节猜 token。 */
private fun ApplicationCall.hasValidToken(token: String): Boolean {
    val provided = bearerToken() ?: request.queryParameters["token"] ?: return false
    return constantTimeEquals(provided, token)
}

private fun ApplicationCall.bearerToken(): String? {
    val header = request.headers[HttpHeaders.Authorization]?.trim() ?: return null
    // 用 substring 而不是 removePrefix：后者大小写敏感，"bearer xxx" 会去掉失败。
    if (!header.startsWith("Bearer ", ignoreCase = true)) return null
    return header.substring(7).trim().takeIf { it.isNotEmpty() }
}

/** 等长比较防长度侧信道；`MessageDigest.isEqual` 内部是常量时间比较。 */
private fun constantTimeEquals(a: String, b: String): Boolean {
    val aBytes = a.toByteArray(Charsets.UTF_8)
    val bBytes = b.toByteArray(Charsets.UTF_8)
    return MessageDigest.isEqual(aBytes, bBytes)
}
