package io.legado

import io.legado.rules.StrUtilFormat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `StrUtilFormat.render` 的判据。
 *
 * 它替换掉了原来三行内联的 `forEach { text = text.replaceFirst("{}", arg) }`。
 * 那次改动有两个目的是**必须**同时成立的：
 *
 * 1. **复杂度从 O(参数数 × 模板长度) 降到线性** —— 原写法每次替换都全串扫描并新分配整串；
 * 2. **语义一个字节都不能变** —— 线上已有书源依赖它，改写实现不等于可以重新定义行为。
 *
 * 所以下面的判据分两组：先钉语义（含边界），再钉复杂度没有退化。
 */
class StrUtilFormatTest {

    /** 按出现顺序取参数；越界返回 null，表示"这一位没有参数"。 */
    private fun render(template: String, vararg args: String): String {
        var i = 0
        return StrUtilFormat.render(template) { if (i < args.size) args[i++] else null }
    }

    // ───────────────────────── 语义：必须与 replaceFirst 一致 ─────────────────────────

    @Test
    fun `按顺序替换多个占位符`() {
        assertEquals("张三 20 岁", render("{} {} 岁", "张三", "20"))
    }

    @Test
    fun `参数用完后剩下的占位符原样保留`() {
        // 这是最容易写错的一条：`replaceFirst` 只在有参数时才替换，
        // 多余的 `{}` 会**留在原处**，而不是被换成空串。
        assertEquals("x=1 y={}", render("x={} y={}", "1"))
        assertEquals("一个参数都没有时整体原样", "真的{}保留", render("真的{}保留"))
        assertEquals("两个参数填前两个", "a b {}", render("{} {} {}", "a", "b"))
    }

    @Test
    fun `多余的参数被忽略`() {
        assertEquals("只有a", render("只有{}", "a", "b", "c"))
    }

    @Test
    fun `没有占位符时原样返回`() {
        assertEquals("没有占位符", render("没有占位符", "多余"))
    }

    @Test
    fun `空模板返回空串`() {
        assertEquals("", render("", "a"))
    }

    @Test
    fun `相邻占位符不会被吞掉`() {
        // 推进游标时如果写成 `at + 2` 之后又做了 `indexOf` 相对偏移的错误换算，
        // 这里会变成 "ab" 而不是 "a b"。
        assertEquals("ab", render("{}{}", "a", "b"))
        assertEquals("abc", render("{}{}{}", "a", "b", "c"))
    }

    @Test
    fun `参数内容里的花括号不会被当成占位符`() {
        // 替换是单遍扫描模板，参数里的 `{}` 只是被拼接进去的普通文本。
        assertEquals("{x} {}", render("{} {}", "{x}"))
    }

    @Test
    fun `单开或单闭的花括号不被当成占位符`() {
        assertEquals("{ a }", render("{ a }", "x"))
        assertEquals("{ { }", render("{ { }", "x"))
    }

    @Test
    fun `无占位符时直接返回同一个字符串实例`() {
        // 热路径优化：多数调用没有占位符，不该为此分配 StringBuilder。
        val template = "没有占位符的长字符串".repeat(50)
        assertSame("没有占位符时应原样返回同一个实例", template, StrUtilFormat.render(template) { "" })
    }

    // ───────────────────────── 复杂度：不能退化成 O(k×n) ─────────────────────────

    @Test
    fun `参数很多时不会退化成平方复杂度`() {
        // 原实现在这里要拷贝 k × n 个字符。取 k = 5000、模板 20 万字符：
        //   - 线性实现：几十毫秒量级
        //   - 原实现：5000 × 200000 × 每参数剩余长度 ≈ 数百亿字符拷贝，分钟级
        // 阈值放到 10 秒是为了不去赌 CI 机器快慢，只要能排除平方级就够了。
        val placeholder = "{}"
        val template = placeholder.repeat(5000) + "x".repeat(200_000)
        val args = Array(5000) { "v" }
        var i = 0

        val started = System.currentTimeMillis()
        val out = StrUtilFormat.render(template) { if (i < args.size) args[i++] else null }
        val elapsed = System.currentTimeMillis() - started

        assertEquals("结果长度应为 5000 个 v 加 20 万字符", 5000 + 200_000, out.length)
        assertTrue("5000 个占位符 + 20 万字符模板必须在 10 秒内完成，实际 ${elapsed}ms", elapsed < 10_000)
    }

    @Test
    fun `超长模板没有占位符时几乎零成本`() {
        val template = "x".repeat(1_000_000)
        val started = System.currentTimeMillis()
        val out = StrUtilFormat.render(template) { "a" }
        val elapsed = System.currentTimeMillis() - started
        assertEquals(1_000_000, out.length)
        assertTrue("无占位符的大模板不该有复制成本，实际 ${elapsed}ms", elapsed < 500)
    }
}
