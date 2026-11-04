import React, { useDeferredValue, useMemo, useState } from 'react'
import type { BookNote, Chapter } from '../../lib/api'
import { Icon } from '../../icons'
import { NotesPanel } from './NotesPanel'
import { TocDrawerHeader } from './TocDrawerHeader'
import { VirtualChapterList } from './VirtualChapterList'
import { TOC_ROW_HEIGHT } from './readerInteractions'
import type { NoteExportMeta } from './noteExport'

/**
 * 目录抽屉：标题栏 + 章节搜索 + 虚拟列表 +（可切换的）笔记面板。
 *
 * 从 `ReaderScreen` 抽出（0.2.15 架构重排第二步）：
 * 这一整块只跟「这本书的章节表」有关，与翻页、正文、分页测量、朗读都不相干。
 *
 * **搜索与倒序状态住在组件内部**：它们是抽屉自己的界面态，别处没有读取者
 * （快捷键不聚焦这个输入框，跳章统一走 `onSelectChapter`）。
 * 把这两个 useState 留在 `ReaderScreen` 只会让父组件多背两个无关变量。
 */
export interface ReaderCatalogProps {
  /** 抽屉是否展开（决定 aside 的 open 类，与内容渲染无关）。 */
  open: boolean
  /** 当前章标题（已过简繁转换）；空表示还没定位到章。 */
  chapterTitle: string | null
  chapters: Chapter[]
  chapterIndex: number
  cachedUrlsSet: Set<string>
  wordCounts: ReadonlyMap<string, number>
  convertTitle: (text: string) => string
  /** 选中某一章：父组件负责切章并关抽屉。 */
  onSelectChapter: (index: number) => void
  onCloseDrawer: () => void

  // —— 标题栏上的五个开关 ——
  notesPanel: boolean
  onBackToToc: () => void
  onOpenSourceSwitch: () => void
  onOpenRefresh?: () => void
  inShelf: boolean
  onToggleShelf: () => void

  // —— 笔记面板 ——
  notes: BookNote[]
  onJumpNote: (note: BookNote) => void
  bookMeta: NoteExportMeta
  chapterTitles: Record<number, string>

  /** 抽屉打开时置 1，让列表把当前章滚进视野。 */
  autoScrollKey: number
}

export function ReaderCatalog({
  open,
  chapterTitle,
  chapters,
  chapterIndex,
  cachedUrlsSet,
  wordCounts,
  convertTitle,
  onSelectChapter,
  onCloseDrawer,
  notesPanel,
  onBackToToc,
  onOpenSourceSwitch,
  onOpenRefresh,
  inShelf,
  onToggleShelf,
  notes,
  onJumpNote,
  bookMeta,
  chapterTitles,
  autoScrollKey,
}: ReaderCatalogProps) {
  const [chapterQuery, setChapterQuery] = useState('')
  const deferredQuery = useDeferredValue(chapterQuery)

  const filteredChapters = useMemo(() => {
    const query = deferredQuery.trim().toLowerCase()
    if (!query) return chapters
    // 纯数字当作章号：输入「100」要能命中第 100 章（index 99）与「第 100 章」这类标题
    const numQuery = /^\d+$/.test(query) ? parseInt(query, 10) : null
    return chapters.filter((item) => {
      if (item.title.toLowerCase().includes(query)) return true
      if (numQuery !== null && (item.index === numQuery - 1 || item.index === numQuery)) return true
      return false
    })
  }, [deferredQuery, chapters])

  // 目录倒序（借鉴 Legado TocActivity 的 reverse_toc）：只影响显示顺序，跳转仍用章节原始 index。
  const [tocReverse, setTocReverse] = useState(false)
  const tocList = useMemo(
    () => (tocReverse ? filteredChapters.slice().reverse() : filteredChapters),
    [filteredChapters, tocReverse],
  )

  return (
    <aside className={`reader-drawer reader-drawer-left ${open ? 'open' : ''}`} aria-label="目录抽屉">
      <TocDrawerHeader
        chapterTitle={chapterTitle}
        chapterCount={chapters.length}
        tocReverse={tocReverse}
        onToggleReverse={() => setTocReverse((value) => !value)}
        notesPanel={notesPanel}
        onBackToToc={onBackToToc}
        onOpenSourceSwitch={onOpenSourceSwitch}
        onOpenRefresh={onOpenRefresh}
        inShelf={inShelf}
        onToggleShelf={onToggleShelf}
        onClose={onCloseDrawer}
      />
      {notesPanel ? (
        /* 这本书的全部划线 / 备注，点一条跳到那一章。
           导出需要书名与章名：书名从 bookMeta 取，章名用章节标题表，
           缺章名时导出那边会退回「第 N 章」，不编造。 */
        <NotesPanel
          notes={notes}
          onJump={onJumpNote}
          meta={bookMeta}
          chapterTitles={chapterTitles}
        />
      ) : (
        <>
          <div className="chapter-search">
            <Icon name="search" />
            <input
              value={chapterQuery}
              onChange={(event) => setChapterQuery(event.target.value)}
              placeholder="搜索章节"
            />
          </div>
          <VirtualChapterList
            chapters={tocList}
            activeChapterIndex={chapterIndex}
            cachedUrlsSet={cachedUrlsSet}
            wordCounts={wordCounts}
            onSelect={(index) => onSelectChapter(index)}
            itemHeight={TOC_ROW_HEIGHT}
            overscan={8}
            convertTitle={convertTitle}
            autoScrollKey={autoScrollKey}
          />
        </>
      )}
    </aside>
  )
}