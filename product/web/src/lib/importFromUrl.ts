/**
 * 「从地址导入」共用的取数通道。
 *
 * 浏览器不直连第三方地址：书源 JSON 与备份 zip 都走同源代理
 * `GET /api/book/media?url=<encodeURIComponent(url)>` —— 服务端代取后原样回传，
 * 文本与二进制都走这一条。空地址、非 http(s)、代理返回非 2xx 的提示都收敛在这里，
 * 两个导入入口只负责把 message 显示出来，不再各自拼一套说法。
 */

/** 把用户填的地址收敛成可请求的 http(s) 地址；不合法时抛出可直接展示的中文提示。 */
export function normalizeImportUrl(input: string): string {
  const trimmed = (input ?? '').trim()
  if (!trimmed) throw new Error('地址为空，请先填写要导入的地址')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('地址格式不对，请填写完整的 http(s) 链接')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('只支持 http:// 或 https:// 开头的地址')
  }
  return parsed.toString()
}

/** 从地址末段取文件名；取不到（没有路径、解码失败）时用 fallback，备份包默认 backup.zip。 */
export function fileNameFromUrl(input: string, fallback = 'backup.zip'): string {
  let pathname: string
  try {
    pathname = new URL(normalizeImportUrl(input)).pathname
  } catch {
    return fallback
  }
  const last = pathname.split('/').filter(Boolean).pop()
  if (!last) return fallback
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

/** 代理地址：与阅读器取音频/视频/文件同一条通道。 */
function importProxyUrl(url: string): string {
  return `/api/book/media?url=${encodeURIComponent(normalizeImportUrl(url))}`
}

/** 发一次代理请求并检查状态；两种取数形态（blob / text）共用。 */
async function requestImport(url: string): Promise<Response> {
  const target = importProxyUrl(url)
  let response: Response
  try {
    response = await fetch(target)
  } catch {
    throw new Error('取不到这个地址：请求没有完成，请确认地址能直接打开')
  }
  if (!response.ok) {
    throw new Error(`取不到这个地址：服务返回 HTTP ${response.status}，请先在浏览器里打开确认地址有效`)
  }
  return response
}

/** 按二进制取回地址内容（备份 zip 用）。 */
export async function fetchImportUrl(url: string): Promise<{ blob: Blob }> {
  const response = await requestImport(url)
  return { blob: await response.blob() }
}

/** 按文本取回地址内容（书源 JSON 用）。 */
export async function fetchImportText(url: string): Promise<string> {
  const response = await requestImport(url)
  return await response.text()
}
