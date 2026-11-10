import { useCallback, useEffect, type RefObject } from 'react'
import type { BookNote, BookSearchHit, Chapter } from '../../lib/api'
import { offsetToParagraph, textOffsetRect, type LogicalPosition } from './content/logicalPosition'

type NoteTarget = LogicalPosition & { chapterIndex: number }

type SearchFlash = { chapterIndex: number; offset: number; term: string }

interface PositionJumpParams {
  chapters: Chapter[]
  chapterIndex: number
  chapter: Chapter | null
  content: string
  loading: boolean
  setNotesPanel: (open: boolean) => void
  setActiveDrawer: (value: null) => void
  setBookSearchOpen: (open: boolean) => void
  setSearchFlash: (value: SearchFlash | null) => void
  changeChapter: (index: number, mode: 'first' | 'last' | 'auto') => void
  pendingNoteJumpRef: RefObject<NoteTarget | null>
  pageMode: string
  scrollToLogicalPosition: (position: NoteTarget) => boolean
  stride: number
  pageCount: number
  chunked: boolean
  renderLimit: number
  revealParagraph: (index: number) => void
  bodyRef: RefObject<HTMLDivElement | null>
  logicalMetaRef: RefObject<{ starts: number[] }>
  setPageIndex: (index: number) => void
}

/**
 * 阅读器「跳转到笔记 / 搜索命中」的导航原语，从 ReaderScreen 抽出来独立成 hook。
 *
 * 落点算法（滚动滚视口、分页换页码、跨章等正文挂进 DOM 再滚）原样保留，
 * 只是不再闭包 ReaderScreen 的几十个状态，便于单独阅读与测试。
 */
export function useReaderPositionJump(params: PositionJumpParams) {
  const {
    chapters, chapterIndex, chapter, content, loading,
    setNotesPanel, setActiveDrawer, setBookSearchOpen, setSearchFlash,
    changeChapter, pendingNoteJumpRef, pageMode,
    scrollToLogicalPosition, stride, pageCount, chunked, renderLimit,
    revealParagraph, bodyRef, logicalMetaRef, setPageIndex,
  } = params

  const jumpToNotePosition = useCallback((position: NoteTarget): boolean => {
    if (pageMode !== 'paginate') {
      /*
        分块章节里目标段可能还没挂出来：先补块，把落点交给 pending 的 effect，
        等这一轮渲染完再滚（直接滚会找不到那一段，然后悄悄退化成章首）。
      */
      if (chunked && logicalMetaRef.current?.starts.length) {
        const { index } = offsetToParagraph(logicalMetaRef.current.starts, position.charOffset)
        if (index >= renderLimit) {
          pendingNoteJumpRef.current = position
          revealParagraph(index)
          return false
        }
      }
      return scrollToLogicalPosition(position)
    }
    const meta = logicalMetaRef.current
    const body = bodyRef.current
    if (!meta?.starts.length || !body || stride <= 0) return false
    const section = body.querySelector<HTMLElement>(`.reader-page-chapter[data-chapter-index="${position.chapterIndex}"]`)
    const els = section ? Array.from(section.querySelectorAll<HTMLElement>('[data-paragraph-index]')) : []
    if (!els.length) return false
    const { index, within } = offsetToParagraph(meta.starts, position.charOffset)
    const target = els.find(el => Number(el.dataset.paragraphIndex ?? 0) === index) ?? els[0]
    const rect = textOffsetRect(target, within) ?? target.getBoundingClientRect()
    const offset = rect.left - body.getBoundingClientRect().left
    setPageIndex(Math.min(pageCount - 1, Math.max(0, Math.round(offset / stride))))
    return true
  }, [pageMode, scrollToLogicalPosition, stride, pageCount, chunked, renderLimit, revealParagraph, pendingNoteJumpRef, bodyRef, logicalMetaRef, setPageIndex])

  /** 从「笔记」面板跳到那一条所在的章，并滚到它的位置（跨章异步，落点挂 ref 等 DOM）。 */
  const jumpToNote = (note: BookNote) => {
    const target: NoteTarget = {
      chapterIndex: note.chapterIndex,
      charOffset: note.startOffset,
      paragraphAnchor: note.paragraphAnchor ?? '',
      positionChecksum: note.positionChecksum ?? '',
    }
    const index = chapters.findIndex(item => item.url === note.chapterUrl)
    setNotesPanel(false)
    setActiveDrawer(null)
    if (index >= 0 && index !== chapterIndex) {
      pendingNoteJumpRef.current = target
      changeChapter(index, 'first')
      return
    }
    jumpToNotePosition(target)
  }

  /** 跳到搜索命中处：切章、滚到那一段、把关键词临时高亮几秒。 */
  const jumpToSearchHit = (hit: BookSearchHit, term: string) => {
    setBookSearchOpen(false)
    setSearchFlash({ chapterIndex: hit.chapterIndex, offset: hit.offset, term })
    const target: NoteTarget = { chapterIndex: hit.chapterIndex, charOffset: hit.offset, paragraphAnchor: '', positionChecksum: '' }
    const index = chapters.findIndex(item => item.url === hit.chapterUrl)
    if (index >= 0 && index !== chapterIndex) {
      pendingNoteJumpRef.current = target
      changeChapter(index, 'first')
      return
    }
    jumpToNotePosition(target)
  }

  /** 跨章跳转的落点：正文挂进 DOM 之后才能滚，所以挂在 ref 上等这一条 effect。 */
  useEffect(() => {
    const pending = pendingNoteJumpRef.current
    if (!pending || loading || !content || !chapter) return
    if (chapter.index !== pending.chapterIndex) return
    if (jumpToNotePosition(pending)) pendingNoteJumpRef.current = null
  }, [content, loading, chapter, jumpToNotePosition])

  return { jumpToNote, jumpToSearchHit }
}
