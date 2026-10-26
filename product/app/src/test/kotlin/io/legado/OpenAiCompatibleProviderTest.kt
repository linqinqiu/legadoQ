package io.legado

import io.legado.ai.AgentProfileStore
import io.legado.ai.OpenAiCompatibleProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `OpenAiCompatibleProvider` 的两段纯逻辑：**URL 拼接**与**响应解析**。
 *
 * 这两段原来都埋在 `post()` 里（private），没法单独验 —— 而这个类 87 行只有 5 行覆盖，
 * 恰恰漏掉的就是最容易错的两处：
 *
 * - **URL 拼接**：`baseUrl` 带不带 `/v1`、带不带尾斜杠，结果不同。拼错了表现为
 *   所有 AI 对话 502，而错误信息只会说"连不上"，看不出是地址拼错。
 * - **响应解析**：`choices[0].message.content` 的取法、`tool_calls` 的解析、
 *   以及"既没内容也没工具调用"时退回原文 —— 这条兜底是最容易被"优化"掉的。
 *
 * 网络那一半（真的发请求）不打桩：它失败要有可读说法，由 HTTP 层测（AgentRoutesHttpTest）。
 */
class OpenAiCompatibleProviderTest {

    private val provider = OpenAiCompatibleProvider()

    private fun profile(baseUrl: String?, apiKey: String? = null, model: String? = null) =
        AgentProfileStore.Profile(
            id = "test",
            name = "测试",
            kind = AgentProfileStore.ProfileKind.OPENAI_COMPATIBLE,
            baseUrl = baseUrl,
            apiKey = apiKey,
            model = model,
        )

    // ===== URL 拼接 =====

    @Test
    fun `baseUrl 不带 v1 时自动补上`() {
        assertEquals(
            "https://api.example.com/v1/chat/completions",
            provider.endpointUrl(profile("https://api.example.com")),
        )
    }

    @Test
    fun `baseUrl 已带 v1 时不重复拼`() {
        assertEquals(
            "https://api.example.com/v1/chat/completions",
            provider.endpointUrl(profile("https://api.example.com/v1")),
        )
    }

    @Test
    fun `尾斜杠被去掉，不会拼出双斜杠`() {
        assertEquals(
            "https://api.example.com/v1/chat/completions",
            provider.endpointUrl(profile("https://api.example.com/")),
        )
        assertEquals(
            "https://api.example.com/v1/chat/completions",
            provider.endpointUrl(profile("https://api.example.com/v1/")),
        )
    }

    @Test
    fun `前后空白被裁掉`() {
        assertEquals(
            "https://api.example.com/v1/chat/completions",
            provider.endpointUrl(profile("  https://api.example.com  ")),
        )
    }

    @Test
    fun `baseUrl 为空或缺失时返回 null，不拼出半截地址`() {
        assertNull("null 应返回 null", provider.endpointUrl(profile(null)))
        assertNull("空串应返回 null", provider.endpointUrl(profile("")))
        assertNull("纯空白应返回 null", provider.endpointUrl(profile("   ")))
    }

    @Test
    fun `本机地址与自定义端口也能正确拼`() {
        assertEquals(
            "http://127.0.0.1:5591/v1/chat/completions",
            provider.endpointUrl(profile("http://127.0.0.1:5591")),
        )
        assertEquals(
            "http://127.0.0.1:5591/v1/chat/completions",
            provider.endpointUrl(profile("http://127.0.0.1:5591/v1")),
        )
    }

    @Test
    fun `baseUrl 带路径前缀时保留前缀`() {
        // 中转站常见形态：https://gateway.example.com/openai/v1
        assertEquals(
            "https://gateway.example.com/openai/v1/chat/completions",
            provider.endpointUrl(profile("https://gateway.example.com/openai/v1")),
        )
        assertEquals(
            "https://gateway.example.com/openai/v1/chat/completions",
            provider.endpointUrl(profile("https://gateway.example.com/openai")),
        )
    }

    // ===== 响应解析 =====

    @Test
    fun `标准响应取 choices 0 message content`() {
        val body = """{"choices":[{"message":{"role":"assistant","content":"你好，我是模型"}}]}"""
        assertEquals("你好，我是模型", provider.parseReply(body).content)
    }

