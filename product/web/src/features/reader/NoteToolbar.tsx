/**
 * 笔记浮层（PROPOSAL-019 E）：选中正文后摆出来，也用来改 / 删已有的高亮。
 *
 * 从 `ReaderScreen` 抽出来（PROPOSAL-019 F 的第一步）：它挂在 `<section class="reader-main">`
 * **之外** —— 自己的点击不该再触发 onReaderMouseUp，所以它是独立的一块，只跟草稿与四个动作打交道。
 */
export type NoteDraft = {
  id: number | null
  chapterIndex: number
  chapterUrl: string
  startOffset: number
  endOffset: number
  excerpt: string
  text: string
  x: number
  y: number
}

export function NoteToolbar({ draft, onChangeText, onSave, onRemove, onDismiss }: {
  draft: NoteDraft
  onChangeText: (text: string) => void
  onSave: () => void
  onRemove: () => void
  /** 关掉浮层；`clearSelection` 为真时连正文选区一起清（「取消」按钮），Esc 只关浮层。 */
  onDismiss: (clearSelection: boolean) => void
}) {
  return (
    <div className="reader-note-toolbar" style={{ left: draft.x, top: draft.y }} role="dialog" aria-label="笔记">
      {draft.id !== null && <p className="reader-note-excerpt">{draft.excerpt}</p>}
      <input
        className="reader-note-input"
        value={draft.text}
        autoFocus
        placeholder="写点备注（留空就只划线）"
        aria-label="备注"
        onChange={event => onChangeText(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') onSave()
          if (event.key === 'Escape') onDismiss(false)
        }}
      />
      <div className="reader-note-actions">
        <button type="button" className="primary-button" onClick={onSave}>保存</button>
        {draft.id !== null && <button type="button" className="subtle-button is-danger" onClick={onRemove}>删除</button>}
        <button type="button" className="subtle-button" onClick={() => onDismiss(true)}>取消</button>
      </div>
    </div>
  )
}
