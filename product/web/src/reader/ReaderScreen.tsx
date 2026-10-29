// React 默认导入是正文要的：`React.ReactNode` / `React.TransitionEvent` / `React.WheelEvent`
// 这些类型引用挂在它身上。（AGENTS §5 那个 classic JSX 的同形坑：`VirtualChapterList` 被
// `renderToStaticMarkup` 静态渲染才需要默认 React 在作用域里 —— 那件组件已拆进
// `VirtualChapterList.tsx`，那条理由与它的默认导入一起搬过去了。）
import React, { CSSProperties, Fragment, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, BookDetails, BookNote, Chapter, SearchResult, TocRuleOption } from '../lib/api'
import { getBrand } from '../lib/brandStore'
import { ContextMenuItem, showContextMenu } from '../components/ContextMenu'
import { Icon } from '../icons'
import { useEscapeClose } from '../lib/useEscapeClose'
import { calculatePaginationLayout, contentImageUrl, findFirstFullyVisibleParagraphIndex, isAtBottomBoundary, isAtTopBoundary, isInteractiveReaderTarget, isSameSiteAsset, isTapGesture, paginateWheelStep, swipeDirection, TOC_ROW_HEIGHT, ViewportBounds } from './readerInteractions'
import { readerImageSrc } from './readerImage'
import { TapAction, zoneAt } from './tapZones'
import { isMediaType } from '../shelf/bookType'
import { TapZoneEditor } from './TapZoneEditor'
import { NoteToolbar, type NoteDraft } from './NoteToolbar'
import { MarkingMenu } from './MarkingMenu'
import { setAiChatOpen } from '../features/ai/aiChatStore'
import { setSelection, setSelectionFromDraft } from '../lib/selectionStore'
import { NotesPanel } from './NotesPanel'
import { BookSearchDialog } from './BookSearchDialog'
import { RefreshChaptersModal } from './RefreshChaptersModal'
import { TocDrawerHeader } from './TocDrawerHeader'
import { ReaderHeader } from './ReaderHeader'
import { Md3BottomBar, Md3TopBar } from './Md3Chrome'
import { ReaderSheet } from './ReaderSheet'
import { OtherSettingsPanel } from './OtherSettingsPanel'
import { reportProgress } from './readerProgress'
import { MediaBlock } from './MediaBlock'
import { IconButton } from './IconButton'
import { ReaderContentSkeleton } from './ReaderContentSkeleton'
import { ReaderSettingsControls } from './ReaderSettingsControls'
import { clampScrollPosition, effectiveReaderFontFamily, ReaderSettings, scrollPosition, themeClassNames, ttsSessionKey, TtsEngineType, BUILTIN_SKINS } from './readerSettings'
import { stepFontSize } from './fontSizeControl'
import { ReaderMenuAction } from './readerMenu'
import { IDENTITY_CONVERTER, loadScriptConverter, type ScriptConverter } from './scriptConvert'
import { coverDirection, pageTurnAnim, planNextPage, planPrevPage } from './pageTurn'
import { flowAdvance, holdScroll, pageAlignmentPads, pageAlignmentStarts, pageProgress, pageWindowShift, prependLandingPage, resolveMeasuredPage, sectionAtPage, sectionProgress } from './readerFlow'
import { SourceSwitchModal } from '../sources/SourceSwitchModal'
import { cleanAuthor, cleanTitle } from '../lib/searchFilters'
import { toast } from '../components/Toast'
import { useReaderTts } from './useReaderTts'
import { ITtsEngine, WebSpeechEngine, HttpAudioTtsEngine, TtsPlayState, TtsSpeakMode, isPlayInterruptedError } from './ttsEngine'
import { TtsSettingsModal, SleepTimerOption } from './TtsSettingsModal'
import { VirtualChapterList } from './VirtualChapterList'
import { TtsPlayerBar } from './TtsPlayerBar'
import { resetTtsBarPosition } from './ttsBarPosition'
import { isTypingTarget, normalizeKey, READER_SHORTCUTS, shortcutFor } from './shortcuts'
import { ReplaceRulesModal } from '../components/ReplaceRulesModal'
import { OfflineCacheModal } from '../components/OfflineCacheModal'
import { warmContentImages } from './contentImages'
import { splitParagraphs } from './paragraphs'
import type { OpenBook } from './openBook'
import {
  downloadChaptersToOffline,
  getOfflineChaptersSet,
} from '../lib/offlineStorage'

type ReaderScreenProps = {
  openBook: OpenBook
  startIndex: number
  settings: ReaderSettings
  onSettingsChange: (next: ReaderSettings) => void
  onClose: () => void
}

