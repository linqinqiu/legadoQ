/**
 * 书架分页口径。
 *
 * 书架以前直接 `visibleItems.map(...)`，架上几百上千本时会一次性建出全部卡片
 * （每张卡片还带封面 `<img>`），首屏与切分组都要重排整架。书源页早就用
 * `SOURCE_PAGE_SIZE = 120` 的「加载更多」口径，这里沿用同一个数，避免两页行为不一致。
 *
 * 只放纯函数：页大小、可见条数的增长规则、以及"还剩多少没显示"的计数。
 * 状态本身留在 `ShelfPage`，方便筛选/排序变化时复位。
 */

/** 一次多显示多少本。与书源页 `SOURCE_PAGE_SIZE` 同口径。 */
export const SHELF_PAGE_SIZE = 120

/**
 * 按"已请求条数"算这一屏实际渲染多少条。
 *
 * 永远不超过 `total`：把 `visibleCount` 直接交给 `slice` 也能工作，但界面要显示
 * "已显示 N / M"，用这个函数算出的值才是真正渲染出来的那个数。
 */
export function visibleCountOf(total: number, requested: number): number {
  if (total <= 0) return 0
  if (!Number.isFinite(requested) || requested < 0) return Math.min(total, SHELF_PAGE_SIZE)
  return Math.min(total, Math.max(0, Math.floor(requested)))
}

/** 是否还有没显示的书（决定要不要出「加载更多」）。 */
export function hasMoreOf(total: number, requested: number): boolean {
  return visibleCountOf(total, requested) < total
}

/** 点一次「加载更多」之后的新请求条数。 */
export function moreCountOf(requested: number, step: number = SHELF_PAGE_SIZE): number {
  const base = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0
  return base + Math.max(1, step)
}