package io.legado.rules

/**
 * `StrUtil.format` 的单遍实现。
 *
 * ## 为什么单独成文件
 *
 * 原来它是 `JavaPackages` 里的三行内联代码：
 *
 * ```kotlin
 * var text = textOf(a.firstOrNull())
 * a.drop(1).forEach { arg -> text = text.replaceFirst("{}", textOf(arg)) }
 * ```
 *
 * 复杂度是 **O(参数个数 × 模板长度)**：每次 `replaceFirst` 都全串扫描并新分配一整串。
 * `format(20 万字的模板, 20000 个参数)` 约 4GB 拷贝，分钟到小时级的纯宿主 CPU；
 * 而整个 `forEach` 在一次 Rhino 调用里完成，`JsGuard` 的 `observeInstructionCount`
 * 一次都不会被回调 —— 墙钟守卫对它是完全失明的。
 *
 * 提成顶层纯函数的好处和 [GzipLimits] 一样：判据可以直接在 Kotlin 里调它，
 * 不必为了测「大输入会不会退化」而先造出一个巨大的 JS 环境。
 *
 * ## 语义必须与原实现一致
 *
 * 原实现逐次 `replaceFirst("{}", arg)`，等价于：
 * - 每个 `{}` 按出现顺序消费下一个参数；
 * - 参数用完后剩下的 `{}` **原样保留**（不是被替换成空串）；
 * - 多余的参数被忽略。
 *
 * 这个语义是兼容性契约 —— 线上已有书源依赖它，不能「顺手改成更合理的」。
 */
object StrUtilFormat {

    /**
     * 把 [template] 里的 `{}` 依次替换为 [argAt] 提供的值。
     *
     * @param argAt 按序号取参数；返回 `null` 表示该位没有参数，此时 `{}` 原样保留。
     */
    fun render(template: String, argAt: (Int) -> String?): String {
        // 没有占位符时直接返回，省掉一次分配（多数调用都是这种）。
        if (!template.contains("{}")) return template

        val out = StringBuilder(template.length)
        var argIndex = 0
        var cursor = 0
        while (true) {
            val at = template.indexOf("{}", cursor)
            if (at < 0) {
                out.append(template, cursor, template.length)
                break
            }
            val arg = argAt(argIndex)
            out.append(template, cursor, at)
            if (arg == null) {
                // 参数用完了：占位符原样保留（与原 `replaceFirst` 行为一致）
                out.append("{}")
            } else {
                out.append(arg)
                argIndex++
            }
            cursor = at + 2
        }
        return out.toString()
    }
}
