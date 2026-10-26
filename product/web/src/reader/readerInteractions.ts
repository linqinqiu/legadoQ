export type ReaderTapZone = 'previous' | 'toggle' | 'next'

export function scrollTapZone(clientY: number, viewportHeight: number): ReaderTapZone {
  const position = clientY / Math.max(1, viewportHeight)
  if (position < 0.3) return 'previous'
  if (position >= 0.7) return 'next'
  return 'toggle'
}

export function paginateTapZone(clientX: number, viewportWidth: number): ReaderTapZone {
  const position = clientX / Math.max(1, viewportWidth)
  if (position < 0.3) return 'previous'
  if (position >= 0.7) return 'next'
  return 'toggle'
}

export function mobileTapZone(clientY: number, viewportHeight: number): ReaderTapZone {
  return scrollTapZone(clientY, viewportHeight)
}

export function isAtTopBoundary(scrollTop: number, threshold = 5): boolean {
  return scrollTop <= threshold
}

export function isAtBottomBoundary(scrollTop: number, scrollHeight: number, clientHeight: number, threshold = 20): boolean {
  return scrollTop + clientHeight >= scrollHeight - threshold
}

export function isTapGesture(startX: number, startY: number, endX: number, endY: number, threshold = 10): boolean {
  return Math.hypot(endX - startX, endY - startY) <= threshold
}

export function swipeDirection(startX: number, startY: number, endX: number, endY: number, minDistance = 40): 'left' | 'right' | null {
  const dx = endX - startX
  const dy = endY - startY
  if (Math.abs(dx) > Math.abs(dy) * 1.5 && Math.abs(dx) >= minDistance) {
    return dx < 0 ? 'left' : 'right'
  }
  return null
}

export function isInteractiveReaderTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('button, a, input, textarea, select, label, summary, [contenteditable="true"]'))
}

/**
 * 滚轮增量归一化成 CSS 像素。
 *
 * `WheelEvent.deltaMode` 有三种口径：0=像素（触控板与多数鼠标）、1=行、2=页。
 * 不乘这个系数量出来的"幅度"根本不是一个单位 —— 翻页模式原来写的是
 * `Math.abs(delta) < 25 return`，于是行模式下一格滚轮（约 3）与触控板轻扫（1~20 像素）
 * 都够不着阈值，表现是"鼠标能翻、触控板翻不动"。
 */
export function wheelPixels(delta: number, deltaMode: number, lineHeight = 16, pageHeight = 600): number {
  const unit = deltaMode === 1 ? lineHeight : deltaMode === 2 ? pageHeight : 1
  return delta * unit
}

/**
 * 翻页模式的一格滚轮：把多次小增量**累计**成一次翻页。
 *
 * 返回 `{ action, rest }`，调用方把 `rest` 存回去。只按单次事件判阈值会让慢速轻扫永远翻不动
 * （见 `wheelPixels` 那三种口径），累计之后触控板每一下都在攒，攒够 `step` 像素翻一页。
 */
export function paginateWheelStep(
  deltaX: number,
  deltaY: number,
  deltaMode: number,
  accumulated: number,
  step = 48,
  lineHeight = 16,
  pageHeight = 600,
): { action: 'next' | 'prev' | null; rest: number } {
  const x = wheelPixels(deltaX, deltaMode, lineHeight, pageHeight)
  const y = wheelPixels(deltaY, deltaMode, lineHeight, pageHeight)
  const primary = Math.abs(x) > Math.abs(y) ? x : y
  const total = accumulated + primary
  if (Math.abs(total) < step) return { action: null, rest: total }
  return { action: total > 0 ? 'next' : 'prev', rest: 0 }
}

export function isDoubleColumnActive(columnMode: 'auto' | 'single' | 'double', viewportWidth: number): boolean {
  return columnMode === 'double' || (columnMode === 'auto' && viewportWidth >= 800)
}

export type PaginationLayout = {
  isDoubleColumn: boolean
  columnWidth: number
  stride: number
  pageCount: number
}

