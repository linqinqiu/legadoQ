/**
 * 超大章节的分块渲染（STATUS 缺口：「整章挂 DOM」）。
 *
 * 普通章节整章渲染完全没问题 —— 一本正常小说一章几十段，拆开反而让首屏闪烁。
 * 只有**超过阈值**的章节（有的源把整本书塞进一章）才按块挂：先挂一块，滚到底再挂下一块。
 * 分页模式不参与：分页要把整章量成列，缺段就量不出总页数。
 */

/** 超过这个段数才分块。普通章节（几十段）永远走整章渲染，行为与以前一模一样。 */
export const CHUNK_THRESHOLD = 400

/** 一次挂多少段。150 段在手机上也够滚好几屏，不至于每滑一下就补一块。 */
export const CHUNK_SIZE = 150

export function shouldChunk(pageMode: string, paragraphCount: number): boolean {
  return pageMode !== 'paginate' && paragraphCount > CHUNK_THRESHOLD
}

/** 再挂一块（不超过总数）。 */
export function growLimit(limit: number, total: number, chunk = CHUNK_SIZE): number {
  if (limit >= total) return total
  return Math.min(total, limit + chunk)
}

/**
 * 要让第 `index` 段出现在 DOM 里，`limit` 至少要多大 —— 按块对齐，
 * 这样"跳到很靠后的一段"只多挂一块，不会把前面几百段一起补上。
 */
export function ensureLimit(limit: number, index: number, total: number, chunk = CHUNK_SIZE): number {
  if (index < limit) return limit
  return Math.min(total, Math.ceil((index + 1) / chunk) * chunk)
}
