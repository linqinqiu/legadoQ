package io.legado.ops

/**
 * 日志脱敏：把凭据从**进日志之前**擦掉，而不是等它落进库再删。
 *
 * 为什么放在这里而不是各调用点：结构化日志的出口只有一个（[LogService.log]），
 * 三条去向（SQLite / 日志文件 / 标准输出）和 `GET /api/logs` 都从那儿走。
 * 在调用点各自记得"别打 token"是维持不住的——`RuleHttp.networkContext` 把整条 URL
 * （含 query）塞进上下文，书源把 `?token=` / `?key=` / `?sign=` 拼在地址上是常态。
 *
 * 规则只按**键名/头名**命中，不做"看起来像随机串"的启发式：
 * 宁可少擦一点，也不能把 `page=2`、`bookUrl=...` 这类排障必需的字段擦掉——
 * 一份定位不到问题的日志，和没有日志是一样的。
 *
 * 顺序有讲究：头名规则自己吞掉 `Bearer`/`Basic` 前缀，所以先擦头、再擦裸凭据；
 * 反过来的话 `Authorization: Bearer x` 会先变成 `Authorization: Bearer ***`，
 * 头规则再命中时留下一个孤零零的 `***`。
 *
 * 幂等：`token=***` 再擦一遍还是 `token=***`。
 */
object LogRedaction {

    /** `Bearer <token>` / `Basic <base64>` 这种裸凭据（常出现在异常消息里）。 */
    private val BEARER_SECRET = Regex("(?i)\\b(bearer|basic)\\s+[A-Za-z0-9\\-._~+/=]{8,}")

    /**
     * 查询串里的敏感键。匹配 `?` / `&` / `;` 之后，**键名整体相等**才算命中
     * （`key=` 命中，`keyword=` 不命中）。
     */
    private val QUERY_SECRET = Regex(
        "(?i)([?&;](?:token|access_token|refresh_token|id_token|api_key|apikey|key|secret|client_secret" +
            "|sign|signature|password|passwd|pwd|auth|authorization|session|sessionid|sid|code)=)[^&#\\s]*",
    )

    /** Cookie 整段都算敏感：`Cookie: sid=1; uid=2` 只留头名。 */
    private val COOKIE_SECRET = Regex("(?i)\\b(cookie|set-cookie)(\\s*[:=]\\s*)[^\\n]*")

    /** 其余凭据头：值取到空白或分隔符为止；`Bearer`/`Basic` 这类前缀连同值一起吃掉。 */
    private val HEADER_SECRET = Regex(
        "(?i)\\b(authorization|x-api-key|x-auth-token|proxy-authorization|apikey|x-feedback-token)(\\s*[:=]\\s*)" +
            "(?:(?:bearer|basic)\\s+)?[^\\s,;]+",
    )

    /** URL 里的 userinfo：`https://user:pass@host/...`。 */
    private val URL_USERINFO = Regex("(?i)(://)[^/@\\s:]+:[^/@\\s]+@")

    /** 统一替换成 `***`；对已经脱敏的文本再跑一遍结果不变。 */
    fun redact(text: String): String {
        if (text.isEmpty()) return text
        var out = text
        out = HEADER_SECRET.replace(out) { "${it.groupValues[1]}${it.groupValues[2]}***" }
        out = COOKIE_SECRET.replace(out) { "${it.groupValues[1]}${it.groupValues[2]}***" }
        out = BEARER_SECRET.replace(out) { "${it.groupValues[1]} ***" }
        out = QUERY_SECRET.replace(out) { "${it.groupValues[1]}***" }
        out = URL_USERINFO.replace(out) { "${it.groupValues[1]}***:***@" }
        return out
    }
}
