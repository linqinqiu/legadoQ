package io.legado.port

/**
 * 「按端口索取」的载体 —— 规则内核只需要这一组访问器，不需要知道背后是谁。
 *
 * ## 为什么需要它
 *
 * 规则内核（`rules/`）此前直接持有 `data.Database`（宽句柄）。但实测它**从未调用过 `Database` 的
 * 任何一个原始方法** —— 14 处 `asLoginStateStore()`、10 处 `asCookieStore()`、5 处 `asReader()`、
 * 4 处 `asVariableStore()`、3 处 `asScriptCacheStore()`，全部经由适配器访问器取窄端口。
 * 也就是说那条 `rules → data` 横穿**只剩一个类型名**，能力面早就收敛了。
 *
 * 于是这里把这组访问器提成接口：`Database` 实现它，`rules/` 只认它。
 * 这样做的关键好处是 **`Database` 是它的子类型**，所以既有的构造点
 * （`RuleRunner(db)`、`JsSandbox(database = db)`、`ScriptCache.get(..., db)`，共 53 处）
 * **一处都不用改** —— 而如果改成"传入 5 个端口"的写法，这 53 处全要动。
 *
 * ## 边界纪律
 *
 * 本接口只出现在 `port` 包，**不许 import `data`** —— 否则只是把横穿换了个名字。
 * 落地实现（`DatabaseCookieStore` 等）留在 `data/StoreAdapters.kt`，那是 infra 的内部细节。
 *
 * 新增能力时先问：这是**内核真的要用的能力**，还是只是"顺手能拿到"？
 * 前者才该加进这里；后者应该由组合根（`Application.kt`）在装配处接起来。
 */
interface PortBundle {
    /** Cookie 桶读写（含按 URL 取/删）。 */
    fun asCookieStore(): CookieStore

    /** 书源变量与键值的读写。 */
    fun asVariableStore(): VariableStore

    /** 脚本全局 `cache` 的落盘能力。 */
    fun asScriptCacheStore(): ScriptCacheStore

    /** 书源登录态（loginInfo / loginHeader）的读写。 */
    fun asLoginStateStore(): LoginStateStore

    /** 只读投影：书源 / 书架 / 目录缓存 / 生效的净化规则。 */
    fun asReader(): KernelReader
}
