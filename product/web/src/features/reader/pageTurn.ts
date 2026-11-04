/**
 * 翻页状态机的**决策**（PROPOSAL-019 A：「翻页引擎」）。
 *
 * 只放"当前页 → 下一页 / 上一页 / 跳章"的决策与"这一下该播哪种动画"的判断。
 * DOM 归 `ReaderScreen`；分页网格（页区间、垫栏、页对齐）归 `readerFlow.ts` ——
 * 这里**调用**它，不重写它。
 *
 * 抽出来的理由（用户 2026-10-11 的 A–F）：分页网格是自研的，改一处容易牵动另一处，
 * 缺一层可测的翻页状态机。把决策收成纯函数之后，逐页翻 / 跨章 / 接章 / 动画选择
 * 都能在 `web/test/PageTurn.test.ts` 里直接钉，不必起浏览器。
 */

/**
 * 分页模式的翻页动画。
 *
 * 值域与"动画怎么演"是分开的：这里只声明有哪几种，具体演法在 ReaderScreen + CSS
 * （`slide` 移动轨道、`fade` 透明度、`cover` 覆盖层从右盖上来）。
 * 将来若要加 `仿真`（卷页，需要 canvas），**加一个值 + 一处渲染即可**，不动本文件的决策。
 */
export type PageTurnAnim = 'slide' | 'fade' | 'cover' | 'none'

/** 一次翻页的落点决策。 */
export type PageTurnPlan =
  /** 章内逐页：翻到**同一窗口**的第 `page` 页。 */
  | { kind: 'step'; page: number }
  /** 跨章：交给 `changeChapter`（下一章）/ 接章（上一章）。`direction` = 1 下一章、-1 上一章。 */
  | { kind: 'chapter'; direction: 1 | -1 }

/** 「下一页」：本章还有页就逐页翻；已经在最后一页就跨到下一章。 */
export function planNextPage(page: number, pageCount: number): PageTurnPlan {
  if (page < pageCount - 1) return { kind: 'step', page: page + 1 }
  return { kind: 'chapter', direction: 1 }
}

/** 「上一页」：本章还有页就逐页翻；已经在第一页就往前接一章。 */
export function planPrevPage(page: number): PageTurnPlan {
  if (page > 0) return { kind: 'step', page: page - 1 }
  return { kind: 'chapter', direction: -1 }
}

/**
 * 从 `from` 页翻到 `to` 页，这一下该播哪种动画。
 *
 * **只有逐页翻（页码差 1）才播**：接章补偿、窗口往前挪一章都是"几页的跳"，
 * 滑过去反而像又跳了一次（用户 2026-10-03：「不要这样的跳转」）。
 * 关掉（`none`）或不是逐页，一律返回 `'none'`。
 */
export function pageTurnAnim(anim: PageTurnAnim, from: number, to: number): PageTurnAnim {
  if (anim === 'none') return 'none'
  return Math.abs(to - from) === 1 ? anim : 'none'
}

/**
 * 覆盖动画里，新页从哪一侧进来：往后翻从右边盖上来（+1），往回翻从左边（-1）。
 * 抽出来是为了让 ReaderScreen 与门禁共用同一条方向口径，不各判一次 `to > from`。
 */
export function coverDirection(from: number, to: number): 1 | -1 {
  return to >= from ? 1 : -1
}
