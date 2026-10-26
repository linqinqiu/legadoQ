import { api } from './api'
import { sanitizeImageUrl } from '../sources/sourceImport'

/**
 * RSS 条目的配图让服务端代取，不放浏览器直连。
 *
 * 「订阅」页那两张 `<img>` 写着 `referrerPolicy="no-referrer"`：防盗链的图站收不到来源就回 403，
 * 而 `onError` 把图整张藏起来 —— 症状是"这条新闻没有图"，其实是取不到。服务端那一路
 * （`/api/book/image`）会补 Referer、按每一跳落地域名带 Cookie（登录过的源这才出得了图），
 * 还过 SSRF 与 SVG 两道闸门。
 * 站内相对地址本来就在本地，原样交给浏览器，不绕这一圈。
 */
export function rssImageSrc(image: string | null | undefined, referer: string | null | undefined): string | null {
  const raw = sanitizeImageUrl(image)
  if (!raw) return null
  // 协议相对地址（`//img.example.com/a.jpg`）在浏览器里是按当前页的协议解析的：留原样就是"绕过代理直连外域"，
  // 而服务端那一路要的是带协议的完整地址，所以按 https 补齐（这类图站今天只有 https）。
  const url = raw.startsWith('//') ? `https:${raw}` : raw
  if (url.startsWith('/')) return url
  const page = referer && /^https?:\/\//i.test(referer) ? referer : undefined
  return api.bookImage(url, page)
}