export function ReaderScreen({ openBook, startIndex, settings, onSettingsChange, onClose }: ReaderScreenProps) {
  const [currentBook, setCurrentBook] = useState<OpenBook>(openBook)
  /**
   * 简繁转换（用户 2026-10-11 的 A–F 里 C 项）。词表 200KB 上下，只有开了才去拉 chunk，
   * 所以这里是"先恒等、载好了再换"——没开的人一点代价都不付。
   *
   * 声明放在最前面：章名、正文、目录、页脚、浏览器标题栏、朗读都过它，
   * 摆在中途会让前半段的调用撞上暂时性死区。
   *
   * **转换器是函数，凡是被 React 当"值"收的地方都要包一层**：
   * ① 初始化器 `useState(() => IDENTITY_CONVERTER)` —— 直接写 `useState(IDENTITY_CONVERTER)`
   *    会被当**惰性初始化器**调用一次（`IDENTITY_CONVERTER()` 无参 → 返回 `undefined`），
   *    于是 `convert` 是 `undefined`，正文一渲染就 `convert is not a function`、整屏"阅读器崩了"。
   * ② `setConvert(() => loaded)` —— 直接 `setConvert(loaded)` 会被当 updater 调用（入参是上一轮
   *    state），表现为"设置开了但正文没变"。两处是同一个坑的两面。
   */
  const [convert, setConvert] = useState<ScriptConverter>(() => IDENTITY_CONVERTER)
  useEffect(() => {
    let alive = true
    loadScriptConverter(settings.scriptMode)
      .then(loaded => { if (alive) setConvert(() => loaded) })
      // 词表拉不下来（离线首开、chunk 404）就退回原文：读得慢总好过读不了
      .catch(() => { if (alive) setConvert(() => IDENTITY_CONVERTER) })
    return () => { alive = false }
  }, [settings.scriptMode])

  /** 可选的目录规则清单（只在读本地书时取一次）；取不到就不摆这一档控件。 */
  const [tocRuleOptions, setTocRuleOptions] = useState<TocRuleOption[]>([])
  /** 这本本地书**实际**用的规则，来自书架记录（设置里那条只是下一本的默认值）。 */
  const [shelfTocRule, setShelfTocRule] = useState<string | null>(null)
  /**
   * 滚动模式的续接窗口（用户 2026-10-02：「章节间的连接还是不对，怎么能跳转呢，不是一体的吗」）。
   * 锚点章之后已经取到正文的章节，渲染在同一个滚动容器里 —— 读完一章是"顶上来"，不是"跳过去"。
   */
  const [flowTail, setFlowTail] = useState<{ chapter: Chapter; content: string }[]>([])
  /** 跨过章边界摘掉顶部那几章时，新锚点该停在屏幕上哪（null = 这一帧不需要校正）。 */
  const pendingKeepRef = useRef<number | null>(null)
  /** 正在"续接推进"（不是用户主动跳章）：这一帧不许 scrollTo，也不许重放进场动画。 */
  const flowAdvanceRef = useRef(false)
  /** 容器 key：只有主动跳章/换源/换书才换；续接推进不换，否则每跨一章白闪一次。 */
  const [flowKey, setFlowKey] = useState(() => openBook.chapters[startIndex]?.url || openBook.bookUrl)
  /** 朗读按段落索引找节点必须限定在锚点那一章里，否则会挑到续接进来的下一章。 */
  const anchorSectionRef = useRef<HTMLElement | null>(null)
  // 滚动回调是长期存在的闭包，读续接窗口要经 ref（与 currentChapterUrlRef 同一手法）
  const flowTailRef = useRef<{ chapter: Chapter; content: string }[]>([])
  flowTailRef.current = flowTail
  /**
   * 续接窗口的**前面一半**（用户 2026-10-04：「你只是在两章之间起作用了，往回怎么办」）。
   *
   * 原来窗口只有尾巴：往回翻到第 0 页就 `changeChapter(-1,'last')` —— 换锚点、清空窗口、
   * 再按"当时量到的页数"跳到最后一页。而那一刻尾章还没挂上来、垫栏还没补上，页数还在变，
   * 于是落点算的是**旧窗口**的页码。实测（双栏、书「像素游戏成真了…」）：
   * 前进是 `8/15 → 1/16`（一步一页），后退一步却落到 `4/15` —— 第 11 章在这一窗里占 1–8 页，
   * 该回的是 8，落在中间就是"往回翻不知道自己在哪"。
   *
   * 现在改成与前进对称：往回翻到窗口开头时，把上一章**接到窗口前面**，页码整体加上它的页数，
   * 眼前这一页一个字都不动，"上一页"就真的只是上一页。不需要任何"猜最后一页"的算术。
   */
  const [flowHead, setFlowHead] = useState<{ chapter: Chapter; content: string }[]>([])
  const flowHeadRef = useRef<{ chapter: Chapter; content: string }[]>([])
  flowHeadRef.current = flowHead
  /** 刚把某一章接到窗口前面：先记着是哪一章，量完 DOM 才知道它占几页、页码要后移多少。 */
  const pendingPrependRef = useRef<string | null>(null)
  /** 分页模式下每一章占的页区间（量自排版后的 DOM），以及顶窗口之后该落到第几页。 */
  const pageSpansRef = useRef<{ start: number; end: number }[]>([])
  /** 量得的每章起始**栏**号（DOM 真值）。后退接章的页码补偿按它落页 —— 算术推的 spans 在
   *  垫栏/强制分栏有一处出入时就差半页（paginate-flow-check ④：接之前第 2 段落 vs 之后第 5 段落）。 */
  const measuredStartsRef = useRef<number[]>([])
  const columnsPerPageRef = useRef(1)
  /** 屏幕上真的对齐了吗（按 DOM 量出来的，不是按算术推的）—— 挪窗口的闸门看这个。 */
  const pageAlignedRef = useRef(true)
  const pendingPageRef = useRef<number | null>(null)
  const [chapterIndex, setChapterIndex] = useState(startIndex)
  /** 同一个手法：判断"只能往前顶"要读当前的那一个，不能闭包里那个早就过期的数字。 */
  const chapterIndexRef = useRef(chapterIndex)
  chapterIndexRef.current = chapterIndex
  const [content, setContent] = useState('')
  // 非文本章节（音频/EPUB 直链）：服务端把媒体地址放在 `mediaUrl`。离线缓存里没有这个字段，
  // 但音频源的 `content` 本身就是那串地址，所以渲染时用 `mediaUrl`，没有就用像 URL 的 `content`。
  const [mediaUrl, setMediaUrl] = useState<string | null>(null)
  const [loadedChapterUrl, setLoadedChapterUrl] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [chapterQuery, setChapterQuery] = useState('')
  const deferredQuery = useDeferredValue(chapterQuery)
  const [activeDrawer, setActiveDrawer] = useState<'toc' | 'settings' | 'other' | null>(null)
  /** 「在正文上编辑点击区域」那层开着没有（见 TapZoneEditor）。 */
  const [tapZoneEditing, setTapZoneEditing] = useState(false)
  /** 正在拖「目录 | 正文」那条边界（只为高亮它）。 */
  const [resizingSidebar, setResizingSidebar] = useState(false)
  const [toolbarsVisible, setToolbarsVisible] = useState(false)
  // PROPOSAL-020：MD3 阅读外壳，**默认开启**；`?ui=legacy` 或 localStorage 置 0 时回旧界面（回退用）。
  const [uiV2] = useState(() => {
    try {
      const q = new URLSearchParams(window.location.search).get('ui')
      if (q === 'legacy') return false
      if (q === 'md3') return true
      return window.localStorage.getItem('reader-ui-v2') !== '0'
    } catch { return true }
  })
  const [boundaryMessage, setBoundaryMessage] = useState('')
  const [inShelf, setInShelf] = useState(true)
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null)
  const [showSourceSwitch, setShowSourceSwitch] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  useEffect(() => {
    const sync = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
    else void document.documentElement.requestFullscreen().catch(() => undefined)
  }
  const [showReplaceRules, setShowReplaceRules] = useState(false)
  const [cachedChapterUrls, setCachedChapterUrls] = useState<Set<string>>(new Set())
  /**
   * 已取到正文的章节字数（`chapterUrl` → 字符数）。用户要的「当获取到内容的时候，把章节字数
   * 显示在右边」就是这张表：只有正文真的落库的章节才进得来，没内容就没有字数可说。
   *
   * 两个来源汇成一张表：
   * - 服务端 `GET /api/bookshelf/cached-chapters` 的 `cachedWordCounts`（与 `cachedChapterUrls` 同序）；
   * - 本章刚取回正文时本地直接量 `content.length` —— 服务端那一刻也把它写进了缓存，
   *   但界面不该等下一轮同步才显示出"眼前这一章的字数"。
   */
  const [chapterWordCounts, setChapterWordCounts] = useState<ReadonlyMap<string, number>>(new Map())
  const [offlineStatsModal, setOfflineStatsModal] = useState(false)
  const [showRefreshChapters, setShowRefreshChapters] = useState(false)
  const [localSyncing, setLocalSyncing] = useState(false)
  const [localSyncProgress, setLocalSyncProgress] = useState({ current: 0, total: 0 })
  const localSyncAbortRef = useRef<AbortController | null>(null)
  const [customRangeOpen, setCustomRangeOpen] = useState(false)
  /**
   * 目录抽屉底部那一块（离线缓存 + 这本书）默认收起（用户 2026-10-09：「这张图片位置内容折叠整理
   * 归纳到底部，不要影响目录显示」）—— 原来它常驻四五行，把章节列表挤得只剩几条。
   * 缓存进行中时强制展开，不然进度条看不见。
   */
  const [drawerFooterOpen, setDrawerFooterOpen] = useState(false)
  const [customRangeStart, setCustomRangeStart] = useState(1)
  const [customRangeEnd, setCustomRangeEnd] = useState(50)
  // 这两层都只认点击、不认 Esc —— 统一补上 Esc 关闭（PROPOSAL-018 W6 的"遮罩与关闭键必须走统一那一套"）
  useEscapeClose(() => setLightboxSrc(null))

  const [cacheStatus, setCacheStatus] = useState<{ state: string; cached: number; total: number; error?: string }>({
    state: 'idle',
    cached: 0,
    total: openBook.chapters.length,
  })

  // Pagination states
  const [pageIndex, setPageIndex] = useState(0)
  const [pageCount, setPageCount] = useState(1)
  /** 每一章**前面**垫几栏空白（双栏时把章节边界对齐到页开头）；量出来的，见 measurePagination。 */
  const [pageFillers, setPageFillers] = useState<number[]>([])
  const [columnWidth, setColumnWidth] = useState(600)
  const [stride, setStride] = useState(640)
  const [isDoubleColumn, setIsDoubleColumn] = useState(false)
  const columnGap = 40

  /**
   * 翻页动画（参照 legado-with-MD3 的 PageAnim，Web 里做真的三种）：
   * `slide` 给 track 挂过渡类 —— 只在**逐页翻**（页码差 1）时挂；接章补偿/窗口挪动是几页的跳，
   * 滑过去反而像"又跳了一次"，所以大跳一律即时切。`fade` 在页码变化时把 track 淡出再淡回。
   * `none` 即时切换（改动前的行为）。连续滚动没有页，整段不生效。
   */
  const pageAnim = settings.pageMode === 'paginate' ? settings.pageAnim : 'none'
  const prevPageIndexRef = useRef(pageIndex)
  const [fading, setFading] = useState(false)
  /**
   * 这一下该播哪种动画：只有**逐页翻**才播（接章补偿/挪窗口是几页的跳，滑过去像又跳了一次）。
   * 决策在 `pageTurn.ts`，这里只拿去渲染。
   */
  const turnAnim = pageTurnAnim(pageAnim, prevPageIndexRef.current, pageIndex)
  const slideAnimOn = turnAnim === 'slide'
  useEffect(() => { prevPageIndexRef.current = pageIndex }, [pageIndex])
  useEffect(() => {
    if (pageAnim !== 'fade') return
    setFading(true)
    const timer = window.setTimeout(() => setFading(false), 150)
    return () => window.clearTimeout(timer)
  }, [pageIndex, pageAnim])
  // 分页模式的进度上报（PROPOSAL-020 P2）：章内页码比例，供底栏进度条显示真实进度。
  useEffect(() => {
    if (settings.pageMode !== 'paginate') return
    reportProgress({ chapterIndex, total: currentBook.chapters.length, fraction: pageCount > 1 ? pageIndex / (pageCount - 1) : 0 })
  }, [chapterIndex, pageIndex, pageCount, settings.pageMode, currentBook.chapters.length])
  /**
   * 覆盖动画（`pageAnim === 'cover'`）：逐页翻**不立刻改 pageIndex** ——
   * 先挂一层"新页"从一侧滑进来盖住旧页，动画结束才真正翻页。
   * `to` 是目标页，`direction` 是新页从哪一侧进来（右=+1、左=-1）。
   */
  const [coverTurn, setCoverTurn] = useState<{ to: number; direction: 1 | -1 } | null>(null)
  const [coverEntered, setCoverEntered] = useState(false)
  const coverTurnRef = useRef<{ to: number; direction: 1 | -1 } | null>(null)
  coverTurnRef.current = coverTurn
  // 先挂上（此时在视口外），下一帧再置 entered —— CSS transition 才有得演。
  useEffect(() => {
    if (!coverTurn) { setCoverEntered(false); return }
    const raf = window.requestAnimationFrame(() => setCoverEntered(true))
    return () => window.cancelAnimationFrame(raf)
  }, [coverTurn])
  const finishCover = useCallback(() => {
    const current = coverTurnRef.current
    if (!current) return
    setPageIndex(current.to)
    setCoverTurn(null)
  }, [])
  /** `transitionend` 是主路径；`coverTurnRef` 挡住重复收尾（兜底定时器与它可能都到）。 */
  const onCoverTransitionEnd = useCallback((event: React.TransitionEvent) => {
    if (event.propertyName === 'transform') finishCover()
  }, [finishCover])
  /**
   * 别只靠 `transitionend`：系统开了"减少动态效果"、或这条 transition 被别的规则盖掉时它可能不来，
   * 那样页码就永远翻不过去。给一个略长于动画时长的兜底，谁先到谁收尾。
   */
  useEffect(() => {
    if (!coverTurn) return
    const timer = window.setTimeout(finishCover, 600)
    return () => window.clearTimeout(timer)
  }, [coverTurn, finishCover])

  const currentRef = useRef<{ chapter: Chapter; position: number } | null>(null)
  const timerRef = useRef<number | null>(null)
  const restoredRef = useRef(false)
  const wakeLockRef = useRef<WakeLockSentinel | null>(null)
  const preloadedContentRef = useRef(new Map<string, string>())
  const preloadingRef = useRef(new Set<string>())
  const lastScrollYRef = useRef(0)
  const pointerStartRef = useRef<{ x: number; y: number; target: EventTarget | null } | null>(null)
  const boundaryTimerRef = useRef<number | null>(null)
  const targetInitialPageRef = useRef<'first' | 'last' | null>(null)
  const initialPagePositionRef = useRef<number | null>(null)
  const wheelTimerRef = useRef<number | null>(null)
  // 滚轮增量累计量（像素）与"没在滚了就清零"的定时器：见 readerInteractions.paginateWheelStep
  const wheelAccumRef = useRef(0)
  const wheelIdleRef = useRef<number | null>(null)

  const viewportRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  /** 正文区（.reader-main）：点击分区按它的矩形算，固定目录时不把目录栏算进去。 */
  const readerMainRef = useRef<HTMLElement | null>(null)
  const resizingSidebarRef = useRef(false)

  const chapter = currentBook.chapters[chapterIndex]
  // 异步回调里判断「这一章还是不是当前章」必须用 ref：闭包捕获的 chapter 是发起请求那一刻的。
  const currentChapterUrlRef = useRef('')
  currentChapterUrlRef.current = chapter?.url ?? ''
  // AI 闭环：记住「本章原始正文」（AI 覆盖应用之前的那一版），用于「撤销」回滚。
  // 只在正常加载正文时写入；AI 覆盖走 setContent 直接改，不会污染这里。
  const chapterBaseContentRef = useRef('')
  const bookName = currentBook.details.name || '书籍正文'

  /**
   * 阅读记录（PROPOSAL-019 D）：在阅读页停留计时，每攒够 30 秒上报一段。
   *
   * 只在页面**可见**时计时（切到别的标签页 / 锁屏不算在读）；换章时把没满 30 秒的零头也报上去 ——
   * 否则「每章只读二十秒」的读者一条记录都不会有。上报失败只吞掉：它是统计，丢了不影响读书。
   * 依赖里带 `chapterIndex` 是故意的：换章就是一次收尾。
   */
  useEffect(() => {
    const sourceId = currentBook.details.sourceId
    const bookUrl = currentBook.bookUrl
    const name = currentBook.details.name
    const index = chapterIndex
    let pending = 0
    let last = Date.now()
    let visible = document.visibilityState !== 'hidden'
    const report = (seconds: number) => {
      if (seconds <= 0) return
      void api.addReadingLog({ sourceId, bookUrl, bookName: name, chapterIndex: index, seconds }).catch(() => undefined)
    }
    const tick = () => {
      const now = Date.now()
      if (visible) pending += (now - last) / 1000
      last = now
      if (pending >= 30) { report(Math.round(pending)); pending = 0 }
    }
    const timer = window.setInterval(tick, 2000)
    const onVisibility = () => { tick(); visible = document.visibilityState !== 'hidden'; last = Date.now() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      tick()
      report(Math.round(pending))
    }
  }, [currentBook.bookUrl, currentBook.details.sourceId, currentBook.details.name, chapterIndex])

  /** 读本地书时才去取规则清单；取不到就整档不出现，不摆一个点了没反应的控件。 */
  useEffect(() => {
    if (currentBook.details.sourceId !== 'loc_book' || tocRuleOptions.length > 0) return
    void api.tocRules().then(list => setTocRuleOptions(list.options)).catch(() => undefined)
  }, [currentBook.details.sourceId, tocRuleOptions.length])

  /**
   * 换一条目录规则重切这本本地书（用户 2026-10-02：「txt目录规则，这个可以放到阅读设置里」）。
   * 原始文件在导入时就整本留在服务端 `local_books/` 里，所以不必让用户重新上传。
   * 重切后目录、预载缓存、正文缓存要一起换 —— 章节编号整体错位之后留着旧正文等于让读者读到错章。
   */
  const reparseLocalBook = async (ruleKey: string): Promise<string | null> => {
    if (currentBook.details.sourceId !== 'loc_book') return '只有导入到本机的书可以换目录规则'
    try {
      const result = await api.reparseLocalBook(currentBook.details.sourceId, currentBook.bookUrl, ruleKey)
      const chapters = await api.chapters(currentBook.details.sourceId, currentBook.bookUrl)
      const next = { ...currentBook, chapters }
      setCurrentBook(next)
      setChapterIndex(0)
      setShelfTocRule(result.tocRuleUsed)
      preloadedContentRef.current.clear()
      sessionStorage.setItem('legado-open-book-v1', JSON.stringify({ book: next, index: 0 }))
      void syncCacheStatus()
      toast.success(`已按「${result.ruleLabel}」重切出 ${result.totalChapters} 章`)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : '重切目录失败'
    }
  }

  /**
   * 阅读器是否还挂着。`syncCacheStatus` 是 async，且被 1.2s 轮询反复调用：
   * 用户关掉阅读器时在途那一趟回来，原本照样 setCachedChapterUrls / setShelfTocRule /
   * setCacheStatus，还会把「离线缓存完成」的 toast 弹到已经关掉的界面上（那次请求可能
   * 挂了十几秒——正是大书缓存到尾声的时刻）。同文件里 :498 / :1093 / :1146 用局部
   * `alive` 变量的写法对付同一类问题，这里因为要跨两个 effect 共享，改用 ref。
   */
  const syncCacheAliveRef = useRef(false)
  useEffect(() => {
    syncCacheAliveRef.current = true
    return () => { syncCacheAliveRef.current = false }
  }, [])
  /** cacheStatus.state 的镜像：给 syncCacheStatus 判"上一轮是不是 caching"用，不参与依赖。 */
  const cacheStateRef = useRef(cacheStatus.state)
  cacheStateRef.current = cacheStatus.state

  // Sync cache status with bookshelf and local IndexedDB
  const syncCacheStatus = useCallback(async () => {
    try {
      const [shelf, cachedUrlsRes, localOfflineSet] = await Promise.all([
        api.bookshelf().catch(() => []),
        api.getCachedChapters(currentBook.details.sourceId, currentBook.bookUrl).catch(() => null),
        getOfflineChaptersSet(currentBook.details.sourceId, currentBook.bookUrl).catch(() => new Set<string>()),
      ])

      // 三个 await 都回来了才知道阅读器还在不在：期间可能已经关掉或换了书。
      if (!syncCacheAliveRef.current) return

      const mergedSet = new Set<string>(localOfflineSet)
      const mergedWords = new Map<string, number>()
      if (cachedUrlsRes?.cachedChapterUrls) {
        cachedUrlsRes.cachedChapterUrls.forEach((u, i) => {
          mergedSet.add(u)
          // 服务端把「地址 → 字数」按同序两个数组回传（见 CachedChaptersResponse.cachedWordCounts）。
          // 对不上号（旧版服务端的响应没这个字段）就干脆不填，让界面那一格留空 ——
          // 报 0 字是谎话，报旧书的字数也是谎话。
          const words = cachedUrlsRes.cachedWordCounts?.[i]
          if (typeof words === 'number') mergedWords.set(u, words)
        })
      }
      setCachedChapterUrls(mergedSet)
      setChapterWordCounts(mergedWords)

      const item = shelf.find(s => s.sourceId === currentBook.details.sourceId && s.bookUrl === currentBook.bookUrl)
      // 这本本地书"实际用的是哪条目录规则"只有书架记录知道（设置里那条只是下一本的默认值）
      setShelfTocRule(item?.tocRule ?? null)
      if (item) {
        setInShelf(true)
        // 「缓存完成 / 中断」只在**从 caching 变成终态**那一趟报一次。
        // 以前这条 toast 写在 setCacheStatus 的 updater 里 —— updater 必须纯，
        // React 可能重复调用它（并发渲染下重复弹 toast），而且它挡不住"界面已关"。
        // 判据读 ref 而不是 cacheStatus.state：把 state 写进 useCallback 依赖会让这个
        // 回调每次状态变化就换一个身份，从而把下面两个 effect 反复重置（轮询永远重头计时）。
        //
        // 判完立刻把 ref 推到新状态：这个函数可能重叠执行（3s 一拍，而一次要拉整份书架，
        // 慢的时候上一拍还没回来），两拍都读到 caching 就会各弹一次。
        if (cacheStateRef.current === 'caching' && item.cacheState === 'ready') {
          toast.success(`《${bookName}》离线缓存完成（共 ${item.cachedChapters} 章）`)
        } else if (cacheStateRef.current === 'caching' && item.cacheState === 'failed') {
          toast.warning(`《${bookName}》缓存中断：${item.cacheError || '部分章节未下载'}`)
        }
        cacheStateRef.current = item.cacheState
        setCacheStatus({
          state: item.cacheState,
          cached: Math.max(item.cachedChapters, mergedSet.size),
          total: item.totalChapters || currentBook.chapters.length,
          error: item.cacheError,
        })
      } else {
        setInShelf(false)
      }
    } catch {
      // ignore
    }
  }, [bookName, currentBook.bookUrl, currentBook.chapters.length, currentBook.details.sourceId])

  useEffect(() => {
    void syncCacheStatus()
  }, [syncCacheStatus])

  useEffect(() => {
    if (cacheStatus.state !== 'caching') return
    // 1200ms → 3000ms：每一拍都要 api.bookshelf() 拉整份书架（几千本时是 MB 级），
    // 缓存进度条不需要 1.2s 的精度。卸载时 clearInterval（本 effect 的 cleanup 已覆盖）。
    const timer = window.setInterval(syncCacheStatus, 3000)
    return () => window.clearInterval(timer)
  }, [cacheStatus.state, syncCacheStatus])

  /**
   * 手动刷新正文之后，屏幕上挂着的三处正文都要跟着换：当前章、下方续接段、向前接的段。
   * 服务端缓存此时已经是新正文，这里重取命中缓存、不会二次回源；失败只影响界面这一份，
   * 缓存里已是新内容，翻页回来仍能看到。
   */
  const handleChaptersRefreshed = useCallback((chapterUrls: string[]) => {
    if (chapterUrls.length === 0) return
    const refreshed = new Set(chapterUrls)
    chapterUrls.forEach(url => preloadedContentRef.current.delete(url))
    setCachedChapterUrls(prev => {
      const next = new Set(prev)
      chapterUrls.forEach(url => next.add(url))
      return next
    })
    const sourceId = currentBook.details.sourceId
    const bookUrl = currentBook.bookUrl
    const updateFlow = async (items: { chapter: Chapter; content: string }[]) => {
      if (!items.some(item => refreshed.has(item.chapter.url))) return items
      return Promise.all(items.map(async item => {
        if (!refreshed.has(item.chapter.url)) return item
        const result = await api.content(sourceId, item.chapter.url, bookUrl).catch(() => null)
        return result ? { chapter: item.chapter, content: result.content } : item
      }))
    }
    const tailBefore = flowTailRef.current
    void updateFlow(tailBefore).then(next => { if (next !== tailBefore) setFlowTail(next) })
    const headBefore = flowHeadRef.current
    void updateFlow(headBefore).then(next => { if (next !== headBefore) setFlowHead(next) })
    const currentUrl = currentChapterUrlRef.current
    if (currentUrl && refreshed.has(currentUrl)) {
      void api.content(sourceId, currentUrl, bookUrl)
        .then(result => {
          if (currentChapterUrlRef.current !== currentUrl) return
          setContent(result.content)
          chapterBaseContentRef.current = result.content
          setMediaUrl(result.mediaUrl ?? null)
          setChapterWordCounts(prev => {
            const next = new Map(prev)
            next.set(currentUrl, result.content.length)
            return next
          })
          warmContentImages(result.content, currentUrl, sourceId)
        })
        .catch(error => toast.error(`本章缓存已更新，但界面重载失败：${error instanceof Error ? error.message : '未知错误'}`))
    }
    void syncCacheStatus()
  }, [currentBook.bookUrl, currentBook.details.sourceId, syncCacheStatus])

  useEffect(() => {
    // 名字读单一来源而不是写死「legadoQ」：用户改了应用名之后，
    // 这里若照旧硬编码，一进阅读器标签页就把新名字冲回去（"改了又变回去"最难查）。
    const brandName = getBrand().displayName
    const shown = chapter?.title ? convert(chapter.title) : ''
    const title = shown ? `${bookName} - ${shown} | ${brandName}` : `${bookName} | ${brandName}`
    document.title = title
    return () => {
      document.title = getBrand().displayName
    }
  }, [bookName, chapter?.title, convert])

  const filteredChapters = useMemo(() => {
    const query = deferredQuery.trim().toLowerCase()
    if (!query) return currentBook.chapters
    const numQuery = /^\d+$/.test(query) ? parseInt(query, 10) : null
    return currentBook.chapters.filter(item => {
      if (item.title.toLowerCase().includes(query)) return true
      if (numQuery !== null && (item.index === numQuery - 1 || item.index === numQuery)) return true
      return false
    })
  }, [deferredQuery, currentBook.chapters])

  // 目录倒序（借鉴 Legado TocActivity 的 reverse_toc）：仅影响抽屉显示顺序，跳转仍用章节原始 index。
  const [tocReverse, setTocReverse] = useState(false)
  const tocList = useMemo(() => (tocReverse ? filteredChapters.slice().reverse() : filteredChapters), [filteredChapters, tocReverse])
  // 正文配图点击放大（借鉴 Legado「点击预览图片」）：position:fixed 遮罩，点任意处关闭。
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  /**
   * 正文配图（漫画就是一页页图）的两件事，键都是**原图地址**：
   * `imageGeneration` 是"这一张被重取过几次"，只用来改浏览器侧的缓存键；
   * `failedImages` 是"哪几张取失败了、为什么"。
   * 以前取失败的那张被 `setAttribute('hidden')` 整块藏掉 —— 于是"这张没取到"与"这一页本来没图"
   * 在界面上是同一个样子（与 RSS 那条「还没到 / 取失败 / 确实没有是三件事」同一个病），
   * 而站点用同一个 URL 换过图时，服务端那份按 `sha256(地址)` 落盘的副本永不过期，用户没有任何出路。
   */
  const [imageGeneration, setImageGeneration] = useState<Record<string, number>>({})
  const [failedImages, setFailedImages] = useState<Record<string, string>>({})

  /** 让服务端绕开盘上那份重取一次，成功后换代次（浏览器那份 7 天副本就此作废）。 */
  const refetchChapterImage = async (image: string, referer: string | undefined) => {
    try {
      await api.refreshBookImage(image, referer)
      setImageGeneration(current => ({ ...current, [image]: (current[image] ?? 0) + 1 }))
      setFailedImages(current => {
        const next = { ...current }
        delete next[image]
        return next
      })
    } catch (error) {
      // 站点这次也可能不给：把原因留在这一行，让用户知道"又试了一次，还是不行，是因为什么"。
      setFailedImages(current => ({ ...current, [image]: error instanceof Error ? error.message : '重取失败' }))
    }
  }

  // 拖动进度条时的临时读数：松手/键盘抬起才真正切章，避免拖一格发一次正文请求。
  const [scrubIndex, setScrubIndex] = useState<number | null>(null)
  const shownChapterIndex = scrubIndex ?? chapterIndex
  const chapterProgress = currentBook.chapters.length > 1 ? (shownChapterIndex / (currentBook.chapters.length - 1)) * 100 : 0

  const isCurrentChapterLoaded = loadedChapterUrl === chapter?.url && !loading
  // content 与 loadedChapterUrl 在 applyContent 里成对写入，所以 loadedChapterUrl 就是
  // "屏幕上这段正文属于哪一章"。切章瞬间它与 chapter 不一致 = 正在过渡：旧正文继续挂着（变暗 +
  // 顶部一条「正在载入」），而不是被骨架屏挖空。
  const isStaleContent = loading && !!content && loadedChapterUrl !== (chapter?.url ?? '')

  /**
   * 续接进来的章（`flowHead` / `flowTail`）也走这条：**拆段之后逐段转**，不是把整章转完再拆。
   * 词组的匹配范围因此止于段内 —— 不会让上一段末尾和下一段开头凑出一个词组来。
   */
  const splitBody = useCallback((text: string) => splitParagraphs(text).map(convert), [convert])
  const paragraphs = useMemo(() => (content ? splitBody(content) : []), [content, splitBody])

  /**
   * 漫画单图模式。
   *
   * 漫画源（`bookSourceType === 2`）的一章正文就是一串 `![图片](地址)` 占位行。默认把它们
   * 一屏一张地铺开、按图翻页：长图不会被文本分页从中间切开，跨页衔接也更接近漫画阅读器。
   * 关掉（`settings.mangaSinglePage === false`）就退回普通图文混排。
   */
  const mangaImages = useMemo(
    () => paragraphs.map(line => contentImageUrl(line)).filter((url): url is string => Boolean(url)),
    [paragraphs],
  )
  const isMangaMode = currentBook.details.sourceType === 2 && settings.mangaSinglePage && mangaImages.length > 0
  const [mangaIndex, setMangaIndex] = useState(0)
  // 换章回到第一张；同一章内容刷新（重取正文）也从头开始，避免下标越界。
  useEffect(() => { setMangaIndex(0) }, [chapter?.url, mangaImages.length])
  // 预取下一张：翻页时直接命中服务端 7 天缓存，不等网络。
  useEffect(() => {
    if (!isMangaMode) return
    const next = mangaImages[mangaIndex + 1]
    if (!next) return
    const image = new Image()
    image.decoding = 'async'
    image.src = readerImageSrc(next, chapter?.url, imageGeneration[next] ?? 0, currentBook.details.sourceId)
  }, [isMangaMode, mangaIndex, mangaImages, chapter?.url, imageGeneration])

  /**
   * 笔记 / 划线（PROPOSAL-019 E）。
   *
   * 偏移是**章节内字符偏移**（段落在章里的起点 + 段内偏移），不用像素 / 列号 ——
   * 字号、字体、分栏一改位置就跳，这是阅读器那条老教训。
   * `excerpt` 另外留一份选中原文：高亮按它在这段文字里定位，简繁转换换了字形也找得到。
   */
  const [notes, setNotes] = useState<BookNote[]>([])
  useEffect(() => {
    let alive = true
    api.notes(currentBook.details.sourceId, currentBook.bookUrl)
      .then(list => { if (alive) setNotes(list) })
      .catch(() => { if (alive) setNotes([]) })
    return () => { alive = false }
  }, [currentBook.details.sourceId, currentBook.bookUrl])
  /** 每一段在**本章原文**里的起始字符偏移（段与段之间按一个换行算）。 */
  const paragraphStarts = useMemo(() => {
    if (!content) return [] as number[]
    const starts: number[] = []
    let running = 0
    for (const line of splitParagraphs(content)) { starts.push(running); running += line.length + 1 }
    return starts
  }, [content])
  /**
   * 待保存 / 正在编辑的那一条。`id === null` = 刚从选区新建；否则是点已有高亮打开的。
   * `x`/`y` 是浮层要摆的位置（视口坐标，横向以选中处为中心）。
   */
  const [noteDraft, setNoteDraft] = useState<NoteDraft | null>(null)
  /** 目录抽屉里的「笔记」面板开关（按书查看）。 */
  const [notesPanel, setNotesPanel] = useState(false)
  /** 标记快捷条 vs 笔记编辑器：选中后先显示快捷条，点「笔记」才展开 NoteToolbar。 */
  const [noteEditorOpen, setNoteEditorOpen] = useState(false)
  /** 本书正文检索弹窗（搜索本书 feature，只在已缓存章节正文里找）。 */
  const [bookSearchOpen, setBookSearchOpen] = useState(false)
  /** 阅读设置弹层里的顶层标签页：阅读（排版/颜色/行为）或其它（简繁/点击区域/工具栏/本地书目录/净化）。
   *  用户要求「两颗齿轮合并成一颗，点开用标签页切换界面/其它」。 */
  const [settingsTab, setSettingsTab] = useState<'reader' | 'other'>('reader')

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

  /** 从「笔记」面板跳到那一条所在的章。 */
  const jumpToNote = (note: BookNote) => {
    const index = currentBook.chapters.findIndex(item => item.url === note.chapterUrl)
    if (index >= 0 && index !== chapterIndex) changeChapter(index, 'first')
    setNotesPanel(false)
    setActiveDrawer(null)
  }

  /**
   * 这一段里落着的笔记高亮。按 `excerpt` 在这段文字里定位 ——
   * 简繁转换只换字形不换词，转换后仍然找得到；找不到（原文被源站改过）就安静跳过。
   */
  const renderNoteHighlights = (text: string, ownerIndex: number) => {
    const chapterNotes = notes.filter(note => note.chapterIndex === ownerIndex && note.excerpt && text.includes(note.excerpt))
    if (!chapterNotes.length) return null
    const marks: Array<{ start: number; end: number; note: BookNote }> = []
    for (const note of chapterNotes) {
      const at = text.indexOf(note.excerpt)
      if (at < 0) continue
      // 与已有高亮重叠的跳过：重叠的 <mark> 没法叠着画
      if (marks.some(mark => at < mark.end && at + note.excerpt.length > mark.start)) continue
      marks.push({ start: at, end: at + note.excerpt.length, note })
    }
    if (!marks.length) return null
    marks.sort((a, b) => a.start - b.start)
    const out: React.ReactNode[] = []
    let cursor = 0
    for (const mark of marks) {
      if (mark.start > cursor) out.push(text.slice(cursor, mark.start))
      out.push(
        <mark
          key={`note-${mark.note.id}`}
          className={`reader-note-highlight${mark.note.note ? ' has-note' : ''}`}
          data-note-id={mark.note.id}
          title={mark.note.note || '划线'}
          onClick={event => { event.stopPropagation(); openNote(mark.note, event.clientX, event.clientY) }}
        >{text.slice(mark.start, mark.end)}</mark>,
      )
      cursor = mark.end
    }
    if (cursor < text.length) out.push(text.slice(cursor))
    return out
  }
  // 朗读管线只认"当前这一章已经到位"的正文，过渡期间给空数组，避免读进上一章剩下的段落。
  // 非文本章节（音频/视频/文件）：这一章的"正文"其实是一个媒体地址，不能当段落排出来。
  // 优先用服务端给的 `mediaUrl`；离线缓存没有它，但音频源的 `content` 本身就是那串地址，故兜底。
  const sourceType = currentBook.details.sourceType ?? 0
  const mediaSrc = useMemo(() => {
    // 服务端嗅出来的地址优先认：社区书源里 `bookSourceType` 填错的一大把（写着 0 文本、正文却是 m3u8），
    // 只按声明类型放行的话，这些源永远排成一段文字。自己兜底嗅那条只在离线缓存没有 mediaUrl 时用。
    if (!mediaUrl && !isMediaType(sourceType)) return null
    // 优先用服务端给的 mediaUrl；离线缓存没有它，但音频源的 content 本身就是那串地址，故兜底。
    const raw = mediaUrl ? mediaUrl : (() => {
      const trimmed = content.trim()
      return /^https?:\/\/\S+$/.test(trimmed) ? trimmed : null
    })()
    if (!raw) return null
    // 外域地址走服务端媒体代理（注入 Referer + 转发 Range），本站内的原样返回。
    if (isSameSiteAsset(raw)) return raw
    return api.bookMedia(raw, chapter.url)
  }, [sourceType, mediaUrl, content, chapter.url])
  // 过渡期间大标题跟着正文走（挂着上一章的标题），新章名只出现在「正在载入」那条里 ——
  // 标题是新的、正文是旧的，比两者都旧更容易让人以为串了章。
  const shownChapterTitle = isStaleContent ? (currentRef.current?.chapter.title || chapter?.title) : chapter?.title
  /**
   * 窗口里现在挂着哪些章 —— 顺序必须和 DOM 里 `.reader-page-chapter` 的顺序一致，
   * 因为量出来的 `pageSpansRef` 是按 DOM 排的。前面接的章、锚点、后面续的章三段拼成一条。
   */
  const windowChapters = useMemo(() => [
    ...flowHead.map(item => item.chapter), chapter, ...flowTail.map(item => item.chapter),
  ].filter((item): item is Chapter => !!item), [chapter, flowHead, flowTail])
  const windowChaptersRef = useRef<Chapter[]>(windowChapters)
  windowChaptersRef.current = windowChapters
  /**
   * 页脚那一格要说的是**你眼前这一页属于哪一章**，不是"这一窗口锚在哪一章"。
   * 窗口里挂着两三章，用锚点名就会连着几页都写着上一章的名字 —— 用户截图里
   * 「第4章 生活」配着满屏的「第5章 片刻喘息」就是这一条（2026-10-03）。
   */
  const paginatedFooterTitle = (() => {
    const spans = pageSpansRef.current
    if (spans.length <= 1) return shownChapterTitle ?? ''
    return windowChapters[sectionAtPage(spans, pageIndex)]?.title ?? shownChapterTitle ?? ''
  })()
  const incomingChapterTitle = isStaleContent ? chapter?.title : ''
  // 章末那条「下一章」提示要写出真实章名，跳过卷分组头与没有地址的条目（与预载走同一套判据）。
  const nextChapterTitle = useMemo(() => {
    for (let j = chapterIndex + 1; j < currentBook.chapters.length; j++) {
      const c = currentBook.chapters[j]
      if (!c.isVolume && c.url) return c.title
    }
    return ''
  }, [chapterIndex, currentBook.chapters])

  const persist = useCallback(() => {
    const current = currentRef.current
    if (!current) return
    void api.saveProgress(currentBook.details.sourceId, currentBook.bookUrl, current.chapter.url, current.chapter.index, clampScrollPosition(current.position)).catch(() => undefined)
  }, [currentBook.bookUrl, currentBook.details.sourceId])

  const preloadNextChapter = useCallback((index: number) => {
    let j = index + 1
    while (j < currentBook.chapters.length && (currentBook.chapters[j].isVolume || !currentBook.chapters[j].url)) j++
    const next = currentBook.chapters[j]
    if (!next || !next.url || preloadedContentRef.current.has(next.url) || preloadingRef.current.has(next.url)) return
    preloadingRef.current.add(next.url)
    void api.content(currentBook.details.sourceId, next.url, currentBook.bookUrl)
      .then(result => {
        const map = preloadedContentRef.current
        map.set(next.url, result.content)
        // 只增不清的 Map 会跟着阅读无界增长（长书读一章缓存一章），留最近的十几章足够
        if (map.size > 12) {
          const oldest = map.keys().next().value
          if (oldest !== undefined) map.delete(oldest)
        }
      })
      .catch(() => undefined)
      .finally(() => preloadingRef.current.delete(next.url))
  }, [currentBook.bookUrl, currentBook.chapters, currentBook.details.sourceId])

  const preloadPrevChapter = useCallback((index: number) => {
    let j = index - 1
    while (j >= 0 && (currentBook.chapters[j].isVolume || !currentBook.chapters[j].url)) j--
    const prev = currentBook.chapters[j]
    if (!prev || !prev.url || preloadedContentRef.current.has(prev.url) || preloadingRef.current.has(prev.url)) return
    preloadingRef.current.add(prev.url)
    void api.content(currentBook.details.sourceId, prev.url, currentBook.bookUrl)
      .then(result => {
        const map = preloadedContentRef.current
        map.set(prev.url, result.content)
        if (map.size > 12) {
          const oldest = map.keys().next().value
          if (oldest !== undefined) map.delete(oldest)
        }
      })
      .catch(() => undefined)
      .finally(() => preloadingRef.current.delete(prev.url))
  }, [currentBook.bookUrl, currentBook.chapters, currentBook.details.sourceId])

  // 切章的 ref：useReaderTts 里的 playTtsChunk 要跨章续播，而 changeChapter 又要 stopTts —— 环用 ref 打破
  // （与 playTtsChunkRef 同一手法：异步回调永远读到最新那份）。
  const changeChapterRef = useRef<(rawIndex: number) => void>(() => undefined)
  const tts = useReaderTts({
    chapter, chapterIndex, chapterCount: currentBook.chapters.length,
    paragraphs, isCurrentChapterLoaded, convert, mediaSrc, content, viewportRef,
    settings, persist, preloadNextChapter, changeChapterRef,
  })
  const {
    ttsActive, setTtsActive, ttsPlayState, setTtsPlayState, currentChunkIndex, setCurrentChunkIndex,
    sleepTimer, setSleepTimer, showTtsSettings, setShowTtsSettings,
    offlineTtsConfirmOpen, setOfflineTtsConfirmOpen,
    ttsParagraphs, ttsData, currentChunk, activeParagraphIndex, activeSentenceText,
    getTtsEngine, stopAllEngines, stopTts, pauseTts, resumeTts, playTtsChunk, playTtsChunkRef,
    getInitialTtsChunkIndex, toggleTts, handlePrevChunk, handleNextChunk,
    handlePrevChapterTts, handleNextChapterTts, autoPlayNextChapterRef,
  } = tts

  // 「朗读引擎在使用中切换会重音，都启动」（用户 2026-09-30）。
  // 换引擎/音色/语速时旧引擎不会自己停：WebSpeech 的 utterance.onEnd 与 HttpAudio 的分片 onEnd
  // 都还在推进 currentChunkIndex，新引擎接着出声 → 两条声音叠在一起。这里在"正在播"的当口
  // 把两套引擎一起停掉，再用新设置重读当前分片（'replace' 分支内部会 resetSession 并清掉旧音色的预取队列）。
  // 暂停态刻意不动：resume 只续播现有音频，真正出声的是下一分片的 speak()，
  // 而 HttpAudioTtsEngine.speak 检测到 settings key 变了会自己 resetSession（ttsEngine.ts speak 开头）。

  const handleParagraphClick = useCallback((pIdx: number) => {
    // Only jump to paragraph if TTS is already active; don't auto-start reading on arbitrary clicks
    if (!ttsActive) return
    const targetChunk = ttsData.chunks.find(c => c.paragraphIndex === pIdx)
    if (targetChunk) {
      playTtsChunk(targetChunk.globalIndex)
    }
  }, [ttsData.chunks, ttsActive, playTtsChunk])

  const renderParagraphContent = (rawLine: string, pIndex: number, ownerIndex = chapterIndex) => {
    // 有笔记就先画高亮。一段里「笔记高亮」与「朗读到哪句」叠着画不出来，笔记优先。
    const highlighted = renderNoteHighlights(rawLine, ownerIndex)
    if (highlighted) return highlighted
    if (!ttsActive || activeParagraphIndex !== pIndex || !currentChunk) {
      return rawLine
    }
    const sentenceText = currentChunk.text
    const sIdx = rawLine.indexOf(sentenceText)
    if (sIdx >= 0) {
      const before = rawLine.slice(0, sIdx)
      const after = rawLine.slice(sIdx + sentenceText.length)
      return <>
        {before}
        <span className="tts-active-sentence">{sentenceText}</span>
        {after}
      </>
    }
    return rawLine
  }

  /**
   * 取图失败的那一行：说清失败了、为什么，并给一条「重取这一张」的出路。
   * 正文配图与漫画单图共用这一处，避免两套文案与两条重取路径。
   */
  const renderImageFailure = (image: string, referer: string | undefined, key?: number) => (
    <p key={key} className="reader-image-failed">
      <span>{failedImages[image] ?? '这张图没取到'}</span>
      <button type="button" className="link-button" onClick={event => { event.stopPropagation(); void refetchChapterImage(image, referer) }}>重取这一张</button>
    </p>
  )

  /** 正文块渲染：`![图片](url)` 占位行还原成走代理的 `<img>`，其余仍是段落。 */
  const renderContentBlock = (line: string, index: number, owner?: Chapter) => {
    const image = contentImageUrl(line)
    if (image) {
      // 本地 EPUB 的插图本来就是站内地址，再过一道图片代理是错的（那一层只收 http(s)）
      // Referer 用**这一段属于哪一章**：续接进来的下一章的图，不能拿锚点章的地址当来源
      const referer = (owner ?? chapter)?.url
      const src = readerImageSrc(image, referer, imageGeneration[image] ?? 0, currentBook.details.sourceId)
      const failure = failedImages[image]
      if (failure) {
        // 取失败不当成"没有图"藏起来：这一行说清失败了、为什么，并给一条出路。
        return renderImageFailure(image, referer, index)
      }
      const isFullImage = currentBook.details.imageStyle?.toUpperCase() === 'FULL'
      return (
        <figure key={index} className={`reader-paragraph-image${isFullImage ? ' is-full' : ''}`}>
          <img
            src={src}
            alt=""
            loading="lazy"
            decoding="async"
            role="button"
            tabIndex={0}
            // 图没加载出来之前按 3:4 预留高度：否则分页量的时候图片高度是 0，量完图一进来页面就错位。
            // 加载完把比例交还给图片本身（真实宽高比），并在分页模式下重新量一次。
            style={{ cursor: 'zoom-in', aspectRatio: '3 / 4' }}
            onClick={event => { event.stopPropagation(); setLightboxSrc(src) }}
            onLoad={event => {
              const element = event.currentTarget
              element.style.aspectRatio = 'auto'
              if (settings.pageMode === 'paginate') window.requestAnimationFrame(() => measurePagination())
            }}
            onError={event => {
              event.currentTarget.hidden = true
              setFailedImages(current => (current[image] ? current : { ...current, [image]: '这张图没取到' }))
            }}
          />
        </figure>
      )
    }
    return (
      <p
        key={index}
        data-paragraph-index={index}
        className={`reader-paragraph ${ttsActive && activeParagraphIndex === index ? 'tts-active-paragraph' : ''}`}
        onClick={() => handleParagraphClick(index)}
      >
        {renderParagraphContent(line, index, owner?.index ?? chapterIndex)}
      </p>
    )
  }

  /**
   * 漫画单图：只渲染当前这一张，翻页交给 `goNextPage` / `goPrevPage`（它们已经接上按图翻）。
   * 失败仍复用「重取这一张」的出路；页码角标让读者知道这一章还有几张。
   */
  const renderMangaContent = () => {
    const image = mangaImages[Math.min(mangaIndex, mangaImages.length - 1)]
    if (!image) return null
    const referer = chapter?.url
    const src = readerImageSrc(image, referer, imageGeneration[image] ?? 0)
    const failure = failedImages[image]
    return (
      <div className="manga-page" data-manga-index={mangaIndex}>
        {failure ? renderImageFailure(image, referer) : (
          <img
            className="manga-page-image"
            src={src}
            alt=""
            decoding="async"
            onClick={event => { event.stopPropagation(); setLightboxSrc(src) }}
            onError={event => {
              event.currentTarget.hidden = true
              setFailedImages(current => (current[image] ? current : { ...current, [image]: '这张图没取到' }))
            }}
          />
        )}
        <span className="manga-page-count">{mangaIndex + 1} / {mangaImages.length}</span>
      </div>
    )
  }

  const showBoundaryNotice = useCallback((msg: string) => {    setBoundaryMessage(msg)
    if (boundaryTimerRef.current !== null) window.clearTimeout(boundaryTimerRef.current)
    boundaryTimerRef.current = window.setTimeout(() => {
      boundaryTimerRef.current = null
      setBoundaryMessage('')
    }, 1400)
  }, [])

  /**
   * @param keepContainer 翻页模式里"跨章的那一翻"用：不换容器 key，于是整棵子树不重挂、
   *   进场动画不重放。主动跳章（目录、`Home/End`、章末提示条）仍然要重挂 —— 那是另一回事。
   */
  const changeChapter = useCallback((rawIndex: number, targetPage: 'first' | 'last' | 'auto' = 'auto', keepContainer = false) => {
    if (rawIndex < 0 || rawIndex >= currentBook.chapters.length || rawIndex === chapterIndex) {
      if (rawIndex < 0 || rawIndex >= currentBook.chapters.length) {
        showBoundaryNotice(rawIndex < 0 ? '已是第一章' : '已是最后一章')
      }
      return
    }
    // 卷分组头（isVolume，无正文地址）不能当作章节打开：沿移动方向跳到最近的真实章节。
    let nextIndex = rawIndex
    const dir = rawIndex > chapterIndex ? 1 : -1
    while (nextIndex >= 0 && nextIndex < currentBook.chapters.length && currentBook.chapters[nextIndex].isVolume) {
      nextIndex += dir
    }
    if (nextIndex < 0 || nextIndex >= currentBook.chapters.length || nextIndex === chapterIndex) {
      if (nextIndex < 0 || nextIndex >= currentBook.chapters.length) {
        showBoundaryNotice(nextIndex < 0 ? '已是第一章' : '已是最后一章')
      }
      return
    }
    persist()
    if (!autoPlayNextChapterRef.current) {
      stopTts()
    } else if (settings.ttsEngine === 'webSpeech') {
      stopAllEngines()
    }
    // 翻页模式的页码是**相对当前窗口**的，而这里马上要清掉续接窗口并重挂容器（下面两行），
    // 旧页码对新锚点没有任何含义。原来 'auto' 什么都不设，测量收尾那一轮只做夹取，
    // 于是从目录跳章、底部「上一章/下一章」、进度滑条、朗读的上一/下一章按钮都会**停在旧页码上**：
    // 在第 12 页点目录跳到一章只有三页的书，落点是第 3 页而不是第 1 页。
    targetInitialPageRef.current = targetPage === 'auto'
      ? (settings.pageMode === 'paginate' ? 'first' : null)
      : targetPage
    // 既不清 content 也不清 loadedChapterUrl：这两个值成对描述"屏幕上挂的是哪一章"。
    // 历史上这里两者都清，是为了杜绝切章瞬间朗读误读上一章旧正文（AGENTS.md 的跨章竞态守卫）——
    // 那个目的现在由 ttsParagraphs 承担（过渡期间给朗读管线空数组），视觉侧不必跟着挖空。
    // 清 content 的代价就是用户 2026-09-30 说的"章节之间过渡没有做好"：整页先白一闪。
    setLoading(true)
    setChapterIndex(nextIndex)
    setActiveDrawer(null)
    // 主动跳章与"顶上来"是两回事：这里要换容器 key（重挂 + 重放一次进场动画），
    // 并把续接推进的状态清干净，否则上一次跨章的补偿会被用错地方。
    flowAdvanceRef.current = false
    pendingKeepRef.current = null
    // 续接窗口跟着跳：留着旧位置后面那几章的话，这一帧会在新的锚点下面挂出毫不相干的章节。
    // 前面接的那些同理 —— 主动跳章就是"换地方重新看"，不保留窗口两侧。
    setFlowTail([])
    setFlowHead([])
    pendingPrependRef.current = null
    if (!keepContainer) setFlowKey(currentBook.chapters[nextIndex]?.url ?? `jump-${nextIndex}`)
  }, [chapterIndex, currentBook.chapters.length, persist, settings.pageMode, settings.ttsEngine, showBoundaryNotice, stopTts, stopAllEngines])
  // 把最新那份 changeChapter 交给朗读 hook（它要用 ref 打破循环依赖）。
  changeChapterRef.current = changeChapter

  /**
   * 顶栏的「上一章 / 下一章」：沿用旧底栏进度行那套动作（先落进度、再切章），
   * 判据只看 chapterIndex —— 首章禁用上一章、末章禁用下一章。
   */
  const goPrevChapter = useCallback(() => {
    if (chapterIndex <= 0) return
    persist()
    changeChapter(chapterIndex - 1)
  }, [chapterIndex, changeChapter, persist])
  const goNextChapter = useCallback(() => {
    if (chapterIndex >= currentBook.chapters.length - 1) return
    persist()
    changeChapter(chapterIndex + 1)
  }, [chapterIndex, changeChapter, currentBook.chapters.length, persist])

  // 滚动模式的"滚到底再往下推一下就进下一章"。判据必须是"已经触底 + 继续向下滚"，
  // 只按位置阈值会在正常阅读途中翻章；1.2 秒冷却挡住一次惯性滚动连跳多章。
  // 监听挂在 window 上而不是正文元素上：版心两侧那段空白同样会滚轮，挂在正文里等于
  // "鼠标停在边缘滚就没反应"。
  const autoNextAtRef = useRef(0)
  useEffect(() => {
    if (settings.pageMode !== 'scroll') return
    const onWindowWheel = (event: WheelEvent) => {
      if (event.deltaY <= 0 || loading || !content) return
      if (chapterIndex >= currentBook.chapters.length - 1) return
      // 连续流里"下一章"本来就挂在下面，跨章由滚动回调顶窗口；这里再翻一次就是重复跳章
      if (flowTailRef.current.length > 0) return
      const doc = document.documentElement
      if (doc.scrollHeight - (window.scrollY + window.innerHeight) > 4) return
      const now = Date.now()
      if (now - autoNextAtRef.current < 1200) return
      autoNextAtRef.current = now
      changeChapter(chapterIndex + 1, 'first')
    }
    window.addEventListener('wheel', onWindowWheel, { passive: true })
    return () => window.removeEventListener('wheel', onWindowWheel)
  }, [changeChapter, chapterIndex, content, currentBook.chapters.length, loading, settings.pageMode])

  const toggleShelf = async () => {
    try {
      if (inShelf) {
        if (!confirm(`移出“${bookName}”将清除书架、阅读进度和缓存封面，确定继续吗？`)) return
        await api.removeFromBookshelf(currentBook.details.sourceId, currentBook.bookUrl)
        setInShelf(false)
        toast.info(`《${bookName}》已移出书架`)
        return
      }
      const fallbackCover = currentBook.details.coverUrl || currentBook.details.alternateSources?.find(s => s.coverUrl?.trim())?.coverUrl?.trim()
      await api.addToBookshelf({
        sourceId: currentBook.details.sourceId,
        bookUrl: currentBook.bookUrl,
        name: bookName,
        author: currentBook.details.author,
        tocUrl: currentBook.details.tocUrl,
        coverUrl: fallbackCover || undefined,
        alternateSources: currentBook.details.alternateSources,
      })
      setInShelf(true)
      toast.success(`《${bookName}》已加入书架`)
    } catch (error) {
      // 调用点是 void toggleShelf()：不接住就成 unhandled rejection，用户还以为加架成功了
      toast.error(error instanceof Error ? error.message : '书架操作失败')
    }
  }

  const handleCacheBook = async () => {
    await handleCacheRange('all')
  }

  const handleCacheRange = async (mode: 'all' | 'custom', start?: number, end?: number) => {
    let s = chapterIndex
    let count: number | undefined
    let e: number | undefined

    if (mode === 'all') {
      s = 0
      count = undefined
    } else {
      s = Math.max(0, (start ?? 1) - 1)
      e = Math.max(s, (end ?? currentBook.chapters.length) - 1)
      count = undefined
    }

    try {
      await api.cacheBookshelfRange({
        sourceId: currentBook.details.sourceId,
        bookUrl: currentBook.bookUrl,
        startIndex: s,
        endIndex: e,
        count,
      })
      toast.success(mode === 'all' ? '已加入全本离线缓存队列' : `已开始缓存第 ${s + 1} ~ ${(e ?? 0) + 1} 章`)
      setCacheStatus(prev => ({ ...prev, state: 'caching', error: undefined }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '发起缓存失败')
    }
  }

  const handleSyncToLocal = async (rangeChapters?: Chapter[]) => {
    const targetChapters = rangeChapters || currentBook.chapters.slice(chapterIndex, chapterIndex + 50)
    localSyncAbortRef.current?.abort()
    const controller = new AbortController()
    localSyncAbortRef.current = controller

    setLocalSyncing(true)
    setLocalSyncProgress({ current: 0, total: targetChapters.length })

    try {
      const res = await downloadChaptersToOffline(
        currentBook.details.sourceId,
        currentBook.bookUrl,
        targetChapters,
        async (chUrl) => {
          return api.content(currentBook.details.sourceId, chUrl, currentBook.bookUrl, controller.signal)
        },
        (comp, tot) => {
          setLocalSyncProgress({ current: comp, total: tot })
        },
        controller.signal
      )
      if (!controller.signal.aborted) {
        toast.success(`离线同步完成：成功 ${res.successful} 章，跳过/已缓存 ${targetChapters.length - res.failed - res.successful} 章`)
        // 原来这里 `setCachedChapterUrls(offlineSet)` —— 用 IndexedDB 那一份**整体替换**，
        // 于是「只在服务端缓存过」的那些章节（整本缓存过、或换设备后本地库被清空）云朵全部复亮，
        // 用户看到的就是「缓存下载了怎么还有小云朵」。改成走同一条并集通道：
        // syncCacheStatus 自己就是「服务端 ∪ IndexedDB」，顺带把字数表一起刷新。
        await syncCacheStatus()
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        toast.error('离线同步中断')
      }
    } finally {
      if (!controller.signal.aborted) {
        setLocalSyncing(false)
      }
    }
  }

  const handleCancelCache = async () => {
    try {
      await api.cancelBookCache(currentBook.details.sourceId, currentBook.bookUrl)
      setCacheStatus(prev => ({ ...prev, state: 'failed', error: '已取消缓存' }))
      toast.info(`已取消《${bookName}》的离线缓存`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '无法取消缓存')
    }
  }

  const handleSwitchSource = async (chosen: { result: SearchResult; chapters: Chapter[]; targetChapterIndex: number }) => {
    const details = await api.details(chosen.result.sourceId, chosen.result.bookUrl)
    const fallbackCover = details.coverUrl?.trim() ||
      chosen.result.coverUrl?.trim() ||
      currentBook.details.coverUrl?.trim() ||
      currentBook.details.alternateSources?.find(s => s.coverUrl?.trim())?.coverUrl?.trim()

    const safeDetails: BookDetails = {
      ...details,
      name: cleanTitle(details.name?.trim() || currentBook.details.name || '未知书名') || currentBook.details.name,
      author: cleanAuthor(details.author?.trim() || currentBook.details.author) || currentBook.details.author,
      coverUrl: fallbackCover || undefined,
      intro: details.intro || currentBook.details.intro,
      alternateSources: currentBook.details.alternateSources,
    }

    await api.switchBookshelfSource({
      oldSourceId: currentBook.details.sourceId,
      oldBookUrl: currentBook.bookUrl,
      book: {
        sourceId: safeDetails.sourceId,
        bookUrl: chosen.result.bookUrl,
        name: safeDetails.name,
        author: safeDetails.author,
        tocUrl: safeDetails.tocUrl,
        coverUrl: safeDetails.coverUrl,
      },
      alternateSources: currentBook.details.alternateSources,
    })

    const newOpenBook: OpenBook = {
      details: safeDetails,
      bookUrl: chosen.result.bookUrl,
      chapters: chosen.chapters,
      progress: {
        sourceId: safeDetails.sourceId,
        bookUrl: chosen.result.bookUrl,
        chapterUrl: chosen.chapters[chosen.targetChapterIndex]?.url || '',
        chapterIndex: chosen.targetChapterIndex,
        scrollPosition: 0,
        updatedAt: Date.now(),
      },
    }

    setCurrentBook(newOpenBook)
    setChapterIndex(chosen.targetChapterIndex)
    preloadedContentRef.current.clear()
    // 换源等于"这本书的正文全部重来"：旧书的续接章节挂在新 currentBook 下面会画出别的源的章节，
    // 而朗读管线此刻不会再出声（chunks 跟着新书清空），悬浮条却停在播放态。
    stopTts()
    flowAdvanceRef.current = false
    pendingKeepRef.current = null
    pendingPrependRef.current = null
    setFlowTail([])
    setFlowHead([])
    setFlowKey(chosen.chapters[chosen.targetChapterIndex]?.url ?? newOpenBook.bookUrl)
    sessionStorage.setItem('legado-open-book-v1', JSON.stringify({ book: newOpenBook, index: chosen.targetChapterIndex }))
  }

  // Load chapter content.
  // 用 useLayoutEffect 而不是 useEffect：预载命中时（下一章往往已经在 preloadedContentRef 里）
  // 正文在浏览器绘制之前就换好了，不会先画一帧骨架屏再画正文；真在飞的场合骨架屏照旧出现。
  useLayoutEffect(() => {
    let cancelled = false
    setLoading(true)
    setMessage('')
    const applyContent = (nextContent: string, nextMediaUrl: string | null = null) => {
      if (cancelled) return
      setContent(nextContent)
      chapterBaseContentRef.current = nextContent
      setMediaUrl(nextMediaUrl)
      setLoadedChapterUrl(chapter.url)
      // 「当获取到内容的时候」就把这一章的字数记进表里：服务端这一刻同时把正文写进了缓存
      // （ReadingRoutes 的 cacheBookContent），但界面不该等下一轮同步才显示出眼前这一章的字数。
      if (nextContent.length > 0) {
        setChapterWordCounts(prev => {
          if (prev.get(chapter.url) === nextContent.length) return prev
          const nextMap = new Map(prev)
          nextMap.set(chapter.url, nextContent.length)
          return nextMap
        })
        // 同一刻这一章在服务端已经落库（cacheBookContent 就在刚才那次请求里写了行），
        // 云朵该立刻熄掉。缓存标记的轮询只在 `state==='caching'` 时才跑（见下面的 effect），
        // 平时读到的新章不会有人再来拉 —— "读着读着云还挂着"就是这条断链。
        setCachedChapterUrls(prev => (prev.has(chapter.url) ? prev : new Set(prev).add(chapter.url)))
      }
      // 漫画/图文章节：趁用户看首屏，把正文里的图片提前喂给服务端代理取回落盘缓存，
      // 后面滚动/翻页不必每张都等服务端联网（referer 用本章地址，图站防盗链才放得过去）。
      warmContentImages(nextContent, chapter.url, currentBook.details.sourceId)
      // 续接推进时 position 给 null：下面那个定位 effect 见到 null 就直接返回，
      // 于是"跨章"不再伴随任何 scrollTo —— 这正是"不是一体的吗"要的答案。
      const advancing = flowAdvanceRef.current
      flowAdvanceRef.current = false
      const position = advancing ? null
        : (!restoredRef.current && chapter.index === startIndex ? currentBook.progress?.scrollPosition ?? 0 : 0)
      restoredRef.current = true
      currentRef.current = { chapter, position: position ?? 0 }
      initialPagePositionRef.current = position
      setLoading(false)
    }
    const preloaded = preloadedContentRef.current.get(chapter.url)
    if (preloaded) {
      applyContent(preloaded)
    } else {
      void api.content(currentBook.details.sourceId, chapter.url, currentBook.bookUrl)
        .then(result => applyContent(result.content, result.mediaUrl ?? null))
        .catch(error => {
          if (!cancelled) setMessage(error instanceof Error ? error.message : '无法读取正文')
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }
    return () => {
      cancelled = true
    }
  }, [chapter, currentBook.bookUrl, currentBook.details.sourceId, currentBook.progress?.scrollPosition, startIndex])

  /**
   * 续接窗口：把锚点章之后的 1~2 章挂到下面（滚动与分页两种模式都要）。
   * 优先吃预载缓存 —— `preloadNextChapter` 在本章读到 70% 时就把下一章取回来了，
   * 所以正常情况下这一趟零请求。
   */
  useEffect(() => {
    if (!content) return
    // 非文本章节（音频/视频/文件）不续接下一章：它们是"一章一个媒体"，续接只会把地址当正文排出来。
    if (isMediaType(sourceType)) { setFlowTail([]); return }
    // 锚点还没换上这一章的正文时不许重排窗口：那会在"上一章的字还挂着"的那一两帧里
    // 把已经续接进来的那一章从 DOM 中摘走，画面凭空少一章 —— 正是要消灭的"跳"。
    // 宁可让那一章短暂地出现两次（重复的那份在视口下方，看不见），也不许它消失。
    if (chapter && loadedChapterUrl !== chapter.url) return
    let cancelled = false
    void (async () => {
      const wanted: Chapter[] = []
      for (let i = chapterIndex + 1; i < currentBook.chapters.length && wanted.length < 2; i += 1) {
        const candidate = currentBook.chapters[i]
        if (!candidate || candidate.isVolume || !candidate.url) continue
        wanted.push(candidate)
      }
      const filled: { chapter: Chapter; content: string }[] = []
      for (const candidate of wanted) {
        const cached = preloadedContentRef.current.get(candidate.url)
        if (cached) {
          filled.push({ chapter: candidate, content: cached })
          continue
        }
        const result = await api.content(currentBook.details.sourceId, candidate.url, currentBook.bookUrl).catch(() => null)
        if (!result || cancelled) break
        preloadedContentRef.current.set(candidate.url, result.content)
        // 预载的下一章若含图（漫画常见），趁现在把它的图也预热，翻过去时直接命中缓存。
        warmContentImages(result.content, candidate.url, currentBook.details.sourceId)
        filled.push({ chapter: candidate, content: result.content })
      }
      if (!cancelled) setFlowTail(filled)
    })()
    return () => { cancelled = true }
  }, [settings.pageMode, chapterIndex, chapter?.url, content, loadedChapterUrl, currentBook.bookUrl, currentBook.chapters, currentBook.details.sourceId])

  // Scroll mode layout effect to restore position or jump to start/end
  useLayoutEffect(() => {
    if (settings.pageMode !== 'scroll' || loading || !content) return
    // 续接推进：摘掉了顶部那几章，滚动位置要按"新锚点现在量出来的偏移"校正回去。
    // 放在这个 layout effect 里是因为它在浏览器绘制之前 —— 校正必须和摘除同一帧完成，
    // 否则用户看到的就是画面往上跳一截（那正是要消灭的症状，只是换了个触发点）。
    if (pendingKeepRef.current !== null) {
      const keep = pendingKeepRef.current
      pendingKeepRef.current = null
      const first = document.querySelector<HTMLElement>('.reading-content .reader-flow-chapter')
      if (first) {
        const next = holdScroll(window.scrollY, first.getBoundingClientRect().top, keep)
        lastScrollYRef.current = next
        window.scrollTo({ top: next, behavior: 'auto' })
      }
      return
    }
    const targetMode = targetInitialPageRef.current
    const initialPos = initialPagePositionRef.current
    targetInitialPageRef.current = null
    initialPagePositionRef.current = null

    const scrollToTarget = () => {
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
      let targetScroll = 0
      if (targetMode === 'last') {
        targetScroll = maxScroll
      } else if (targetMode === 'first') {
        targetScroll = 0
      } else if (initialPos !== null) {
        targetScroll = Math.round(maxScroll * initialPos)
      } else {
        return
      }
      lastScrollYRef.current = targetScroll
      window.scrollTo({ top: targetScroll, behavior: 'auto' })
    }

    scrollToTarget()
    const rafId = window.requestAnimationFrame(scrollToTarget)
    return () => window.cancelAnimationFrame(rafId)
  }, [content, loading, settings.pageMode])

  /**
   * 分页模式的跨章也是"顶窗口"（用户 2026-10-02：「竖版做好了，横板还是跳转」）。
   * 翻进已经挂在下面的那一章时不换章、不重挂子树、不把页码归零：
   * 摘掉最前面那一章，页码减去它的页数 —— 与滚动模式同一套动作，只是单位从像素换成页。
   */
  useLayoutEffect(() => {
    if (settings.pageMode !== 'paginate' || pendingPageRef.current !== null) return
    // 只在几何真的对齐时才挪窗口。垫栏是"量完再渲染"的，首屏那一轮可能还没落进 DOM：
    // 这时下一章的起始栏是奇数（正好挂在上一页的右半格），挪一下会把页码归零到
    // 同一栏上 —— 用户看到的就是"同一栏读两遍"。不挪反而没事：继续往前翻是连续的。
    // 下一轮重量会把垫栏补上，之后再挪就是无缝的。
    if (!pageAlignedRef.current) return
    const shift = pageWindowShift(pageSpansRef.current, pageIndex)
    if (!shift) return
    // 窗口现在是「前面接的章 + 锚点 + 后面续的章」，所以要按整条窗口找第 lead 节是哪一章，
    // 不能再假设 sections[0] 就是锚点（往前翻过之后它是某个 head）。
    const target = windowChaptersRef.current[shift.lead]
    if (!target) return
    const targetIndex = currentBook.chapters.findIndex(item => item.url === target.url)
    if (targetIndex <= chapterIndexRef.current) return
    pendingPageRef.current = shift.pageIndex
    setChapterIndex(targetIndex)
    // 新锚点之前的章不再属于这个窗口：往回翻接在窗口前面的 flowHead 必须一起摘掉。
    // 留着它们，`shift.pageIndex` 是按"新锚点从第 0 页开始"算的，页码会指到这些旧章上 ——
    // 画面跳回已经读过的章，垫栏空白也会被当成一页翻出来。尾章由续接 effect 按新锚点重算。
    if (flowHeadRef.current.length > 0) setFlowHead([])
  }, [pageIndex, settings.pageMode, currentBook.chapters])

  // Pagination measurement
  const measurePagination = useCallback(() => {
    const viewport = viewportRef.current
    const body = bodyRef.current
    if (!viewport || !body) return
    const w = viewport.clientWidth
    if (w <= 0) return
    if (loading || !content) return

    const totalScrollWidth = body.scrollWidth
    const layout = calculatePaginationLayout({
      viewportWidth: w,
      totalScrollWidth,
      columnGap,
      columnMode: settings.columnMode,
    })

    setColumnWidth(layout.columnWidth)
    setStride(layout.stride)
    setIsDoubleColumn(layout.isDoubleColumn)

    // 每一章在窗口里占哪几页。
    // 关键：**先算每一章占几栏（精确整数），再累加出起始栏号**，最后才除以"一屏几栏"。
    // 原来直接 (矩形左边缘 - body 左边缘) / stride 取整，等于把章节起始列的奇偶丢掉 ——
    // 下一章落在奇数列时，它的第一栏是上一页的右半格（用户已经看过），窗口一挪页码归零，
    // 那一栏又挪回左半格。用户 2026-10-03 的两句"不要这样的跳转"就是这么来的。
    let effectivePageCount = layout.pageCount
    const sections = [...body.querySelectorAll<HTMLElement>('.reader-page-chapter')]
    if (sections.length > 0) {
      const columnsPerPage = layout.isDoubleColumn ? 2 : 1
      // 每一章占几栏 —— **不能量 section 的 getBoundingClientRect().width**：
      // 分栏里一个跨七栏的 <section>，它的矩形只报到约两栏宽（实测算出 [1,2,2] 而真实是 [1,7,7]），
      // 于是"补齐到整页"永远算出 0，界面照旧重复一栏。用 Range 量才拿得到每一栏的那块碎片。
      // 也正因为如此，垫的那一栏必须落在 section **外面**：算在里面的话章数会被自己数多一栏，
      // 下一轮又算成不用垫 —— 来回振荡。
      //
      // 数"多少栏"还不能直接对碎片左缘去重：段落有**首行缩进**时，每一栏里都多出一个
      // "缩进后的第一行"左缘 —— 一个真栏被数成两个（探针书实测：一章 8 栏数成 13、
      // 前言 1 栏数成 2）。偶数的假栏数 → 该垫的垫成 0 → 下一章落在奇数栏，接章补偿
      // 与翻页窗口全都差半页。修法：左缘先按 stride 分桶量化，缩进的左缘落进所在栏的桶，
      // 桶数才是真栏数（paginate-flow-check ④ 的几何转储逮到的就是这个）。
      const bodyLeft = body.getBoundingClientRect().left
      const measuredStride = layout.columnWidth + columnGap
      const columnCounts = sections.map(node => {
        const range = document.createRange()
        range.selectNodeContents(node)
        const lefts = new Set([...range.getClientRects()]
          .filter(rect => rect.width > 1)
          .map(rect => Math.round((rect.left - bodyLeft) / measuredStride)))
        return Math.max(1, lefts.size)
      })
      const nextFillers = pageAlignmentPads(columnCounts, columnsPerPage)
      const starts = pageAlignmentStarts(columnCounts, columnsPerPage)
      // 对齐闸门按**量出来的**起始栏判，不按算术：算术说垫了、DOM 里还没渲染出来，
      // 这一刻挪窗口照样会重复一栏。
      const measuredStarts = sections.map(node => {
        const range = document.createRange()
        range.selectNodeContents(node)
        const rects = [...range.getClientRects()].filter(rect => rect.width > 1)
        const left = rects.length > 0 ? Math.min(...rects.map(rect => rect.left)) : bodyLeft
        return Math.round((left - bodyLeft) / measuredStride)
      })
      pageAlignedRef.current = measuredStarts.every(col => col % columnsPerPage === 0)
      measuredStartsRef.current = measuredStarts
      columnsPerPageRef.current = columnsPerPage
      setPageFillers(current => (current.length === nextFillers.length
        && current.every((value, index) => value === nextFillers[index]) ? current : nextFillers))
      // 最后一章末尾那一栏垫白不该被算成一页：`layout.pageCount` 是按 DOM 总宽量的，
      // 若它比"最后一节正文落在的页"还多，多出来的页里只有垫栏 —— 翻过去就是一整页空白。
      // 只收紧、不放宽：正常对齐时两者相等，这一条是兜底（章末不再出现空白页）。
      const contentEndColumn = starts[starts.length - 1] + columnCounts[columnCounts.length - 1]
      effectivePageCount = Math.max(1, Math.min(layout.pageCount, Math.ceil(contentEndColumn / columnsPerPage)))
      setPageCount(effectivePageCount)
      pageSpansRef.current = starts.map((start, index) => ({
        start: Math.round(start / columnsPerPage),
        end: index + 1 < starts.length
          ? Math.round(starts[index + 1] / columnsPerPage)
          : effectivePageCount,
      }))
      // 刚往前接了一章：页码由下面那个专门的 layout effect 补（它同步量、同步补，不靠这里的时机）
      // 刚把窗口往前挪过：页码要落到"摘掉前面那几章之后"的那一页上，否则画面跳回窗口开头
      if (pendingPageRef.current !== null) {
        const next = Math.min(effectivePageCount - 1, Math.max(0, pendingPageRef.current))
        pendingPageRef.current = null
        setPageIndex(next)
        return
      }
    } else {
      pageSpansRef.current = []
      measuredStartsRef.current = []
      setPageCount(effectivePageCount)
    }

    const pageTarget = targetInitialPageRef.current
    const restoredPosition = initialPagePositionRef.current
    targetInitialPageRef.current = null
    initialPagePositionRef.current = null
    if (pageTarget === null && restoredPosition === null) {
      // 同一个锚点内重量一次（改字号、拖窗口、续接挂章）：原地不动，只做夹取
      setPageIndex(curr => resolveMeasuredPage(null, null, curr, effectivePageCount))
      return
    }
    setPageIndex(resolveMeasuredPage(pageTarget, restoredPosition, 0, effectivePageCount))
  }, [columnGap, content, loading, settings.columnMode])

  useLayoutEffect(() => {
    if (settings.pageMode !== 'paginate') return
    if (loading || !content) return
    measurePagination()
    const viewport = viewportRef.current
    if (!viewport) return
    // 只观察 viewport 是不够的：续接窗口挂上/摘掉章节时窗口宽度会变，而视口尺寸没变，
    // ResizeObserver 一次都不会回调 —— 于是 pageCount 停在"只有锚点那一章"的页数上，
    // 多出来的那些列被 overflow:hidden 裁掉，用户永远翻不进去（横版"还是跳转"就是这么来的）。
    const observer = new ResizeObserver(() => measurePagination())
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [
    settings.pageMode,
    content,
    loading,
    // 往前接一章之后必须重量一次。分栏容器的高度不变、宽度才变，而 ResizeObserver 观察的是
    // 元素盒子 —— 内容变宽而盒子没变时它一次都不回调（AGENTS §5「分页/测量」那条同一个病），
    // 只挂 flowTail 的话新接进来的那一章永远算不进页数，页码就不会后移。
    flowHead,
    flowTail,
    // 垫栏本身要再量一次：首屏只挂上锚点那一章时"章末那一栏"还没有地方渲染，
    // 等下一张预览挂上来才补得上 —— 不重量的话第一次跨章那一下仍会重复一栏。
    pageFillers,
    settings.fontSize,
    settings.lineHeight,
    settings.letterSpacing,
    settings.paragraphSpacing,
    settings.textIndent,
    settings.contentPadding,
    settings.maxWidth,
    settings.columnMode,
    settings.sidebarPinned,
    settings.font,
    measurePagination,
  ])

  /**
   * 往前接进来的那一章挂上之后，把页码落到**上一章的最后一页**。
   *
   * 落点按**量得的起始栏**算：接章前窗口的第 0 节（无论它当时是锚点还是之前的头章）
   * 接完后排第 1 节，它第一页的前一页就是接进来那一章的最后一页（`prependLandingPage`）。
   * 这就是「往回翻一页」，与前进对称：前进从本章末页进下一章首页。
   *
   * 原来按"接进来的那章占几页"（`pageSpans` 的算术推算）补，实测（双栏、探针书）
   * 页码补了、眼前那栏字却滑到几段之外（paginate-flow-check ④「接之前第 2 段落 vs
   * 之后第 5 段落」）—— 算术与 DOM 在垫栏/强制分栏上有一处出入，这里就错半页；
   * 量出来的不会错。
   *
   * **必须等垫栏真的落进 DOM**：接章首帧用的还是旧窗口的 `pageFillers` 数组，
   * 新接进来那一章的垫栏要等这一轮 `measurePagination` 写回状态后才渲染。
   * 对齐之前补页码会差半页；更要紧的是，若只补一次就放弃，页码会停在 0 ——
   * 那正好是接进来那章的**第一页**，也就是「往回翻落到上一章开头」。
   * 所以 `pageFillers` 也在依赖里：垫栏落地后这里会再跑一次。
   */
  const settlePrependedPage = useCallback(() => {
    const url = pendingPrependRef.current
    if (!url || settings.pageMode !== 'paginate' || loading || !content) return
    // 这一章还没成为窗口最上面那一节（React 还没提交，或提交到一半）：等它成为再说
    if (windowChaptersRef.current[0]?.url !== url) return
    const sections = windowChaptersRef.current.length
    const starts = measuredStartsRef.current
    if (starts.length !== sections || sections < 2) return
    if (!pageAlignedRef.current) return
    pendingPrependRef.current = null
    setPageIndex(prependLandingPage(starts[1], columnsPerPageRef.current))
  }, [content, loading, settings.pageMode])

  useLayoutEffect(() => {
    if (!pendingPrependRef.current) return
    measurePagination()
    settlePrependedPage()
  }, [content, loading, measurePagination, pageFillers, settings.pageMode, settlePrependedPage, windowChapters])

  const goNextPage = useCallback(() => {
    // 漫画单图：章内按图翻，翻到最后一张再进下一章（与文本分页同一套入口）。
    if (isMangaMode) {
      if (mangaIndex < mangaImages.length - 1) setMangaIndex(mangaIndex + 1)
      else changeChapter(chapterIndex + 1, 'first')
      return
    }
    const plan = planNextPage(pageIndex, pageCount)
    if (plan.kind === 'step') {
      // 覆盖档要先把"新页"演出来，动画收尾才真翻页；其余档当场翻。
      if (pageAnim === 'cover') setCoverTurn({ to: plan.page, direction: 1 })
      else setPageIndex(plan.page)
      return
    }
    // 已到本章最后一页：翻页模式下这是"下一页"而不是"跳一章"（不换容器 key，不重挂）
    changeChapter(chapterIndex + 1, 'first', settings.pageMode === 'paginate')
  }, [chapterIndex, changeChapter, isMangaMode, mangaImages.length, mangaIndex, pageCount, pageIndex, pageAnim, settings.pageMode])

  /**
   * 往回翻到窗口开头时，把**上一章接到窗口最前面**。
   *
   * 不做"换锚点 + 跳到最后一页"那一套：那要等尾章挂上来、垫栏补完才知道总页数，
   * 而它是在旧窗口的页数上算的，实测就会落到上一章的中间（这正是用户问的"往回怎么办"）。
   * 接进来之后眼前这一页一个字都不动，只是页码整体涨了那一章的页数 —— 与前进完全对称。
   * 返回 false 表示前面真的没有章了（调用方去说"已是第一章"）。
   */
  const prependPreviousChapter = useCallback(async () => {
    // 非文本章节（音频/视频/文件）不往回接章：同续接，媒体地址不能当正文。
    if (isMediaType(currentBook.details.sourceType ?? 0)) return false
    const oldest = flowHeadRef.current[0]?.chapter ?? chapter
    const oldestIndex = oldest ? currentBook.chapters.findIndex(item => item.url === oldest.url) : -1
    let target = oldestIndex - 1
    while (target >= 0 && (currentBook.chapters[target]?.isVolume || !currentBook.chapters[target]?.url)) target -= 1
    if (oldestIndex < 1 || target < 0) return false
    const candidate = currentBook.chapters[target]
    const cached = preloadedContentRef.current.get(candidate.url)
    let text = cached ?? null
    if (text === null) {
      const result = await api.content(currentBook.details.sourceId, candidate.url, currentBook.bookUrl).catch(() => null)
      if (!result) return false
      text = result.content
      preloadedContentRef.current.set(candidate.url, result.content)
    }
    pendingPrependRef.current = candidate.url
    setFlowHead(prev => (prev.some(item => item.chapter.url === candidate.url) ? prev : [{ chapter: candidate, content: text ?? '' }, ...prev]))
    return true
  }, [chapter, currentBook.bookUrl, currentBook.chapters, currentBook.details.sourceId])

  const goPrevPage = useCallback(() => {
    // 漫画单图：章内退一张，退到第一张再回上一章的末图。
    if (isMangaMode) {
      if (mangaIndex > 0) setMangaIndex(mangaIndex - 1)
      else changeChapter(chapterIndex - 1, 'last')
      return
    }
    const plan = planPrevPage(pageIndex)
    if (plan.kind === 'step') {
      if (pageAnim === 'cover') setCoverTurn({ to: plan.page, direction: -1 })
      else setPageIndex(plan.page)
      return
    }
    // 窗口开头：往前接一章，而不是跳去"上一章的最后一页"。接的过程中不重复触发。
    if (pendingPrependRef.current !== null) {
      // 那一章其实已经挂上来了、只是页码还没补上（标记卡在量之前）：主动再量一次，
      // 不然一次错过就把"往回翻"永久锁死在这里。
      if (flowHeadRef.current[0]?.chapter.url === pendingPrependRef.current) measurePagination()
      return
    }
    void prependPreviousChapter().then(ok => {
      // 成了就不清这个标记：它要活到量出页数那一刻（由 measurePagination 消费）。
      // 没成就清掉，否则一次失败会永久卡住往回翻。
      if (!ok) {
        pendingPrependRef.current = null
        showBoundaryNotice('已是第一章')
      }
    })
  }, [chapterIndex, changeChapter, isMangaMode, mangaIndex, pageIndex, pageAnim, prependPreviousChapter, showBoundaryNotice])

  // Sync scroll / page progress
  useEffect(() => {
    if (settings.pageMode !== 'scroll') return
    let rafId: number | null = null
    const onScroll = () => {
      if (rafId !== null) return
      rafId = window.requestAnimationFrame(() => {
        rafId = null
        const current = currentRef.current
        if (!current) return
        const currentY = window.scrollY
        const scrollDelta = currentY - lastScrollYRef.current
        if (currentY > 72 && scrollDelta > 12) {
          setToolbarsVisible(false)
        } else if (scrollDelta < -8) {
          setToolbarsVisible(true)
        }
        lastScrollYRef.current = currentY
        const scrollHeight = document.documentElement.scrollHeight
        const clientHeight = window.innerHeight
        if (settings.pageMode === 'scroll') {
          // 进度仍然按"这一章读了多少"算（契约不变，分母从整篇换成锚点那一节），
          // 顺便判断该不该把窗口往前顶一格 —— 顶格是摘掉顶部那些章 + 补偿滚动，不是 scrollTo。
          const nodes = [...document.querySelectorAll<HTMLElement>('.reading-content .reader-flow-chapter')]
          if (nodes.length > 0) {
            const boxes = nodes.map(node => ({ top: currentY + node.getBoundingClientRect().top, height: node.offsetHeight }))
            current.position = clampScrollPosition(sectionProgress(boxes[0], currentY, clientHeight))
            // 一帧之内可能跨过多章（拖滚动条、程序化跳转），所以是一次顶过去若干节而不是逐节数。
            const advance = nodes.length > 1 ? flowAdvance(boxes, currentY) : null
            const target = advance ? flowTailRef.current[advance.lead - 1] : undefined
            if (advance && target) {
              const targetIndex = currentBook.chapters.findIndex(item => item.url === target.chapter.url)
              if (targetIndex > chapterIndexRef.current) {
                pendingKeepRef.current = advance.keepTop
                flowAdvanceRef.current = true
                persist()
                setChapterIndex(targetIndex)
              }
            }
          } else {
            current.position = scrollPosition(currentY, scrollHeight, clientHeight)
          }
        } else {
          current.position = scrollPosition(currentY, scrollHeight, clientHeight)
        }
        reportProgress({ chapterIndex: chapterIndexRef.current, total: currentBook.chapters.length, fraction: current.position })
        if (current.position >= 0.7) {
          preloadNextChapter(current.chapter.index)
        } else if (current.position <= 0.3) {
          preloadPrevChapter(current.chapter.index)
        }
        if (timerRef.current === null) {
          timerRef.current = window.setTimeout(() => {
            timerRef.current = null
            persist()
          }, 1200)
        }
      })
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') persist()
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('scroll', onScroll)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (rafId !== null) window.cancelAnimationFrame(rafId)
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      persist()
    }
  }, [persist, preloadNextChapter, preloadPrevChapter, settings.pageMode, currentBook.chapters])

  useEffect(() => {
    if (settings.pageMode !== 'paginate') return
    // 分母是"这一章有几页"，不是"这个窗口有几页" —— 与滚动模式同一份进度契约
    const position = pageSpansRef.current.length
      ? pageProgress(pageSpansRef.current, pageIndex)
      : (pageCount > 1 ? pageIndex / (pageCount - 1) : 0)
    const current = currentRef.current
    if (current && chapter) {
      current.position = position
      if (position >= 0.7) {
        preloadNextChapter(chapter.index)
      } else if (position <= 0.3) {
        preloadPrevChapter(chapter.index)
      }
      if (timerRef.current === null) {
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null
          persist()
        }, 1200)
      }
    }
  }, [chapter, pageCount, pageIndex, persist, preloadNextChapter, preloadPrevChapter, settings.pageMode])

  // Stop TTS on unmount
  useEffect(() => () => {
    stopAllEngines()
  }, [stopAllEngines])

  // Chapter content load effect for auto continuous next chapter
  useEffect(() => {
    if (!content || loading || loadedChapterUrl !== chapter?.url) return
    if (autoPlayNextChapterRef.current) {
      autoPlayNextChapterRef.current = false
      setTtsActive(true)
      playTtsChunkRef.current(0, 'continue')
    }
  }, [content, loading, loadedChapterUrl, chapter?.url])

  // Sleep Timer countdown effect
  useEffect(() => {
    if (sleepTimer === 'off' || sleepTimer === 'chapter') {
      setRemainingSeconds(null)
      return
    }
    const totalSecs = parseInt(sleepTimer, 10) * 60
    setRemainingSeconds(totalSecs)
    const timer = window.setInterval(() => {
      setRemainingSeconds(prev => {
        if (prev === null || prev <= 1) {
          window.clearInterval(timer)
          toast.info('睡眠定时时间到，已停止朗读')
          stopTts()
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [sleepTimer, stopTts])

  // MediaSession API integration
  useEffect(() => {
    if (!('mediaSession' in navigator) || !ttsActive) return
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: chapter?.title || '正文朗读',
        artist: currentBook.details.author || currentBook.details.name,
        album: bookName,
        artwork: currentBook.details.coverUrl ? [{ src: currentBook.details.coverUrl }] : undefined,
      })
      navigator.mediaSession.playbackState = ttsPlayState === 'playing' ? 'playing' : 'paused'

      navigator.mediaSession.setActionHandler('play', () => resumeTts())
      navigator.mediaSession.setActionHandler('pause', () => pauseTts())
      navigator.mediaSession.setActionHandler('previoustrack', () => handlePrevChunk())
      navigator.mediaSession.setActionHandler('nexttrack', () => handleNextChunk())
    } catch {
      // Ignore mediaSession errors
    }
  }, [ttsActive, ttsPlayState, chapter?.title, bookName, currentBook.details.author, currentBook.details.coverUrl, resumeTts, pauseTts, handlePrevChunk, handleNextChunk])

  // Wake Lock API integration
  useEffect(() => {
    if (!('wakeLock' in navigator)) return
    if (ttsActive && ttsPlayState === 'playing') {
      navigator.wakeLock.request('screen').then(lock => {
        wakeLockRef.current = lock
      }).catch(() => undefined)
    } else {
      wakeLockRef.current?.release().catch(() => undefined)
      wakeLockRef.current = null
    }
    return () => {
      wakeLockRef.current?.release().catch(() => undefined)
      wakeLockRef.current = null
    }
  }, [ttsActive, ttsPlayState])

  // Auto-scroll / highlight follower effect
  useEffect(() => {
    if (!ttsActive || activeParagraphIndex < 0) return

    if (settings.pageMode === 'scroll') {
      // 同上：高亮跟读只在锚点那一章里找，不然会滚到续接进来的下一章的同名段落
      const el = anchorSectionRef.current?.querySelector(`[data-paragraph-index="${activeParagraphIndex}"]`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    } else if (settings.pageMode === 'paginate') {
      // 高亮跟读只在锚点那一章里找（续接进来的下一章有同名段落），页码换算用与
      // `pageSpansRef` 同一套矩形差：offsetLeft 与 rect.left 混着量，跳页就会偏一整页。
      const body = bodyRef.current
      const anchor = body?.querySelector<HTMLElement>('.reader-page-chapter')
      const el = anchor?.querySelector<HTMLElement>(`[data-paragraph-index="${activeParagraphIndex}"]`)
      if (body && el && stride > 0) {
        const offset = el.getBoundingClientRect().left - body.getBoundingClientRect().left
        const targetPage = Math.min(pageCount - 1, Math.max(0, Math.round(offset / stride)))
        setPageIndex(targetPage)
      }
    }
  }, [activeParagraphIndex, ttsActive, settings.pageMode, stride, pageCount])

  useEffect(() => () => { if (boundaryTimerRef.current !== null) window.clearTimeout(boundaryTimerRef.current) }, [])

  // 快捷键：动作与界面上那张「快捷键」表都取自 web/src/shortcuts.ts 同一份定义。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = normalizeKey(event)
      if (!key || isTypingTarget(event.target, key)) return
      const hit = shortcutFor(READER_SHORTCUTS, key)
      if (!hit) return
      const jumpWithinChapter = (end: boolean) => {
        const section = anchorSectionRef.current
        if (!section) return
        const top = window.scrollY + section.getBoundingClientRect().top
        window.scrollTo({
          top: Math.max(0, end ? top + section.offsetHeight - window.innerHeight + 24 : top - 24),
          behavior: 'smooth',
        })
      }
      // 名字别叫 stepFontSize：那是纯函数的 import 名，遮蔽它会变成自递归。
      const bumpFontSize = (delta: number) => onSettingsChange({
        ...settings,
        // 字号口径唯一出处 fontSizeControl.ts（设置步进器/快捷键/Ctrl+滚轮三处共用）。
        fontSize: stepFontSize(settings.fontSize, delta),
      })
      // 键盘回调里抛出的异常只能落到 window.onerror —— ErrorBoundary 只兜渲染期，兜不住事件回调。
      // 「快速连按快捷键」正是把这类一次性异常放大成"界面卡死"的场景：`setLoading(true)` 已执行、
      // 后续步骤抛出，界面就永远停在加载态。这里收一道：动作出错不崩界面，如实报一句并交还控制权。
      // 整个 switch 留在本函数作用域内：`event`、上面那两个局部helper 都要能拿到。
      try {
      switch (hit.action) {
        case 'close':
          if (!activeDrawer) return
          setActiveDrawer(null)
          break
        case 'page-up':
          event.preventDefault()
          if (settings.pageMode === 'paginate') goPrevPage()
          else if (isAtTopBoundary(window.scrollY)) changeChapter(chapterIndex - 1, 'last')
          else window.scrollBy({ top: -window.innerHeight * 0.85, behavior: 'smooth' })
          break
        case 'page-down':
          event.preventDefault()
          if (settings.pageMode === 'paginate') goNextPage()
          else if (isAtBottomBoundary(window.scrollY, document.documentElement.scrollHeight, window.innerHeight)) changeChapter(chapterIndex + 1, 'first')
          else window.scrollBy({ top: window.innerHeight * 0.85, behavior: 'smooth' })
          break
        case 'chapter-prev':
          event.preventDefault()
          if (settings.pageMode === 'paginate') goPrevPage()
          else changeChapter(chapterIndex - 1, 'last')
          break
        case 'chapter-next':
          event.preventDefault()
          if (settings.pageMode === 'paginate') goNextPage()
          else changeChapter(chapterIndex + 1, 'first')
          break
        case 'chapter-start':
          event.preventDefault()
          jumpWithinChapter(false)
          break
        case 'chapter-end':
          event.preventDefault()
          jumpWithinChapter(true)
          break
        case 'font-increase':
          event.preventDefault()
          bumpFontSize(1)
          break
        case 'font-decrease':
          event.preventDefault()
          bumpFontSize(-1)
          break
        case 'theme-next': {
          event.preventDefault()
          // T 键在内置七套里循环（自定义皮肤不在轮换里，网格里点选）。
          const next = BUILTIN_SKINS[(BUILTIN_SKINS.findIndex(skin => skin.id === settings.theme) + 1) % BUILTIN_SKINS.length]
          onSettingsChange({ ...settings, theme: next.id })
          break
        }
        case 'toc':
          event.preventDefault()
          setActiveDrawer(drawer => drawer === 'toc' ? null : 'toc')
          break
        case 'settings':
          event.preventDefault()
          setActiveDrawer(drawer => drawer === 'settings' ? null : 'settings')
          break
        case 'tts':
          event.preventDefault()
          toggleTts()
          break
        case 'fullscreen':
          event.preventDefault()
          toggleFullscreen()
          break
      }
      } catch (error) {
        // 出了错也要把界面交回来：不能停在"正在加载"那一档让人以为书打不开。
        setLoading(false)
        setMessage(error instanceof Error ? error.message : '这一下快捷键没有执行成功')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeDrawer, changeChapter, chapterIndex, goNextPage, goPrevPage, onSettingsChange, settings, toggleTts])

  // Ctrl/⌘ + 滚轮直接调字号：不用先开设置抽屉再拖滑杆。必须 passive:false，否则拦不住浏览器的页面缩放。
  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return
      event.preventDefault()
      const next = stepFontSize(settings.fontSize, event.deltaY > 0 ? -1 : 1)
      if (next !== settings.fontSize) onSettingsChange({ ...settings, fontSize: next })
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [settings, onSettingsChange])

  const readerStyle = {
    '--reader-font-size': `${settings.fontSize}px`,
    '--reader-line-height': settings.lineHeight,
    '--reader-letter-spacing': `${settings.letterSpacing}px`,
    '--reader-paragraph-spacing': `${settings.paragraphSpacing}em`,
    '--reader-text-indent': `${settings.textIndent}em`,
    '--reader-content-padding': `${settings.contentPadding}px`,
    '--reader-max-width': `${settings.maxWidth}px`,
    '--reader-text-align': settings.textAlign,
    '--reader-sidebar-width': `${settings.sidebarWidth}px`,
    '--reader-font-family': effectiveReaderFontFamily(settings),
    '--reader-bg-color': settings.readerBgColor || 'transparent',
    // 背景图带一层压暗（readerBgDim）：再亮的图也不至于把墨色文字顶没。
    '--reader-bg-image': settings.readerBgImage
      ? `linear-gradient(rgb(0 0 0 / ${settings.readerBgDim}), rgb(0 0 0 / ${settings.readerBgDim})), url("${settings.readerBgImage}")`
      : 'none',
  } as CSSProperties

  // Pointer & Gesture interactions
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    // 只认主键。右键是"叫出上下文菜单"的手势，不是翻页：原来这里没判 button，
    // 右键点正文会一路走到 `paginateTapZone` / `scrollTapZone`，于是"右键 → 取消菜单"之后
    // 页面已经翻了一页 / 正文往上滚了一屏（用户 2026-10-04：「鼠标右键点击正文页面取消后正文莫名向上移动」）。
    if (event.button !== 0) return
    if (loading || activeDrawer || isInteractiveReaderTarget(event.target)) return
    pointerStartRef.current = { x: event.clientX, y: event.clientY, target: event.target }
  }

  /**
   * 点在一格里该干什么（用户 2026-10-04：「可以自定义点击区域范围并设置」）。
   * 格子表在 `settings.tapZones`，出厂那张与改动前逐字一致；这里只负责"动作 → 行为"。
   */
  const runTapAction = useCallback((action: TapAction) => {
    const paginate = settings.pageMode === 'paginate'
    if (action === 'previous') {
      if (paginate) {
        goPrevPage()
        return
      }
      if (isAtTopBoundary(window.scrollY)) changeChapter(chapterIndex - 1, 'last')
      else window.scrollBy({ top: -window.innerHeight * 0.85, behavior: 'smooth' })
      return
    }
    if (action === 'next') {
      if (paginate) {
        goNextPage()
        return
      }
      if (isAtBottomBoundary(window.scrollY, document.documentElement.scrollHeight, window.innerHeight)) changeChapter(chapterIndex + 1, 'first')
      else window.scrollBy({ top: window.innerHeight * 0.85, behavior: 'smooth' })
      return
    }
    if (action === 'toc' || action === 'settings') {
      setActiveDrawer(drawer => (drawer === action ? null : action))
      return
    }
    if (action === 'none') return
    setToolbarsVisible(visible => !visible)
  }, [chapterIndex, changeChapter, goNextPage, goPrevPage, settings.pageMode])

  /**
   * 正文区的视口矩形。
   *
   * 点击分区的范围必须按它算，不能按整窗 —— 目录固定在左侧时正文被 `margin-left` 挤到右边
   * （用户 2026-10-09：「如果我左侧打开了目录那么你这规定范围会不会有问题」），
   * 按整窗算的话"左边一列"有一半压在目录栏底下，点在正文左缘会算成别的区。
   */
  const readingRect = () => {
    const el = readerMainRef.current
    if (el) {
      const rect = el.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      }
    }
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
  }

  /**
   * 拖「目录 | 正文」那条边界改目录栏宽度（用户 2026-10-09：「我希望目录与正文边界能左右移动部分，
   * 但是不影响功能和界面展示」）。宽度存进设置；正文区与点击分区的范围都跟着 CSS 变量走。
   */
  const onSidebarResizeDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    resizingSidebarRef.current = true
    setResizingSidebar(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onSidebarResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizingSidebarRef.current) return
    const width = Math.round(Math.min(560, Math.max(220, event.clientX)))
    if (width !== settings.sidebarWidth) onSettingsChange({ ...settings, sidebarWidth: width })
  }
  const onSidebarResizeUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    resizingSidebarRef.current = false
    setResizingSidebar(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  /**
   * 编辑层要盖在**正文区**上，不能压住固定的目录栏（用户 2026-10-09：「不要影响目录显示」）。
   * 正文区左缘由布局决定（固定目录 / 拖出来的宽度），所以实测而不是猜。
   */
  const [readingLeft, setReadingLeft] = useState(0)
  useEffect(() => {
    if (!tapZoneEditing) return
    const measure = () => setReadingLeft(Math.round(readerMainRef.current?.getBoundingClientRect().left ?? 0))
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [tapZoneEditing, settings.sidebarPinned, settings.sidebarWidth])

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const start = pointerStartRef.current
    pointerStartRef.current = null
    if (event.button !== 0) return
    if (!start || loading || isInteractiveReaderTarget(event.target) || isInteractiveReaderTarget(start.target) || window.getSelection()?.toString()) return

    if (activeDrawer) {
      setActiveDrawer(null)
      return
    }

    if (settings.pageMode === 'paginate') {
      const swipe = swipeDirection(start.x, start.y, event.clientX, event.clientY)
      if (swipe === 'left') {
        goNextPage()
        return
      }
      if (swipe === 'right') {
        goPrevPage()
        return
      }
      if (isTapGesture(start.x, start.y, event.clientX, event.clientY)) {
        const rect = readingRect()
        runTapAction(zoneAt(settings.tapZones.paginate, event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height))
      }
    } else {
      if (isTapGesture(start.x, start.y, event.clientX, event.clientY)) {
        const rect = readingRect()
        runTapAction(zoneAt(settings.tapZones.scroll, event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height))
      }
    }
  }

  /**
   * 正文上的右键（用户 2026-10-04：「选定段落，右击功能你还没有添加」）。
   *
   * 上游在手机上是"长按选句 → 一条菜单"（复制/朗读/替换/站内搜索…），桌面这边对应物就是右键。
   * 第一条永远是**手上正选着的那几段** —— 人右键的时候多半刚选好，让他再去别处找那颗按钮，
   * 等于没有这个功能。
   */
  const onBodyContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    if (settings.pageMode === 'paginate' && activeDrawer) return
    const selectedText = (window.getSelection()?.toString() ?? '').trim()
    const items: ContextMenuItem[] = []
    if (selectedText) {
      const built = buildSelectionDraft()
      const cite = `${selectedText}\n—— 《${bookName}》${chapter?.title ? ` · ${convert(chapter.title)}` : ''}`
      items.push({
        label: '复制',
        icon: 'copy',
        onSelect: () => {
          void navigator.clipboard?.writeText(selectedText).then(
            () => toast.success('已复制'),
            () => toast.warning('浏览器没让复制，手动选一次再试'),
          )
        },
      })
      items.push({
        label: '复制为引用',
        icon: 'book',
        onSelect: () => {
          void navigator.clipboard?.writeText(cite).then(
            () => toast.success('已复制为引用'),
            () => toast.warning('浏览器没让复制，手动选一次再试'),
          )
        },
      })
      if (built) {
        const draft = built.draft
        items.push({
          label: '划线',
          icon: 'edit',
          onSelect: () => {
            void api.addNote({
              sourceId: currentBook.details.sourceId, bookUrl: currentBook.bookUrl, bookName,
              chapterUrl: draft.chapterUrl, chapterIndex: draft.chapterIndex,
              startOffset: draft.startOffset, endOffset: draft.endOffset, excerpt: draft.excerpt, note: '',
            }).then(
              created => { if (created) { setNotes(list => [...list, created]); toast.success('已划线') } },
              () => toast.warning('划线失败'),
            )
          },
        })
        items.push({
          label: '笔记',
          icon: 'file',
          onSelect: () => { setNoteDraft(draft); setNoteEditorOpen(true) },
        })
        items.push({
          label: '发给 AI',
          icon: 'sparkles',
          onSelect: () => { setSelectionFromDraft(built.selection); setAiChatOpen(true) },
        })
      }
    }
    items.push({ label: '章节目录', icon: 'list', onSelect: () => setActiveDrawer('toc') })
    showContextMenu(event, items)
  }

  const onWheelPaginate = (event: React.WheelEvent) => {
    if (settings.pageMode !== 'paginate' || activeDrawer) return
    const { action, rest } = paginateWheelStep(event.deltaX, event.deltaY, event.deltaMode, wheelAccumRef.current)
    if (action === null) {
      // 还没攒够一格：继续攒，但停手 500ms 就把零头丢掉，免得下次一上手被旧累计量带翻一页。
      // 这个窗口不能太紧：慢速轻扫（每下间隔接近一个 round-trip）也要能攒起来，
      // 实测 180ms 在"一下一下慢慢滚"的节奏下每下都被清零，等于又回到修前的"翻不动"。
      wheelAccumRef.current = rest
      if (wheelIdleRef.current !== null) window.clearTimeout(wheelIdleRef.current)
      wheelIdleRef.current = window.setTimeout(() => { wheelAccumRef.current = 0; wheelIdleRef.current = null }, 500)
      return
    }
    // 攒够了一格却撞上冷却：**不消费**，把这一格留在累计量里，冷却结束后的第一件事件立刻兑现。
    // 修前是"冷却期一到就整段 return"，连累计都不进 —— 快速轻扫时有整整一格行程被吞掉，
    // 表现还是"翻不动"，只是换了个成因。
    if (wheelTimerRef.current !== null) return
    if (wheelIdleRef.current !== null) { window.clearTimeout(wheelIdleRef.current); wheelIdleRef.current = null }
    wheelAccumRef.current = rest
    wheelTimerRef.current = window.setTimeout(() => { wheelTimerRef.current = null }, 140)
    if (action === 'next') goNextPage()
    else goPrevPage()
  }

  const cachePercent = Math.min(100, Math.round((cacheStatus.cached / Math.max(1, cacheStatus.total || currentBook.chapters.length)) * 100))

  /**
   * 工具栏按钮由 `settings.menuItems` 决定（显示与顺序都在设置抽屉的「工具栏」里配）。
   * 清单的唯一来源是 `readerMenu.ts`，别在这儿另起一套。
   */
  /**
   * 分页模式那条分栏流里的全部章节（窗口前面接进来的 + 锚点 + 后面续接的）。
   *
   * 抽成函数是为了让**覆盖动画那一层**能挂同一份内容（新页从一侧盖上来）——
   * 两处共用一份 JSX，避免"主轨道改了、覆盖层忘改"。
   * 垫栏的下标是"这一章在窗口里的绝对位置"：head 占 0..K-1、锚点 K、尾巴 K+1..。
   */
  const renderPaginatedSections = () => (
    <>
      {flowHead.map((item, headIndex) => (
        <Fragment key={item.chapter.url}>
          {headIndex > 0 && (pageFillers[headIndex - 1] ?? 0) > 0 && <div className="reader-column-filler" aria-hidden="true" />}
          <section className="reader-page-chapter" data-chapter-index={item.chapter.index}>
            <h1>{convert(item.chapter.title)}</h1>
            {splitBody(item.content).map((line, index) => renderContentBlock(line, index, item.chapter))}
          </section>
        </Fragment>
      ))}
      {flowHead.length > 0 && (pageFillers[flowHead.length - 1] ?? 0) > 0 && <div className="reader-column-filler" aria-hidden="true" />}
      <section className="reader-page-chapter" data-chapter-index={chapter?.index ?? 0}>
        <h1>{convert(shownChapterTitle ?? '')}</h1>
        {isStaleContent && <p className="reader-chapter-incoming" role="status">正在载入：{convert(incomingChapterTitle)}</p>}
        {loading && !content && <ReaderContentSkeleton />}
        {message && <p className="reader-error">{message}</p>}
        {mediaSrc ? <MediaBlock mediaSrc={mediaSrc} sourceType={sourceType} onEnded={() => { if (chapterIndex < currentBook.chapters.length - 1) changeChapter(chapterIndex + 1) }} /> : isMangaMode ? renderMangaContent() : paragraphs.map((line, index) => renderContentBlock(line, index))}
      </section>
      {flowTail.map((item, tailIndex) => (
        <Fragment key={item.chapter.url}>
          {(pageFillers[flowHead.length + tailIndex] ?? 0) > 0 && <div className="reader-column-filler" aria-hidden="true" />}
          <section className="reader-page-chapter" data-chapter-index={item.chapter.index}>
            <h1>{convert(item.chapter.title)}</h1>
            {splitBody(item.content).map((line, index) => renderContentBlock(line, index, item.chapter))}
          </section>
        </Fragment>
      ))}
    </>
  )

  return <main className={`reader-workspace ${themeClassNames(settings).join(' ')} ${toolbarsVisible ? 'toolbars-open' : 'toolbars-hidden'} ${settings.sidebarPinned ? 'sidebar-pinned' : ''} ${activeDrawer ? 'drawer-open' : ''}`} style={readerStyle}>
    {/* 顶栏：MD3 外壳（PROPOSAL-020）或旧浮动工具栏，由 uiV2 开关切换 */}
    {uiV2 ? <Md3TopBar
      bookName={bookName}
      chapterTitle={chapter?.title ? convert(chapter.title) : null}
      chapterIndex={chapterIndex}
      totalChapters={currentBook.chapters.length}
      menuItems={settings.menuItems}
      isFullscreen={isFullscreen}
      mediaDisabled={!!mediaSrc}
      ttsActive={ttsActive}
      ttsPlayState={ttsPlayState}
      onBack={() => { persist(); stopTts(); onClose() }}
      onToggleToc={() => {
        if (settings.sidebarPinned) {
          onSettingsChange({ ...settings, sidebarPinned: false })
          setActiveDrawer(null)
        } else if (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 960px)').matches) {
          // 桌面端：点目录直接把目录 dock 成左侧常驻侧栏（推出版心），而不是盖一层遮罩的抽屉 —— 更像桌面阅读器。
          // 移动端（<960px）仍走覆盖式抽屉；持久化默认值不变（仍是 false），所以门禁对默认值的断言不受影响。
          onSettingsChange({ ...settings, sidebarPinned: true })
          setActiveDrawer(null)
        } else {
          setActiveDrawer(d => d === 'toc' ? null : 'toc')
        }
      }}
      onPrevChapter={goPrevChapter}
      onNextChapter={goNextChapter}
      onOpenSourceSwitch={() => setShowSourceSwitch(true)}
      onToggleSettings={() => setActiveDrawer(d => d === 'settings' ? null : 'settings')}
      onToggleFullscreen={toggleFullscreen}
      onToggleTts={toggleTts}
      onResetTtsBar={resetTtsBarPosition}
      onBookSearch={() => setBookSearchOpen(true)}
      onToggleNotes={() => { setActiveDrawer('toc'); setNotesPanel(true) }}
      notesCount={notes.length}
    /> : <ReaderHeader
      bookName={bookName}
      chapterIndex={chapterIndex}
      totalChapters={currentBook.chapters.length}
      menuItems={settings.menuItems}
      isFullscreen={isFullscreen}
      mediaDisabled={!!mediaSrc}
      ttsActive={ttsActive}
      ttsPlayState={ttsPlayState}
      onBack={() => { persist(); stopTts(); onClose() }}
      onToggleToc={() => {
        if (settings.sidebarPinned) {
          onSettingsChange({ ...settings, sidebarPinned: false })
          setActiveDrawer(null)
        } else if (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 960px)').matches) {
          // 桌面端：点目录直接把目录 dock 成左侧常驻侧栏（推出版心），而不是盖一层遮罩的抽屉 —— 更像桌面阅读器。
          // 移动端（<960px）仍走覆盖式抽屉；持久化默认值不变（仍是 false），所以门禁对默认值的断言不受影响。
          onSettingsChange({ ...settings, sidebarPinned: true })
          setActiveDrawer(null)
        } else {
          setActiveDrawer(d => d === 'toc' ? null : 'toc')
        }
      }}
      onPrevChapter={goPrevChapter}
      onNextChapter={goNextChapter}
      onOpenSourceSwitch={() => setShowSourceSwitch(true)}
      onToggleSettings={() => setActiveDrawer(d => d === 'settings' ? null : 'settings')}
      onToggleFullscreen={toggleFullscreen}
      onToggleTts={toggleTts}
      onResetTtsBar={resetTtsBarPosition}
    />}

    {/* MD3 底栏：只剩窄屏那一排动作 pill（宽屏整条不渲染）。章节导航已在顶栏。 */}
    {uiV2 && <Md3BottomBar
      notesCount={notes.length}
      ttsActive={ttsActive}
      onToggleToc={() => setActiveDrawer(d => d === 'toc' ? null : 'toc')}
      onToggleNotes={() => { setActiveDrawer('toc'); setNotesPanel(true) }}
      onToggleTts={toggleTts}
      onToggleSettings={() => setActiveDrawer(d => d === 'settings' ? null : 'settings')}
      onBookSearch={() => setBookSearchOpen(true)}
    />}

    {/* TOC Drawer (Left) */}
    <aside className={`reader-drawer reader-drawer-left ${activeDrawer === 'toc' ? 'open' : ''} ${settings.sidebarPinned ? 'pinned' : ''}`} aria-label="目录抽屉">
      <TocDrawerHeader
        chapterTitle={chapter?.title ? convert(chapter.title) : null}
        chapterCount={currentBook.chapters.length}
        tocReverse={tocReverse}
        onToggleReverse={() => setTocReverse(value => !value)}
        sidebarPinned={settings.sidebarPinned}
        onTogglePin={() => onSettingsChange({ ...settings, sidebarPinned: !settings.sidebarPinned })}
        notesPanel={notesPanel}
        notesCount={notes.length}
        onToggleNotes={() => setNotesPanel(value => !value)}
        onOpenSourceSwitch={() => { setActiveDrawer(null); setShowSourceSwitch(true) }}
        onOpenRefresh={currentBook.details.sourceId === 'loc_book' ? undefined : () => setShowRefreshChapters(true)}
        inShelf={inShelf}
        onToggleShelf={() => void toggleShelf()}
        onClose={() => {
          if (settings.sidebarPinned) {
            onSettingsChange({ ...settings, sidebarPinned: false })
          }
          setActiveDrawer(null)
        }}
      />
      {notesPanel ? (
        /* 「笔记」面板（PROPOSAL-019 E）：这本书的全部划线 / 备注，点一条跳到那一章。
           导出需要书名与章名：书名从 currentBook 取，章名用 chapters 的标题表，
           缺章名时导出那边会退回「第 N 章」，不编造。 */
        <NotesPanel
          notes={notes}
          onJump={jumpToNote}
          meta={{
            bookName: currentBook.details.name,
            author: currentBook.details.author,
            sourceId: currentBook.details.sourceId,
          }}
          chapterTitles={Object.fromEntries(
            currentBook.chapters.map((chapter, index) => [index, chapter.title]),
          )}
        />
      ) : (
        <>
          <div className="chapter-search">
            <Icon name="search" />
            <input value={chapterQuery} onChange={event => setChapterQuery(event.target.value)} placeholder="搜索章节" />
          </div>
          <VirtualChapterList
            chapters={tocList}
            activeChapterIndex={chapterIndex}
            cachedUrlsSet={cachedChapterUrls}
            wordCounts={chapterWordCounts}
            onSelect={index => {
              changeChapter(index)
              if (!settings.sidebarPinned) {
                setActiveDrawer(null)
              }
            }}
            itemHeight={TOC_ROW_HEIGHT}
            overscan={8}
            convertTitle={convert}
            autoScrollKey={activeDrawer === 'toc' || settings.sidebarPinned ? 1 : 0}
          />
        </>
      )}
    </aside>

    {/* 目录 | 正文 那条边界：固定目录时可左右拖（用户 2026-10-09） */}
    {settings.sidebarPinned && (
      <div
        className={`reader-sidebar-resizer ${resizingSidebar ? 'is-dragging' : ''}`}
        style={{ left: `${settings.sidebarWidth}px` }}
        role="separator"
        aria-label="拖动调整目录栏宽度"
        onPointerDown={onSidebarResizeDown}
        onPointerMove={onSidebarResizeMove}
        onPointerUp={onSidebarResizeUp}
      />
    )}

    {/* 阅读设置：一颗齿轮 + 单个弹层，层内用「阅读 / 其它」标签页切换两批设置。
     *  （原来「界面」「设置」各占一颗齿轮、各一个弹层，用户反馈「现在有两个设置处理一下」。） */}
    {uiV2 ? <>
      <ReaderSheet open={activeDrawer === 'settings'} title="阅读设置" onClose={() => setActiveDrawer(null)}>
        <nav className="settings-tabs is-two" role="tablist" aria-label="设置分组">
          <button
            type="button"
            role="tab"
            aria-selected={settingsTab === 'reader'}
            className={`settings-tab${settingsTab === 'reader' ? ' selected' : ''}`}
            onClick={() => setSettingsTab('reader')}
          ><Icon name="columns" />阅读</button>
          <button
            type="button"
            role="tab"
            aria-selected={settingsTab === 'other'}
            className={`settings-tab${settingsTab === 'other' ? ' selected' : ''}`}
            onClick={() => setSettingsTab('other')}
          ><Icon name="sliders" />其它</button>
        </nav>
        {settingsTab === 'reader' ? (
          <ReaderSettingsControls settings={settings} onChange={onSettingsChange} />
        ) : (
          <OtherSettingsPanel
            settings={settings}
            onChange={onSettingsChange}
            onOpenReplaceRules={() => setShowReplaceRules(true)}
            onEditTapZones={() => { setActiveDrawer(null); setTapZoneEditing(true) }}
            localBook={currentBook.details.sourceId === 'loc_book' ? { name: bookName, tocRule: shelfTocRule } : null}
            tocRuleOptions={tocRuleOptions}
            onReparseLocal={currentBook.details.sourceId === 'loc_book' ? reparseLocalBook : undefined}
          />
        )}
      </ReaderSheet>
    </> : <aside className={`reader-drawer reader-drawer-right ${activeDrawer === 'settings' ? 'open' : ''}`} aria-label="阅读设置">
      <header className="drawer-header">
        <div className="drawer-title"><Icon name="settings" /><strong>阅读设置</strong></div>
        <IconButton label="关闭设置" icon="close" onClick={() => setActiveDrawer(null)} />
      </header>
      {/* 旧界面把「界面」三标签与「设置」那批都挂在这条抽屉里，功能不缺。 */}
      <ReaderSettingsControls settings={settings} onChange={onSettingsChange} />
      <OtherSettingsPanel
        settings={settings}
        onChange={onSettingsChange}
        onOpenReplaceRules={() => setShowReplaceRules(true)}
        onEditTapZones={() => { setActiveDrawer(null); setTapZoneEditing(true) }}
        localBook={currentBook.details.sourceId === 'loc_book' ? { name: bookName, tocRule: shelfTocRule } : null}
        tocRuleOptions={tocRuleOptions}
        onReparseLocal={currentBook.details.sourceId === 'loc_book' ? reparseLocalBook : undefined}
      />
    </aside>}

    {/* Backdrop for Drawers：目录抽屉两种界面都用；设置抽屉在 MD3 下改由弹层自带遮罩 */}
    {activeDrawer && (activeDrawer === 'toc' ? !settings.sidebarPinned : !uiV2) && (
      <div className="reader-drawer-backdrop" onClick={() => setActiveDrawer(null)} aria-hidden="true" />
    )}

    {/*
      「在正文上编辑点击区域」那层：盖在正文之上（正文仍渲染，看得见字），
      画横竖虚线分区、控制条收在底部一行。只编**当前翻页方式**那张表 —— 分页看竖线、滚动看横线。
    */}
    {tapZoneEditing && (
      <TapZoneEditor
        map={settings.pageMode === 'paginate' ? settings.tapZones.paginate : settings.tapZones.scroll}
        mode={settings.pageMode}
        left={readingLeft}
        onMap={map => onSettingsChange({
          ...settings,
          tapZones: settings.pageMode === 'paginate'
            ? { ...settings.tapZones, paginate: map }
            : { ...settings.tapZones, scroll: map },
        })}
        onMode={mode => onSettingsChange({ ...settings, pageMode: mode })}
        onPreset={(paginate, scroll) => onSettingsChange({ ...settings, tapZones: { paginate, scroll } })}
        onClose={() => setTapZoneEditing(false)}
      />
    )}

    {/* Central Reading Canvas */}
    <section ref={readerMainRef} className="reader-main" onMouseUp={onReaderMouseUp}>
      {settings.pageMode === 'paginate' ? (
        <div className="reader-paginated-wrap" onPointerDown={onPointerDown} onPointerUp={onPointerUp} onWheel={onWheelPaginate} onContextMenu={onBodyContextMenu}>
          <div ref={viewportRef} className={`reader-paginated-viewport ${isDoubleColumn ? 'is-double-column' : ''}${pageAnim === 'fade' && fading ? ' is-fading' : ''}`}>
            <div className={`reader-paginated-track${slideAnimOn ? ' is-anim-slide' : ''}`} style={{ transform: `translateX(-${pageIndex * stride}px)` }}>
              {/*
                分页模式也是一篇连续文档：一章一个 <section> 排在同一条分栏流里，
                翻页翻过章边界只是"下一页"，不是重挂一棵子树再回到章首。
                容器的 key 只在主动跳章/换书时换（续接推进不换），否则每跨一章白闪一次。
              */}
              <article ref={bodyRef} key={flowKey} className={`reader-paginated-column-body chapter-enter${isStaleContent ? ' is-stale' : ''}`} style={{ columnWidth: `${columnWidth}px`, columnGap: `${columnGap}px` }}>
                {renderPaginatedSections()}
              </article>
            </div>
            {/*
              覆盖动画（pageAnim === 'cover'）的进场层：新页从一侧盖上来，**旧页原地不动**。
              做法是再挂一份同样的分栏正文，把它平移到目标页、整体从视口外滑进来 ——
              与 `slide`（整条栏流滑过去、旧页跟着走）是两回事。动画结束就卸掉，
              平时不占 DOM；`reader-paginated-column-body` 与主轨道同款，测量只认主轨道的 `bodyRef`。
            */}
            {coverTurn && (
              <div
                className={`reader-page-cover is-from-${coverTurn.direction === 1 ? 'next' : 'prev'}${coverEntered ? ' is-entered' : ''}`}
                aria-hidden="true"
                onTransitionEnd={onCoverTransitionEnd}
              >
                <div className="reader-paginated-track" style={{ transform: `translateX(-${coverTurn.to * stride}px)` }}>
                  <div className="reader-paginated-column-body" style={{ columnWidth: `${columnWidth}px`, columnGap: `${columnGap}px` }}>
                    {renderPaginatedSections()}
                  </div>
                </div>
              </div>
            )}
          </div>
          <footer className="reader-paginated-footer">
            <span>{convert(paginatedFooterTitle || '')}</span>
            <div className="reader-paginated-pager">
              <button className="md3-icon-btn" type="button" aria-label="上一页" title="上一页" onClick={goPrevPage}><Icon name="arrowLeft" /></button>
              <span className="reader-paginated-pagecount">{pageIndex + 1} / {pageCount}</span>
              <button className="md3-icon-btn" type="button" aria-label="下一页" title="下一页" onClick={goNextPage}><Icon name="arrowRight" /></button>
            </div>
          </footer>
        </div>
      ) : (
        <article className={`reading-content chapter-enter${isStaleContent ? ' is-stale' : ''}`} key={flowKey} onPointerDown={onPointerDown} onPointerUp={onPointerUp} onContextMenu={onBodyContextMenu}>
          {/*
            滚动模式是一篇连续文档（用户 2026-10-02：「怎么能跳转呢，不是一体的吗」）：
            锚点章之后把后续章节续接在同一棵容器里，读完一章是"顶上来"，不是"跳过去"。
            每章一个 <section>，标题与正文成组；章与章之间是一条分隔线，不是"翻页"。
          */}
          <section ref={anchorSectionRef} className="reader-flow-chapter" data-chapter-index={chapter?.index ?? 0}>
            <h1>{convert(shownChapterTitle ?? '')}</h1>
            {isStaleContent && <p className="reader-chapter-incoming" role="status">正在载入：{convert(incomingChapterTitle)}</p>}
            {loading && !content && <ReaderContentSkeleton />}
            {message && <p className="reader-error">{message}</p>}
            {mediaSrc ? <MediaBlock mediaSrc={mediaSrc} sourceType={sourceType} onEnded={() => { if (chapterIndex < currentBook.chapters.length - 1) changeChapter(chapterIndex + 1) }} /> : isMangaMode ? renderMangaContent() : paragraphs.map((line, index) => renderContentBlock(line, index))}
          </section>
          {flowTail.map(item => (
            <section key={item.chapter.url} className="reader-flow-chapter reader-flow-tail" data-chapter-index={item.chapter.index}>
              <h1>{convert(item.chapter.title)}</h1>
              {splitBody(item.content).map((line, index) => renderContentBlock(line, index, item.chapter))}
            </section>
          ))}
          {!!content && !loading && loadedChapterUrl === chapter?.url && !!nextChapterTitle && flowTail.length === 0 && (
            <div className="reader-next-hint">
              <button type="button" onClick={() => changeChapter(chapterIndex + 1, 'first')}>
                <span>下一章 · {convert(nextChapterTitle)}</span>
                <Icon name="chevronDown" />
              </button>
              <small>这是最后一章之前唯一没有续接上的位置：滚到底再向下滑即进入</small>
            </div>
          )}
          {content && <footer className="reader-navigation"><button disabled={chapterIndex === 0 || loading} onClick={() => changeChapter(chapterIndex - 1)}><Icon name="arrowLeft" />上一章</button><div className="chapter-progress"><i style={{ width: `${chapterProgress}%` }} /><input className="chapter-scrub" type="range" min={0} max={Math.max(0, currentBook.chapters.length - 1)} step={1} value={shownChapterIndex} disabled={loading || currentBook.chapters.length < 2} aria-label={`章节进度：第 ${shownChapterIndex + 1} 章，共 ${currentBook.chapters.length} 章`} onChange={event => setScrubIndex(Number(event.target.value))} onPointerUp={() => { if (scrubIndex !== null && scrubIndex !== chapterIndex) changeChapter(scrubIndex); setScrubIndex(null) }} onKeyUp={() => { if (scrubIndex !== null && scrubIndex !== chapterIndex) changeChapter(scrubIndex); setScrubIndex(null) }} /><span>{shownChapterIndex + 1} / {currentBook.chapters.length}</span></div><button disabled={chapterIndex === currentBook.chapters.length - 1 || loading} onClick={() => changeChapter(chapterIndex + 1)}>下一章<Icon name="arrowRight" /></button></footer>}
        </article>
      )}
      {boundaryMessage && <p className="reader-boundary-message" role="status">{boundaryMessage}</p>}
    </section>

    {/* Floating Mobile Bottom Nav */}
    <nav className="mobile-reader-nav">
      <button onClick={() => setActiveDrawer('toc')}><Icon name="list" /><span>目录</span></button>
      <button onClick={() => setShowSourceSwitch(true)}><Icon name="sliders" /><span>换源</span></button>
      <button onClick={toggleTts} disabled={!!mediaSrc}><Icon name={ttsActive && ttsPlayState === 'playing' ? 'pause' : 'volume2'} /><span>{ttsActive ? (ttsPlayState === 'playing' ? '暂停' : '继续') : '朗读'}</span></button>
      <button onClick={() => setActiveDrawer('settings')}><span className="aa">Aa</span><span>设置</span></button>
      <button onClick={() => onSettingsChange({ ...settings, theme: settings.theme === 'dark' ? 'light' : 'dark' })}><Icon name="moon" /><span>夜读</span></button>
    </nav>

    {/* In-reader Source Switch Modal */}
    {showSourceSwitch && (
      <SourceSwitchModal
        bookName={bookName}
        author={currentBook.details.author}
        currentSourceId={currentBook.details.sourceId}
        currentBookUrl={currentBook.bookUrl}
        currentChapterTitle={chapter?.title}
        currentChapterIndex={chapterIndex}
        knownAlternateSources={currentBook.details.alternateSources}
        onSwitch={handleSwitchSource}
        onClose={() => setShowSourceSwitch(false)}
      />
    )}

    {/* TTS Floating Player Bar */}
    {ttsActive && (
      <TtsPlayerBar
        playState={ttsPlayState}
        currentParagraphIndex={activeParagraphIndex}
        totalParagraphs={ttsParagraphs.length}
        currentChunkIndex={currentChunkIndex}
        totalChunks={ttsData.chunks.length}
        activeSentenceText={activeSentenceText}
        sleepTimer={sleepTimer}
        remainingSeconds={remainingSeconds}
        onTogglePlay={toggleTts}
        onPrevChunk={handlePrevChunk}
        onNextChunk={handleNextChunk}
        onPrevChapter={handlePrevChapterTts}
        onNextChapter={handleNextChapterTts}
        onOpenSettings={() => setShowTtsSettings(true)}
        onClose={stopTts}
      />
    )}

    {/* TTS Settings Modal */}
    {showTtsSettings && (
      <TtsSettingsModal
        settings={settings}
        onChange={onSettingsChange}
        sleepTimer={sleepTimer}
        onSleepTimerChange={setSleepTimer}
        remainingSeconds={remainingSeconds}
        onClose={() => setShowTtsSettings(false)}
      />
    )}

    {/* Replace Rules Modal */}
    {showReplaceRules && (
      <ReplaceRulesModal
        isOpen={showReplaceRules}
        onClose={() => setShowReplaceRules(false)}
        currentBookName={bookName}
        currentSourceUrl={currentBook.details.sourceId}
        onRulesChanged={() => {
          if (chapter) {
            const requestedUrl = chapter.url
            setLoadedChapterUrl('')
            setContent('')
            setLoading(true)
            api.content(currentBook.details.sourceId, chapter.url, currentBook.bookUrl)
              .then(res => {
                // 用户可能已经翻到别的章节；这里无条件写入会用旧章正文覆盖新章，
                // 结果 loadedChapterUrl 与当前章不符 → 章节标题下永远空白。
                if (currentChapterUrlRef.current !== requestedUrl) return
                setContent(res.content)
                setLoadedChapterUrl(requestedUrl)
              })
              .catch(err => {
                if (currentChapterUrlRef.current !== requestedUrl) return
                setMessage(err.message || '加载章节内容失败')
              })
              .finally(() => {
                if (currentChapterUrlRef.current === requestedUrl) setLoading(false)
              })
          }
        }}
      />
    )}

    {/* Offline Cache Stats Modal */}
    {offlineStatsModal && (
      <OfflineCacheModal
        onClose={() => {
          setOfflineStatsModal(false)
          void syncCacheStatus()
        }}
      />
    )}

    {/* 手动刷新正文：单章或一批，绕过缓存回源重取 */}
    {showRefreshChapters && (
      <RefreshChaptersModal
        sourceId={currentBook.details.sourceId}
        bookUrl={currentBook.bookUrl}
        chapters={currentBook.chapters}
        currentIndex={chapterIndex}
        cachedUrls={cachedChapterUrls}
        onClose={() => setShowRefreshChapters(false)}
        onRefreshed={handleChaptersRefreshed}
      />
    )}

    {/* Offline TTS Fallback Confirmation Dialog */}
    {offlineTtsConfirmOpen && (
      <div className="overlay-backdrop" onClick={() => setOfflineTtsConfirmOpen(false)}>
        <div
          className="dialog-shell size-s"
          onClick={e => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label="离线语音提示"
        >
          <header className="dialog-head">
            <div className="source-login-title">
              <span><Icon name="volume2" /></span>
              <div>
                <h2>离线朗读提示</h2>
                <small>当前设备处于离线状态</small>
              </div>
            </div>
            <button type="button" className="overlay-close" onClick={() => setOfflineTtsConfirmOpen(false)} aria-label="关闭">
              <Icon name="close" />
            </button>
          </header>
          <div className="source-login-body">
            <p style={{ margin: '8px 0', fontSize: '14px', lineHeight: '1.6', color: 'var(--ink)' }}>
              当前未连接到互联网，云端 Edge-TTS 朗读不可用。是否切换使用设备本地自带的<strong>系统语音 (Web Speech)</strong> 进行脱机朗读？
            </p>
          </div>
          <footer className="source-login-footer">
            <button type="button" className="subtle-button" onClick={() => setOfflineTtsConfirmOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                setOfflineTtsConfirmOpen(false)
                onSettingsChange({ ...settings, ttsEngine: 'webSpeech' })
                setTtsActive(true)
                const startIdx = getInitialTtsChunkIndex()
                playTtsChunk(startIdx)
              }}
            >
              使用系统离线语音
            </button>
          </footer>
        </div>
      </div>
    )}
    {lightboxSrc && (
      <div className="overlay-backdrop is-viewer" onClick={() => setLightboxSrc(null)} role="dialog" aria-label="图片预览">
        <button type="button" className="reader-image-lightbox-close" aria-label="关闭预览" onClick={() => setLightboxSrc(null)}><Icon name="close" /></button>
        <img src={lightboxSrc} alt="" onClick={event => event.stopPropagation()} />
      </div>
    )}
    {bookSearchOpen && (
      <BookSearchDialog
        sourceId={currentBook.details.sourceId}
        bookUrl={currentBook.bookUrl}
        onJump={index => { if (index !== chapterIndex) changeChapter(index, 'first'); setBookSearchOpen(false) }}
        onClose={() => setBookSearchOpen(false)}
      />
    )}
    {/*
      选中正文后的浮层（PROPOSAL-019 E 笔记编辑器 + 标记快捷条）：
      先摆「标记快捷条」（划线 / 笔记 / 复制 / AI），点「笔记」才展开 NoteToolbar 编辑器。
      两者都挂在 `<section class="reader-main">` **之外**，自己的点击不该再触发 onReaderMouseUp。
    */}
    {noteDraft && !noteEditorOpen && (
      <MarkingMenu
        x={noteDraft.x}
        y={noteDraft.y}
        onHighlight={highlightFromMenu}
        onNote={openNoteEditor}
        onCopy={copySelection}
        onAi={sendSelectionToAi}
        onDismiss={dismissMarkingMenu}
      />
    )}
    {noteDraft && noteEditorOpen && (
      <NoteToolbar
        draft={noteDraft}
        onChangeText={text => setNoteDraft(current => (current ? { ...current, text } : current))}
        onSave={() => void saveNote()}
        onRemove={() => void removeNote()}
        onDismiss={clearSelection => { setNoteEditorOpen(false); setNoteDraft(null); setSelection(null); if (clearSelection) window.getSelection()?.removeAllRanges() }}
      />
    )}
  </main>
}
