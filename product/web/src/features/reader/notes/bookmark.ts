import type { BookNote, BookNoteWrite } from '../../../lib/api'

/**
 * 书签（`product/docs/待定功能.md` 里那条「待定」落地）。
 *
 * 边界定在这里：**书签只标位置，不要求选中正文**。所以它是一条 `bookmark=true` 的笔记，
 * 偏移落在段落首字符上（`startOffset === endOffset`），摘要取那一段的开头。
 * 这样它和划线共用同一张表、同一套跳转与导出，不需要第二套数据模型。
 */

/** 同一段落只留一条书签：按「章 + 段落锚点」判重；老数据没有锚点时退回字符偏移。 */
export function findBookmarkAt(
  notes: BookNote[],
  chapterIndex: number,
  anchor: string | null | undefined,
  startOffset: number,
): BookNote | undefined {
  return notes.find(note => note.bookmark
    && note.chapterIndex === chapterIndex
    && (anchor ? note.paragraphAnchor === anchor : note.startOffset === startOffset))
}

/** 列表里的书签摘要：压掉换行与多余空白，超过 40 字截断 —— 一行放得下才有用。 */
export function bookmarkExcerpt(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > 40 ? `${clean.slice(0, 40)}…` : clean
}

/** 把「当前读到哪」变成一条书签写入体。位置不可用（没排版好 / 没有章节地址）时返回 null。 */
export function bookmarkPayload(input: {
  sourceId: string
  bookUrl: string
  bookName: string
  chapterIndex: number
  chapterUrl: string
  charOffset: number
  paragraphAnchor: string | null
  positionChecksum: string | null
  text: string
}): BookNoteWrite | null {
  if (!input.chapterUrl) return null
  const excerpt = bookmarkExcerpt(input.text)
  if (!excerpt) return null
  return {
    sourceId: input.sourceId,
    bookUrl: input.bookUrl,
    bookName: input.bookName,
    chapterUrl: input.chapterUrl,
    chapterIndex: input.chapterIndex,
    startOffset: input.charOffset,
    endOffset: input.charOffset,
    excerpt,
    note: '',
    bookmark: true,
    paragraphAnchor: input.paragraphAnchor,
    positionChecksum: input.positionChecksum,
  }
}
