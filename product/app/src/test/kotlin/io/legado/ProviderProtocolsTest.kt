package io.legado

import io.legado.ai.AgentProfileStore
import io.legado.ai.AnthropicProvider
import io.legado.ai.LlmMessage
import io.legado.ai.LlmToolCall
import io.legado.ai.OpenAiResponsesProvider
import io.legado.ai.ProfileOptions
import io.legado.ai.ProviderHttp
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 新增的两家协议（Anthropic Messages / OpenAI Responses）的纯逻辑判据。
 *
 * 和 `OpenAiCompatibleProviderTest` 同一个思路：把最容易错、又不需要真发请求的部分钉住 ——
 * 地址拼接、请求编码的形状、响应解析、usage 归并、多 key 拆分。
 *
 * 为什么请求编码也要测：这两家不是"换个 URL"，而是**消息形状不同**。
 * Anthropic 要求 system 单独提出来、相邻同角色合并（角色必须交替）、工具结果是 `tool_result` 块；
 * Responses 要求 `input[]` 里混排消息、`function_call`、`function_call_output`。
 * 写错任何一处，表现为上游 400，而错误信息只会说"参数不对"。
 */
class ProviderProtocolsTest {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    private fun profile(
        baseUrl: String? = "https://api.example.com",
        model: String? = "m",
        apiKey: String? = null,
        options: Map<String, String> = emptyMap(),
        kind: AgentProfileStore.ProfileKind = AgentProfileStore.ProfileKind.ANTHROPIC,
    ) = AgentProfileStore.Profile(
        id = "t", name = "测试", kind = kind, baseUrl = baseUrl, apiKey = apiKey, model = model, options = options,
    )

    // ===== 地址拼接 =====

    @Test
    fun `Anthropic 地址拼到 v1 messages 且不重复 v1`() {
        val provider = AnthropicProvider()
        assertEquals("https://api.anthropic.com/v1/messages", provider.endpointUrl(profile("https://api.anthropic.com")))
        assertEquals("https://api.anthropic.com/v1/messages", provider.endpointUrl(profile("https://api.anthropic.com/v1")))
        assertEquals("https://api.anthropic.com/v1/messages", provider.endpointUrl(profile("https://api.anthropic.com/v1/")))
        assertEquals(
            "粘了整条端点也能纠正",
            "https://api.anthropic.com/v1/messages",
            provider.endpointUrl(profile("https://api.anthropic.com/v1/messages")),
        )
        assertNull("空地址返回 null", provider.endpointUrl(profile("  ")))
    }

    @Test
    fun `Responses 地址拼到 v1 responses 且不重复 v1`() {
        val provider = OpenAiResponsesProvider()
        assertEquals("https://api.openai.com/v1/responses", provider.endpointUrl(profile("https://api.openai.com")))
        assertEquals("https://api.openai.com/v1/responses", provider.endpointUrl(profile("https://api.openai.com/v1")))
        assertEquals(
            "https://api.openai.com/v1/responses",
            provider.endpointUrl(profile("https://api.openai.com/v1/responses")),
        )
        assertNull(provider.endpointUrl(profile(null)))
    }

    // ===== Anthropic 响应解析 =====

    @Test
    fun `Anthropic 解析 text 与 tool_use 以及 usage`() {
        val body = """{
            "content":[
              {"type":"text","text":"你好"},
              {"type":"tool_use","id":"toolu_1","name":"source.list","input":{"q":"a"}}
            ],
            "usage":{"input_tokens":10,"output_tokens":5}
        }"""
        val reply = AnthropicProvider().parseReply(body)
        assertEquals("你好", reply.content)
        assertEquals(1, reply.toolCalls.size)
        val call = reply.toolCalls.first()
        assertEquals("toolu_1", call.id)
        assertEquals("source.list", call.name)
        assertEquals("a", call.args["q"])
        assertEquals(10, reply.usage?.promptTokens)
        assertEquals(5, reply.usage?.completionTokens)
        assertEquals("Anthropic 不返回 total，应自己加起来", 15, reply.usage?.totalTokens)
    }

    @Test
    fun `Anthropic 非 JSON 退回原文`() {
        val body = "这不是 JSON"
        assertEquals(body, AnthropicProvider().parseReply(body).content)
    }

