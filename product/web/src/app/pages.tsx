import React from 'react'
import { ExplorePage } from '../pages/ExplorePage'
import { LibraryPage } from '../pages/LibraryPage'
import { RssPage } from '../pages/RssPage'
import { ShelfPage } from '../pages/ShelfPage'
import { SourcesPage } from '../pages/SourcesPage'
import { SettingsPage, type SettingsSection } from '../pages/SettingsPage'
import type { BookshelfItem, SearchResult, SourceSummary } from '../lib/api'
import type { OpenBook } from '../reader/openBook'
import type { ReaderSettings } from '../reader/readerSettings'
import type { AppModal, Page, PageDialogKind } from '../lib/nav'

/**
 * 页面渲染表 —— 路由的另一半。
 *
 * `pageMeta.ts` 管"有哪些页面、怎么解析 hash"，这里管"每一页渲染什么"。
 * 宿主（`main.tsx`）只负责把状态与回调打包成 [PageContext]，不再写 `page === 'x' ? … : …`
 * 那条会越接越长的三元链。
 *
 * 为什么参数是一整包上下文而不是每页一份 props：页面之间共享的东西（书源清单、设置、
 * 打开书/打开条目的动作）本来就来自同一个宿主；拆成六份只会让新增一页要改六处签名。
 */
export type PageContext = {
  sources: SourceSummary[]
  selected: SourceSummary | null
  settings: ReaderSettings
  /** 设置页的分区表：宿主已按当前动作接好线。 */
  settingsSections: SettingsSection[]
  /** 「设置 → TXT 分章规则」的去开一下信号（0 = 还没人点过）。 */
  tocRulesSignal: number
  onSelectSource: (source: SourceSummary | null) => void
  onSourcesChange: (sources: SourceSummary[]) => void
  refreshSources: () => void
  openBook: (book: OpenBook, index: number, origin: Page) => void
  openShelfItem: (item: BookshelfItem) => void
  openExploreDetail: (result: SearchResult) => Promise<void>
  onSettingsChange: (settings: ReaderSettings) => void
  openModal: (modal: AppModal) => void
  openPageDialog: (kind: PageDialogKind) => void
  openTocRules: () => void
}

export function renderPage(page: Page, ctx: PageContext): React.ReactNode {
  switch (page) {
    case 'sources':
      return (
        <SourcesPage
          selected={ctx.selected}
          onSelect={ctx.onSelectSource}
          onSourcesChange={ctx.onSourcesChange}
        />
      )
    case 'subscriptions':
      return <RssPage onOpenBackup={() => ctx.openModal('backup')} />
    case 'settings':
      return <SettingsPage sections={ctx.settingsSections} />
    case 'shelf':
      return (
        <ShelfPage
          sources={ctx.sources}
          onOpen={ctx.openShelfItem}
          txtTocRule={ctx.settings.txtTocRule}
          onTxtTocRuleChange={value => ctx.onSettingsChange({ ...ctx.settings, txtTocRule: value })}
          tocRulesSignal={ctx.tocRulesSignal}
        />
      )
    case 'explore':
      return <ExplorePage onOpen={ctx.openExploreDetail} />
    case 'reader':
      // 阅读器是整屏态，由宿主在进入外壳之前单独渲染；没有打开的书时落回书库。
      return null
    case 'library':
    default:
      return (
        <LibraryPage
          sources={ctx.sources}
          onSourcesChanged={ctx.refreshSources}
          onOpen={(book, index) => ctx.openBook(book, index, 'library')}
        />
      )
  }
}
