/** 统一 fetch 基础客户端：所有域 API 客户端复用此 request。 */

import { fetchWithMetrics } from '../performance'
import { clearAccessToken, getAccessToken, signalUnauthorized } from '../accessToken'

/**
 * 写操作仍由服务端的同源闸门把关（浏览器自带 Origin）。这里唯一注入的是可选的对外访问
 * token（S3-B）：服务端未设 `LEGADO_ACCESS_TOKEN` 时 getAccessToken() 为 null，一个头都不加，
 * 行为与历史逐字节一致；设了且当前是非回环访问时，服务端会校验这个 Bearer 头。
 */

type RequestOptions = { timeoutMs?: number }

/**
 * 发请求并做统一处理：补 JSON 头、带同源凭据、走性能采集、非 2xx 抛服务端那句话。
 *
 * 单独留出 `Response` 这一层，是因为有些端点回的不是 JSON（更新日志是文本、语音是
 * Blob、字体是 ArrayBuffer）——它们仍然要走同一个超时 / 采集 / 错误口径，不能各写一份裸 fetch。
 */
async function requestResponse(
  path: string,
  init: RequestInit = {},
  opts: RequestOptions = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  // FormData 必须留给浏览器自己带 boundary，写死 application/json 会让服务端收不到文件
  if (init.body && !(typeof FormData !== 'undefined' && init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
  }
  // S3-B：本地存了 token 就带上；没存（单机默认）一个头都不加。
  const token = getAccessToken()
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  // 走性能监控版 fetch：慢请求（>300ms）会进 collector，`__legadoPerf.report()` 能查。
  const response = await fetchWithMetrics(
    path,
    { ...init, headers, credentials: 'same-origin' },
    opts.timeoutMs,
  )
  if (response.status === 401) {
    // token 缺失/失效：清掉可能过期的旧值并弹输入框（复用已有 token 却仍 401 说明它错了）。
    clearAccessToken()
    signalUnauthorized()
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: response.statusText })) as { message?: string }
    throw new Error(body.message ?? '请求失败')
  }
  return response
}

/**
 * @param opts.timeoutMs 给了就统一超时（浏览器 `fetch` 本身没有超时）。默认不设：
 *   「书源体检」这类端点本来就要跑几十分钟，给所有请求套一个通用上限会把正常的长任务掐死。
 *   需要上限的调用方（AI 探测、单次短请求）各自显式传。
 */
export async function request<T>(
  path: string,
  init: RequestInit = {},
  opts: RequestOptions = {},
): Promise<T> {
  const response = await requestResponse(path, init, opts)
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>)
}

/** 取纯文本（更新日志、备份 kept 条目这类端点）。非 2xx 与 request 同一套错误口径。 */
export async function requestText(
  path: string,
  init: RequestInit = {},
  opts: RequestOptions = {},
): Promise<string> {
  return (await requestResponse(path, init, opts)).text()
}

/** 取二进制 Blob（语音合成这类端点）。 */
export async function requestBlob(
  path: string,
  init: RequestInit = {},
  opts: RequestOptions = {},
): Promise<Blob> {
  return (await requestResponse(path, init, opts)).blob()
}

/** 取二进制 ArrayBuffer（字体文件这类端点）。 */
export async function requestArrayBuffer(
  path: string,
  init: RequestInit = {},
  opts: RequestOptions = {},
): Promise<ArrayBuffer> {
  return (await requestResponse(path, init, opts)).arrayBuffer()
}
