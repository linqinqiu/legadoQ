import { useEffect, useState } from 'react'
import { api, type BookNote, type Chapter } from '../../lib/api'
import { setAiChatOpen } from '../../lib/aiChatStore'
import { setSelection, setSelectionFromDraft } from '../../lib/selectionStore'
import { toast } from '../../components/Toast'
import type { OpenBook } from '../../lib/openBook'
import type { NoteDraft } from './notes/NoteToolbar'
import { bookmarkPayload, findBookmarkAt } from './notes/bookmark'
import { reanchorNotes } from './notes/reanchor'

/**
 * 笔记 / 划线的状态与增删改（PROPOSAL-019 E）。
 *
 * 偏移是**章节内字符偏移**（段落在章里的起点 + 段内偏移），不用像素 / 列号 ——
 * 字号、字体、分栏一改位置就跳，这是阅读器那条老教训。`excerpt` 另外留一份选中原文：
 * 高亮按它在这段文字里定位，简繁转换换了字形也找得到。
 *
 * **刻意不搬进本 hook 的两块**（它们依赖导航原语或正文渲染路径，见研究续篇 §3）：
 * - `toggleBookmark`：要用 `readLogicalPosition`，与 `persist` 共享同一套逻辑位置算法，留在 ReaderScreen；
 * - `renderNoteHighlights` / `jumpToNote` / `jumpToSearchHit`：前者在正文渲染深层调用，后两者与搜索命中
 *   共用 `jumpToNotePosition` / `pendingNoteJumpRef` 导航原语，也留在 ReaderScreen。
 * 本 hook 只把「状态 + 与渲染/导航无关的增删改」收进来，`setNotes` / `openNote` 暴露给上面那两块复用。
 */
export interface UseReaderNotesDeps {
  currentBook: OpenBook
  bookName: string
  chapter: Chapter
  content: string
  paragraphStarts: number[]
  positionChecksum: string
  chapterIndex: number
}

