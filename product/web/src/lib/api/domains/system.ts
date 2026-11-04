/** 系统相关 API：目录、服务自身、日志、诊断、关于、更新日志。 */
import { request } from '../client'
import type {
  AboutInfo,
  ChangelogRelease,
  LogEntry,
  ServerInfo,
  ServerPortResult,
  SourceHealthCheckResponse,
} from '../types'

/** 系统。 */
export const system = {
  /** 机器可读端点目录。 */
  catalog: () => request<{
    service: string
    version: string
    count: number
    scope: string
    endpoints: Array<{
      method: string
      path: string
      write: boolean
      purpose: string
      group: string
    }>
    howToConnect: {
      baseUrl: string
      auth: string
      contentType: string
      errors: string
      response: string
      note: string
      keys: string
    }
    workflow: string[]
  }>('/api/catalog'),
  /** 服务自身：当前绑的地址与端口。 */
  info: () => request<ServerInfo>('/api/server'),
  /** 改端口：只写安装根的 port.txt，重启后生效。 */
  setPort: (port: number) =>
    request<ServerPortResult>('/api/server/port', {
      method: 'PUT',
      body: JSON.stringify({ port }),
    }),
  /** 日志。 */
  logs: (opts: {
    category?: string
    level?: string
    limit?: number
  } = {}) => {
    const q = new URLSearchParams()
    if (opts.category) q.set('category', opts.category)
    if (opts.level) q.set('level', opts.level)
    q.set('limit', String(opts.limit ?? 200))
    return request<LogEntry[]>(`/api/logs?${q.toString()}`)
  },
  clearLogs: () => request<void>('/api/logs', { method: 'DELETE' }),
  /** 诊断：哪个源在拖慢搜索。 */
  diagnostics: () => request<SourceHealthCheckResponse>('/api/diagnostics'),
  /** 关于：名字、版本、发布仓库。 */
  about: () => request<AboutInfo>('/api/about'),
  checkUpdate: () =>
    request<{
      current: string
      latest?: string | null
      url?: string | null
      publishedAt?: string | null
      repository: string
      status: string
      message?: string | null
      rollingTag?: string | null
      rollingUrl?: string | null
      rollingPublishedAt?: string | null
    }>('/api/about/update-check', { method: 'POST' }),
  /** 更新日志：随包发出的 CHANGELOG.md 原文。 */
  changelog: async (): Promise<string> => {
    const res = await fetch('/api/changelog')
    if (!res.ok) throw new Error(`更新日志读取失败（HTTP ${res.status}）`)
    return res.text()
  },
}