    // ===== Anthropic 请求编码 =====

    @Test
    fun `Anthropic system 单独提出来 相邻 user 合并 工具结果是 tool_result 块`() {
        val messages = listOf(
            LlmMessage("system", "规则 A"),
            LlmMessage("system", "规则 B"),
            LlmMessage("user", "帮我查"),
            LlmMessage("assistant", "我查一下", toolCalls = listOf(LlmToolCall("call_1", mapOf("sourceId" to "1"), "source.get"))),
            LlmMessage("tool", "结果 1", toolCallId = "call_1"),
            LlmMessage("tool", "结果 2", toolCallId = "call_2"),
        )
        val root = json.parseToJsonElement(
            AnthropicProvider().encodeRequest(profile(), messages, emptyList(), stream = false),
        ).jsonObject
        assertEquals("多条 system 应合并到顶层 system", "规则 A\n\n规则 B", root["system"]!!.jsonPrimitive.content)
        assertEquals("system 不应出现在 messages 里", 3, root["messages"]!!.jsonArray.size)

        val assistant = root["messages"]!!.jsonArray[1].jsonObject
        assertEquals("assistant", assistant["role"]!!.jsonPrimitive.content)
        val assistantBlocks = assistant["content"]!!.jsonArray
        assertEquals(2, assistantBlocks.size)
        assertEquals("text", assistantBlocks[0].jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals("tool_use", assistantBlocks[1].jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals("call_1", assistantBlocks[1].jsonObject["id"]!!.jsonPrimitive.content)
        assertEquals(
            "参数应编码成 input 对象",
            "1",
            assistantBlocks[1].jsonObject["input"]!!.jsonObject["sourceId"]!!.jsonPrimitive.content,
        )

        val toolUser = root["messages"]!!.jsonArray[2].jsonObject
        assertEquals("tool 结果应进入 user 消息", "user", toolUser["role"]!!.jsonPrimitive.content)
        val toolBlocks = toolUser["content"]!!.jsonArray
        assertEquals("两条 tool 结果应合并进同一条 user 消息", 2, toolBlocks.size)
        assertEquals("tool_result", toolBlocks[0].jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals("call_1", toolBlocks[0].jsonObject["tool_use_id"]!!.jsonPrimitive.content)
        assertEquals("结果 1", toolBlocks[0].jsonObject["content"]!!.jsonPrimitive.content)
    }

    @Test
    fun `Anthropic 开了 thinking 时 max_tokens 必须大于预算`() {
        val root = json.parseToJsonElement(
            AnthropicProvider().encodeRequest(
                profile(options = mapOf("maxTokens" to "1000", "thinking" to "high")),
                listOf(LlmMessage("user", "hi")),
                emptyList(),
                stream = false,
            ),
        ).jsonObject
        assertEquals(4096, root["thinking"]!!.jsonObject["budget_tokens"]!!.jsonPrimitive.content.toInt())
        assertEquals("max_tokens 应抬到预算以上", 5120, root["max_tokens"]!!.jsonPrimitive.content.toInt())
    }

    @Test
    fun `Anthropic 流式请求带 stream 与工具 schema`() {
        val tool = io.legado.ai.ToolMeta("source.list", "sources", "列书源", writes = false)
        val root = json.parseToJsonElement(
            AnthropicProvider().encodeRequest(profile(), listOf(LlmMessage("user", "hi")), listOf(tool), stream = true),
        ).jsonObject
        assertEquals(true, root["stream"]!!.jsonPrimitive.content.toBoolean())
        val tools = root["tools"]!!.jsonArray
        assertEquals(1, tools.size)
        assertEquals("source.list", tools[0].jsonObject["name"]!!.jsonPrimitive.content)
        assertTrue("工具应带 input_schema", tools[0].jsonObject.containsKey("input_schema"))
    }

    // ===== Responses 响应解析 =====

    @Test
    fun `Responses 解析 output 里的 message 与 function_call 以及 usage`() {
        val body = """{
          "output":[
            {"type":"message","content":[{"type":"output_text","text":"答案"}]},
            {"type":"function_call","call_id":"call_x","name":"shelf.list","arguments":"{\"limit\":3}"}
          ],
          "usage":{"input_tokens":7,"output_tokens":2,"total_tokens":9}
        }"""
        val reply = OpenAiResponsesProvider().parseReply(body)
        assertEquals("答案", reply.content)
        assertEquals(1, reply.toolCalls.size)
        assertEquals("call_x", reply.toolCalls.first().id)
        assertEquals("shelf.list", reply.toolCalls.first().name)
        assertEquals("3", reply.toolCalls.first().args["limit"])
        assertEquals(7, reply.usage?.promptTokens)
        assertEquals(9, reply.usage?.totalTokens)
    }

    @Test
    fun `Responses 非 JSON 退回原文`() {
        val body = "<html>502</html>"
        assertEquals(body, OpenAiResponsesProvider().parseReply(body).content)
    }

    // ===== Responses 请求编码 =====

    @Test
    fun `Responses system 变 instructions 工具调用与结果按条目混排`() {
        val messages = listOf(
            LlmMessage("system", "规则"),
            LlmMessage("user", "帮我查"),
            LlmMessage("assistant", "", toolCalls = listOf(LlmToolCall("call_1", mapOf("sourceId" to "1"), "source.get"))),
            LlmMessage("tool", "结果", toolCallId = "call_1"),
        )
        val root = json.parseToJsonElement(
            OpenAiResponsesProvider().encodeRequest(profile(kind = AgentProfileStore.ProfileKind.OPENAI_RESPONSES), messages, emptyList(), stream = true),
        ).jsonObject
        assertEquals("规则", root["instructions"]!!.jsonPrimitive.content)
        val input = root["input"]!!.jsonArray
        assertEquals("user / function_call / function_call_output 三条", 3, input.size)
        assertEquals("user", input[0].jsonObject["role"]!!.jsonPrimitive.content)
        assertEquals("function_call", input[1].jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals("call_1", input[1].jsonObject["call_id"]!!.jsonPrimitive.content)
        assertEquals("source.get", input[1].jsonObject["name"]!!.jsonPrimitive.content)
        assertEquals("function_call_output", input[2].jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals("call_1", input[2].jsonObject["call_id"]!!.jsonPrimitive.content)
        assertEquals(true, root["stream"]!!.jsonPrimitive.content.toBoolean())
    }

    // ===== 共用的连接配置 =====

    @Test
    fun `多 key 逗号分号空白都能拆 并支持 options 追加`() {
        val p = profile(
            apiKey = "k1, k2;k3\nk4",
            options = mapOf("key.5" to "k5", "key.6" to "k1"),
        )
        assertEquals(listOf("k1", "k2", "k3", "k4", "k5"), ProviderHttp.keys(p))
    }

    @Test
    fun `重试与超时配置写错就回默认`() {
        assertEquals(2, ProviderHttp.retries(profile(options = emptyMap())))
        assertEquals(0, ProviderHttp.retries(profile(options = mapOf("retries" to "0"))))
        assertEquals("超出 0..5 视为写错", 2, ProviderHttp.retries(profile(options = mapOf("retries" to "99"))))
        assertEquals(800L, ProviderHttp.backoffMs(profile()))
        assertEquals(1500L, ProviderHttp.backoffMs(profile(options = mapOf("retryBackoffMs" to "1500"))))
        assertEquals(4096, ProfileOptions.maxTokens(emptyMap(), 4096))
        assertEquals(200, ProfileOptions.maxTokens(mapOf("maxTokens" to "200"), 4096))
    }

    @Test
    fun `连接类型解析宽容 大小写下划线混写都认`() {
        assertEquals(
            AgentProfileStore.ProfileKind.OPENAI_COMPATIBLE,
            AgentProfileStore.ProfileKind.parse("OpenAI_Compatible"),
        )
        assertEquals(AgentProfileStore.ProfileKind.ANTHROPIC, AgentProfileStore.ProfileKind.parse("ANTHROPIC"))
        assertEquals(
            AgentProfileStore.ProfileKind.OPENAI_RESPONSES,
            AgentProfileStore.ProfileKind.parse("openai_responses"),
        )
        assertNull(AgentProfileStore.ProfileKind.parse("ollama"))
        assertNull(AgentProfileStore.ProfileKind.parse(null))
    }
}
