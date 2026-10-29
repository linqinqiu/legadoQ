/**
 * 流式对话的累积器 —— 把 `AgentStreamEvent` 一片片拼成界面要显示的一份快照。
 *
 * 两个入口（设置里的 AI 接入、全站悬浮球）共用同一份逻辑：
 * 事件拼装、错误收敛、断开语义只写一次，两边就不可能对同一个事件有不同解释。
 *
 * 关键取舍：
 * - `delta` 只追加不覆盖；工具轮的"我先查一下"会和最终答案分开 —— 最终文本以 `end.content` 为准。
 * - `tool_start` 先挂"运行中"，`tool_end` 按 `callId` 回填结果；同一轮同名工具也能分清。
 * - 客户端主动停止（AbortSignal）不算错误：返回已经攒下的文本，由调用方决定怎么落库。
 */
import { api, type AgentChatMessage, type AgentChatUsage, type AgentStreamEvent } from '../../lib/api'

export type AgentStreamTool = {
  callId: string
  toolId: string
  status: 'running' | 'ok' | 'error'
  code?: string
  message?: string
  ms?: number
}

export type AgentStreamDraft = {
  /** 已收到的增量文本（工具轮次之前的"我先查一下"也在里面）。 */
  text: string
  /** 思考过程（支持 reasoning 的模型才有）。 */
  reasoning: string
  tools: AgentStreamTool[]
  engine: string
  model: string
  /** 本轮注入的技能 id。 */
  skills: string[]
  usage?: AgentChatUsage
  /** 最终文本：`end.content` 优先，没有 end 时退回增量。 */
  content: string
  toolRounds?: string[]
  error?: { code: string; message: string }
  /** 用户点了停止（或组件卸载导致中断）。 */
  aborted: boolean
  done: boolean
}

export function emptyAgentDraft(): AgentStreamDraft {
  return {
    text: '',
    reasoning: '',
    tools: [],
    engine: '',
    model: '',
    skills: [],
    content: '',
    aborted: false,
    done: false,
  }
}

function applyEvent(draft: AgentStreamDraft, event: AgentStreamEvent): void {
  switch (event.type) {
    case 'start':
      if (event.engine) draft.engine = event.engine
      if (event.model) draft.model = event.model
      if (event.skills) draft.skills = event.skills
      break
    case 'delta':
      if (event.text) draft.text += event.text
      break
    case 'reasoning':
      if (event.text) draft.reasoning += event.text
      break
    case 'tool_start': {
      const callId = event.callId || event.toolId || ''
      const existing = draft.tools.find(tool => tool.callId === callId)
      if (existing) {
        existing.status = 'running'
      } else {
        draft.tools.push({ callId, toolId: event.toolId || callId, status: 'running' })
      }
      break
    }
    case 'tool_end': {
      const callId = event.callId || event.toolId || ''
      let tool = draft.tools.find(item => item.callId === callId)
      if (!tool) {
        tool = { callId, toolId: event.toolId || callId, status: 'ok' }
        draft.tools.push(tool)
      }
      tool.status = event.status === 'error' ? 'error' : 'ok'
      tool.code = event.code
      tool.message = event.message
      tool.ms = event.ms
      break
    }
    case 'usage':
      draft.usage = {
        promptTokens: event.promptTokens,
        completionTokens: event.completionTokens,
        totalTokens: event.totalTokens,
      }
      break
    case 'end':
      draft.done = true
      draft.content = event.content ?? draft.text
      if (event.engine) draft.engine = event.engine
      if (event.skills) draft.skills = event.skills
      if (event.toolRounds) draft.toolRounds = event.toolRounds
      break
    case 'error':
      draft.done = true
      draft.error = {
        code: event.code ?? 'error',
        message: event.message ?? 'AI 请求失败',
      }
      break
    default:
      break
  }
}

function snapshot(draft: AgentStreamDraft): AgentStreamDraft {
  return {
    ...draft,
    tools: draft.tools.map(tool => ({ ...tool })),
    skills: [...draft.skills],
    usage: draft.usage ? { ...draft.usage } : undefined,
    toolRounds: draft.toolRounds ? [...draft.toolRounds] : undefined,
    error: draft.error ? { ...draft.error } : undefined,
  }
}

/**
 * 发一轮流式对话并累积结果。
 *
 * @param onUpdate 每收到一帧就回调一份新快照（浅拷贝，可直接塞进 React state）。
 * @returns 最终快照；`aborted=true` 表示用户中途停止，`error` 只表示真正的失败。
 */
export async function streamAgentChat(
  messages: AgentChatMessage[],
  opts: {
    toolGroups?: string[] | null
    skills?: string[]
    signal?: AbortSignal
    onUpdate?: (draft: AgentStreamDraft) => void
  } = {},
): Promise<AgentStreamDraft> {
  const draft = emptyAgentDraft()
  const publish = () => opts.onUpdate?.(snapshot(draft))
  publish()
  try {
    await api.agentChatStream(messages, {
      toolGroups: opts.toolGroups,
      skills: opts.skills,
      signal: opts.signal,
      onEvent: event => {
        applyEvent(draft, event)
        publish()
      },
    })
  } catch (failure) {
    // AbortError 是用户点"停止"或组件卸载：不算失败，把已收到的文本交回去。
    if (failure instanceof DOMException && failure.name === 'AbortError') {
      draft.aborted = true
    } else {
      throw failure
    }
  }
  if (!draft.done && !draft.aborted) {
    // 服务端没发 end/error 就关流：这是真的断了，不是"回答完了"。
    draft.error = { code: 'stream_closed', message: '连接提前中断，本次回答可能不完整' }
    draft.done = true
  }
  if (!draft.content) draft.content = draft.text
  publish()
  return draft
}