export function useReaderNotes({ currentBook, bookName, chapter, content, paragraphStarts, positionChecksum, chapterIndex }: UseReaderNotesDeps) {
  const [notes, setNotes] = useState<BookNote[]>([])
  useEffect(() => {
    let alive = true
    api.notes(currentBook.details.sourceId, currentBook.bookUrl)
      .then(list => { if (alive) setNotes(list) })
      .catch(() => { if (alive) setNotes([]) })
    return () => { alive = false }
  }, [currentBook.details.sourceId, currentBook.bookUrl])
  /**
   * 正文换了（源站改版 / 重取章节 / AI 覆盖）之后，把这一章的批注位置重新对一遍：
   * 偏移漂了就把高亮与跳转拉回原文，实在认不出才标 stale。只改内存，不写库 ——
   * 正文还会再变，把一次猜测固化进库更难撤回。
   */
  useEffect(() => {
    if (!content || !chapter || !positionChecksum) return
    setNotes(list => reanchorNotes(list, chapter.index, content, positionChecksum))
  }, [content, chapter, positionChecksum])
  /**
   * 待保存 / 正在编辑的那一条。`id === null` = 刚从选区新建；否则是点已有高亮打开的。
   * `x`/`y` 是浮层要摆的位置（视口坐标，横向以选中处为中心）。
   */
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null)
  /** 目录抽屉里的「笔记」面板开关（按书查看）。 */
  const [notesPanel, setNotesPanel] = useState(false)
  /** 标记快捷条 vs 笔记编辑器：选中后先显示快捷条，点「笔记」才展开 NoteToolbar。 */
  const [noteEditorOpen, setNoteEditorOpen] = useState(false)

  /** 段落里某个节点位置 → 段内字符偏移（选区跨多个文本节点时，前面那些也要加上）。 */
  const offsetWithin = (root: HTMLElement, node: Node, offset: number): number => {
    let total = 0
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const current = walker.currentNode
      if (current === node) return total + offset
      total += (current.textContent ?? '').length
    }
    return total
  }

  /** 把当前选区算成一条 noteDraft + 同步给 AI 的 selection；选中了正文就返回，否则 null。
   * 左键松手（onReaderMouseUp）和右键菜单（onBodyContextMenu）共用这一份算法。 */
  const buildSelectionDraft = (): { draft: NoteDraft; selection: Parameters<typeof setSelectionFromDraft>[0] } | null => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
    const range = selection.getRangeAt(0)
    const startEl = (range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer as HTMLElement)
    const endEl = (range.endContainer.nodeType === Node.TEXT_NODE ? range.endContainer.parentElement : range.endContainer as HTMLElement)
    const startP = startEl?.closest<HTMLElement>('.reader-paragraph')
    const endP = endEl?.closest<HTMLElement>('.reader-paragraph')
    if (!startP || !endP) return null
    const startIndex = Number(startP.dataset.paragraphIndex ?? -1)
    const endIndex = Number(endP.dataset.paragraphIndex ?? -1)
    if (startIndex < 0 || endIndex < startIndex) return null
    const excerpt = selection.toString().trim()
    if (!excerpt) return null
    const startOffset = (paragraphStarts[startIndex] ?? 0) + offsetWithin(startP, range.startContainer, range.startOffset)
    const endOffset = (paragraphStarts[endIndex] ?? 0) + offsetWithin(endP, range.endContainer, range.endOffset)
    // 选中的那一段属于**哪一章**：续接上来的下一章也在同一个容器里，不能一律按锚点章记
    const ownerIndex = Number(startP.closest<HTMLElement>('[data-chapter-index]')?.dataset.chapterIndex ?? chapterIndex)
    const rect = range.getBoundingClientRect()
    const chapterUrl = currentBook.chapters[ownerIndex]?.url ?? ''
    const draft: NoteDraft = {
      id: null, chapterIndex: ownerIndex, chapterUrl,
      startOffset, endOffset: Math.max(endOffset, startOffset + excerpt.length), excerpt, text: '',
      x: rect.left + rect.width / 2, y: rect.top,
    }
    const sel = {
      excerpt,
      chapterIndex: ownerIndex,
      chapterUrl,
      startOffset,
      endOffset: Math.max(endOffset, startOffset + excerpt.length),
      sourceId: currentBook.details.sourceId,
      bookUrl: currentBook.bookUrl,
      bookName,
      chapterTitle: currentBook.chapters[ownerIndex]?.title,
      x: rect.left + rect.width / 2,
      y: rect.top,
    }
    return { draft, selection: sel }
  }

  /** 松手时看有没有选中正文；选中了就摆出浮层（划线 / 写备注都在那一层里）。 */
  const onReaderMouseUp = () => {
    const built = buildSelectionDraft()
    if (!built) return
    setNoteDraft(built.draft)
    setNoteEditorOpen(false)
    // 同一份选区同步到共享 store：AI 悬浮球挂在根节点上，拿不到这里的局部 state，
    // 于是模型只知道"你在第几章"、不知道"你正盯着哪一段"（用户说的「不能在对应地点研究」）。
    setSelectionFromDraft(built.selection)
  }

  /** 保存（新建或改备注）。备注留空就是纯划线。 */
  const saveNote = async () => {
    const draft = noteDraft
    if (!draft) return
    if (draft.id === null) {
      const created = await api.addNote({
        sourceId: currentBook.details.sourceId, bookUrl: currentBook.bookUrl, bookName,
        chapterUrl: draft.chapterUrl, chapterIndex: draft.chapterIndex,
        startOffset: draft.startOffset, endOffset: draft.endOffset, excerpt: draft.excerpt, note: draft.text,
      }).catch(() => null)
      if (created) {
        setNotes(list => [...list, created])
        toast.success(draft.text?.trim() ? '已保存笔记' : '已划线')
      }
    } else {
      const ok = await api.updateNote(draft.id, draft.text).then(() => true).catch(() => false)
      if (ok) {
        setNotes(list => list.map(item => (item.id === draft.id ? { ...item, note: draft.text } : item)))
        toast.success('已更新笔记')
      }
    }
    setNoteDraft(null)
    setNoteEditorOpen(false)
    setSelection(null)
    window.getSelection()?.removeAllRanges()
  }

  const removeNote = async () => {
    const draft = noteDraft
    if (!draft || draft.id === null) return
    const ok = await api.deleteNote(draft.id).then(() => true).catch(() => false)
    if (ok) setNotes(list => list.filter(item => item.id !== draft.id))
    setNoteDraft(null)
    setSelection(null)
  }

  /** 标记快捷条：划线（仅高亮，不写备注）。 */
  const highlightFromMenu = () => { void saveNote() }
  /** 标记快捷条：展开笔记编辑器。 */
  const openNoteEditor = () => setNoteEditorOpen(true)
  /** 标记快捷条：复制选中原文。 */
  const copySelection = () => {
    const text = noteDraft?.excerpt
    if (text) void navigator.clipboard?.writeText(text).then(() => toast.success('已复制'), () => toast.warning('浏览器没让复制'))
    setNoteDraft(null)
    setNoteEditorOpen(false)
  }
  /** 标记快捷条：把选区交给 AI 悬浮球（选区已写入 selectionStore）。 */
  const sendSelectionToAi = () => {
    setAiChatOpen(true)
    setNoteDraft(null)
    setNoteEditorOpen(false)
  }
  /** 标记快捷条：关闭（Esc 也走这条）。 */
  const dismissMarkingMenu = () => {
    setNoteDraft(null)
    setNoteEditorOpen(false)
  }

  /** 点已有高亮：打开编辑（改备注 / 删）。 */
  const openNote = (note: BookNote, x: number, y: number) => {
    setNoteDraft({ id: note.id, chapterIndex: note.chapterIndex, chapterUrl: note.chapterUrl, startOffset: note.startOffset, endOffset: note.endOffset, excerpt: note.excerpt, text: note.note, x, y })
    setNoteEditorOpen(true)
  }

  return {
    notes, noteDraft, notesPanel, noteEditorOpen,
    setNotes, setNoteDraft, setNoteEditorOpen, setNotesPanel,
    buildSelectionDraft, onReaderMouseUp,
    saveNote, removeNote, highlightFromMenu, openNoteEditor,
    copySelection, sendSelectionToAi, dismissMarkingMenu, openNote,
  }
}
