import type { BookNote } from '../../../lib/api'

/**
 * 批注锚点重定位（STATUS 缺口：「字段已落库，锚点失效后无模糊重匹配」）。
 *
 * 笔记落的是「章内字符偏移 + 段落锚点 + 内容校验值」。源站改了正文（补字、删广告、换排版）之后，
 * 偏移会整体漂移 —— 高亮画错行、点进去跳到别处。这里在正文加载后做一次重定位：
 *
 *   1. 校验值相同：位置没变，原样保留。
 *   2. 原文在旧偏移处仍然对得上：只更新校验值。
 *   3. 原文在别处出现：挪到最近的一次出现。
 *   4. 空白 / 标点被改过：归一化后再找（记下标映射，回到原文偏移）。
 *   5. 只剩开头还认得出：用归一化前缀定位。
 *   6. 都找不到：标 `stale`，位置不动 —— 列表里提示「原文已变」，不假装还对。
 *
 * 只在内存里修正，不写库：正文可能还会变（AI 覆盖、重取章节），把一次猜测固化进库更难撤回。
 */

/** 归一化时忽略的字符：空白与常见中英文标点。 */
const IGNORED = /[\s，。、；：""''（）《》〈〉【】「」『』〔〕!！?？…—·.,;:'"`~@#$%^&*+=|\\/<>-]/

/** 归一化正文，并记下每个归一化字符对应的原文下标（回到原文偏移要用）。 */
export function normalizeWithMap(text: string): { text: string; map: number[] } {
  let normalized = ''
  const map: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (IGNORED.test(ch)) continue
    normalized += ch
    map.push(i)
  }
  return { text: normalized, map }
}

/** 在归一化正文里找 needle 的所有起点，取离旧偏移最近的那一个（并列时取靠前的）。 */
function nearestOccurrence(haystack: string, needle: string, preferred: number): number {
  if (!needle) return -1
  let best = -1
  let bestDistance = Number.POSITIVE_INFINITY
  let from = 0
  while (from <= haystack.length) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) break
    const distance = Math.abs(at - preferred)
    if (distance < bestDistance) { best = at; bestDistance = distance }
    from = at + 1
  }
  return best
}

export type ReanchorStatus = 'exact' | 'relocated' | 'stale'

/** 给一条笔记在新正文里找位置。返回修正后的笔记与结论。 */
export function relocateNote(
  note: BookNote,
  content: string,
  checksum: string,
  normalized?: { text: string; map: number[] },
): { note: BookNote; status: ReanchorStatus } {
  if (note.positionChecksum === checksum) return { note, status: 'exact' }
  const excerpt = note.excerpt.trim()
  if (!excerpt) return { note: { ...note, positionChecksum: checksum, stale: false }, status: 'exact' }

  // ② 旧偏移处仍然对得上：正文变了但这一段没动。
  if (content.slice(note.startOffset, note.startOffset + excerpt.length) === excerpt) {
    return { note: { ...note, positionChecksum: checksum, stale: false }, status: 'exact' }
  }

  // ③ 原文在别处出现：取最近的一次，避免同段重复句把位置甩到章节开头。
  const direct = nearestOccurrence(content, excerpt, note.startOffset)
  if (direct >= 0) {
    return {
      note: { ...note, startOffset: direct, endOffset: direct + excerpt.length, positionChecksum: checksum, stale: false },
      status: 'relocated',
    }
  }

  // ④ 空白 / 标点被改过：归一化后再找，再按映射回到原文偏移。
  const norm = normalized ?? normalizeWithMap(content)
  const needle = normalizeWithMap(excerpt).text
  const at = nearestOccurrence(norm.text, needle, note.startOffset)
  if (at >= 0) {
    const start = norm.map[at] ?? note.startOffset
    return {
      note: { ...note, startOffset: start, endOffset: start + excerpt.length, positionChecksum: checksum, stale: false },
      status: 'relocated',
    }
  }

  // ⑤ 只剩开头认得出（后半段被改写）：用归一化前缀定位，至少把高亮放回这一带。
  const prefix = needle.slice(0, Math.min(20, Math.max(6, Math.floor(needle.length / 2))))
  const prefixAt = nearestOccurrence(norm.text, prefix, note.startOffset)
  if (prefixAt >= 0) {
    const start = norm.map[prefixAt] ?? note.startOffset
    return {
      note: { ...note, startOffset: start, endOffset: start + excerpt.length, positionChecksum: checksum, stale: true },
      status: 'stale',
    }
  }

  // ⑥ 找不到：位置不动，标 stale 让界面说清楚。
  return { note: { ...note, positionChecksum: checksum, stale: true }, status: 'stale' }
}

/**
 * 重定位某一章的全部笔记。没有变化时**返回同一个数组** —— 调用方据此避免无谓的重渲染。
 * 别的章的笔记原样带过：一本书里每章校验值不同，拿这一章的正文去算别的章是错的。
 */
export function reanchorNotes(notes: BookNote[], chapterIndex: number, content: string, checksum: string): BookNote[] {
  if (!content || !checksum) return notes
  let changed = false
  let normalized: { text: string; map: number[] } | undefined
  const next = notes.map(note => {
    if (note.chapterIndex !== chapterIndex) return note
    normalized ??= normalizeWithMap(content)
    const result = relocateNote(note, content, checksum, normalized)
    if (result.note !== note) changed = true
    return result.note
  })
  return changed ? next : notes
}