    @Test
    fun `多 choice 时只取第一个`() {
        val body = """{"choices":[
            {"message":{"content":"第一个"}},
            {"message":{"content":"第二个"}}
        ]}"""
        assertEquals("第一个", provider.parseReply(body).content)
    }

    @Test
    fun `既没 content 也没工具调用时退回响应原文`() {
        // 这是刻意的兜底：有些服务返回非标准结构，把响应吃成空串比返回原文更糟
        val body = """{"choices":[{"message":{"role":"assistant"}}]}"""
        assertEquals("退回原文：$body", body, provider.parseReply(body).content)
    }

    @Test
    fun `非 JSON 响应退回原文`() {
        val body = "这不是 JSON"
        assertEquals(body, provider.parseReply(body).content)
    }

    @Test
    fun `解析 tool_calls：id 取函数名，arguments 解析成扁平键值`() {
        val body = """{"choices":[{"message":{"content":"","tool_calls":[
            {"id":"call_1","function":{"name":"source.list","arguments":"{\"q\":\"abc\",\"limit\":5}"}}
        ]}}]}"""
        val reply = provider.parseReply(body)
        assertEquals("应解析出 1 个工具调用", 1, reply.toolCalls.size)
        val call = reply.toolCalls.first()
        assertEquals("id 应取函数名（框架侧按工具 id 分发）", "source.list", call.id)
        assertEquals("abc", call.args["q"])
        assertEquals("数字也按字符串收（框架侧对未知键宽容）", "5", call.args["limit"])
    }

    @Test
    fun `content 与 tool_calls 同时存在时都保留`() {
        val body = """{"choices":[{"message":{"content":"我先查一下","tool_calls":[
            {"function":{"name":"shelf.list","arguments":"{}"}}
        ]}}]}"""
        val reply = provider.parseReply(body)
        assertEquals("我先查一下", reply.content)
        assertEquals(1, reply.toolCalls.size)
    }

    @Test
    fun `tool_calls 里缺 name 的条目被跳过，不抛异常`() {
        val body = """{"choices":[{"message":{"content":"ok","tool_calls":[
            {"function":{"arguments":"{}"}},
            {"function":{"name":"valid.tool","arguments":"{}"}}
        ]}}]}"""
        val reply = provider.parseReply(body)
        assertEquals("只保留有 name 的那条", 1, reply.toolCalls.size)
        assertEquals("valid.tool", reply.toolCalls.first().id)
    }

    @Test
    fun `arguments 不是合法 JSON 时当空参，不抛`() {
        val body = """{"choices":[{"message":{"content":"ok","tool_calls":[
            {"function":{"name":"t","arguments":"not json"}}
        ]}}]}"""
        val reply = provider.parseReply(body)
        assertEquals(1, reply.toolCalls.size)
        assertTrue("坏 arguments 应回落成空表，不是抛异常", reply.toolCalls.first().args.isEmpty())
    }

    @Test
    fun `arguments 缺失时也当空参`() {
        val body = """{"choices":[{"message":{"content":"ok","tool_calls":[
            {"function":{"name":"t"}}
        ]}}]}"""
        val reply = provider.parseReply(body)
        assertEquals(1, reply.toolCalls.size)
        assertTrue(reply.toolCalls.first().args.isEmpty())
    }

    // ===== parseArgs 单测 =====

    @Test
    fun `parseArgs 只收顶层键，嵌套值转成字符串`() {
        val args = provider.parseArgs("""{"a":"x","b":1,"c":{"nested":true},"d":[1,2]}""")
        assertEquals("x", args["a"])
        assertEquals("1", args["b"])
        // 嵌套对象/数组转字符串 —— 框架侧对未知形状宽容，不在这里做类型推断
        assertTrue("嵌套对象应转成字符串", args["c"] is String)
        assertTrue("数组应转成字符串", args["d"] is String)
    }

    @Test
    fun `parseArgs 遇到非对象或坏 JSON 返回空表`() {
        assertTrue(provider.parseArgs("[]").isEmpty())
        assertTrue(provider.parseArgs("\"just a string\"").isEmpty())
        assertTrue(provider.parseArgs("bad").isEmpty())
        assertTrue(provider.parseArgs("").isEmpty())
    }
}
