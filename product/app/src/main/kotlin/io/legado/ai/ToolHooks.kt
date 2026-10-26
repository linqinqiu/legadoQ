package io.legado.ai

import java.util.concurrent.CopyOnWriteArrayList

/**
 * 工具调用的生命周期钩子：审计、限流、改写结果都在工具**外面**做，不必改框架源码。
 *
 * 语义定死：[beforeTool] 返回 null 放行、返回非 null 即拦截（工具不执行，但该结果仍走 [afterTool]
 * —— 拦截也是一种结果，审计要看得见）；[afterTool] 返回 null 保持原结果；[onError] 在框架把异常
 * 转成 error 结果之后回调；多个钩子按注册顺序执行。
 *
 * 红线：钩子只能拒绝或改写，不能替工具绕过 Guardrails（护栏在工具内部）。
 */
class ToolHooks {

    /** 工具执行前。返回非 null 即拦截（该结果直接作为最终返回）。 */
    fun interface Before {
        suspend fun before(tool: ToolMeta, args: ToolArgs): AgentResult?
    }

    /** 工具执行后。返回非 null 即替换工具结果。 */
    fun interface After {
        suspend fun after(tool: ToolMeta, args: ToolArgs, result: AgentResult): AgentResult?
    }

    /** 工具抛异常时（框架已转成 error 结果之后回调，用于日志/告警）。 */
    fun interface OnError {
        suspend fun onError(tool: ToolMeta, args: ToolArgs, error: Throwable, converted: AgentResult)
    }

    private data class Entry(
        val before: Before? = null,
        val after: After? = null,
        val onError: OnError? = null,
    )

    private val entries = CopyOnWriteArrayList<Entry>()

    /**
     * 注册一组钩子。三者都可空 —— 只关心一个阶段就只传一个。
     * 返回一个**注销句柄**，调用它即移除这组钩子（插件卸载时用）。
     */
    fun install(before: Before? = null, after: After? = null, onError: OnError? = null): AutoCloseable {
        val entry = Entry(before, after, onError)
        entries += entry
        return AutoCloseable { entries.remove(entry) }
    }

    /** 当前挂了几组钩子（诊断用）。 */
    fun size(): Int = entries.size

    /** 全部清空（测试与热重载用）。 */
    fun clear() = entries.clear()

    /**
     * 执行 before 链。返回第一个非 null 的拦截结果；全放行则返回 null。
     * 内部用，[Agent] 调用。
     */
    internal suspend fun runBefore(meta: ToolMeta, args: ToolArgs): AgentResult? {
        for (e in entries) {
            val r = e.before?.before(meta, args)
            if (r != null) return r
        }
        return null
    }

    /**
     * 执行 after 链。允许逐层改写：每个钩子的返回值成为下一个钩子的输入。
     * 返回最终结果（没有钩子改写就是传进来的那个）。
     */
    internal suspend fun runAfter(meta: ToolMeta, args: ToolArgs, initial: AgentResult): AgentResult {
        var current = initial
        for (e in entries) {
            val r = e.after?.after(meta, args, current)
            if (r != null) current = r
        }
        return current
    }

    /** 执行 error 链（异常已被转成 error 结果）。异常本身也传下去，方便记录堆栈。 */
    internal suspend fun runOnError(meta: ToolMeta, args: ToolArgs, error: Throwable, converted: AgentResult) {
        for (e in entries) {
            e.onError?.onError(meta, args, error, converted)
        }
    }
}
