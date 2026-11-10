/** 统一 fetch 基础客户端：所有域 API 客户端复用此 request。 */

import { fetchWithMetrics } from '../performance'

/** 不设身份：写操作由服务端的同源闸门把关，浏览器自己带 Origin，这里不注入任何令牌。 */

/**
 * @param opts.timeoutMs 给了就统一超时（浏览器 `fetch` 本身没有超时）。默认不设：
 *   「书源体检」这类端点本来就要跑几十分钟，给所有请求套一个通用上限会把正常的长任务掐死。
 *   需要上限的调用方（AI 探测、单次短请求）各自显式传。
 */
export async function request<T>(
  path: string,
  init: RequestInit = {},
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const headers = new Headers(init.headers)
  // FormData 必须留给浏览器自己带 boundary，写死 application/json 会让服务端收不到文件
  if (init.body && !(typeof FormData !== 'undefined' && init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
  }
  // 走性能监控版 fetch：慢请求（>300ms）会进 collector，`__legadoPerf.report()` 能查。
  const response = await fetchWithMetrics(
    path,
    { ...init, headers, credentials: 'same-origin' },
    opts.timeoutMs,
  )
  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: response.statusText })) as { message?: string }
    throw new Error(body.message ?? '请求失败')
  }
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>)
}
