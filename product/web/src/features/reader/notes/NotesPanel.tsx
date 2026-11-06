import { useState } from 'react'
import type { BookNote } from '../../../lib/api'
import { downloadMarkdown, notesExportFileName, notesToMarkdown, type NoteExportMeta } from './noteExport'
import { filterNotes, noteCounts, type NoteKind } from './noteFilter'

/**
 * 「笔记」面板（PROPOSAL-019 E）：这本书的全部划线 / 备注 / 书签，点一条跳到那一章。
 *
 * 从 `ReaderScreen` 抽出来（PROPOSAL-019 F）—— 只跟笔记清单与「跳到那条」打交道，
 * 与翻页 / 进度 / 缓存无关。
 *
 * 书签（2026-11-06 接回）：数据一直在（`bookmark=true` 的笔记），缺的只是入口与辨认。
 * 现在三档筛选（全部 / 划线 / 书签）在面板顶部，书签项打徽标；「在当前位置加书签」
 * 也放这里 —— 窄屏顶栏只剩返回与标题，放这里是所有屏宽都够得着的入口。
 *
 * 导出（2026-10-22 加）：划线攒在库里只能一条条看，想拿走（写读后感、整理书摘、
 * 丢进别的笔记软件）没有出路。现在可以导成一份 Markdown —— 那是「能记下来却带不走」
 * 的缺口。导出是纯前端动作，不新增端点（`/api/catalog` 仍是 155 条）。
 */
export function NotesPanel({ notes, onJump, meta, chapterTitles, onBookmarkHere }: {
  notes: BookNote[]
  onJump: (note: BookNote) => void
  /** 导出用的书籍信息；不传就不显示导出按钮（例如别处只想复用清单）。 */
  meta?: NoteExportMeta
  /** 章号 → 章名；缺了导出会退回「第 N 章」，不编标题。 */
  chapterTitles?: Record<number, string>
  /** 在当前位置加一条书签；不传就不显示那个按钮（别处复用清单时不带阅读器上下文）。 */
  onBookmarkHere?: () => void
}) {
  const [kind, setKind] = useState<NoteKind>('all')
  const counts = noteCounts(notes)
  const visible = filterNotes(notes, kind)
  const exportable = !!meta && notes.length > 0
  return (
    <>
      {(exportable || onBookmarkHere) && (
        <div className="reader-notes-actions">
          {onBookmarkHere && (
            <button
              type="button"
              className="subtle-button"
              onClick={onBookmarkHere}
              title="把当前读到的那一段记成书签（再点一次取消）"
            >
              在当前位置加书签
            </button>
          )}
          {exportable && (
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
          )}
          <span className="reader-notes-count">共 {notes.length} 条</span>
        </div>
      )}
      <div className="reader-notes-tabs" role="tablist" aria-label="笔记类型">
        {([
          ['all', '全部'],
          ['marks', '划线'],
          ['bookmarks', '书签'],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={kind === value}
            className={`reader-notes-tab${kind === value ? ' is-active' : ''}`}
            onClick={() => setKind(value)}
          >
            {label}<small>{counts[value]}</small>
          </button>
        ))}
      </div>
      <ul className="reader-notes-list">
        {visible.length === 0 && (
          <li className="reader-notes-empty">
            {kind === 'bookmarks'
              ? '这本书还没有书签。读到想记住的地方，点上面的「在当前位置加书签」。'
              : kind === 'marks'
                ? '还没有划线或备注。选中正文可以划线、写备注。'
                : '这本书还没有笔记。选中正文可以划线、写备注；想只记个位置就用书签。'}
          </li>
        )}
        {visible.map(note => (
          <li key={note.id} className="reader-note-item">
            <button type="button" className="reader-note-item-main" onClick={() => onJump(note)}>
              {note.bookmark && <span className="reader-note-badge">书签</span>}
              <span className="reader-note-item-excerpt">{note.excerpt}</span>
              {note.note && <span className="reader-note-item-text">{note.note}</span>}
              <span className="reader-note-item-meta">
                第 {note.chapterIndex + 1} 章{note.stale ? ' · 原文已变，位置可能不准' : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}
