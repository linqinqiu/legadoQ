/**
 * 阅读进度的小型外部 store（PROPOSAL-020 P2）。
 *
 * 为什么单开一个 store 而不是走 React state：进度随滚动/翻页**每帧**变，
 * 而 `ReaderScreen` 有 2800+ 行，用 state 会让整屏重组（原代码专门为此在注释里踩过坑）。
 * 这里只让订阅者（底栏进度条那一个组件）重渲染。
 */
export type ReaderProgress = {
  /** 当前章序号（0 基）。 */
  chapterIndex: number
  /** 全书章数。 */
  total: number
  /** 本章内已读比例 0~1（滚动=章内滚动比例，分页=章内页码比例）。 */
  fraction: number
}

let snapshot: ReaderProgress = { chapterIndex: 0, total: 1, fraction: 0 }
const listeners = new Set<() => void>()

export function subscribeProgress(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getProgress(): ReaderProgress {
  return snapshot
}

/** 上报进度；变化太小就不通知，避免每帧无谓重渲染。 */
export function reportProgress(next: ReaderProgress): void {
  if (
    next.chapterIndex === snapshot.chapterIndex
    && next.total === snapshot.total
    && Math.abs(next.fraction - snapshot.fraction) < 0.002
  ) return
  snapshot = next
  for (const listener of listeners) listener()
}

/** 全书总进度 0~1（底栏进度条用）。 */
export function overallProgress(p: ReaderProgress): number {
  const total = Math.max(1, p.total)
  return Math.min(1, Math.max(0, (p.chapterIndex + Math.min(1, Math.max(0, p.fraction))) / total))
}