export function calculatePaginationLayout({
  viewportWidth,
  totalScrollWidth,
  columnGap = 40,
  columnMode = 'auto',
}: {
  viewportWidth: number
  totalScrollWidth: number
  columnGap?: number
  columnMode?: 'auto' | 'single' | 'double'
}): PaginationLayout {
  const isDouble = isDoubleColumnActive(columnMode, viewportWidth)
  if (isDouble) {
    const columnWidth = Math.max(100, Math.floor((viewportWidth - columnGap) / 2))
    const stride = 2 * (columnWidth + columnGap)
    const pageCount = Math.max(1, Math.round((totalScrollWidth + columnGap) / stride))
    return {
      isDoubleColumn: true,
      columnWidth,
      stride,
      pageCount,
    }
  } else {
    const columnWidth = Math.max(100, viewportWidth)
    const stride = columnWidth + columnGap
    const pageCount = Math.max(1, Math.round((totalScrollWidth + columnGap) / (columnWidth + columnGap)))
    return {
      isDoubleColumn: false,
      columnWidth,
      stride,
      pageCount,
    }
  }
}

export type ParagraphRect = {
  top: number
  bottom: number
  left: number
  right: number
}

export type ViewportBounds = {
  top: number
  bottom: number
  left: number
  right: number
}

/**
 * Calculates the first paragraph index that is fully visible within the given viewport bounds.
 * If no paragraph is fully visible, falls back to the best partially visible paragraph, or 0.
 */
export function findFirstFullyVisibleParagraphIndex(
  paragraphs: Array<{ index: number; rect: ParagraphRect }>,
  viewport: ViewportBounds,
  tolerance = 2
): number {
  if (!paragraphs || paragraphs.length === 0) return 0

  // 1. Look for the first paragraph whose rect is completely inside the viewport bounds
  for (const p of paragraphs) {
    const fullyInsideY = p.rect.top >= viewport.top - tolerance && p.rect.bottom <= viewport.bottom + tolerance
    const fullyInsideX = p.rect.left >= viewport.left - tolerance && p.rect.right <= viewport.right + tolerance
    if (fullyInsideY && fullyInsideX) {
      return p.index
    }
  }

  // 2. If none are fully visible (e.g. paragraph is taller than viewport), find the first paragraph that has substantial visibility inside the viewport
  for (const p of paragraphs) {
    const visibleTop = Math.max(p.rect.top, viewport.top)
    const visibleBottom = Math.min(p.rect.bottom, viewport.bottom)
    const visibleHeight = visibleBottom - visibleTop

    const visibleLeft = Math.max(p.rect.left, viewport.left)
    const visibleRight = Math.min(p.rect.right, viewport.right)
    const visibleWidth = visibleRight - visibleLeft

    if (visibleHeight > 0 && visibleWidth > 0) {
      return p.index
    }
  }

  return 0
}




/**
 * 服务端把正文里的 `<img>` 换成的占位行：`![图片](绝对地址)`。
 * 图片因此能穿过净化管道、离线缓存与 TTS 的同一条字符串链路，不用另开一套数据结构。
 *
 * 地址有两类，都必须认：
 * - `https?://…` —— 在线书的图，要经 `/api/book/image` 代理（防盗链与混合内容）；
 * - `/api/…` —— 本地 EPUB 的内嵌插图，本来就在同源，**再套一层代理是错的**
 *   （代理只收 http(s)，且会把包内资源当成外部站点去抓）。
 */
const CONTENT_IMAGE_LINE = /^!\[[^\]]*\]\((https?:\/\/[^)\s]+|\/api\/[^)\s]+)\)$/

export const contentImageUrl = (line: string): string | null => CONTENT_IMAGE_LINE.exec(line.trim())?.[1] ?? null

/** 站内绝对路径直接就是能用的地址，不需要再过图片代理。 */
export const isSameSiteAsset = (url: string): boolean => url.startsWith('/api/')

/**
 * 目录虚拟列表一行的像素高（虚拟化算的是「第 i 行位移 = i × 行高」）。
 *
 * 同一个数还写在 `styles.css` 的 `--row-h-list`。行高与实际渲染不一致时，
 * 5,000 章的目录滚到底会差出整屏，所以两处必须相等 —— 由测试当场钉。
 */
export const TOC_ROW_HEIGHT = 40
