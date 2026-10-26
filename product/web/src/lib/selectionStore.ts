/**
 * 选区共享：让 AI 知道「用户此刻选中了哪一段」。
 * 选区原本只活在 `ReaderScreen` 的 `useState` 里，而 AI 悬浮球挂在根节点拿不到 ——
 * 于是模型只知道"第几章"，不知道用户正盯着哪一段。这里把选区提到组件之外
 * （模块级 store + `useSyncExternalStore`），阅读器写入、AI 面板读取，两边对同一份状态说话。
 *
 * 两条纪律：① 没有选区就是 null，不猜不编；② 发给模型前必须截断 —— 选区可能有整章那么长
 * （`Agent.MAX_TOOL_DATA` 4000 字符）。
 */

/** 当前选区的样子。与阅读器里的 `NoteDraft` 对齐，但只留 AI 真正用得上的字段。 */
export type TextSelection = {
  /** 选中原文（已被裁剪，见 `MAX_SELECTION`）。 */
  text: string
  /** 选中原文的完整长度（裁剪前），让模型知道被截断了。 */
  fullLength: number
  /** 所在章的序号（0 起）。 */
  chapterIndex: number
  /** 所在章的标题。 */
  chapterTitle: string
  /** 所在章的地址。 */
  chapterUrl: string
  /** 章内字符偏移。 */
  startOffset: number
  endOffset: number
  /** 这本书的标识（AI 要用工具取正文时需要）。 */
  sourceId: string
  bookUrl: string
  bookName: string
  /** 选区所在位置（屏幕坐标），AI 面板可用它把结果贴回原处。 */
  x: number
  y: number
}

/** 选区原文发给模型时的上限。超过这个长度就截断并说明。 */
export const MAX_SELECTION = 2000

let current: TextSelection | null = null
const listeners = new Set<() => void>()

function emit(): void {
  listeners.forEach(fn => fn())
}

export function getSelection(): TextSelection | null {
  return current
}

export function subscribeSelection(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 裁剪选区原文：超长就截断，并把真实长度记下来。 */
export function clipSelection(text: string, max = MAX_SELECTION): { text: string; fullLength: number } {
  const trimmed = text.trim()
  if (trimmed.length <= max) return { text: trimmed, fullLength: trimmed.length }
  return { text: trimmed.slice(0, max), fullLength: trimmed.length }
}

/** 阅读器选中文字时调用。传 null 表示选区已取消。 */
export function setSelection(next: TextSelection | null): void {
  current = next
  emit()
}

/** 阅读器在选中文字时写入（自动裁剪原文）。 */
export function setSelectionFromDraft(draft: {
  excerpt: string
  chapterIndex: number
  chapterUrl: string
  startOffset: number
  endOffset: number
  sourceId: string
  bookUrl: string
  bookName: string
  chapterTitle?: string
  x: number
  y: number
}): void {
  const clipped = clipSelection(draft.excerpt)
  setSelection({
    text: clipped.text,
    fullLength: clipped.fullLength,
    chapterIndex: draft.chapterIndex,
    chapterTitle: draft.chapterTitle ?? '',
    chapterUrl: draft.chapterUrl,
    startOffset: draft.startOffset,
    endOffset: draft.endOffset,
    sourceId: draft.sourceId,
    bookUrl: draft.bookUrl,
    bookName: draft.bookName,
    x: draft.x,
    y: draft.y,
  })
}
