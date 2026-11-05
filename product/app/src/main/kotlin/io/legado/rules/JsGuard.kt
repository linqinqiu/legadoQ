package io.legado.rules

import org.mozilla.javascript.Context
import org.mozilla.javascript.ContextFactory
import org.mozilla.javascript.EvaluatorException
import io.legado.AppConfig

/**
 * 书源 JS / 规则脚本是**不可信**的：一条 `while(true)` 或 `for(;;)` 就能占死一条工作线程
 * （DoS）。Rhino 的解释器会周期性回调 `observeInstructionCount`，据此做一层**墙钟上限**守卫：
 * 每 [GRANULARITY] 条指令检查一次是否超过 [AppConfig.jsTimeoutMs]，超时即抛错中断这次执行。
 *
 * 只在解释模式（`optimizationLevel = -1`，两处调用点都设了）下观察器会触发；合法规则都是
 * 毫秒级、远低于默认 30 秒上限，绝不会被误伤——这道闸只拦失控/死循环。
 */
private class BoundedContext : Context() {
    @Volatile var deadlineMs: Long = Long.MAX_VALUE
    override fun observeInstructionCount(instructionCount: Int) {
        if (System.currentTimeMillis() > deadlineMs) {
            throw EvaluatorException("书源 JS 执行超过 ${AppConfig.jsTimeoutMs}ms 上限，已中断（疑似死循环）")
        }
    }
}

private object BoundedContextFactory : ContextFactory() {
    override fun makeContext(): Context = BoundedContext().apply {
        /**
         * 解释模式（`-1`）。**必须在设 `maximumInterpreterStackDepth` 之前设**，否则 Rhino 抛
         * `IllegalStateException: Cannot set maximumInterpreterStackDepth outside interpreted mode`。
         *
         * 同时这也是墙钟守卫的**前提**：`observeInstructionCount` 只在解释模式下会被周期回调，
         * 编译模式下 Rhino 走字节码，观察器永远不触发 —— 那样 `deadlineMs` 就是一纸空文。
         *
         * 从前靠"两处调用点各自记得设 optimizationLevel"来保证，等于把一条安全前提押在
         * 调用方的自觉上；现在收回 factory 里，任何走 `BoundedJs.enter()` 的路径都自动带上。
         */
        optimizationLevel = -1
        instructionObserverThreshold = GRANULARITY
        /**
         * 递归爆栈保护。
         *
         * 墙钟守卫（[BoundedContext.observeInstructionCount]）拦得住死循环，拦不住**深度递归**：
         * `f(n) = f(n-1) + 1` 每层只消耗极少指令，20_000 条指令的检查间隔足够它把解释器栈推爆 ——
         * 那时抛的是 `StackOverflowError`（`Error` 不是 `Exception`，`runCatching` 兜不住），
         * 能把整条工作线程打掉。
         *
         * 1000 取自上游 `legado-with-MD3`（`modules/rhino/.../RhinoScriptEngine.kt` 的
         * `cx.maximumInterpreterStackDepth = 1000`），那里已在移动端跑过真实书源池。
         */
        maximumInterpreterStackDepth = MAX_INTERPRETER_STACK_DEPTH
        /**
         * 显式对齐上游的语言版本（`modules/rhino` 的 `RhinoScriptEngine` 与 `AnalyzeUrl`
         * 都设 `Context.VERSION_ES6`）。
         *
         * 别误读成"这行修了个 bug"：把这行注掉跑 `JsEs6SyntaxTest` 照样绿 ——
         * Rhino 当前的**默认版本已经能解析**箭头函数与模板字符串
         * （启用库里 665 份源写 `=>`、429 份写 `${}`，它们本来就一直在跑）。
         * 显式设它是不把行为押在库的默认值上：升级 Rhino 时默认版本可能变，
         * 那时这批脚本会一夜之间全红，而没人想得起来原因。
         */
        languageVersion = Context.VERSION_ES6
    }

    private const val GRANULARITY = 20_000
    private const val MAX_INTERPRETER_STACK_DEPTH = 1000
}

object BoundedJs {
    /** 进入一个带墙钟上限的 Rhino Context；用完必须配对 [exit]（与原 `Context.enter()/exit()` 对称）。 */
    fun enter(): Context = (BoundedContextFactory.enter() as BoundedContext).apply {
        deadlineMs = System.currentTimeMillis() + AppConfig.jsTimeoutMs
    }

    fun exit() { Context.exit() }
}
