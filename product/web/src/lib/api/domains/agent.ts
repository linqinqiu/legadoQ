/** AI 自定义接入（/api/agent/*）相关 API。 */
import { request } from '../client'
import type {
  AgentChatMessage,
  AgentChatResult,
  AgentComprehendResult,
  AgentConnection,
  AgentConnectionInput,
  AgentManifest,
  AgentManifestTool,
  AgentMcpServer,
  AgentMcpServerInput,
  AgentModelListResult,
  AgentPrompt,
  AgentPromptInput,
  AgentSkill,
  AgentSkillInput,
  AgentStreamEvent,
  AgentTaskModel,
  AgentTaskModelInput,
} from '../types'

/** 连接管理。 */
export const connections = {
  manifest: () => request<AgentManifest>('/api/agent/manifest'),
  list: () => request<AgentConnection[]>('/api/agent/connections'),
  register: (req: AgentConnectionInput) =>
    request<AgentConnection>('/api/agent/connections', {
      method: 'POST',
      body: JSON.stringify(req),
    }),
  delete: (id: string) =>
    request<{ ok: boolean; removed: string }>(
      `/api/agent/connections/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
}

/** 模型清单探针。 */
export const models = {
  list: (baseUrl: string, apiKey?: string, options?: Record<string, string>, kind?: string) =>
    request<AgentModelListResult>('/api/agent/models', {
      method: 'POST',
      body: JSON.stringify({ baseUrl, apiKey, options, ...(kind ? { kind } : {}) }),
    }),
}

/** 书源双动作（新建 / 校验）。 */
export const agentSources = {
  validate: (json: string) =>
    request<{
      valid: boolean
      errors: string[]
      warnings: string[]
    }>('/api/agent/sources/validate', {
      method: 'POST',
      body: JSON.stringify({ json }),
    }),
  create: (json: string, version?: number) =>
    request<{ id: string; version: number; updatedAt: string }>('/api/agent/sources', {
      method: 'POST',
      body: JSON.stringify({ json, version }),
    }),
}

/** 阅读理解。 */
export const comprehend = (req: {
  text: string
  question?: string
  summarySentences?: number
  topKeywords?: number
}) =>
  request<AgentComprehendResult>('/api/agent/comprehend', {
    method: 'POST',
    body: JSON.stringify(req),
  })

/** 自由对话。`opts.timeoutMs` 给"实测可达"这类短探测用：上游挂住时不该永远转圈。 */
export const chat = (
  messages: AgentChatMessage[],
  toolGroups?: string[] | null,
  skills?: string[],
  disabledTools?: string[],
  opts: { timeoutMs?: number } = {},
) =>
  request<AgentChatResult>('/api/agent/chat', {
    method: 'POST',
    body: JSON.stringify({
      messages,
      ...(toolGroups ? { toolGroups } : {}),
      ...(skills && skills.length > 0 ? { skills } : {}),
      ...(disabledTools && disabledTools.length > 0 ? { disabledTools } : {}),
    }),
  }, opts)

/** 流式对话（SSE）。 */
export const chatStream = async (
  messages: AgentChatMessage[],
  opts: {
    toolGroups?: string[] | null
    skills?: string[]
    disabledTools?: string[]
    signal?: AbortSignal
    onEvent: (event: AgentStreamEvent) => void
  },
): Promise<void> => {
  const response = await fetch('/api/agent/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      messages,
      ...(opts.toolGroups ? { toolGroups: opts.toolGroups } : {}),
      ...(opts.skills && opts.skills.length > 0 ? { skills: opts.skills } : {}),
      ...(opts.disabledTools && opts.disabledTools.length > 0 ? { disabledTools: opts.disabledTools } : {}),
    }),
    signal: opts.signal,
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({ message: response.statusText }))
    throw new Error(err.message ?? `请求失败（${response.status}）`)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('当前浏览器不支持流式读取')
  const decoder = new TextDecoder()
  let buffer = ''
  let finished = false
  try {
    while (!finished) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n')
        if (data) {
          let event: AgentStreamEvent
          try {
            event = JSON.parse(data) as AgentStreamEvent
          } catch {
            throw new Error('流式响应格式无效')
          }
          opts.onEvent(event)
          if (event.type === 'end' || event.type === 'error') finished = true
        }
        if (finished) break
        boundary = buffer.indexOf('\n\n')
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

/** 技能库。 */
export const skills = {
  list: () => request<{ skills: AgentSkill[] }>('/api/agent/skills'),
  save: (req: AgentSkillInput) =>
    request<AgentSkill>('/api/agent/skills', {
      method: 'POST',
      body: JSON.stringify(req),
    }),
  delete: (id: string) =>
    request<{ ok: boolean; removed: string }>(
      `/api/agent/skills/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
}

/** 提示词预设。 */
export const prompts = {
  list: () => request<{ prompts: AgentPrompt[] }>('/api/agent/prompts'),
  save: (req: AgentPromptInput) =>
    request<AgentPrompt>('/api/agent/prompts', {
      method: 'POST',
      body: JSON.stringify(req),
    }),
  delete: (id: string) =>
    request<{ ok: boolean; removed: string }>(
      `/api/agent/prompts/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
}

/**
 * 按任务选模型：对话、摘要与理解、以及每条技能各是一项任务。
 * 保存时 `connectionId` 与 `model` 都留空 = 取消这一项的路由（退回默认连接）。
 */
export const taskModels = {
  list: () => request<{ tasks: AgentTaskModel[] }>('/api/agent/task-models'),
  save: (req: AgentTaskModelInput) =>
    request<{ tasks: AgentTaskModel[] }>('/api/agent/task-models', {
      method: 'POST',
      body: JSON.stringify(req),
    }),
}

/**
 * 外部 MCP 服务：接上之后它的工具会挂进能力清单（组名 `mcp`）。
 *
 * 保存即尝试握手，所以 `save` 返回的就是"这一刻通没通"；`refresh` 是全部重连一遍，
 * 用于服务重启过、或上次保存时它还没起来。
 */
export const mcp = {
  list: () => request<{ group: string; servers: AgentMcpServer[] }>('/api/agent/mcp'),
  save: (req: AgentMcpServerInput) =>
    request<AgentMcpServer>('/api/agent/mcp', {
      method: 'POST',
      body: JSON.stringify(req),
    }),
  refresh: () =>
    request<{ group: string; servers: AgentMcpServer[] }>('/api/agent/mcp/refresh', {
      method: 'POST',
    }),
  delete: (id: string) =>
    request<{ deleted: string }>(`/api/agent/mcp/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}
