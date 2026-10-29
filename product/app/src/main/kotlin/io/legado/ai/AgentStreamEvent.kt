package io.legado.ai

import kotlinx.serialization.Serializable

/**
 * 流式对话的一帧。SSE 里以 `data: {json}` 发出，前端按 [type] 分发。
 *
 * 事件序列（正常路径）：
 * `start` → (`delta` | `reasoning`)* → (`tool_start` → `tool_end`)* → `usage`? → `end`
 *
 * 异常路径以 `error` 结束（不会再发 `end`）。**`end.content` 才是最终答案** ——
 * 工具轮次之前的 `delta` 可能是"我先查一下"这类中间话，前端拿到 `end` 后应整体替换，
 * 而不是继续往同一段里追加。
 *
 * 所有字段都可空：不要为了一种事件把所有字段填满。这样协议演进时老前端不会崩。
 */
@Serializable
data class AgentStreamEvent(
    /** start | delta | reasoning | tool_start | tool_end | usage | end | error */
    val type: String,
    /** 形如 `external:<连接id>`；start/end/error 带。 */
    val engine: String? = null,
    /** 模型名；start 带。 */
    val model: String? = null,
    /** delta / reasoning 的增量文本。 */
    val text: String? = null,
    /** tool_start / tool_end 的工具 id。 */
    val toolId: String? = null,
    /** 本次工具调用的协议 id（同一轮同名工具可能不同）。 */
    val callId: String? = null,
    /** tool_start 的参数（值统一转字符串，过长会截断）。 */
    val args: Map<String, String>? = null,
    /** tool_end 的结果状态：ok / error。 */
    val status: String? = null,
    /** tool_end 的结果码；error 事件的错误码。 */
    val code: String? = null,
    /** 给人看的一句话（tool_end 的摘要 / error 的原因）。 */
    val message: String? = null,
    /** tool_end 的执行耗时（毫秒）。 */
    val ms: Long? = null,
    /** usage 事件的累计用量。 */
    val promptTokens: Int? = null,
    val completionTokens: Int? = null,
    val totalTokens: Int? = null,
    /** end 事件的最终文本。 */
    val content: String? = null,
    /** end 事件：本轮执行过的工具（`工具id:结果码`）。 */
    val toolRounds: List<String>? = null,
    /** start/end 事件：本轮注入的技能 id。 */
    val skills: List<String>? = null,
    /** start/end 事件：本轮注入的提示词预设 id（按注入顺序）。 */
    val prompts: List<String>? = null,
    /** start/end 事件：为塞进上下文预算丢掉的旧消息条数。没裁就不出现。 */
    val trimmed: Int? = null,
)
