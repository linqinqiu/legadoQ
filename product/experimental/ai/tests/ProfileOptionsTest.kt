package io.legado

import io.legado.ai.AgentProfileStore
import io.legado.ai.ProfileOptions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 连接档案 `options` 字段的判据 —— 借鉴自上游 `legado-with-MD3` 的两件事。
 *
 * 背景：`Profile.options` 从前是**死字段**（只写不读）。上游有两处做得比我们细，
 * 都落在"每个连接自己的配置"上：
 * - AI 供应商支持自定义请求头
 * - 模型思考强度五档（OpenAI 标准 low/medium/high/xhigh/max）
 *
 * 这组判据钉住的是**解析契约**：key 怎么写、危险头怎么挡、写错了怎么办。
 */
class ProfileOptionsTest {

    private fun profile(options: Map<String, String>) = AgentProfileStore.Profile(
        id = "t", name = "测试", kind = AgentProfileStore.ProfileKind.OPENAI_COMPATIBLE,
        baseUrl = "http://127.0.0.1:9/v1", apiKey = "", model = "m", options = options,
    )

    // ========== 自定义请求头 ==========

    @Test
    fun `自定义请求头 按 header_ 前缀读出来`() {
        val headers = ProfileOptions.headers(mapOf(
            "header.X-Api-Key" to "secret",
            "header.X-Org" to "org-1",
        ))
        assertEquals(2, headers.size)
        assertEquals("secret", headers["X-Api-Key"])
        assertEquals("org-1", headers["X-Org"])
    }

    @Test
    fun `自定义请求头 没有配置就是空`() {
        assertTrue(ProfileOptions.headers(emptyMap()).isEmpty())
        assertTrue(ProfileOptions.headers(mapOf("thinking" to "high")).isEmpty())
    }

    @Test
    fun `自定义请求头 危险头被挡掉 —— 不许用户改坏框架自己的头`() {
        val headers = ProfileOptions.headers(mapOf(
            "header.Content-Type" to "text/plain",     // 改坏 body 解析
            "header.Authorization" to "Bearer other",  // 与 apiKey 两处漂移
            "header.Host" to "evil.example.com",       // JDK 自己算
            "header.Content-Length" to "999",          // JDK 自己算
            "header.X-Ok" to "fine",                   // 这个该留
        ))
        assertEquals("只应留下 X-Ok", 1, headers.size)
        assertEquals("fine", headers["X-Ok"])
    }

    @Test
    fun `自定义请求头 挡的是大小写不敏感的`() {
        val headers = ProfileOptions.headers(mapOf(
            "header.content-type" to "x",
            "header.CONTENT-TYPE" to "y",
            "header.Origin" to "ok",
        ))
        assertEquals(1, headers.size)
        assertTrue(headers.containsKey("Origin"))
    }

    @Test
    fun `自定义请求头 空名字的头被忽略`() {
        val headers = ProfileOptions.headers(mapOf("header." to "value", "header.X-Real" to "v"))
        assertEquals(1, headers.size)
        assertEquals("v", headers["X-Real"])
    }

    // ========== 思考强度 ==========

    @Test
    fun `思考强度 五个档位都认`() {
        for ((raw, expected) in listOf(
            "low" to ProfileOptions.Thinking.LOW,
            "medium" to ProfileOptions.Thinking.MEDIUM,
            "high" to ProfileOptions.Thinking.HIGH,
            "xhigh" to ProfileOptions.Thinking.XHIGH,
            "max" to ProfileOptions.Thinking.MAX,
        )) {
            assertEquals("档位 $raw", expected, ProfileOptions.thinking(mapOf("thinking" to raw)))
        }
    }

    @Test
    fun `思考强度 大小写与空白都宽容`() {
        assertEquals(ProfileOptions.Thinking.HIGH, ProfileOptions.thinking(mapOf("thinking" to "  HIGH  ")))
        assertEquals(ProfileOptions.Thinking.LOW, ProfileOptions.thinking(mapOf("thinking" to "Low")))
    }

    @Test
    fun `思考强度 没设或写错返回 null 不改变请求`() {
        assertNull("没设", ProfileOptions.thinking(emptyMap()))
        assertNull("写错", ProfileOptions.thinking(mapOf("thinking" to "ultra")))
        assertNull("空串", ProfileOptions.thinking(mapOf("thinking" to "   ")))
    }

    @Test
    fun `思考强度 线上值就是 OpenAI 那五个字`() {
        // 序列化出去必须是 OpenAI 认的拼写，不能是我们自己的枚举名
        assertEquals("low", ProfileOptions.Thinking.LOW.wire)
        assertEquals("medium", ProfileOptions.Thinking.MEDIUM.wire)
        assertEquals("high", ProfileOptions.Thinking.HIGH.wire)
        assertEquals("xhigh", ProfileOptions.Thinking.XHIGH.wire)
        assertEquals("max", ProfileOptions.Thinking.MAX.wire)
    }

    // ========== 超时 ==========

    @Test
    fun `超时 配了就用配的`() {
        assertEquals(5000L, ProfileOptions.timeoutMs(mapOf("timeoutMs" to "5000")))
    }

    @Test
    fun `超时 没配或非法返回 null 用默认`() {
        assertNull(ProfileOptions.timeoutMs(emptyMap()))
        assertNull("非数字", ProfileOptions.timeoutMs(mapOf("timeoutMs" to "abc")))
        assertNull("零", ProfileOptions.timeoutMs(mapOf("timeoutMs" to "0")))
        assertNull("负数", ProfileOptions.timeoutMs(mapOf("timeoutMs" to "-1")))
    }

    // ========== 组合：一个真实的中转站配置 ==========

    @Test
    fun `组合 中转站的典型配置能一次读全`() {
        val p = profile(mapOf(
            "header.X-Api-Key" to "sk-relay",
            "header.X-Relay-Region" to "cn",
            "thinking" to "medium",
            "timeoutMs" to "60000",
        ))
        val headers = ProfileOptions.headers(p.options)
        assertEquals(2, headers.size)
        assertEquals(ProfileOptions.Thinking.MEDIUM, ProfileOptions.thinking(p.options))
        assertEquals(60000L, ProfileOptions.timeoutMs(p.options))
    }
}
