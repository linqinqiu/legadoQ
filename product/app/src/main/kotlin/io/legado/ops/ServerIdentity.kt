package io.legado.ops

/**
 * 服务端真实绑定身份：`Application` 启动时写入，同源写门比对它而不是请求头。
 *
 * 为什么住 `ops/` 而不是 `http/`：它是「这台服务自己是谁」这一**基础设施事实**，
 * 不是 HTTP 适配层的细节。`ai/ProviderHttp.kt` 要靠它拒绝「AI 连接打到这台服务自己」
 * （那等于绕过唯一的写保护），而 `ai` 属 infra —— 留在 `http/` 就会让 infra 反向依赖 api。
 * 与 `NetworkSecurity` / `GuardedHttpClient` 同址，见 `docs/architecture-audit.md` §3。
 */
object ServerIdentity {
    @Volatile var host: String = "127.0.0.1"
    @Volatile var port: Int = 1234
    fun init(host: String, port: Int) { this.host = host; this.port = port }
}
