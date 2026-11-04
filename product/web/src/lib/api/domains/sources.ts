/** 书源、Cookie、登录、内置浏览器、发现页相关 API。 */
import { request } from '../client'
import type {
  BatchSourceAction,
  BatchSourceResponse,
  BookSearchHit,
  SourceBrowserCookies,
  SourceBrowserSession,
  SourceCredentialStatus,
  SourceHealthCheckItem,
  SourceHealthCheckResponse,
  SourceLoginActionResult,
  SourceLoginCheckResult,
  SourceLoginUiActionResponse,
  SourceLoginUiRenderResponse,
  SourceLoginUiResponse,
  SourceRecord,
  SourceSummary,
  SearchResult,
  ImportResponse,
  SourceSubscription,
} from '../types'

/** 全局 inflight 书源清单请求，避免同一份数据重复请求。 */
let sourcesInflight: Promise<SourceSummary[]> | null = null

const fetchSources = (query = '') => {
  if (query) return request<SourceSummary[]>(`/api/sources?q=${encodeURIComponent(query)}`)
  if (!sourcesInflight) {
    sourcesInflight = request<SourceSummary[]>('/api/sources?q=').finally(() => {
      sourcesInflight = null
    })
  }
  return sourcesInflight
}

/** 书源自定义排序：屏幕上这一列按新顺序整段回传。 */
export const sources = {
  list: (query = '') => fetchSources(query),
  get: (id: string) => request<SourceRecord>(`/api/sources/${encodeURIComponent(id)}`),
  save: (id: string, json: string, version?: number) =>
    request<SourceRecord>(`/api/sources/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ json, version }),
    }),
  remove: (id: string) =>
    request<void>(`/api/sources/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  batch: (action: BatchSourceAction, ids: string[], group?: string) =>
    request<BatchSourceResponse>('/api/sources/batch', {
      method: 'POST',
      body: JSON.stringify({ action, ids, group }),
    }),
  healthCheck: (ids?: string[], timeoutMs = 5000) =>
    request<SourceHealthCheckResponse>('/api/sources/health-check', {
      method: 'POST',
      body: JSON.stringify({ ids, timeoutMs }),
    }),
  reorder: (ids: string[]) =>
    request<{ updated: number }>('/api/sources/order', {
      method: 'PUT',
      body: JSON.stringify({ ids }),
    }),
  clearOrder: () => request<{ updated: number }>('/api/sources/order', { method: 'DELETE' }),
  export: (ids?: string[]) =>
    request<string[]>(
      `/api/sources/export${ids && ids.length > 0 ? `?${ids.map((id) => `id=${encodeURIComponent(id)}`).join('&')}` : ''}`,
    ),
  import: (sources: string[]) =>
    request<{ imported: number; updated: number; skipped: number; errors: string[] }>(
      '/api/sources/import',
      { method: 'POST', body: JSON.stringify({ sources }) },
    ),
  validate: (id: string, draftJson?: string) =>
    request<{
      valid: boolean
      errors: string[]
      warnings: string[]
    }>(`/api/sources/${encodeURIComponent(id)}/validate`, {
      method: 'POST',
      body: JSON.stringify(draftJson ? { json: draftJson } : {}),
    }),
  /** 分阶段调试是 SSE 流，交给 EventSource 自己开，这里只负责拼地址。 */
  debugStreamUrl: (id: string, keyword: string, bookUrl?: string, chapterIndex?: number) =>
    `/api/sources/${encodeURIComponent(id)}/debug?keyword=${encodeURIComponent(keyword)}` +
    (bookUrl ? `&bookUrl=${encodeURIComponent(bookUrl)}` : '') +
    (chapterIndex ? `&chapterIndex=${chapterIndex}` : ''),
}

/** 登录与凭据。 */
export const cookies = {
  list: () =>
    request<{
      count: number
      cookies: Array<{
        domain: string
        keys: string[]
        mentionedBy: number
        sessionKeys: string[]
        droppedKeys: string[]
        headerChars: number
        oversized: boolean
      }>
    }>('/api/cookies'),
  detail: (u: string) =>
    request<{
      domain: string
      cookie: string
      sessionKeys: string[]
      droppedKeys: string[]
    }>(`/api/cookies/detail?u=${encodeURIComponent(u)}`),
  remove: (u: string) =>
    request<void>(`/api/cookies?url=${encodeURIComponent(u)}`, { method: 'DELETE' }),
  write: (url: string, cookie: string) =>
    request<{ ok: boolean; domain: string; count: number }>('/api/cookies', {
      method: 'POST',
      body: JSON.stringify({ url, cookie }),
    }),
}

/** 书源登录 UI。 */
export const sourceLogin = {
  getUi: (sourceId: string) =>
    request<SourceLoginUiResponse>(`/api/sources/${encodeURIComponent(sourceId)}/login-ui`),
  saveInfo: (sourceId: string, loginInfo: Record<string, string>) =>
    request<{ ok: boolean }>(`/api/sources/${encodeURIComponent(sourceId)}/login-info`, {
      method: 'POST',
      body: JSON.stringify({ loginInfo }),
    }),
  removeInfo: (sourceId: string) =>
    request<{ ok: boolean }>(`/api/sources/${encodeURIComponent(sourceId)}/login-info`, {
      method: 'DELETE',
    }),
  saveHeader: (sourceId: string, loginHeader: string) =>
    request<{ ok: boolean }>(`/api/sources/${encodeURIComponent(sourceId)}/login-header`, {
      method: 'POST',
      body: JSON.stringify({ loginHeader }),
    }),
  removeHeader: (sourceId: string) =>
    request<{ ok: boolean }>(`/api/sources/${encodeURIComponent(sourceId)}/login-header`, {
      method: 'DELETE',
    }),
  saveCookie: (sourceId: string, cookie: string, url?: string) =>
    request<{ ok: boolean; message?: string }>(
      `/api/sources/${encodeURIComponent(sourceId)}/login-cookie`,
      { method: 'POST', body: JSON.stringify({ cookie, url }) },
    ),
  renderUi: (sourceId: string, state = '{}') =>
    request<SourceLoginUiRenderResponse>(
      `/api/sources/${encodeURIComponent(sourceId)}/login-ui/render`,
      { method: 'POST', body: JSON.stringify({ state }) },
    ),
  executeUiAction: (
    sourceId: string,
    action: string,
    state: string,
    form: Record<string, string>,
    browserCompleted = false,
    browserBody?: string,
  ) =>
    request<SourceLoginUiActionResponse>(
      `/api/sources/${encodeURIComponent(sourceId)}/login-ui/action`,
      {
        method: 'POST',
        body: JSON.stringify({ action, state, form, browserCompleted, browserBody }),
      },
    ),
  executeAction: (
    sourceId: string,
    action: string,
    loginData: Record<string, string>,
    isLongClick = false,
    browserCompleted = false,
    browserBody?: string,
  ) =>
    request<SourceLoginActionResult>(
      `/api/sources/${encodeURIComponent(sourceId)}/login-action`,
      {
        method: 'POST',
        body: JSON.stringify({ action, loginData, isLongClick, browserCompleted, browserBody }),
      },
    ),
  check: (sourceId: string) =>
    request<SourceLoginCheckResult>(
      `/api/sources/${encodeURIComponent(sourceId)}/login-check`,
    ),
  credential: (sourceId: string, url: string) =>
    request<SourceCredentialStatus>(
      `/api/sources/${encodeURIComponent(sourceId)}/credential?u=${encodeURIComponent(url)}`,
    ),
}

/** 内置浏览器会话。 */
export const sourceBrowser = {
  createSession: (sourceId: string, url?: string) =>
    request<SourceBrowserSession>(`/api/sources/${encodeURIComponent(sourceId)}/browser/session`, {
      method: 'POST',
      body: JSON.stringify(url ? { url } : {}),
    }),
  closeSession: (sourceId: string, token: string) =>
    request<void>(
      `/api/sources/${encodeURIComponent(sourceId)}/browser/session?t=${encodeURIComponent(token)}`,
      { method: 'DELETE' },
    ),
  cookies: (sourceId: string) =>
    request<SourceBrowserCookies>(
      `/api/sources/${encodeURIComponent(sourceId)}/browser/cookies`,
    ),
  removeCookie: (sourceId: string, url: string) =>
    request<{
      ok: boolean
      removed: boolean
      count: number
      domains: string[]
    }>(
      `/api/sources/${encodeURIComponent(sourceId)}/browser/cookies?u=${encodeURIComponent(url)}`,
      { method: 'DELETE' },
    ),
  pageUrl: (sourceId: string, token: string, target: string) =>
    `/api/sources/${encodeURIComponent(sourceId)}/browser/page?t=${encodeURIComponent(token)}&u=${encodeURIComponent(target)}`,
  registerInline: (sourceId: string, token: string, url: string) =>
    request<{ key: string }>(`/api/sources/${encodeURIComponent(sourceId)}/browser/inline`, {
      method: 'POST',
      body: JSON.stringify({ token, url }),
    }),
  inlineUrl: (sourceId: string, token: string, key: string) =>
    `/api/sources/${encodeURIComponent(sourceId)}/browser/page?t=${encodeURIComponent(token)}&i=${encodeURIComponent(key)}`,
}

/** 外部浏览器登录。 */
export const externalLogin = {
  start: (sourceId: string, url?: string) =>
    request<{
      opened: boolean
      browser: string
      port: number
      pid: number
      hosts: string[]
      seen: string[]
      stored: string[]
      count: number
    }>(`/api/sources/${encodeURIComponent(sourceId)}/browser/external-login`, {
      method: 'POST',
      body: JSON.stringify(url ? { url } : {}),
    }),
  status: (sourceId: string) =>
    request<{
      opened: boolean
      browser: string
      port: number
      pid: number
      hosts: string[]
      seen: string[]
      stored: string[]
      count: number
    }>(`/api/sources/${encodeURIComponent(sourceId)}/browser/external-login`),
  capture: (sourceId: string) =>
    request<{
      opened: boolean
      browser: string
      port: number
      pid: number
      hosts: string[]
      seen: string[]
      stored: string[]
      count: number
    }>(`/api/sources/${encodeURIComponent(sourceId)}/browser/external-login/capture`, {
      method: 'POST',
      body: '{}',
    }),
  stop: (sourceId: string) =>
    request<void>(`/api/sources/${encodeURIComponent(sourceId)}/browser/external-login`, {
      method: 'DELETE',
    }),
}

/** 发现页。 */
export const explore = {
  listSources: () => request<SourceSummary[]>('/api/explore/sources'),
  tabs: (sourceId: string, signal?: AbortSignal) =>
    request<Array<{ title: string; url: string; supportsPaging?: boolean }>>(
      `/api/sources/${encodeURIComponent(sourceId)}/explore`,
      { signal },
    ),
  run: (sourceId: string, url: string, page = 1, signal?: AbortSignal) =>
    request<SearchResult[]>('/api/explore', {
      method: 'POST',
      body: JSON.stringify({ sourceId, url, page }),
      signal,
    }),
}

/** 书源订阅（手机「订阅」页那套）：拉列表、加/删、单条或全部检查更新。 */
export const subscriptions = {
  list: () => request<SourceSubscription[]>('/api/subscriptions'),
  save: (url: string, enabled = true) =>
    request<SourceSubscription>('/api/subscriptions', {
      method: 'POST',
      body: JSON.stringify({ url, enabled }),
    }),
  remove: (id: number) => request<void>(`/api/subscriptions/${id}`, { method: 'DELETE' }),
  update: (id: number) =>
    request<ImportResponse>(`/api/subscriptions/${id}/update`, { method: 'POST' }),
  updateAll: () =>
    request<{ updated: number; failed: number }>('/api/subscriptions/update', { method: 'POST' }),
}
