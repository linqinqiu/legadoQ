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

/**
 * 把导入内容的字节解成文本。
 *
 * `response.text()` / `File.text()` 永远按 UTF-8 解，遇到 GBK 的老书源 JSON 会静默变成
 * 一串 U+FFFD（服务端 0.2.3 之前的请求体事故是同一个病根，只是换到了浏览器这一侧）。
 * 这里按 BOM → 严格 UTF-8 → GB18030 逐档试探，与后端 `decodeTextAuto` 同一套口径：
 * 整份能通过 UTF-8 校验的几乎肯定是 UTF-8；GBK 中文的字节基本落在 UTF-8 的非法区。
 */
export function decodeImportText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  if (bytes.length === 0) return ''
  // BOM 是内容自己写的声明，优先于任何猜测。
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3))
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    // 不是合法的 UTF-8，继续往下试
  }
  try {
    return new TextDecoder('gb18030', { fatal: true }).decode(bytes)
  } catch {
    // GB18030 也解不出来：多半不是文本
  }
  return new TextDecoder('utf-8').decode(bytes)
}

/** 按文本取回地址内容（书源 JSON 用）。 */
export async function fetchImportText(url: string): Promise<string> {
  const response = await requestImport(url)
  return decodeImportText(await response.arrayBuffer())
}
