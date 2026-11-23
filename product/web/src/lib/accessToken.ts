/**
 * 可选的对外访问 token（阶段 3.6 / S3-B）在浏览器这侧的存放与取用。
 *
 * 服务端未设 `LEGADO_ACCESS_TOKEN` 时一切照旧：这里永远返回 null，不注入任何头。
 * 设了之后，非回环访问需要一个 token；用户遇到 401 时输入一次，存进 localStorage，
 * 之后所有请求（含 SSE / WS）都带上。localStorage 按 origin 隔离，与皮肤/设置同一套规矩。
 *
 * 为什么不自动填：token 是部署方在服务端环境变量里设的，浏览器无从得知；只能由用户输入一次。
 */
const STORAGE_KEY = 'legado_access_token'

/** 派发给 AccessTokenPrompt 的信号：某个请求被服务端判为缺/错 token。 */
export const UNAUTHORIZED_EVENT = 'legado:unauthorized'

export function getAccessToken(): string | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return value && value.trim() ? value.trim() : null
  } catch {
    // 隐私模式 / 存储被禁：当没设，请求不带 token（服务端会回 401，prompt 仍会弹）。
    return null
  }
}

export function setAccessToken(token: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, token.trim())
  } catch {
    /* 存不进就只对本次会话有效（内存态由调用方决定）；下次还得再输一次。 */
  }
}

export function clearAccessToken(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* 同上，忽略存储不可用。 */
  }
}

/** 给不支持自定义请求头的 EventSource / WebSocket 拼 ?token= 后缀。未设时返回空串。 */
export function tokenQuery(): string {
  const token = getAccessToken()
  return token ? `token=${encodeURIComponent(token)}` : ''
}

/** 把 tokenQuery 拼到已有 URL 上（自动处理 ? / &）。 */
export function withTokenQuery(url: string): string {
  const query = tokenQuery()
  if (!query) return url
  return url + (url.includes('?') ? '&' : '?') + query
}

/** 通知 UI 弹 token 输入框；去重：同时多个请求 401 只弹一次。 */
let notifiedAt = 0
export function signalUnauthorized(): void {
  const now = Date.now()
  if (now - notifiedAt < 1000) return
  notifiedAt = now
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
}
