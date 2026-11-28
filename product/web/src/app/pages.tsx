import React, { lazy } from 'react'
// 页面按路由惰性加载：首屏只拉书库那一支，阅读器/书源/书架/订阅/设置各成独立 chunk。
// 用 .then(m => ({ default: m.X })) 是因为这些页面都是具名导出，React.lazy 要的是 default。
// 注意别把这些引用改回静态 import —— 那会让首屏 bundle 又把它们全装回去（体积门禁盯着）。
const ExplorePage = lazy(() => import('../features/explore/ExplorePage').then(m => ({ default: m.ExplorePage })))
const LibraryPage = lazy(() => import('../features/bookshelf/LibraryPage').then(m => ({ default: m.LibraryPage })))
const RssPage = lazy(() => import('../features/rss/RssPage').then(m => ({ default: m.RssPage })))
const ShelfPage = lazy(() => import('../features/bookshelf/ShelfPage').then(m => ({ default: m.ShelfPage })))
const SourcesPage = lazy(() => import('../features/source-editor/SourcesPage').then(m => ({ default: m.SourcesPage })))
const SettingsPage = lazy(() => import('../features/settings/SettingsPage').then(m => ({ default: m.SettingsPage })))
import type { SettingsSection } from '../features/settings/SettingsPage'
import type { BookshelfItem, SearchResult, SourceSummary } from '../lib/api'
import type { OpenBook } from '../lib/openBook'
import type { ReaderSettings } from '../features/reader/settingsPanel/readerSettings'
import type { AppModal, Page, PageDialogKind } from '../lib/nav'

/**
 * 页面渲染表 —— 路由的另一半。
 *
 * `lib/pageMeta.ts`（shared）管"有哪些页面、怎么解析 hash"，这里管"每一页渲染什么"。
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
        <SourcesPage selected={ctx.selected} onSelect={ctx.onSelectSource} />
      )
    case 'subscriptions':
      return <RssPage onOpenBackup={() => ctx.openModal('backup')} onSourcesChange={ctx.refreshSources} />
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
