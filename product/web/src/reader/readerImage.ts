import { api } from '../lib/api'
import { isSameSiteAsset } from './readerInteractions'

/**
 * 正文配图（含漫画每一页）的地址算法，收在一处：渲染、预热、重取三处要用**同一个**地址，
 * 否则预热取回来的图渲染层用不上，或者重取完浏览器还在端详它那份 7 天的旧副本。
 *
 * `generation` 是"这一张被重取过几次"。它只进浏览器侧的缓存键（查询参数），
 * **不进服务端的落盘键**（那边按 `sha256(原图地址)`），所以换代次不会让磁盘多存一份图，
 * 只是让浏览器重新发一次请求 —— 盘上那份由 `POST /api/book/image/refresh` 去覆盖。
 */
export function readerImageSrc(image: string | null | undefined, referer: string | undefined, generation = 0, sourceId?: string): string {
  if (!image) return ''
  if (isSameSiteAsset(image)) return image
  return api.bookImage(image, referer, generation > 0 ? String(generation) : undefined, sourceId)
}
