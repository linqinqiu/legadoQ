import type { BookNote } from '../../../lib/api'

/**
 * 笔记面板的三个筛选档。`marks` 是划线 / 备注（不含书签），`bookmarks` 只列书签 ——
 * 书签和划线在数据里同表（`bookmark` 字段区分），但用户找的是两件事，不能混在一列里。
 */
export type NoteKind = 'all' | 'marks' | 'bookmarks'

export function noteCounts(notes: BookNote[]): Record<NoteKind, number> {
  const bookmarks = notes.filter(note => note.bookmark).length
  return { all: notes.length, marks: notes.length - bookmarks, bookmarks }
}

export function filterNotes(notes: BookNote[], kind: NoteKind): BookNote[] {
  if (kind === 'bookmarks') return notes.filter(note => note.bookmark)
  if (kind === 'marks') return notes.filter(note => !note.bookmark)
  return notes
}
