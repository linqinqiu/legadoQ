import React from 'react'
import type { BookNote } from '../../lib/api'

/**
 * 这一段里落着的笔记高亮。按 `excerpt` 在这段文字里定位 ——
 * 简繁转换只换字形不换词，转换后仍然找得到；找不到（原文被源站改过）就安静跳过。
 *
 * 纯函数：`notes` 与 `onOpenNote` 由调用方传入（不再闭包 `ReaderScreen` 的局部状态），
 * 便于从正文渲染路径里剥离，也便于单测。
 */
export function renderNoteHighlights(
  text: string,
  ownerIndex: number,
  notes: BookNote[],
  onOpenNote: (note: BookNote, x: number, y: number) => void,
): React.ReactNode[] | null {
  // 书签不画高亮：它只标位置，正文上留一条彩色底纹反而像"这段被划了重点"。
  const chapterNotes = notes.filter(note => !note.bookmark && note.chapterIndex === ownerIndex && note.excerpt && text.includes(note.excerpt))
  if (!chapterNotes.length) return null
  const marks: Array<{ start: number; end: number; note: BookNote }> = []
  for (const note of chapterNotes) {
    const at = text.indexOf(note.excerpt)
    if (at < 0) continue
    // 与已有高亮重叠的跳过：重叠的 <mark> 没法叠着画
    if (marks.some(mark => at < mark.end && at + note.excerpt.length > mark.start)) continue
    marks.push({ start: at, end: at + note.excerpt.length, note })
  }
  if (!marks.length) return null
  marks.sort((a, b) => a.start - b.start)
  const out: React.ReactNode[] = []
  let cursor = 0
  for (const mark of marks) {
    if (mark.start > cursor) out.push(text.slice(cursor, mark.start))
    out.push(
      <mark
        key={`note-${mark.note.id}`}
        className={`reader-note-highlight${mark.note.note ? ' has-note' : ''}`}
        data-note-id={mark.note.id}
        title={mark.note.note || '划线'}
        onClick={event => { event.stopPropagation(); onOpenNote(mark.note, event.clientX, event.clientY) }}
      >{text.slice(mark.start, mark.end)}</mark>,
    )
    cursor = mark.end
  }
  if (cursor < text.length) out.push(text.slice(cursor))
  return out
}
