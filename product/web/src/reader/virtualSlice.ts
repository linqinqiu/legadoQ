/**
 * 定高列表的虚拟化窗口算术 —— 阅读器目录与任何"几千行固定行高"的面共用这一份。
 *
 * 原来这里是两份：`ReaderScreen.tsx` 里内联一行 `Math.floor(scrollTop / itemHeight) - overscan`，
 * `web/test/VirtualChapterList.test.ts` 里再手写一个" supposed to 一样"的实现。
 * 判据量的是它自己那一份，产品跑的是另一份 —— 改一边没人会红。现在产品与判据引同一个函数。
 */

export interface VirtualWindowConfig {
  totalCount: number
  itemHeight: number
  scrollTop: number
  viewportHeight: number
  overscan?: number
}

export interface VirtualWindow {
  /** 整列表的滚动高度（顶栏 + 内容 + 底栏要凑出来的那个高度） */
  totalHeight: number
  startIndex: number
  endIndex: number
  renderedCount: number
  /** 窗口上面垫掉的高度：挂给顶前的 spacer */
  offsetY: number
  /** 窗口下面垫掉的高度：挂到尾后的 spacer */
  bottomSpacer: number
}

const DEFAULT_OVERSCAN = 6

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

/**
 * 算出该渲染哪一段。三条纪律：
 * - `scrollTop` 先夹进 `[0, 可滚动距离]`，浏览器不会给越界值，但直接写进 `style.height` 会变成 NaN；
 * - `overscan` 只在两侧多挂几行，越界由 `startIndex` / `endIndex` 的夹取挡掉；
 * - 任何一边算坏了都退回"空窗口"，界面宁可显示空列表也不要把 5 万行挂上 DOM。
 */
export function computeVirtualWindow(config: VirtualWindowConfig): VirtualWindow {
  const totalCount = Math.max(0, Math.floor(finiteOr(config.totalCount, 0)))
  const itemHeight = finiteOr(config.itemHeight, 0)
  const viewportHeight = Math.max(0, finiteOr(config.viewportHeight, 0))
  const overscan = Math.max(0, Math.floor(finiteOr(config.overscan ?? DEFAULT_OVERSCAN, DEFAULT_OVERSCAN)))

  if (totalCount === 0 || itemHeight <= 0) {
    return { totalHeight: 0, startIndex: 0, endIndex: 0, renderedCount: 0, offsetY: 0, bottomSpacer: 0 }
  }

  const totalHeight = totalCount * itemHeight
  const maxScroll = Math.max(0, totalHeight - viewportHeight)
  const scrollTop = Math.max(0, Math.min(maxScroll, finiteOr(config.scrollTop, 0)))

  const rawStart = Math.floor(scrollTop / itemHeight) - overscan
  const startIndex = Math.max(0, Math.min(totalCount - 1, rawStart))

  const rawEnd = Math.ceil((scrollTop + viewportHeight) / itemHeight) + overscan
  const endIndex = Math.min(totalCount, Math.max(startIndex, rawEnd))

  return {
    totalHeight,
    startIndex,
    endIndex,
    renderedCount: Math.max(0, endIndex - startIndex),
    offsetY: startIndex * itemHeight,
    bottomSpacer: Math.max(0, (totalCount - endIndex) * itemHeight),
  }
}

/**
 * 把第 `chapterIndex` 行**居中**需要的 scrollTop。
 * 与 `computeVirtualWindow` 同一份行高口径：这里算的是"滚动位置"，那边算的是"该挂哪些行"。
 */
export function computeCenterScrollOffset(
  chapterIndex: number,
  itemHeight: number,
  viewportHeight: number,
  totalCount: number,
): number {
  if (totalCount <= 0 || itemHeight <= 0 || viewportHeight <= 0) return 0
  const totalHeight = totalCount * itemHeight
  const maxScroll = Math.max(0, totalHeight - viewportHeight)
  const clampedIndex = Math.max(0, Math.min(totalCount - 1, Math.floor(finiteOr(chapterIndex, 0))))
  const targetTop = clampedIndex * itemHeight - (viewportHeight / 2 - itemHeight / 2)
  return Math.max(0, Math.min(maxScroll, Math.round(targetTop)))
}
