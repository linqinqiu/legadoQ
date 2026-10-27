import type { BookNote } from '../lib/api'
import { downloadMarkdown, notesExportFileName, notesToMarkdown, type NoteExportMeta } from './noteExport'

/**
 * 「笔记」面板（PROPOSAL-019 E）：这本书的全部划线 / 备注，点一条跳到那一章。
 *
 * 从 `ReaderScreen` 抽出来（PROPOSAL-019 F）—— 只跟笔记清单与「跳到那条」打交道，
 * 与翻页 / 进度 / 缓存无关。
 *
 * 书签不再从界面进入（功能未做完，已移出主功能，见 product/docs/待定功能.md）；
 * 面板只列划线 / 备注。历史数据里 `bookmark=true` 的条目仍会出现在清单里，
 * 只是不再单独打徽标或提供过滤。
 *
 * 导出（2026-10-22 加）：划线攒在库里只能一条条看，想拿走（写读后感、整理书摘、
 * 丢进别的笔记软件）没有出路。现在可以导成一份 Markdown —— 那是「能记下来却带不走」
 * 的缺口。导出是纯前端动作，不新增端点（`/api/catalog` 仍是 139 条）。
 */
export function NotesPanel({ notes, onJump, meta, chapterTitles }: {
  notes: BookNote[]
  onJump: (note: BookNote) => void
  /** 导出用的书籍信息；不传就不显示导出按钮（例如别处只想复用清单）。 */
  meta?: NoteExportMeta
  /** 章号 → 章名；缺了导出会退回「第 N 章」，不编标题。 */
  chapterTitles?: Record<number, string>
}) {
  const exportable = !!meta && notes.length > 0
  return (
    <>
      {exportable && (
        <div className="reader-notes-actions">
          <button
            type="button"
            className="subtle-button"
            onClick={() => downloadMarkdown(
              notesExportFileName(meta!.bookName),
              notesToMarkdown(notes, meta!, chapterTitles ?? {}),
            )}
            title="把这本书的全部划线导出成 Markdown 文件"
          >
            导出 Markdown
          </button>
          <span className="reader-notes-count">共 {notes.length} 条</span>
        </div>
      )}
      <ul className="reader-notes-list">
        {notes.length === 0 && <li className="reader-notes-empty">这本书还没有笔记。选中正文可以划线、写备注。</li>}
        {notes.map(note => (
          <li key={note.id} className="reader-note-item">
            <button type="button" className="reader-note-item-main" onClick={() => onJump(note)}>
              <span className="reader-note-item-excerpt">{note.excerpt}</span>
              {note.note && <span className="reader-note-item-text">{note.note}</span>}
              <span className="reader-note-item-meta">
                第 {note.chapterIndex + 1} 章
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}
