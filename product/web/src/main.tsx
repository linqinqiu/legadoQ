import { useEffect, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { api, BookDetails, BookshelfItem, SearchResult, SourceSummary } from './lib/api'
import { reportBrand } from './lib/brandStore'
import { ContextMenuLayer } from './components/ContextMenu'
import { ReaderScreen } from './reader/ReaderScreen'
import type { OpenBook } from './reader/openBook'
import { ErrorBoundary } from './components/ErrorBoundary'
import { activeCustomSkin, loadReaderSettings, ReaderSettings, saveReaderSettings, themeClassNames } from './reader/readerSettings'
import { AppHeader } from './components/AppHeader'
import { FirstRunAgreement } from './components/FirstRunAgreement'
import { CustomizeModal } from './components/CustomizeModal'
import { ServerPortModal } from './components/ServerPortModal'
import { BrandModal } from './components/BrandModal'
import { ChangelogModal } from './plugins/changelog/ChangelogModal'
import { BackupModal } from './plugins/backup/BackupModal'
import { AboutModal } from './plugins/about/AboutModal'
import { ReadingLogModal } from './plugins/reading-log/ReadingLogModal'
import { SourceHealthEntryModal } from './plugins/source-health/SourceHealthModalEntry'
import { AiModal } from './features/ai/AiModal'
import { AiFloatingBall } from './features/ai/AiFloatingBall'
import type { UiContext } from './lib/uiContext'
import { getSelection, subscribeSelection } from './lib/selectionStore'
import { cleanAuthor, cleanTitle } from './lib/searchFilters'
import { loadSourceBook, SourceChoice, SourceChoiceStatus, useSearchSlice } from './lib/searchStore'
import { ReplaceRulesModal } from './components/ReplaceRulesModal'
import { PageDialog } from './components/PageDialog'
import { Select } from './components/Select'
import { OfflineCacheModal } from './components/OfflineCacheModal'
import { LogsModal } from './components/LogsModal'
import { ShortcutHelp } from './reader/ShortcutHelp'
import { GLOBAL_SHORTCUTS, isTypingTarget, normalizeKey, PRIMARY_PAGES, shortcutFor } from './reader/shortcuts'
import { buildSettingsSections } from './settings/settingsSections'
import { PwaManager } from './components/PwaManager'
import { flushOfflineProgress } from './lib/offlineStorage'
import { loadAllFonts } from './lib/fontLibrary'
import { toast, ToastContainer } from './components/Toast'
import './styles.css'
import { AppModal, Page, PageDialogKind } from './lib/nav'
import { BookDetailModal } from './components/BookDetailModal'
import { pageFromHash } from './app/pageMeta'
import { renderPage, type PageContext } from './app/pages'

import { parseSourceJsonText, extractSourcesFromRaw, sanitizeImageUrl } from './sources/sourceImport'

export { extractSourcesFromRaw, parseSourceJsonText, sanitizeImageUrl }
export type { SourceChoice, SourceChoiceStatus }
const PAGE_DIALOG_TITLES: Record<PageDialogKind, string> = { rules: '替换净化规则' }
const readerStorageKey = 'legado-open-book-v1'
/** 旧深链进来仍开对的那一个悬浮层，不白屏也不跳页 */
const dialogFromHash = (): PageDialogKind | null => location.hash === '#rules' ? 'rules' : null

/**
 * 老深链 → 对应的**成熟功能浮层**。
 *
 * 0.8.3 起更新日志/备份/关于/阅读记录都不占一级导航了（它们是 `AppModal` 那一族单例浮层，
 * 由本文件渲染、类型住在 `lib/nav.ts`），但老书签/老链接还在 —— 映射到对应浮层，
 * 比 404 或空弹窗都体面。
 */
const MODAL_DEEP_LINKS: Record<string, AppModal> = {
  '#changelog': 'changelog',
  '#backup': 'backup',
  '#about': 'about',
  '#reading-log': 'reading-log',
}

/**
 * 自定义皮肤的注入点（「自定义」里填的 CSS 真的挂上，不是摆个空控件）。
 *
 * 用 `document.createElement('style')` + `textContent` 而不是 `dangerouslySetInnerHTML`：
 * 用户写的 CSS 里出现 `</style>` 也不会拼出新标签（textContent 不走 HTML 解析）。
 * 规则按用户写的样子挂上去（要求他自己写 `.theme-<id> { … }` 这种完整选择器），
 * 因为把用户输入包进 `.theme-x{…}` 会依赖 CSS 嵌套语法，老浏览器上一条都不生效。
 * id 过一遍白名单（`parseSkinId`），只允许 `[a-z0-9-_]`。
 */
function SkinStyle({ settings }: { settings: ReaderSettings }) {
  const active = activeCustomSkin(settings)
  const id = active?.id ?? ''
  const css = (active?.css ?? '').trim()
  useEffect(() => {
    const marker = 'legado-custom-skin'
    const existing = document.getElementById(marker)
    if (!id || !css) {
      existing?.remove()
      return
    }
    let el = existing as HTMLStyleElement | null
    if (!el) {
      el = document.createElement('style')
      el.id = marker
      document.head.appendChild(el)
    }
    el.textContent = css
    return () => { document.getElementById(marker)?.remove() }
  }, [id, css])
  return null
}

function App() {
  const [ready, setReady] = useState(false)
  /**
   * 启动等待提示。这台服务不设身份、冷启动要几十秒（加载几千个书源、预热缓存），
   * 探活一次没问到只说明"它还没起来"——这时该做的是自动重试，而不是把人挡在一张
   * 「连不上本机服务 / 不是你的密码」的整屏页前面（用户 2026-10-08 要求删掉那张页）。
   */
  const [bootHint, setBootHint] = useState('')
  const [settings, setSettings] = useState<ReaderSettings>(loadReaderSettings)
  /**
   * 当前要挂在根上的皮肤类名（自定义皮肤是**叠**在内置皮肤上的，所以可能有两个类；
   * 理由见 `readerSettings.themeClassNames`）。收成一份，effect 与各处外壳同引，
   * 免得某一处忘了跟着改而少挂基类。
   */
  const skinClasses = themeClassNames(settings).join(' ')
  /**
   * 皮肤类**同时挂到 `<html>`**，不只挂在 `.app-shell` 上。
   * 起因是用户 2026-10-01：「指定源搜索还没做好，你看看在夜读模式下」——
   * `Select` 的下拉浮层是 `createPortal(…, document.body)`（必须如此：书架/订阅各有各的
   * 滚动容器与边框，绝对定位会被祖先裁掉），而 `--surface`/`--ink`/`--line` 这些变量原本只定义在
   * `.theme-*` 上、`.theme-*` 只在应用外壳那一层 → **portal 出来的浮层一个变量都拿不到**：
   * 实测菜单底色 `rgba(0,0,0,0)`、文字 `rgb(0,0,0)`。浅色模式只是描边发虚所以藏了很久。
   */
  useEffect(() => {
    const root = document.documentElement
    const stale = [...root.classList].filter(name => name.startsWith('theme-'))
    if (stale.length) root.classList.remove(...stale)
    root.classList.add(...themeClassNames(settings))
  }, [skinClasses])
  /**
   * 系统标题栏/状态栏那条边跟着皮肤走。取的是 `<html>` 上**算出来**的 `--canvas`，
   * 不是前端写死的三档色表 —— 自定义皮肤（叠在某一档之上的那一套）只有这样才取得到。
   * 声明顺序要紧：它必须排在上面挂类的那个 effect 之后，否则读到的是上一个皮肤的值。
   */
  useEffect(() => {
    const canvas = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim()
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', canvas || '#f8f9f7')
  }, [skinClasses])
  const [page, setPage] = useState<Page>(pageFromHash)
  // 阅读器里的选区（划出来的那段）：存放在组件之外（lib/selectionStore），
  // 因为 AI 悬浮球与阅读器是两棵独立的树，靠 props 传要一路穿下来。
  const currentSelection = useSyncExternalStore(subscribeSelection, getSelection, getSelection)
  const [readerReturnPage, setReaderReturnPage] = useState<Page>('shelf')
  const [sources, setSources] = useState<SourceSummary[]>([])
  /** 服务端 /healthz 报回来的版本号，显示在顶栏功能菜单里；构建清单是唯一来源。 */
  const [serverVersion, setServerVersion] = useState('')
  const [selected, setSelected] = useState<SourceSummary | null>(null)
  const [reader, setReader] = useState<{ book: OpenBook; index: number } | null>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(readerStorageKey) ?? 'null')
    } catch {
      return null
    }
  })
  const [pageDialog, setPageDialog] = useState<PageDialogKind | null>(dialogFromHash())
  /**
   * 当前开着的那个「单例弹窗」。
   *
   * 从前是 5 个独立布尔（showOfflineCache / showLogs / showShortcuts / showCustomize /
   * showServerPort），每加一个弹窗就要多一个 useState + 一段 JSX + 一处 onClose 接线 ——
   * 主框架就是这么一点点变重的。而且布尔们允许多个同时为 true，真同时开两层就没人管了。
   *
   * 收成一个字符串状态：同一时刻只可能开一个，加新弹窗只需往 union 里加一个字面量。
   */
  const [openModal, setOpenModal] = useState<AppModal | null>(null)

  /**
   * 浮层的**返回栈**：从一个浮层跳到另一个浮层时，记下从哪儿来的。
   *
   * 为什么需要它（真机门禁 `ui-shell-check` 抓到的）：
   * 「关于」页上有「更新日志」「快捷键」两个按钮。点了之后 `openModal` 变成目标浮层，
   * 关于就被卸载了 —— 再关掉目标浮层，`openModal` 变 null，用户被**扔回主界面**，
   * 而不是回到刚才那个「关于」。真机路径：
   *   关于 → 快捷键 → 关闭 → 期望回到关于，实际回到书架。
   *
   * 所以这里记一层"从哪来的"，关闭时若有来源就先回来源。只记一层：
   * 浮层套浮层再深就该改用真正的路由了，那超出这个单例状态该管的范围。
   */
  const [modalBackTo, setModalBackTo] = useState<AppModal | null>(null)

  /** 打开一个浮层，并记下来源（用于关闭时回退）。 */
  const openModalFrom = (next: AppModal, from: AppModal) => {
    setModalBackTo(from)
    setOpenModal(next)
  }

  /**
   * 从**主界面**直接打开一个浮层（顶栏、设置页、深链都走这条）。
   *
   * 必须清空返回栈：否则上一次"关于 → 快捷键"留下的来源会粘住，
   * 导致这次从设置页打开的快捷键，关掉后跳回「关于」—— 那是凭空冒出来的。
   */
  const openModalDirect = (next: AppModal) => {
    setModalBackTo(null)
    setOpenModal(next)
  }

  /** 关闭当前浮层：有来源就回来源，否则全关。 */
  const closeModal = () => {
    if (modalBackTo) {
      const back = modalBackTo
      setModalBackTo(null)
      setOpenModal(back)
    } else {
      setOpenModal(null)
    }
  }
  /**
   * 「设置 → TXT 分章规则」点下去的意图。规则弹窗连同它那颗「按这条导入本地书」都住在
   * 书架里（导书的动作在那边），所以这里只发一个"去开一下"的信号，不复制一份弹窗。
   */
  const [tocRulesSignal, setTocRulesSignal] = useState(0)
  /** 发现页点中的书：先进详情弹窗（与搜索页同一套），点「开始阅读」才进阅读器。 */
  const [explorePick, setExplorePick] = useState<{ result: SearchResult; book: OpenBook } | null>(null)
  /**
   * 根组件只要"在不在搜索"这一个布尔。以前是 `useSearchStore()` 拿整份快照 ——
   * 整库搜索期间进度每 250ms 写一次 store，于是整棵 App 树跟着每秒重渲染四次。
   */
  const searching = useSearchSlice((state) => state.loading)

  useEffect(() => {
    saveReaderSettings(settings)
  }, [settings])

  useEffect(() => {
    const handleOnline = () => {      void flushOfflineProgress(async (item) => {
        await api.saveProgress(item.sourceId, item.bookUrl, item.chapterUrl, item.chapterIndex, item.scrollPosition)
      })
    }
    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [])

  useEffect(() => {
    // 启动探活：问到就进界面；问不到就**自动重试**（服务冷启动要十几秒）。
    // 不再整屏挡住 —— 这台服务不设身份，"连不上"只意味着它还没起来或正在重启，
    // 该做的是等一等再试，而不是让人去猜一个根本不存在的密码。
    //
    // 两个刻意的取舍（用户 2026-10-09：「加载页转半分钟」）：
    // ① 每次探活**带超时**。原来 fetch 不带 signal：端口已 listen 但服务还没开始答请求时，
    //    这个 fetch 会一直挂着 —— `catch` 不触发、重试不启动、连"正在等待…"那句都换不出来，
    //    加载页就这么干等到服务答话。
    // ② 探活一过就放行，**不再等整份书源清单**（5,574 个源、~1MB）。书源在后台接着取，
    //    取回来再填进去；首屏不必为它多等几秒。
    let cancelled = false
    let timer: number | undefined
    let attempts = 0
    // 前 ~60s 每 1.5s 快速重试（期间停在加载页）；之后先进界面，再每 5s 慢轮询，服务起来会自愈。
    const FAST_UNTIL = 40
    const PROBE_TIMEOUT_MS = 2500
    const tick = async () => {
      if (cancelled) return
      attempts += 1
      if (attempts === 4) setBootHint('正在等待本机服务启动…（它可能正在重启，稍等片刻）')
      // 等了十几秒还没来，多半是服务压根没在跑 —— 给一句能照着做的。
      // 桌面那个 legadoQ 是 PWA 快捷方式，不会启动本机服务；真正能起服务的是同目录的 start.cmd。
      if (attempts === 12) setBootHint('本机服务还没起来。请双击桌面上的「legadoQ」启动它 —— 起来后会自动打开这一页。')
      const controller = new AbortController()
      const probeTimeout = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
      try {
        const response = await fetch('/healthz', { signal: controller.signal })
        if (!response.ok) throw new Error(`healthz ${response.status}`)
        // 版本号只认服务端报的这一个来源：Gradle 写进清单、/healthz 报出来、界面显示它。
        // 三处同一个数，不会出现"改了 build.gradle 忘了改界面"的假版本号。
        const health = await response.json().catch(() => null)
        if (cancelled) return
        if (health?.version) {
          setServerVersion(String(health.version))
        }
        setBootHint('')
        setReady(true)
        void api.sources().then(list => { if (!cancelled) setSources(list) }).catch(() => undefined)
      } catch {
        if (cancelled) return
        if (attempts === FAST_UNTIL) setReady(true) // 等够了先放行，别把人永远挡在加载页
        timer = window.setTimeout(tick, attempts < FAST_UNTIL ? 1500 : 5000)
      } finally {
        window.clearTimeout(probeTimeout)
      }
    }
    void tick()
    return () => { cancelled = true; if (timer) window.clearTimeout(timer) }
  }, [])

  // 品牌（应用名称与图标）在启动时拉一次，写进单一来源 lib/brandStore：
  // 顶栏品牌字、标签页标题都读那里。取不到就保持内置的「legadoQ」，不把界面弄成空名字。
  useEffect(() => {
    void api.brand()
      .then(info => reportBrand({
        displayName: info.displayName,
        builtinName: info.builtinName,
        iconUrl: info.hasIcon ? info.iconUrl ?? null : null,
        themeColor: info.themeColor,
      }))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    // 深链与浏览器前进/后退都从这里走：命中悬浮层 hash（#backup 等）就开层、不换页（保住语境）；
    // 命中普通页面 hash 就换页并关掉可能还开着的悬浮层。
    const sync = () => {
      // 旧深链兼容：这些页面现在是 `AppModal` 单例浮层（见上面的 MODAL_DEEP_LINKS）。
      // 老链接不该白屏、也不该留个没有渲染分支的空悬浮层 —— 直接开对应浮层。
      const modalDeepLink = MODAL_DEEP_LINKS[location.hash]
      if (modalDeepLink) {
        setPageDialog(null)
        setModalBackTo(null)
        setOpenModal(modalDeepLink)
        return
      }
      const dialog = dialogFromHash()
      setPageDialog(dialog)
      if (!dialog) setPage(pageFromHash())
    }
    addEventListener('hashchange', sync)
    // 首次挂载也跑一次：直接打开 `/#backup` 这类深链时没有 hashchange 事件，
    // 不跑就等于"深链只对已经在页面里的人有效"—— 那正是新标签页打开老链接的常见场景。
    sync()
    return () => removeEventListener('hashchange', sync)
  }, [])

  const navigate = (next: Page) => {
    if (next === 'reader' && !reader) return
    location.hash = `#${next}`
    setPage(next)
  }

  // 桌面手感（借鉴悦读）+ 全局快捷键（表在 web/src/shortcuts.ts，「快捷键」那张表渲染同一份）。
  // 阅读器里不抢 Ctrl+F —— 在长正文里找字，浏览器原生查找更好用。
  useEffect(() => {
    const NAV: Page[] = PRIMARY_PAGES.map(item => item.page as Page)
    const focusSearch = () => {
      // 这一页上的"搜索框"措辞不统一（输入书名或作者 / 筛选书名或作者 / 筛选书源），
      // 只按"搜索"两个字找会一条都找不到 —— Ctrl+F 原来就是这么哑着的。
      const input = document.querySelector<HTMLInputElement>(
        'main input[type="search"], .source-filter input, '
        + 'main input[placeholder*="搜索"], main input[placeholder*="筛选"], main input[placeholder*="输入"]')
      if (!input) return false
      input.focus()
      input.select()
      return true
    }
    const handler = (event: KeyboardEvent) => {
      if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        const current = NAV.indexOf(page)
        if (current < 0) return
        event.preventDefault()
        navigate(NAV[(current + (event.key === 'ArrowRight' ? 1 : NAV.length - 1)) % NAV.length])
        return
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f' && page !== 'reader') {
        if (focusSearch()) event.preventDefault()
        return
      }
      const key = normalizeKey(event)
      if (!key || isTypingTarget(event.target, key)) return
      const hit = shortcutFor(GLOBAL_SHORTCUTS, key)
      if (!hit) return
      // 阅读器里那些单字母键归阅读器自己（D/S/T/F/M…）；只有这张表在哪都要能开
      if (page === 'reader' && hit.action !== 'help' && hit.action !== 'close-help') return
      if (hit.action === 'search') {
        if (focusSearch()) event.preventDefault()
      } else if (hit.action === 'help') {
        event.preventDefault()
        setModalBackTo(null)
        setOpenModal(value => (value === 'shortcuts' ? null : 'shortcuts'))
      } else if (hit.action === 'close-help') {
        setModalBackTo(null)
        setOpenModal(value => (value === 'shortcuts' ? null : value))
      } else if (hit.action === 'logs') {
        event.preventDefault()
        setModalBackTo(null)
        setOpenModal('logs')
      } else if (hit.page) {
        event.preventDefault()
        navigate(hit.page as Page)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [page, openModal])

  const openReader = (book: OpenBook, index: number, origin: Page = 'library') => {
    const fallbackCover = book.details.coverUrl || book.details.alternateSources?.find(s => s.coverUrl?.trim())?.coverUrl?.trim()
    void api.addToBookshelf({
      sourceId: book.details.sourceId,
      bookUrl: book.bookUrl,
      name: book.details.name,
      author: book.details.author,
      tocUrl: book.details.tocUrl,
      coverUrl: fallbackCover || undefined,
      alternateSources: book.details.alternateSources,
    }).catch(error => {
      // 静默吞掉的后果是"书读着、进度却写到一本不在书架上的书"——至少要让人知道加架没成
      toast.error(`《${book.details.name}》没能加入书架：${error instanceof Error ? error.message : '未知原因'}`)
    })
    const value = { book, index }
    setReader(value)
    setReaderReturnPage(origin)
    sessionStorage.setItem(readerStorageKey, JSON.stringify(value))
    location.hash = '#reader'
    setPage('reader')
  }

  /**
   * 发现页点击：只取详情与目录，然后弹详情窗 —— 和搜索页走同一个 BookDetailModal。
   * 以前一步直达阅读器，等于在用户还没决定读不读的时候就把书塞进书架。
   */
  const openExploreDetail = async (result: SearchResult) => {
    const book = await loadSourceBook(result)
    setExplorePick({ result, book })
  }

  const openShelfItem = async (item: BookshelfItem) => {
    const fallbackCover = item.coverKey ? api.cover(item.coverKey) : (item.alternateSources?.find(s => s.coverUrl?.trim())?.coverUrl?.trim() || undefined)
    const safeDetails: BookDetails = {
      sourceId: item.sourceId,
      name: cleanTitle(item.name) || item.name,
      author: cleanAuthor(item.author) || item.author,
      coverUrl: fallbackCover,
      intro: undefined,
      tocUrl: item.tocUrl,
      alternateSources: item.alternateSources,
      // 书架条目带书源类型（服务端 json_extract 来的）—— 阅读器据此选播放器/图片流
      sourceType: item.sourceType,
    }

    try {
      const [chapters, progress] = await Promise.all([
        api.chapters(safeDetails.sourceId, safeDetails.tocUrl),
        api.progress(safeDetails.sourceId, item.bookUrl).catch(() => undefined),
      ])
      const resumeIdx = progress?.chapterIndex ?? item.chapterIndex ?? 0
      openReader({
        details: safeDetails,
        bookUrl: item.bookUrl,
        chapters,
        progress: progress || (item.chapterIndex !== undefined ? {
          sourceId: item.sourceId,
          bookUrl: item.bookUrl,
          chapterUrl: chapters[resumeIdx]?.url || '',
          chapterIndex: resumeIdx,
          scrollPosition: item.scrollPosition ?? 0,
          updatedAt: item.lastReadAt,
        } : undefined),
      }, resumeIdx, 'shelf')
    } catch (error) {
      // 这里原来会伪造一章（url = tocUrl）直接进阅读器：读者看到的是一个假章节，
      // 抓回来的其实是目录页内容，还会把 `chapterUrl=tocUrl` 当成真实进度写回服务端与 IndexedDB，
      // 下次联网打开就从这一章的假位置继续。目录取不到时宁可明确报错，不要进入坏状态。
      toast.error(error instanceof Error ? `无法打开《${item.name}》：${error.message}` : `无法打开《${item.name}》：目录加载失败`)
    }
  }

  if (!ready) {
    // 慢启动期间也要挂 PwaManager 与 Toast：更新提示、后台同步的反馈不能因为"还在等"就消失。
    return (
      <main className={`app-loading ${skinClasses}`}>
        <ToastContainer />
        <PwaManager />
        {/* 转一下至少说明"在动"，不是一张死页 —— 服务冷启动要十几秒，光一行字容易被当成卡死。 */}
        <div className="app-loading-box" role="status" aria-live="polite">
          <span className="app-loading-spinner" aria-hidden="true" />
          <span>{bootHint || '正在打开阅读空间…'}</span>
        </div>
      </main>
    )
  }

  /**
   * 当前界面上下文 —— 给 AI 面板用（它随对话发给模型）。
   *
   * 只收集**真实存在**的状态：当前页、打开的浮层、选中的书源、正在读的书与章节。
   * 不做推断、不塞正文（正文让模型用工具去取，那才是插件级功能的用法）。
   *
   * 位置说明：这一段**必须在阅读器分支之前**算出来。
   * 阅读器那一支是提前 `return` 的独立外壳（它自己那层 app-shell，见下），
   * 上下文原先定义在这个 return 之后，于是阅读器里拿不到「正在读这本书第几章」——
   * 而阅读恰恰是最需要"在对应地点研究"的地方。所以这里上移，两支共用同一份。
   */
  const currentUiContext: UiContext = {
    page,
    dialog: pageDialog,
    source: selected ? { id: selected.id, name: selected.name } : null,
    book: reader
      ? {
          sourceId: reader.book.details.sourceId,
          bookUrl: reader.book.bookUrl,
          name: reader.book.details.name,
          author: reader.book.details.author,
          chapterIndex: reader.index,
          chapterTitle: reader.book.chapters[reader.index]?.title,
        }
      : null,
    keyword: null,
    // 选中的那一段：模型据此知道"你问的这一句"具体指哪段话。
    // 没有选区时是 null —— 不猜、不编。
    selection: currentSelection
      ? {
          text: currentSelection.text,
          fullLength: currentSelection.fullLength,
          chapterIndex: currentSelection.chapterIndex,
          chapterTitle: currentSelection.chapterTitle,
        }
      : null,
  }

  if (page === 'reader' && reader) {
    return (
      <div className={`app-shell ${skinClasses}`}>
        <ToastContainer />
        {/* 阅读器这一支是自己那层 app-shell，浮层要自己挂一遍：
            不挂 ContextMenuLayer，卸载主壳时 publish 已被清成空函数，阅读器里右键就"什么都没发生"。 */}
        <ContextMenuLayer />
        {/* 阅读器崩了不该把外壳一起带走：正文那一支单独包一层，出口回到进入前的页面 */}
        <ErrorBoundary region="阅读器" onExit={() => navigate(readerReturnPage)}>
          <ReaderScreen
            openBook={reader.book}
            startIndex={reader.index}
            settings={settings}
            onSettingsChange={setSettings}
            onClose={() => navigate(readerReturnPage)}
          />
        </ErrorBoundary>
        {/* 全局 AI 悬浮球在阅读器里也要在：
            「不能随时随地使用、不能在对应地点研究」——读到一半的正文正是最该能问的地方。
            这里带的 uiContext 含「正在读这本书第几章」，模型问的是眼前这一段。

            注意它必须挂在**这一支自己的返回树**里：主壳那支在下面提前 return 了，
            读到这里说明主壳根本没渲染过，指望主壳的悬浮球是等不到的。 */}
        <AiFloatingBall uiContext={currentUiContext} />
      </div>
    )
  }

  const refreshSources = () => {
    void api.sources().then(setSources).catch(() => undefined)
  }


  /**
   * 页面渲染上下文 —— 宿主只负责把状态与动作打包，选哪一页由 `app/pages.tsx` 的
   * 渲染表决定。这里不再写 `page === 'x' ? …` 的三元链。
   */
  const pageContext: PageContext = {
    sources,
    selected,
    settings,
    settingsSections: buildSettingsSections({
      openShortcuts: () => openModalDirect('shortcuts'),
      openOfflineCache: () => openModalDirect('offline-cache'),
      openCustomize: () => openModalDirect('customize'),
      openReplaceRules: () => setPageDialog('rules'),
      openTocRules: () => setTocRulesSignal(value => value + 1),
      openBackup: () => openModalDirect('backup'),
      openLogs: () => openModalDirect('logs'),
      openServerPort: () => openModalDirect('server-port'),
      openBrand: () => openModalDirect('brand'),
      openAiConnections: () => openModalDirect('ai'),
    }),
    tocRulesSignal,
    onSelectSource: setSelected,
    onSourcesChange: setSources,
    refreshSources,
    openBook: openReader,
    openShelfItem: item => void openShelfItem(item),
    openExploreDetail,
    onSettingsChange: setSettings,
    openModal: setOpenModal,
    openPageDialog: setPageDialog,
    openTocRules: () => setTocRulesSignal(value => value + 1),
  }

  return (
    <div className={`app-shell ${skinClasses}`}>
      <SkinStyle settings={settings} />
      <ToastContainer />
      <ContextMenuLayer />
      <PwaManager />
      <FirstRunAgreement />
      <AppHeader
        page={page}
        settings={settings}
        searching={searching}
        onSettingsChange={setSettings}
        onNavigate={navigate}
        onOpenChangelog={() => openModalDirect('changelog')}
        onOpenAbout={() => openModalDirect('about')}
        onOpenReadingLog={() => openModalDirect('reading-log')}
        onOpenCustomize={() => openModalDirect('customize')}
        version={serverVersion}
      />
      {renderPage(page, pageContext)}
      {explorePick && page === 'explore' && (
        <BookDetailModal
          book={explorePick.book}
          choices={[{ result: explorePick.result, status: 'loaded', book: explorePick.book }]}
          sources={sources}
          onSourcesChanged={refreshSources}
          resumeIndex={0}
          onOpen={index => {
            const book = explorePick.book
            setExplorePick(null)
            openReader(book, index, 'explore')
          }}
          onChooseSource={() => undefined}
          onClose={() => setExplorePick(null)}
        />
      )}
      <ReplaceRulesModal
        isOpen={pageDialog === 'rules'}
        onClose={() => setPageDialog(null)}
      />

      {/* 单例弹窗：同一时刻只开一个。加新弹窗往 AppModal 加字面量，不必再添 useState。 */}
      {openModal === 'offline-cache' && <OfflineCacheModal onClose={closeModal} />}
      {openModal === 'logs' && <LogsModal onClose={closeModal} />}
      {openModal === 'shortcuts' && <ShortcutHelp onClose={closeModal} />}
      {openModal === 'customize' && (
        <CustomizeModal settings={settings} onChange={setSettings} onClose={closeModal} />
      )}
      {openModal === 'server-port' && <ServerPortModal onClose={closeModal} />}
      {openModal === 'brand' && <BrandModal onClose={closeModal} />}

      {/* —— 成熟功能浮层（已定型、低频、不占导航）。它们**不是**实验室条目。 —— */}
      {openModal === 'changelog' && (
        <ChangelogModal onClose={closeModal} serverVersion={serverVersion} />
      )}
      {openModal === 'backup' && <BackupModal onClose={closeModal} />}
      {openModal === 'about' && (
        <AboutModal
          onClose={closeModal}
          onOpenChangelog={() => openModalFrom('changelog', 'about')}
          onOpenShortcuts={() => openModalFrom('shortcuts', 'about')}
        />
      )}
      {openModal === 'reading-log' && <ReadingLogModal onClose={closeModal} />}
      {openModal === 'source-health' && (
        <SourceHealthEntryModal
          sources={sources}
          sourcesState={sources.length > 0 ? 'ready' : 'loading'}
          onClose={closeModal}
          onSourcesChange={refreshSources}
          onToast={(message: string) => toast.info(message)}
        />
      )}

      {/* —— AI 接入：**独立一类**（不是实验室） —— */}
      {openModal === 'ai' && (
        <AiModal onClose={closeModal} uiContext={currentUiContext} />
      )}

      {/* —— 全局 AI 悬浮球：挂在根上，**每个页面都在** ——
          用户原话：「ai 功能太差，1 是位置问题，不能随时随地使用，不能在对应地点研究」。
          以前只能从「设置 → AI 接入」开模态弹窗，人得离开正在看的书/书源走三层才能问一句。
          现在它常驻右下角，带着当前页面的 uiContext（在阅读器就带这本书与章节，
          在书源页就带这个源），问的就是眼前这个东西；对话历史跨页面/跨会话保留。 */}
      <AiFloatingBall uiContext={currentUiContext} />
    </div>
  )
}

// 启动时把 IndexedDB 里存过的自定义字体全部注册回 document.fonts：设置里只存字体族名，
// 字体数据在本地库，不注册回来刷新后 CSS 的 font-family 就命中不到。
// 失败（隐私模式 / 无 IndexedDB / 单条字体损坏）不阻塞应用启动。
void loadAllFonts().catch(() => undefined)

// 根上这一层是最后兜底：连页面外壳自己抛错时，也不能剩一片白屏让人以为程序没了
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary region="页面">
    <App />
  </ErrorBoundary>,
)
