// 漫画分页的纯算术：哪几张图是"一页"、翻一屏跨几张、页号怎么和章节字符偏移互换。
// 抽成纯函数是为了能单测 —— 双页对齐、末屏单张、从右到左这几条边界在 DOM 里试很贵。
import { contentImageUrl } from '../interaction/readerInteractions'

/** 漫画双页顺序：`ltr` 前一张在左（国漫/韩漫），`rtl` 前一张在右（日漫）。 */
export type MangaDirection = 'ltr' | 'rtl'

export type MangaPage = {
  /** 图片地址（原样，过代理与 referer 是 `readerImageSrc` 的事）。 */
  url: string
  /** 这一页在章内**段落序列**里的下标 —— 页进度靠它换成字符偏移落库。 */
  paragraph: number
}

/** 一章正文里的图片页，按出现顺序。 */
export function mangaPages(paragraphs: string[]): MangaPage[] {
  const pages: MangaPage[] = []
  paragraphs.forEach((line, paragraph) => {
    const url = contentImageUrl(line)
    if (url) pages.push({ url, paragraph })
  })
  return pages
}

/** 并排两张的最小屏宽：再窄两张图各自不到 300px，不如一张大图。 */
export const MANGA_SPREAD_MIN_WIDTH = 720

export function mangaSpreadSize(spreadEnabled: boolean, viewportWidth: number): 1 | 2 {
  return spreadEnabled && viewportWidth >= MANGA_SPREAD_MIN_WIDTH ? 2 : 1
}

/** 把任意页号吸到"这一屏的第一张"：双页向左对齐到偶数，单页原样。 */
export function mangaSpreadStart(index: number, size: 1 | 2): number {
  if (index <= 0) return 0
  return size === 2 ? index - (index % 2) : index
}

/** 下一屏的第一张；`null` 表示这一章到头了（调用方去换下一章）。 */
export function mangaNextStart(index: number, size: 1 | 2, total: number): number | null {
  const next = mangaSpreadStart(index, size) + size
  return next < total ? next : null
}

/** 上一屏的第一张；`null` 表示已经在第一屏（调用方去换上一章）。 */
export function mangaPrevStart(index: number, size: 1 | 2): number | null {
  const start = mangaSpreadStart(index, size)
  return start > 0 ? Math.max(0, start - size) : null
}

/**
 * 这一屏渲染哪几张，按**从左到右**的 DOM 顺序给出。
 * 从右到左就是把前一张放右边 —— 页号本身不反过来，翻页方向仍是"页号递增"。
 */
export function mangaSpreadPages(start: number, size: 1 | 2, total: number, direction: MangaDirection): number[] {
  const pages: number[] = []
  for (let i = 0; i < size && start + i < total; i += 1) pages.push(start + i)
  return direction === 'rtl' && pages.length === 2 ? pages.reverse() : pages
}

/**
 * 存档里的字符偏移 → 页号。
 * 图片段在正文里有位置，所以"读到第几张"可以存成字符偏移，与文本位置共用一套进度模型。
 * 偏移落在两张图之间时取**前一张**（那正是读者眼前那一屏的开头）。
 */
export function mangaIndexAtOffset(starts: number[], pages: MangaPage[], charOffset: number): number {
  if (!starts.length || !pages.length) return 0
  let found = 0
  for (let i = 0; i < pages.length; i += 1) {
    if ((starts[pages[i].paragraph] ?? 0) <= charOffset) found = i
    else break
  }
  return found
}

/** 角标：`3–4 / 60`（双页）或 `3 / 60`（单页，含末屏只剩一张）。 */
export function mangaPageLabel(start: number, size: 1 | 2, total: number): string {
  const shown = Math.max(0, Math.min(size, total - start))
  if (shown > 1) return `${start + 1}–${start + shown} / ${total}`
  return `${Math.min(start, Math.max(0, total - 1)) + 1} / ${total}`
}

/** 章内页进度 0~1（首张 0、末张 1），与文本模式的章内进度同一个口径。 */
export function mangaFraction(index: number, total: number): number {
  if (total <= 1) return 0
  return Math.min(1, Math.max(0, index / (total - 1)))
}
