// 正文图片预热（0.8.2 结构重排从 ReaderScreen.tsx 逐字拆出）：把 `![图](url)` 提前发给服务端图片代理。
// 只预热外域图；失败静默 —— 渲染层那一张会自己退化成「这张图没取到 + 重取这一张」。
import { contentImageUrl, isSameSiteAsset } from './readerInteractions'
import { readerImageSrc } from './readerImage'

/**
 * 图片预热：把一段正文里的 `![图](url)` 地址提前发给服务端图片代理，
 * 趁用户在看首屏时把后续图片取回落盘缓存（代理命中 7 天有效），
 * 滚动/翻页下去就不必每张都等服务端联网一次。漫画章节正文就是一张张图，
 * 这一项直接决定翻页顺不顺。
 * 只预热外域图（站内资产本就在本地）；失败静默 —— 渲染层那一张会自己退化成「这张图没取到 + 重取这一张」。
 */
export function warmContentImages(text: string, page: string | undefined) {
  if (!text) return
  for (const raw of text.split('\n')) {
    const image = contentImageUrl(raw)
    if (!image || isSameSiteAsset(image)) continue
    const img = new Image()
    img.decoding = 'async'
    // 与渲染层同一个地址算法（generation 都是 0），否则预热取回来的那张用不上。
    img.src = readerImageSrc(image, page)
  }
}
