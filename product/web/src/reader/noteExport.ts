import type { BookNote } from '../lib/api'

/**
 * 把一本书的划线 / 笔记导出成 Markdown。
 *
 * 为什么需要它：划线攒在 `book_note` 表里，界面上只能一条条看。
 * 想拿去别处用（写读后感、整理书摘、丢进笔记软件）就没有出路 ——
 * 这是笔记功能「能记下来但带不走」的缺口。
 *
 * 三条纪律：
 * 1. **纯函数**：不碰 DOM、不碰下载，方便单测；真正的下载由调用方做。
 * 2. **原文照录**：`excerpt` 是用户选中的原话，一个字都不改（那是他自己划的）。
 * 3. **章名优先**：`chapterTitle` 拿不到时退回「第 N 章」，不编造标题。
 */

/** 书籍元信息，只取导出需要的几个字段。 */
export type NoteExportMeta = {
  bookName: string
  author?: string
  sourceId?: string
}

/** 一条笔记在 Markdown 里的排版：原文作引用块，备注作正文。 */
function renderNote(note: BookNote, chapterTitle?: string): string {
  const lines: string[] = []
  const where = chapterTitle?.trim() || `第 ${note.chapterIndex + 1} 章`
  lines.push(`### ${where}`)
  lines.push('')
  // 原文用引用块：多行原文逐行加 `>`，否则第二行会跳出引用。
  const excerpt = (note.excerpt ?? '').trim()
  if (excerpt) {
    for (const line of excerpt.split(/\r?\n/)) lines.push(`> ${line}`)
    lines.push('')
  }
  const remark = (note.note ?? '').trim()
  if (remark) {
    lines.push(remark)
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * 生成整本书的 Markdown。
 *
 * @param notes 这本书的全部笔记（调用方已按章、按章内位置排好）
 * @param meta  书名 / 作者 / 书源
 * @param chapterTitles 章号 → 章名的映射；缺了会退回「第 N 章」
 */
export function notesToMarkdown(
  notes: BookNote[],
  meta: NoteExportMeta,
  chapterTitles: Record<number, string> = {},
): string {
  const head: string[] = []
  head.push(`# ${meta.bookName || '未命名书籍'}`)
  head.push('')
  if (meta.author?.trim()) {
    head.push(`作者：${meta.author.trim()}`)
    head.push('')
  }
  if (meta.sourceId?.trim()) {
    head.push(`书源：${meta.sourceId.trim()}`)
    head.push('')
  }
  head.push(`共 ${notes.length} 条划线 / 笔记`)
  head.push('')

  if (notes.length === 0) {
    head.push('（这本书还没有笔记。）')
    head.push('')
    return head.join('\n')
  }

  const body = notes
    .slice()
    // 按章、再按章内位置排：与界面上看到的顺序一致，导出的文件才是"读下来"的顺序。
    .sort((a, b) => (a.chapterIndex - b.chapterIndex) || (a.startOffset - b.startOffset))
    .map(note => renderNote(note, chapterTitles[note.chapterIndex]))
    .join('\n---\n\n')

  return head.join('\n') + body + '\n'
}

/** 建议的文件名。用书名，去掉文件系统不接受的字符。 */
export function notesExportFileName(bookName: string): string {
  const safe = (bookName || '未命名书籍')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return `${safe || '未命名书籍'}-笔记.md`
}

/** 在浏览器里触发一次下载。副作用集中在这里，方便测试时绕开。 */
export function downloadMarkdown(fileName: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // 立刻 revoke 会让部分浏览器来不及读：下一拍再释放。
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
