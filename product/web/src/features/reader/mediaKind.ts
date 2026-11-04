/**
 * 媒体地址分类（纯函数，判据可以直接打，不必渲染组件）。
 *
 * 书源的 `bookSourceType` 只有 0 文本 / 1 音频 / 2 图片 / 3 文件（Legado 定义），
 * 视频是社区扩展出来的第 4 类；而真正决定用哪个播放器的，是**这一章的地址本身**：
 * - 直链：`.mp4/.webm/.mp3/.m4a/...`
 * - HLS：`.m3u8/.m3u`（Chrome/Firefox 原生不认，要 hls.js）
 * - 播放页：`https://jx.../player/?url=...` 这类 HTML 页面（没有媒体后缀）
 *
 * 地址可能是原站地址，也可能是本站代理地址 `/api/book/media?url=<encoded>`。
 * 判断一律先解出**目标地址的 pathname** 再比后缀：代理 URL 的 query 里可能编码着
 * `?url=...mp4` 这种播放页参数，拿整串去匹配 `.mp4$` 会把播放页误判成视频。
 */
const VIDEO_EXT = /\.(mp4|webm|ogv|mov|mkv|m4v)$/i
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|flac|oga|wma)$/i
const HLS_EXT = /\.(m3u8|m3u)$/i

/** 取代理地址 query 里的原始 url；不是本站 `/api/book/media` 就返回 null。 */
function proxiedUrl(src: string): string | null {
  try {
    const url = new URL(src, 'http://local.invalid')
    if (!/\/api\/book\/media$/.test(url.pathname)) return null
    return url.searchParams.get('url')
  } catch {
    return null
  }
}

/** 目标地址的 pathname；解不出来就退回原串（只用于后缀判断）。 */
function pathOf(src: string): string {
  if (!src) return ''
  const raw = proxiedUrl(src) ?? src
  try {
    return new URL(raw, 'http://local.invalid').pathname
  } catch {
    return raw.split(/[?#]/)[0]
  }
}

export function isHlsUrl(src: string): boolean {
  return HLS_EXT.test(pathOf(src))
}

export function isDirectMedia(src: string): boolean {
  const path = pathOf(src)
  return VIDEO_EXT.test(path) || AUDIO_EXT.test(path) || HLS_EXT.test(path)
}

export type MediaKind = 'audio' | 'video' | 'file'

export function sniffMediaKind(src: string): MediaKind {
  const path = pathOf(src)
  if (HLS_EXT.test(path) || VIDEO_EXT.test(path)) return 'video'
  if (AUDIO_EXT.test(path)) return 'audio'
  return 'file'
}
