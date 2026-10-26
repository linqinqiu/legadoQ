package io.legado.ai

import io.legado.data.VersionConflict

/**
 * 确认策略：把"批量写是否需要显式确认"这唯一一道**业务默认**抽成可插拔钩子。
 *
 * 框架其余两道护栏（[Guardrails.refuseExternalBind] 地址不可外绑、[Guardrails.catchVersionConflict]
 * 乐观锁冲突转译）是安全 / 正确性的硬约束，**不可**通过此接口放开。
 *
 * 默认实现 [DefaultGuardrailsPolicy] 完全等价于框架历史行为：未显式 `confirm=true` 时拒绝并
 * 要求确认（`confirm_required`）。外部若要"静默放行 / 走自己的人机确认流程"，实现本接口注入即可。
 */
interface GuardrailsPolicy {
    /**
     * 在工具真正落库前询问是否需要确认。
     * 返回 null 表示放行；非 null 是拒绝原因（通常要求调用方带上 `confirm=true` 重试）。
     */
    fun confirm(args: ToolArgs, affectedHint: String): AgentResult?
}

/** 默认确认策略：等价于历史 [Guardrails.requireConfirm] 行为。 */
object DefaultGuardrailsPolicy : GuardrailsPolicy {
    override fun confirm(args: ToolArgs, affectedHint: String): AgentResult? {
        val confirmed = args["confirm"] as? Boolean ?: false
        if (confirmed) return null
        return AgentResult(
            status = "error",
            code = "confirm_required",
            message = "本次操作$affectedHint，需要显式确认（在入参里带上 confirm=true 再调用）。",
        )
    }
}

/**
 * 护栏：AI 在进程内改库前/后都必须过这里。骨架阶段落实三条，都对齐现有 HTTP 行为的语义：
 *
 * 1. 绑定地址不可被移动——[refuseExternalBind] 挡掉任何"把服务搬到 0.0.0.0 / 公网"的意图。
 * 2. 批量删除必须显式确认——[requireConfirm] 防止"删掉所有失效源"被一句话触发。
 * 3. 乐观锁冲突要翻译成 AI 能理解的 [AgentResult]——[catchVersionConflict] 把
 *    [VersionConflict]（HTTP 层是 409 `version_conflict`）包成结构化错误，让上层重试或先读再写。
 *
 * 不在这里做"AI 想不想做"的伦理判断，只落实"现有的写操作本来就有"的那几道闸。
 */
object Guardrails {

    /**
     * 拒绝把服务暴露到非回环地址的意图。返回值 null 表示放行，非 null 是拒绝原因。
     *
     * 注意：`0.0.0.0` 在这里**必须被拒绝**——它代表"监听所有网卡"，等于把整库写权限交给局域网。
     * 真正合法、且是 1234 唯一实际绑定的，只有 `127.0.0.1`（以及 `localhost` / IPv6 回环 `::1`）。
     */
    fun refuseExternalBind(host: String): AgentResult? {
        val normalized = host.lowercase().trim()
        val isLoopback = normalized == "127.0.0.1" || normalized == "localhost" || normalized == "::1"
        return if (isLoopback) null else {
            AgentResult(
                status = "error",
                code = "cross_origin",
                message = "不允许把服务绑定到 $host；本服务只接受回环地址（127.0.0.1），绝不可放开到 0.0.0.0 / 公网。",
            )
        }
    }

    /**
     * 批量写/删动作的统一确认闸。调用方必须在 args 里显式带 `confirm = true` 才放行；
     * 否则返回需要确认的提示，由上层把"将要影响 N 项"如实告诉 AI/用户。
     */
    fun requireConfirm(args: ToolArgs, affectedHint: String): AgentResult? {
        val confirmed = args["confirm"] as? Boolean ?: false
        if (confirmed) return null
        return AgentResult(
            status = "error",
            code = "confirm_required",
            message = "这是一个批量动作（$affectedHint）。请在参数里显式带上 confirm=true 以确认执行；本框架不会在未经确认时批量改动数据。",
        )
    }

    /** 把书源保存时的乐观锁冲突翻译成结构化错误（对应 HTTP 409 version_conflict）。 */
    inline fun <T> catchVersionConflict(block: () -> T): T {
        return try {
            block()
        } catch (conflict: VersionConflict) {
            throw AgentVersionConflict(conflict.message ?: "书源已在别处更新，请先读取最新版本再保存")
        }
    }

    /** 进程内版的 version_conflict，让 [Tool] 能向上抛出、由 [Agent] 统一封包。 */
    class AgentVersionConflict(message: String) : RuntimeException(message)
}
