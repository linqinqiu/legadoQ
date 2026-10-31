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
        instructionObserverThreshold = GRANULARITY
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
}

object BoundedJs {
    /** 进入一个带墙钟上限的 Rhino Context；用完必须配对 [exit]（与原 `Context.enter()/exit()` 对称）。 */
    fun enter(): Context = (BoundedContextFactory.enter() as BoundedContext).apply {
        deadlineMs = System.currentTimeMillis() + AppConfig.jsTimeoutMs
    }

    fun exit() { Context.exit() }
}
