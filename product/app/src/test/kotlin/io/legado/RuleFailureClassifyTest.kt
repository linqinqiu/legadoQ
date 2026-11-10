package io.legado

import io.legado.http.classifyRuleFailure
import io.legado.ops.NetworkSecurity
import io.legado.rules.RuleExecutionException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 规则执行链的失败分类（2026-11-10 审计的后端第 6 条）。
 *
 * 从前 `respondCatching` 的兜底把任何异常的消息原样塞进 502 响应：SQL 片段、文件路径
 * 都可能出现在界面上；而"书源指向内网被闸门拦下"与"上游站点挂了"长得一模一样。
 */
class RuleFailureClassifyTest {

    @Test
    fun `内网地址被拒要说清是拒绝，不是连不上`() {
        val failure = classifyRuleFailure(
            NetworkSecurity.BlockedAddressException("拒绝访问内网或本机地址"),
        )
        assertEquals(502, failure.status.value)
        assertTrue("要带「被拒绝」这层意思：${failure.body.message}", failure.body.message.orEmpty().contains("拒绝"))
        assertFalse("被拒不是内部细节，不需要走日志替换", failure.leaked)
    }

    @Test
    fun `书源执行失败保留上游原话`() {
        val failure = classifyRuleFailure(RuleExecutionException("上游返回 HTTP 403：需要登录"))
        assertEquals(502, failure.status.value)
        assertTrue(failure.body.message.orEmpty().contains("403"))
    }

    @Test
    fun `其它异常不把内部消息吐给前端`() {
        val failure = classifyRuleFailure(RuntimeException("SQLITE_BUSY: select * from shelf where ..."))
        assertEquals(502, failure.status.value)
        assertFalse(
            "内部消息（SQL / 文件路径）不能出现在响应体里：${failure.body.message}",
            failure.body.message.orEmpty().contains("select"),
        )
        assertTrue("要换成一句人话", failure.body.message.orEmpty().contains("日志"))
        assertTrue("原文只进日志", failure.leaked)
    }
}
