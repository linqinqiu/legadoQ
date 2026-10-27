/**
 * 标记快捷条（MD3 MarkingSelectionMenu 形态，PROPOSAL 阅读器增强）：
 * 选中正文后先摆这一条，而不是立刻弹笔记输入框。四个动作：
 *   划线（仅高亮，不写备注）/ 笔记（展开 NoteToolbar 编辑器）/ 复制 / 发给 AI。
 *
 * 挂在 `<section class="reader-main">` **之外** —— 它自己的点击不该再触发 onReaderMouseUp，
 * 所以和 NoteToolbar 一样是独立的一块，只跟选区坐标与回调打交道。
 */
export type MarkingMenuProps = {
  /** 选区中心 x（视口坐标）。 */
  x: number
  /** 选区顶部 y（视口坐标）。 */
  y: number
  onHighlight: () => void
  onNote: () => void
  onCopy: () => void
  onAi: () => void
  onDismiss: () => void
}

export function MarkingMenu({ x, y, onHighlight, onNote, onCopy, onAi, onDismiss }: MarkingMenuProps) {
  return (
    <div
      className="reader-marking-menu"
      style={{ left: x, top: y }}
      role="toolbar"
      aria-label="选中文字操作"
    >
      <button type="button" className="reader-marking-btn" title="划线（仅高亮）" aria-label="划线" onClick={onHighlight}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
      </button>
      <button type="button" className="reader-marking-btn" title="写笔记" aria-label="笔记" onClick={onNote}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3v5h5" /><path d="M15 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-4-5Z" /></svg>
      </button>
      <button type="button" className="reader-marking-btn" title="复制" aria-label="复制" onClick={onCopy}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect width="13" height="13" x="9" y="9" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
      </button>
      <button type="button" className="reader-marking-btn" title="发给 AI 助手" aria-label="AI" onClick={onAi}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l1.9 4.8L19 9.7l-5.1 1.9L12 16.4l-1.9-4.8L5 9.7l5.1-1.9L12 3Z" /><path d="M18.5 15.5l.9 2.2 2.1.8-2.1.8-.9 2.2-.9-2.2-2.1-.8 2.1-.8.9-2.2Z" /></svg>
      </button>
      <button type="button" className="reader-marking-btn" title="关闭" aria-label="关闭" onClick={onDismiss}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>
    </div>
  )
}
