package io.legado.ai

import java.util.concurrent.ConcurrentHashMap

/**
 * 工具注册表：「AI 能做什么」是运行时可增删的，不是一份写死的 `listOf(...)`。
 *
 * 三条不变量：① id 唯一 —— 重复注册默认拒绝，覆盖必须显式 `replace = true`（静默覆盖会让两个
 * 来源互相踩，排查时看不出谁赢）；② 内置工具摘不掉 —— 只有显式 `allowRemovingBuiltin = true`
 * 才能注销 `BuiltinTools.all()` 那批，防止插件悄悄删掉 `source.delete`；③ 线程安全 ——
 * HTTP 线程与进程内调用方共用，用 `ConcurrentHashMap` 兜住。
 *
 * 这里注册的工具**不产生任何 HTTP 路由**，端点计数照常由 `ApiCatalog.test.ts` 断言守着。
 */
class ToolRegistry(
    builtin: List<Tool> = BuiltinTools.all(),
    private val allowRemovingBuiltin: Boolean = false,
) {

    private val tools = ConcurrentHashMap<String, Tool>()
    private val builtinIds: MutableSet<String> = ConcurrentHashMap.newKeySet()

    init {
        builtin.forEach { t ->
            val id = t.meta.id
            require(id.isNotBlank() && id != "__unset__") { "内置工具必须带 ToolMeta.id：$t" }
            enrichSchema(t)
            require(tools.putIfAbsent(id, t) == null) { "内置工具 id 重复：$id" }
            builtinIds += id
        }
    }

    /** 注册一个工具。id 已存在时返回 false（不覆盖），除非 [replace] 为 true。 */
    fun register(tool: Tool, replace: Boolean = false): Boolean {
        val id = tool.meta.id
        require(id.isNotBlank() && id != "__unset__") {
            "注册工具必须带 ToolMeta.id（用 Tool { … }.also { it.meta = ToolMeta(...) } 贴上）"
        }
        enrichSchema(tool)
        if (!replace) return tools.putIfAbsent(id, tool) == null
        tools[id] = tool
        // replace 一个内置 id 时，它仍然算内置：不许借此把内置工具变成可删的
        if (builtinIds.contains(id)) builtinIds += id
        return true
    }

    /**
     * 工具没自己声明参数时，用 [ToolSchemas] 的集中表补齐。
     *
     * 放在注册表而不是 `BuiltinTools.all()`：`tool.search` / `tool.call` 是
     * [AgentModule] 后注册的，插件工具更是随时进来；只有注册这一处能覆盖全部来源。
     * 工具自己带了 params 就不动它 —— 显式声明优先于集中表。
     */
    private fun enrichSchema(tool: Tool) {
        val meta = tool.meta
        if (meta.id == "__unset__" || meta.params.isNotEmpty()) return
        val params = ToolSchemas.forTool(meta.id)
        if (params.isNotEmpty()) tool.meta = meta.copy(params = params)
    }

    /**
     * 注销一个工具。内置工具默认**拒绝删除**（返回 false），
     * 除非构造时显式 `allowRemovingBuiltin = true` —— 这是防止插件摘掉核心能力的硬门。
     */
    fun unregister(id: String): Boolean {
        if (!allowRemovingBuiltin && builtinIds.contains(id)) return false
        return tools.remove(id) != null
    }

    /** 按 id 取工具；没有就返回 null。 */
    fun find(id: String): Tool? = tools[id]

    /** 当前全部工具（顺序不稳定 —— 需要稳定顺序时用 [snapshot]，它按 id 排序）。 */
    fun all(): List<Tool> = tools.values.toList()

    /**
     * 稳定快照：按 id 排序。
     * `toolManifest()` 对外暴露能力清单时要可复现 —— 顺序随 `ConcurrentHashMap` 迭代漂移，
     * 会让"同一个服务两次返回不同清单"这种假 bug 冒出来。
     */
    fun snapshot(): List<Tool> = tools.values.sortedBy { it.meta.id }

    /** 能力清单（元信息），按 id 排序。 */
    fun manifest(): List<ToolMeta> = snapshot().map { it.meta }

    /** 当前注册数量（含内置）。 */
    fun size(): Int = tools.size

    /** 某个 id 是不是内置工具（外部想判断"我能不能删它"时用）。 */
    fun isBuiltin(id: String): Boolean = builtinIds.contains(id)

    /** 内置工具 id 快照（只读用途）。 */
    fun builtinToolIds(): Set<String> = builtinIds.toSet()
}
