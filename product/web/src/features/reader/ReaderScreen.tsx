// React 默认导入是正文要的：`React.ReactNode` / `React.TransitionEvent` / `React.WheelEvent`
// 这些类型引用挂在它身上。（AGENTS §5 那个 classic JSX 的同形坑：`VirtualChapterList` 被
// `renderToStaticMarkup` 静态渲染才需要默认 React 在作用域里 —— 那件组件已拆进
// `VirtualChapterList.tsx`，那条理由与它的默认导入一起搬过去了。）
import React, { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, BookDetails, BookNote, BookSearchHit, Chapter, SearchResult, TocRuleOption } from '../../lib/api'
import { getBrand } from '../../lib/brandStore'
import { ContextMenuItem, showContextMenu } from '../../components/ContextMenu'
import { Icon } from '../../icons'
import { contentImageUrl, findFirstFullyVisibleParagraphIndex, isAtBottomBoundary, isAtTopBoundary, isInteractiveReaderTarget, isSameSiteAsset, isTapGesture, paginateWheelStep, swipeDirection, ViewportBounds } from './interaction/readerInteractions'
import { readerImageSrc } from './content/readerImage'
import { TapAction, zoneAt } from './interaction/tapZones'
import { isMediaType } from '../../lib/bookType'
import { bookmarkPayload, findBookmarkAt } from './notes/bookmark'
import { splitByTerm } from './searchTerm'
import { setAiChatOpen } from '../../lib/aiChatStore'
import { performanceMonitor } from '../../lib/performance'
import { setSelection, setSelectionFromDraft } from '../../lib/selectionStore'
import { ReaderBody } from './ReaderBody'
import { reportProgress } from './content/readerProgress'
import { ReaderChrome } from './ReaderChrome'
import { ReaderOverlays } from './ReaderOverlays'
import { clampScrollPosition, effectiveReaderFontFamily, isBuiltinSkinHidden, readerBackgroundVars, ReaderSettings, resolveTheme, scrollPosition, themeClassNames, ttsSessionKey, TtsEngineType, BUILTIN_SKINS } from './settingsPanel/readerSettings'
import { stepFontSize } from './content/fontSizeControl'
import { ReaderMenuAction } from './interaction/readerMenu'
import { IDENTITY_CONVERTER, loadScriptConverter, type ScriptConverter } from './content/scriptConvert'
import { coverDirection, planNextPage, planPrevPage } from './interaction/pageTurn'
import { flowAdvance, holdScroll, pageProgress, pageWindowShift, prependLandingPage, sectionAtPage, sectionProgress } from './content/readerFlow'
import { findFirstIntersectingParagraphIndex } from './interaction/readerInteractions'
import { caretOffsetWithin, checksumText, offsetToParagraph, paragraphAnchor, textOffsetRect, type LogicalPosition } from './content/logicalPosition'
import { cleanAuthor, cleanTitle } from '../../lib/searchFilters'
import { toast } from '../../components/Toast'
import { useReaderCacheStatus } from './useReaderCacheStatus'
import { useReaderChapterContent } from './useReaderChapterContent'
import { useReaderPageTurn } from './useReaderPageTurn'
import { usePaginationMeasurement } from './usePaginationMeasurement'
import { useReadingLog } from './useReadingLog'
import { useReaderNotes } from './useReaderNotes'
import { TtsContext } from './tts/ReaderTtsContext'
import { useReaderTts } from './tts/useReaderTts'
import { ITtsEngine, WebSpeechEngine, HttpAudioTtsEngine, TtsSpeakMode, isPlayInterruptedError } from './tts/ttsEngine'
import { isTypingTarget, normalizeKey, READER_SHORTCUTS, shortcutFor } from './interaction/shortcuts'
import { warmContentImages } from './content/contentImages'
import { splitParagraphs } from './content/paragraphs'
import { CHUNK_SIZE, ensureLimit, growLimit, shouldChunk } from './content/chunkedRender'
import { mangaFraction, mangaIndexAtOffset, mangaNextStart, mangaPageLabel, mangaPages, mangaPrevStart, mangaSpreadPages, mangaSpreadSize, mangaSpreadStart } from './content/mangaPages'
import type { OpenBook } from '../../lib/openBook'
import {
  downloadChaptersToOffline,
} from '../../lib/offlineStorage'

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
  const [chapterIndex, setChapterIndex] = useState(startIndex)
  /** 同一个手法：判断"只能往前顶"要读当前的那一个，不能闭包里那个早就过期的数字。 */
  const chapterIndexRef = useRef(chapterIndex)
  chapterIndexRef.current = chapterIndex
  const [activeDrawer, setActiveDrawer] = useState<'toc' | 'settings' | 'other' | null>(null)
  /** 「在正文上编辑点击区域」那层开着没有（见 TapZoneEditor）。 */
  const [tapZoneEditing, setTapZoneEditing] = useState(false)
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

  // Pagination states
  const [pageIndex, setPageIndex] = useState(0)
  const columnGap = 40

  // 翻页动画（slide / fade / cover）整段收进 hook；这里只拿渲染要用的值。
  const {
    pageAnim,
    fading,
    slideAnimOn,
    coverTurn,
    setCoverTurn,
    coverEntered,
    onCoverTransitionEnd,
  } = useReaderPageTurn({
    pageMode: settings.pageMode,
    pageAnim: settings.pageAnim,
    pageIndex,
    setPageIndex,
  })

  const currentRef = useRef<{ chapter: Chapter; position: number } | null>(null)
  const timerRef = useRef<number | null>(null)
  const restoredRef = useRef(false)
  const wakeLockRef = useRef<WakeLockSentinel | null>(null)
  const lastScrollYRef = useRef(0)
  const pointerStartRef = useRef<{ x: number; y: number; target: EventTarget | null } | null>(null)
  const boundaryTimerRef = useRef<number | null>(null)
  const targetInitialPageRef = useRef<'first' | 'last' | null>(null)
  const initialPagePositionRef = useRef<number | null>(null)
  /** 首屏要恢复的语义位置；与 fraction 同时准备，语义位置校验通过时优先。 */
  const initialLogicalPositionRef = useRef<(LogicalPosition & { chapterIndex: number }) | null>(null)
  /** 从笔记面板跳过来、还在等正文加载的那一条（跨章跳转用）。 */
  const pendingNoteJumpRef = useRef<(LogicalPosition & { chapterIndex: number }) | null>(null)
  const wheelTimerRef = useRef<number | null>(null)
  // 滚轮增量累计量（像素）与"没在滚了就清零"的定时器：见 readerInteractions.paginateWheelStep
  const wheelAccumRef = useRef(0)
  const wheelIdleRef = useRef<number | null>(null)

  const viewportRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  /** 正文区（.reader-main）：点击分区按它的矩形算，不按整窗算。 */
  const readerMainRef = useRef<HTMLElement | null>(null)

  const chapter = currentBook.chapters[chapterIndex]
  // 异步回调里判断「这一章还是不是当前章」必须用 ref：闭包捕获的 chapter 是发起请求那一刻的。
  const currentChapterUrlRef = useRef('')
  currentChapterUrlRef.current = chapter?.url ?? ''
  // AI 闭环：记住「本章原始正文」（AI 覆盖应用之前的那一版），用于「撤销」回滚。
  // 只在正常加载正文时写入；AI 覆盖走 setContent 直接改，不会污染这里。
  const chapterBaseContentRef = useRef('')
  const bookName = currentBook.details.name || '书籍正文'

  // 离线缓存状态（书架记录 + 本地 IndexedDB）整段收进 hook，阅读器只消费它的返回值。
  const {
    cacheStatus,
    setCacheStatus,
    cachedChapterUrls,
    setCachedChapterUrls,
    chapterWordCounts,
    setChapterWordCounts,
    inShelf,
    setInShelf,
    shelfTocRule,
    setShelfTocRule,
    syncCacheStatus,
  } = useReaderCacheStatus({
    bookName,
    sourceId: currentBook.details.sourceId,
    bookUrl: currentBook.bookUrl,
    chapterCount: currentBook.chapters.length,
  })

  /**
   * 正文落地后的簿记：字数、缓存标记、图片预热、首屏定位。
   *
   * 状态与请求本身在 `useReaderChapterContent` 里；这里只保留"阅读器才知道"的那几件事
   * （续接推进标记、首屏恢复锚点、当前章 ref）。回调放在 hook 的 ref 里，所以它每次渲染
   * 换身份不会让加载 effect 重跑。
   */
  const handleChapterLoaded = useCallback((nextContent: string, _nextMediaUrl: string | null, loadedChapter: Chapter) => {
    chapterBaseContentRef.current = nextContent
    // 「当获取到内容的时候」就把这一章的字数记进表里：服务端这一刻同时把正文写进了缓存
    // （ReadingRoutes 的 cacheBookContent），但界面不该等下一轮同步才显示出眼前这一章的字数。
    if (nextContent.length > 0) {
      setChapterWordCounts(prev => {
        if (prev.get(loadedChapter.url) === nextContent.length) return prev
        const nextMap = new Map(prev)
        nextMap.set(loadedChapter.url, nextContent.length)
        return nextMap
      })
      // 同一刻这一章在服务端已经落库，云朵该立刻熄掉。缓存标记的轮询只在 `state==='caching'`
      // 时才跑，平时读到的新章不会有人再来拉 —— "读着读着云还挂着"就是这条断链。
      setCachedChapterUrls(prev => (prev.has(loadedChapter.url) ? prev : new Set(prev).add(loadedChapter.url)))
    }
    // 漫画/图文章节：趁用户看首屏，把正文里的图片提前喂给服务端代理取回落盘缓存。
    warmContentImages(nextContent, loadedChapter.url, currentBook.details.sourceId)
    // 续接推进时 position 给 null：下面那个定位 effect 见到 null 就直接返回，
    // 于是"跨章"不再伴随任何 scrollTo —— 这正是"不是一体的吗"要的答案。
    const advancing = flowAdvanceRef.current
    flowAdvanceRef.current = false
    const position = advancing ? null
      : (!restoredRef.current && loadedChapter.index === startIndex ? currentBook.progress?.scrollPosition ?? 0 : 0)
    const saved = currentBook.progress
    initialLogicalPositionRef.current = !advancing && !restoredRef.current && loadedChapter.index === startIndex
      && saved?.charOffset != null && !!saved.positionChecksum
      ? {
          chapterIndex: loadedChapter.index,
          charOffset: saved.charOffset,
          paragraphAnchor: saved.paragraphAnchor ?? '',
          positionChecksum: saved.positionChecksum,
        }
      : null
    restoredRef.current = true
    currentRef.current = { chapter: loadedChapter, position: position ?? 0 }
    initialPagePositionRef.current = position
  }, [currentBook.details.sourceId, currentBook.progress, setCachedChapterUrls, setChapterWordCounts, startIndex])

  const {
    content,
    setContent,
    mediaUrl,
    setMediaUrl,
    loadedChapterUrl,
    setLoadedChapterUrl,
    message,
    setMessage,
    loading,
    setLoading,
    preloadedContentRef,
    preloadingRef,
    preloadNextChapter,
    preloadPrevChapter,
    clearPreload,
  } = useReaderChapterContent({
    chapter,
    chapters: currentBook.chapters,
    sourceId: currentBook.details.sourceId,
    bookUrl: currentBook.bookUrl,
    startIndex,
    progress: currentBook.progress,
    onLoaded: handleChapterLoaded,
  })

  // 阅读记录：停留计时与 30 秒分段上报收进 hook。
  useReadingLog({
    sourceId: currentBook.details.sourceId,
    bookUrl: currentBook.bookUrl,
    bookName: currentBook.details.name,
    chapterIndex,
  })

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

  /**
   * 净化规则改完后重取当前章：用户可能已经翻到别的章节，这里无条件写入会用旧章正文覆盖新章，
   * 结果 `loadedChapterUrl` 与当前章不符 → 章节标题下永远空白。所以每次回写都先对一次 URL。
   */
  const handleReplaceRulesChanged = useCallback(() => {
    if (!chapter) return
    const requestedUrl = chapter.url
    setLoadedChapterUrl('')
    setContent('')
    setLoading(true)
    api.content(currentBook.details.sourceId, chapter.url, currentBook.bookUrl)
      .then(res => {
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
  }, [chapter, currentBook.bookUrl, currentBook.details.sourceId, setContent, setLoadedChapterUrl, setLoading, setMessage])

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
   * 超大章节分块渲染：普通章节不受影响（阈值 400 段）。
   * 分页模式不参与 —— 它要把整章量成列，缺段就量不出总页数。
   */
  const chunked = shouldChunk(settings.pageMode, paragraphs.length)
  const [renderLimit, setRenderLimit] = useState(CHUNK_SIZE)
  const chunkSentinelRef = useRef<HTMLDivElement | null>(null)
  const shownParagraphs = chunked ? paragraphs.slice(0, renderLimit) : paragraphs
  /** 换章 / 换正文就回到第一块：分块状态不能跨章带走。 */
  useEffect(() => { setRenderLimit(CHUNK_SIZE) }, [content, chapter?.index])
  /** 要把某一段挂出来（跳笔记 / 搜索命中 / 朗读跟读）：按块对齐地补，不多挂。 */
  const revealParagraph = useCallback((index: number) => {
    setRenderLimit(limit => ensureLimit(limit, index, paragraphs.length))
  }, [paragraphs.length])
  /** 滚到这一块末尾就自动补下一块；IntersectionObserver 不可用时下面的按钮也能补。 */
  useEffect(() => {
    if (!chunked || renderLimit >= paragraphs.length) return
    const node = chunkSentinelRef.current
    if (!node || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setRenderLimit(limit => growLimit(limit, paragraphs.length))
    }, { rootMargin: '800px 0px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [chunked, renderLimit, paragraphs.length])

  /**
   * 漫画阅读模式。
   *
   * 漫画源（`bookSourceType === 2`）的一章正文就是一串 `![图片](地址)` 占位行。默认把它们
   * 一屏一张地铺开、按图翻页：长图不会被文本分页从中间切开，跨页衔接也更接近漫画阅读器。
   * 关掉（`settings.mangaSinglePage === false`）就退回普通图文混排。
   *
   * 宽屏可以双页对开（`mangaSpread`），顺序按 `mangaDirection` 决定前一张在左还是在右；
   * 窄屏一律单页 —— 两张并排各自不到 300px，不如一张大图。
   */
  const mangaPageList = useMemo(() => mangaPages(paragraphs), [paragraphs])
  const mangaImages = useMemo(() => mangaPageList.map(page => page.url), [mangaPageList])
  const isMangaMode = currentBook.details.sourceType === 2 && settings.mangaSinglePage && mangaImages.length > 0
  const [mangaIndex, setMangaIndex] = useState(0)
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === 'undefined' ? 0 : window.innerWidth))
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const mangaSpread = mangaSpreadSize(settings.mangaSpread, viewportWidth)
  /** 双页时把页号吸到这一屏的第一张：翻到第 3 张也要从第 2 张开始配对，跨屏不串页。 */
  const mangaStart = mangaSpreadStart(Math.min(mangaIndex, Math.max(0, mangaImages.length - 1)), mangaSpread)
  /** `readLogicalPosition` 是长期闭包：当前屏经 ref 取，免得把 persist 的依赖搅乱。 */
  const mangaRef = useRef({ start: 0, pages: mangaPageList })
  mangaRef.current = { start: mangaStart, pages: mangaPageList }
  /** 换章后落在哪一屏：`last` = 往回翻跨章落到末屏，`first` = 从章首开始。 */
  const mangaTargetRef = useRef<'first' | 'last' | null>(null)
  /** 已经按存档恢复过的章地址：同一章正文刷新（重取）不再跳回第一张。 */
  const mangaRestoredRef = useRef('')
  // 预取下一屏：翻页时直接命中服务端 7 天缓存，不等网络。
  useEffect(() => {
    if (!isMangaMode) return
    const upcoming = mangaImages.slice(mangaStart + mangaSpread, mangaStart + mangaSpread * 2)
    for (const next of upcoming) {
      const image = new Image()
      image.decoding = 'async'
      image.src = readerImageSrc(next, chapter?.url, imageGeneration[next] ?? 0, currentBook.details.sourceId)
    }
  }, [isMangaMode, mangaStart, mangaSpread, mangaImages, chapter?.url, imageGeneration, currentBook.details.sourceId])

  // 笔记 / 划线的状态与增删改在 useReaderNotes 里；本组件只保留与渲染/导航相关的划线高亮与跳转。
  // （加载、重锚 effect 与 buildSelectionDraft / save / remove / openNote 等已搬进 hook）
  /** 每一段在**本章原文**里的起始字符偏移（段与段之间按一个换行算）。 */
  const paragraphStarts = useMemo(() => {
    if (!content) return [] as number[]
    const starts: number[] = []
    let running = 0
    for (const line of splitParagraphs(content)) { starts.push(running); running += line.length + 1 }
    return starts
  }, [content])
  /**
   * 校验值只回答"这一章的内容还是不是保存时那一份"。
   * 简繁模式也计入：切换字形后同一 charOffset 指向的字会变，宁可退回 scrollPosition。
   * 不把换算后的正文拼进来——词表是异步加载的，等它到位会把首屏恢复拖到第二帧。
   */
  const positionChecksum = useMemo(
    () => (content ? checksumText(`${settings.scriptMode}\n${splitParagraphs(content).join('\n')}`) : ''),
    [content, settings.scriptMode],
  )
  // persist / 首屏恢复都是长期闭包：经 ref 读当前章的段起点与校验值，避免把 persist 的依赖搅乱。
  const logicalMetaRef = useRef({ starts: paragraphStarts, checksum: positionChecksum })
  logicalMetaRef.current = { starts: paragraphStarts, checksum: positionChecksum }

  // 笔记状态与增删改收进 hook；toggleBookmark 与 renderNoteHighlights/jumpToNote 仍在本组件
  // （前者依赖 readLogicalPosition，后者依赖正文渲染路径与导航原语），通过 notesApi 复用状态。
  const notesApi = useReaderNotes({ currentBook, bookName, chapter, content, paragraphStarts, positionChecksum, chapterIndex })

  // 分页测量：DOM 排成几栏、每章占哪几页、页码落在哪，全在 hook 里；这里只消费结果。
  const {
    pageCount,
    pageFillers,
    columnWidth,
    stride,
    isDoubleColumn,
    measurePagination,
    pageSpansRef,
    measuredStartsRef,
    columnsPerPageRef,
    pageAlignedRef,
    pendingPageRef,
  } = usePaginationMeasurement({
    viewportRef,
    bodyRef,
    loading,
    content,
    columnMode: settings.columnMode,
    columnGap,
    setPageIndex,
    targetInitialPageRef,
    initialPagePositionRef,
    initialLogicalPositionRef,
    logicalMetaRef,
  })
  /**
   * 漫画换章后的落点：往回翻跨章要落在**上一章末屏**（原来一律回到第一张，等于白翻）；
   * 正常进入这一章则按存档的字符偏移换回页号，读到哪里就从哪里继续。
   * 只在"这一章第一次挂上图片"时做一次 —— 同一章重取正文不动当前页。
   */
  useEffect(() => {
    if (!isMangaMode) {
      setMangaIndex(0)
      mangaRestoredRef.current = ''
      return
    }
    const url = chapter?.url ?? ''
    if (mangaRestoredRef.current === url || !mangaImages.length) return
    mangaRestoredRef.current = url
    const target = mangaTargetRef.current
    mangaTargetRef.current = null
    if (target === 'last') { setMangaIndex(mangaImages.length - 1); return }
    if (target === 'first') { setMangaIndex(0); return }
    const saved = currentBook.progress
    if (saved && saved.chapterIndex === chapter?.index && saved.charOffset != null) {
      setMangaIndex(mangaIndexAtOffset(paragraphStarts, mangaPageList, saved.charOffset))
      return
    }
    setMangaIndex(0)
  }, [chapter?.url, chapter?.index, isMangaMode, mangaImages.length, mangaPageList, paragraphStarts, currentBook.progress])
  /** 本书正文检索弹窗（搜索本书 feature，只在已缓存章节正文里找）。 */
  const [bookSearchOpen, setBookSearchOpen] = useState(false)
  /** 刚跳过来的搜索命中：在正文里临时高亮几秒，过期自动清掉（见下面的 effect）。 */
  const [searchFlash, setSearchFlash] = useState<{ chapterIndex: number; offset: number; term: string } | null>(null)
  /** 阅读设置弹层里的顶层标签页：阅读（排版/颜色/行为）或其它（简繁/点击区域/工具栏/本地书目录/净化）。
   *  用户要求「两颗齿轮合并成一颗，点开用标签页切换界面/其它」。 */
  const [settingsTab, setSettingsTab] = useState<'reader' | 'other'>('reader')

  /**
   * 书签：把当前读到的那一段记下来，再点一次取消。
   *
   * 位置用 `readLogicalPosition` 取（与保存进度同一套算法：翻页取视口第一段、滚动取第一段相交），
   * 所以两种翻页模式都落在用户正看的地方。只标位置、不要求选中正文 —— 那是书签与划线的边界，
   * 写在 `product/docs/待定功能.md` 里。同一段落只留一条，判重在 `findBookmarkAt`。
   */
  const toggleBookmark = async () => {
    if (!chapter) return
    const position = readLogicalPosition(chapter)
    if (!position) { toast.warning('这一章还没排版好，稍等一下再试'); return }
    const existing = findBookmarkAt(notesApi.notes, chapter.index, position.paragraphAnchor, position.charOffset)
    if (existing) {
      const ok = await api.deleteNote(existing.id).then(() => true).catch(() => false)
      if (!ok) { toast.warning('书签没能取消'); return }
      notesApi.setNotes(list => list.filter(item => item.id !== existing.id))
      toast.success('已取消书签')
      return
    }
    const payload = bookmarkPayload({
      sourceId: currentBook.details.sourceId,
      bookUrl: currentBook.bookUrl,
      bookName,
      chapterIndex: chapter.index,
      chapterUrl: chapter.url,
      charOffset: position.charOffset,
      paragraphAnchor: position.paragraphAnchor,
      positionChecksum: position.positionChecksum,
      text: content.slice(position.charOffset, position.charOffset + 60),
    })
    if (!payload) { toast.warning('这一章还没有正文，等它加载完再试'); return }
    const created = await api.addNote(payload).catch(() => null)
    if (!created) { toast.warning('书签没能保存'); return }
    notesApi.setNotes(list => [...list, created])
    toast.success('已加书签')
  }

  // 标记快捷条动作（划线 / 笔记 / 复制 / 发 AI / 关闭）与 openNote 已搬进 useReaderNotes；
  // 下方 ReaderOverlays / ReaderChrome 接线改用 notesApi.*。

  /**
   * 从「笔记」面板跳到那一条所在的章，并滚到它的位置。
   *
   * 以前只切章、停在章首 —— 划线还能靠高亮认出来，书签只有一条摘要，等于"跳了但没到"。
   * 跨章时正文是异步加载的，所以把目标位置挂到 ref 上，等内容挂进 DOM 再滚（见下面的 effect）。
   */
  const jumpToNote = (note: BookNote) => {
    const target = {
      chapterIndex: note.chapterIndex,
      charOffset: note.startOffset,
      paragraphAnchor: note.paragraphAnchor ?? '',
      positionChecksum: note.positionChecksum ?? '',
    }
    const index = currentBook.chapters.findIndex(item => item.url === note.chapterUrl)
    notesApi.setNotesPanel(false)
    setActiveDrawer(null)
    if (index >= 0 && index !== chapterIndex) {
      pendingNoteJumpRef.current = target
      changeChapter(index, 'first')
      return
    }
    jumpToNotePosition(target)
  }

  /**
   * 跳到搜索命中处：切章、滚到那一段、把关键词临时高亮几秒。
   *
   * 以前只给章号，跳过去还得自己找（STATUS 的已知缺口原话）。现在后端回了命中偏移，
   * 落点复用笔记跳转那套（滚动滚视口、分页换页码），高亮只画在命中那一段上。
   */
  const jumpToSearchHit = (hit: BookSearchHit, term: string) => {
    setBookSearchOpen(false)
    setSearchFlash({ chapterIndex: hit.chapterIndex, offset: hit.offset, term })
    const target = { chapterIndex: hit.chapterIndex, charOffset: hit.offset, paragraphAnchor: '', positionChecksum: '' }
    const index = currentBook.chapters.findIndex(item => item.url === hit.chapterUrl)
    if (index >= 0 && index !== chapterIndex) {
      pendingNoteJumpRef.current = target
      changeChapter(index, 'first')
      return
    }
    jumpToNotePosition(target)
  }

  /**
   * 这一段里落着的笔记高亮。按 `excerpt` 在这段文字里定位 ——
   * 简繁转换只换字形不换词，转换后仍然找得到；找不到（原文被源站改过）就安静跳过。
   */
  const renderNoteHighlights = (text: string, ownerIndex: number) => {
    // 书签不画高亮：它只标位置，正文上留一条彩色底纹反而像"这段被划了重点"。
    const chapterNotes = notesApi.notes.filter(note => !note.bookmark && note.chapterIndex === ownerIndex && note.excerpt && text.includes(note.excerpt))
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
          onClick={event => { event.stopPropagation(); notesApi.openNote(mark.note, event.clientX, event.clientY) }}
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

  /**
   * 从当前视口读一个逻辑位置。
   *
   * 只认**锚点章自己的 section**：滚动模式的 flowHead/flowTail 也带 `data-chapter-index`，
   * 全局查会把上一章/下一章的段号混进来。取"第一段相交"而不是"第一段完整可见"——
   * 页首常有一段只露下半截，跳过它会让下次恢复往前跳一段。
   *
   * 简繁打开时段内偏移不做：词表可能让同一段少/多几个 UTF-16 码元，段首仍然稳定，
   * 段内偏移反而不稳；这条只在默认"原文"模式追求行级精度。
   */
  const readLogicalPosition = useCallback((targetChapter: Chapter): LogicalPosition | null => {
    const meta = logicalMetaRef.current
    if (!meta.starts.length || !meta.checksum) return null
    /*
      漫画模式没有 `[data-paragraph-index]`（一屏是图片，不是段落），DOM 量不出位置。
      但每一页都知道自己是正文里的第几段，于是页号可以换成一个稳定的字符偏移 ——
      与文本位置共用同一套进度模型，关掉再开就回到同一张。
    */
    if (isMangaMode) {
      const page = mangaRef.current.pages[mangaRef.current.start]
      if (!page) return null
      return {
        charOffset: meta.starts[page.paragraph] ?? 0,
        paragraphAnchor: paragraphAnchor(page.paragraph),
        positionChecksum: meta.checksum,
      }
    }
    const scope = settings.pageMode === 'paginate'
      ? bodyRef.current
      : document.querySelector<HTMLElement>('.reading-content')
    const section = scope?.querySelector<HTMLElement>(`[data-chapter-index="${targetChapter.index}"]`)
    if (!section) return null
    const els = Array.from(section.querySelectorAll<HTMLElement>('[data-paragraph-index]'))
    if (!els.length) return null
    const viewport = settings.pageMode === 'paginate'
      ? viewportRef.current?.getBoundingClientRect()
      : { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth }
    if (!viewport) return null
    const rects = els.map(el => {
      const r = el.getBoundingClientRect()
      return {
        index: Number(el.dataset.paragraphIndex ?? 0),
        rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
      }
    })
    const index = findFirstIntersectingParagraphIndex(rects, viewport)
    const target = els.find(el => Number(el.dataset.paragraphIndex ?? 0) === index) ?? els[0]
    const r = target.getBoundingClientRect()
    const within = settings.scriptMode === 'off'
      ? caretOffsetWithin(target, Math.max(r.left, viewport.left) + 2, Math.max(r.top, viewport.top) + 2) ?? 0
      : 0
    return {
      charOffset: (meta.starts[index] ?? 0) + within,
      paragraphAnchor: paragraphAnchor(index),
      positionChecksum: meta.checksum,
    }
  }, [settings.pageMode, settings.scriptMode, isMangaMode])

  /** 把逻辑位置滚回视口。返回 false 表示 DOM 里找不到这一章/这一段，交给 fraction 兜底。 */
  const scrollToLogicalPosition = useCallback((position: LogicalPosition & { chapterIndex: number }): boolean => {
    const meta = logicalMetaRef.current
    if (!meta.starts.length) return false
    const scope = document.querySelector<HTMLElement>('.reading-content')
    const section = scope?.querySelector<HTMLElement>(`[data-chapter-index="${position.chapterIndex}"]`)
    if (!section) return false
    const els = Array.from(section.querySelectorAll<HTMLElement>('[data-paragraph-index]'))
    if (!els.length) return false
    const { index, within } = offsetToParagraph(meta.starts, position.charOffset)
    let target = els.find(el => Number(el.dataset.paragraphIndex ?? 0) === index)
    if (!target) {
      // 图片段没有 data-paragraph-index：退到它前面最近的一段文字；再不行就这一段的第一段。
      const before = els.filter(el => Number(el.dataset.paragraphIndex ?? 0) <= index)
      target = before[before.length - 1] ?? els[0]
    }
    const rect = textOffsetRect(target, within) ?? target.getBoundingClientRect()
    const top = Math.max(0, rect.top + window.scrollY - 8)
    lastScrollYRef.current = top
    window.scrollTo({ top, behavior: 'auto' })
    return true
  }, [])

  /**
   * 跳到某一条笔记 / 书签的位置：滚动模式滚视口，分页模式换页码。
   * 分页下的换算与朗读跟读（`activeParagraphIndex` 那条 effect）用同一套矩形差 ——
   * `offsetLeft` 与 `rect.left` 混着量会稳定偏一整页。
   */
  const jumpToNotePosition = useCallback((position: LogicalPosition & { chapterIndex: number }): boolean => {
    if (settings.pageMode !== 'paginate') {
      /*
        分块章节里目标段可能还没挂出来：先补块，把落点交给 pending 的 effect，
        等这一轮渲染完再滚（直接滚会找不到那一段，然后悄悄退化成章首）。
      */
      if (chunked && logicalMetaRef.current.starts.length) {
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
    if (!meta.starts.length || !body || stride <= 0) return false
    const section = body.querySelector<HTMLElement>(`.reader-page-chapter[data-chapter-index="${position.chapterIndex}"]`)
    const els = section ? Array.from(section.querySelectorAll<HTMLElement>('[data-paragraph-index]')) : []
    if (!els.length) return false
    const { index, within } = offsetToParagraph(meta.starts, position.charOffset)
    const target = els.find(el => Number(el.dataset.paragraphIndex ?? 0) === index) ?? els[0]
    const rect = textOffsetRect(target, within) ?? target.getBoundingClientRect()
    const offset = rect.left - body.getBoundingClientRect().left
    setPageIndex(Math.min(pageCount - 1, Math.max(0, Math.round(offset / stride))))
    return true
  }, [scrollToLogicalPosition, settings.pageMode, stride, pageCount, chunked, renderLimit, revealParagraph])

  /** 跨章跳转的落点：正文挂进 DOM 之后才能滚，所以挂在 ref 上等这一条 effect。 */
  useEffect(() => {
    const pending = pendingNoteJumpRef.current
    if (!pending || loading || !content || !chapter) return
    if (chapter.index !== pending.chapterIndex) return
    if (jumpToNotePosition(pending)) pendingNoteJumpRef.current = null
  }, [content, loading, chapter, jumpToNotePosition])

  /** 搜索高亮是临时的：6 秒后自己消失，不留在正文里（它不是笔记，不该被当成标记）。 */
  useEffect(() => {
    if (!searchFlash) return
    const handle = window.setTimeout(() => setSearchFlash(null), 6000)
    return () => window.clearTimeout(handle)
  }, [searchFlash])

  const persist = useCallback(() => {
    const current = currentRef.current
    if (!current) return
    const logical = readLogicalPosition(current.chapter)
    void api.saveProgress(
      currentBook.details.sourceId,
      currentBook.bookUrl,
      current.chapter.url,
      current.chapter.index,
      clampScrollPosition(current.position),
      logical ?? undefined,
    ).catch(() => undefined)
  }, [currentBook.bookUrl, currentBook.details.sourceId, readLogicalPosition])

  // 切章的 ref：ReaderTtsManager 里的 playTtsChunk 要跨章续播，而 changeChapter 又要 stopTts —— 环用 ref 打破
  const changeChapterRef = useRef<(rawIndex: number) => void>(() => undefined)
  /**
   * 朗读状态由**阅读器自己**持有（2026-11-06 修）。
   *
   * 原来这里是 `useTts()`：它要一个 `TtsContext.Provider`，而唯一的 Provider 在
   * `<ReaderTtsManager>` 里 —— 那是本组件的子节点。父组件读不到子组件提供的 Context，
   * 于是每开一本书都抛 `useTts 必须在 <ReaderTtsManager> 内部使用`，被 ErrorBoundary
   * 收成"阅读器崩了"（11-04 拆分 TTS 时引入，11-06 冒烟测试抓出）。
   *
   * 现在 hook 在这一层调用一次，Provider 由这一层往下发；`ReaderTtsManager` 退化成消费者。
   */
  const ttsCtx = useReaderTts({
    chapter,
    chapterIndex,
    chapterCount: currentBook.chapters.length,
    paragraphs,
    isCurrentChapterLoaded,
    convert,
    mediaSrc,
    content,
    viewportRef,
    settings,
    persist,
    preloadNextChapter,
    changeChapterRef,
  })
  const {
    ttsActive, setTtsActive, ttsPlayState, setTtsPlayState, currentChunkIndex, setCurrentChunkIndex,
    sleepTimer, setSleepTimer, showTtsSettings, setShowTtsSettings,
    offlineTtsConfirmOpen, setOfflineTtsConfirmOpen,
    ttsParagraphs, ttsData, currentChunk, activeParagraphIndex, activeSentenceText,
    getTtsEngine, stopAllEngines, stopTts, pauseTts, resumeTts, playTtsChunk, playTtsChunkRef,
    getInitialTtsChunkIndex, toggleTts, handlePrevChunk, handleNextChunk,
    handlePrevChapterTts, handleNextChapterTts, autoPlayNextChapterRef,
  } = ttsCtx

  /** 离线确认框里的「改用系统语音」：关框、切引擎、立刻从当前分片读起。 */
  const handleUseWebSpeech = useCallback(() => {
    setOfflineTtsConfirmOpen(false)
    onSettingsChange({ ...settings, ttsEngine: 'webSpeech' })
    setTtsActive(true)
    playTtsChunk(getInitialTtsChunkIndex())
  }, [getInitialTtsChunkIndex, onSettingsChange, playTtsChunk, setOfflineTtsConfirmOpen, setTtsActive, settings])

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
    /*
      刚跳过来的搜索命中：只画在锚点章的那一段上。段起点来自本章 `paragraphStarts`，
      续接进来的下一章没有这份偏移，硬算会标错位置。
      偏移对不上（正文被源站改过）时退回本段里找关键词，找不到就安静地不高亮 —— 位置照旧滚到了。
    */
    if (searchFlash && ownerIndex === chapterIndex && searchFlash.chapterIndex === chapterIndex) {
      const start = paragraphStarts[pIndex] ?? 0
      const local = searchFlash.offset - start
      const at = local >= 0 && rawLine.startsWith(searchFlash.term, local) ? local : rawLine.indexOf(searchFlash.term)
      if (at >= 0) {
        const end = at + searchFlash.term.length
        return <>
          {rawLine.slice(0, at)}
          <mark className="reader-search-hit">{rawLine.slice(at, end)}</mark>
          {rawLine.slice(end)}
        </>
      }
    }
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
   * 漫画一屏：渲染当前这一屏（单页或双页），翻页交给 `goNextPage` / `goPrevPage`。
   * 失败仍复用「重取这一张」的出路；页码角标让读者知道这一章还有几张、现在在第几张。
   */
  const renderMangaPage = (index: number) => {
    const image = mangaImages[index]
    if (!image) return null
    const referer = chapter?.url
    const src = readerImageSrc(image, referer, imageGeneration[image] ?? 0)
    if (failedImages[image]) return renderImageFailure(image, referer, index)
    return (
      <img
        key={index}
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
    )
  }

  const renderMangaContent = () => {
    const shown = mangaSpreadPages(mangaStart, mangaSpread, mangaImages.length, settings.mangaDirection)
    if (!shown.length) return null
    return (
      <div
        className={`manga-page${mangaSpread === 2 ? ' manga-page-spread' : ''}`}
        data-manga-index={mangaStart}
        data-manga-direction={settings.mangaDirection}
      >
        {shown.map(index => renderMangaPage(index))}
        <span className="manga-page-count">{mangaPageLabel(mangaStart, mangaSpread, mangaImages.length)}</span>
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
    // 漫画同一条规矩：主动换章从章首开始，往回翻跨章落到上一章末屏（原来一律回到第一张）。
    if (isMangaMode) mangaTargetRef.current = targetPage === 'last' ? 'last' : 'first'
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
  }, [chapterIndex, currentBook.chapters.length, isMangaMode, persist, settings.pageMode, settings.ttsEngine, showBoundaryNotice, stopTts, stopAllEngines])
  // 把最新那份 changeChapter 交给朗读 hook（它要用 ref 打破循环依赖）。
  changeChapterRef.current = changeChapter

  /**
   * legacy 顶栏的「上一章 / 下一章」：沿用旧底栏进度行那套动作（先落进度、再切章），
   * 判据只看 chapterIndex —— 首章禁用上一章、末章禁用下一章。
   * 默认 MD3 界面不再摆这两颗键（2026-11-02 去重），键盘 ←→ / 点按区 / 目录仍走 changeChapter。
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
    const initialLogical = initialLogicalPositionRef.current
    /*
      分块章节的首屏恢复：目标段还在后面没挂出来时，先补块再交给 pending 的 effect 精确滚 ——
      直接按 fraction 兜底会落到估出来的高度上，差得远。
    */
    if (initialLogical && chunked && initialLogical.positionChecksum === positionChecksum && logicalMetaRef.current.starts.length) {
      const { index } = offsetToParagraph(logicalMetaRef.current.starts, initialLogical.charOffset)
      if (index >= renderLimit) {
        initialLogicalPositionRef.current = null
        initialPagePositionRef.current = null
        pendingNoteJumpRef.current = initialLogical
        revealParagraph(index)
        return
      }
    }
    targetInitialPageRef.current = null
    initialPagePositionRef.current = null
    initialLogicalPositionRef.current = null

    const scrollToTarget = () => {
      if (!targetMode && initialLogical && initialLogical.positionChecksum === positionChecksum
        && scrollToLogicalPosition(initialLogical)) return
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
  }, [content, loading, positionChecksum, scrollToLogicalPosition, settings.pageMode])

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
    // 漫画：章内按屏翻（双页一屏两张），翻到末屏再进下一章（与文本分页同一套入口）。
    if (isMangaMode) {
      const next = mangaNextStart(mangaIndex, mangaSpread, mangaImages.length)
      if (next === null) changeChapter(chapterIndex + 1, 'first')
      else setMangaIndex(next)
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
  }, [chapterIndex, changeChapter, isMangaMode, mangaImages.length, mangaIndex, mangaSpread, pageCount, pageIndex, pageAnim, settings.pageMode])

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
    // 漫画：章内退一屏，退到第一屏再回上一章的末屏。
    if (isMangaMode) {
      const prev = mangaPrevStart(mangaIndex, mangaSpread)
      if (prev === null) changeChapter(chapterIndex - 1, 'last')
      else setMangaIndex(prev)
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
  }, [chapterIndex, changeChapter, isMangaMode, mangaIndex, mangaSpread, pageIndex, pageAnim, prependPreviousChapter, showBoundaryNotice])

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
    if (settings.pageMode !== 'paginate' || isMangaMode) return
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
  }, [chapter, pageCount, pageIndex, persist, preloadNextChapter, preloadPrevChapter, settings.pageMode, isMangaMode])

  /**
   * 分页模式的进度上报（PROPOSAL-020 P2）：章内页码比例，供底栏进度条显示真实进度。
   * 漫画自己按屏上报（页数与文本页无关），这里让开。
   */
  useEffect(() => {
    if (settings.pageMode !== 'paginate' || isMangaMode) return
    reportProgress({ chapterIndex, total: currentBook.chapters.length, fraction: pageCount > 1 ? pageIndex / (pageCount - 1) : 0 })
  }, [chapterIndex, pageIndex, pageCount, settings.pageMode, isMangaMode, currentBook.chapters.length])

  /**
   * 漫画的进度：分母是"这一章有几张"，与文本页数无关。
   * 上报给底栏进度条，并按同一份比例决定预载下一章 / 上一章；
   * 落库仍走 `persist`（读到的位置由 `readLogicalPosition` 换成当前屏第一张的字符偏移）。
   */
  useEffect(() => {
    if (!isMangaMode || !chapter) return
    const position = mangaFraction(mangaStart, mangaImages.length)
    const current = currentRef.current
    if (!current) return
    current.position = position
    reportProgress({ chapterIndex, total: currentBook.chapters.length, fraction: position })
    if (position >= 0.7) preloadNextChapter(chapter.index)
    else if (position <= 0.3) preloadPrevChapter(chapter.index)
    if (timerRef.current === null) {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        persist()
      }, 1200)
    }
  }, [isMangaMode, chapter, chapterIndex, mangaStart, mangaImages.length, currentBook.chapters.length, persist, preloadNextChapter, preloadPrevChapter])

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
    // 分块章节里跟读到还没挂出来的段：先补块，等下一轮渲染再滚（找不到节点就什么都不会发生）。
    if (chunked && activeParagraphIndex >= renderLimit) { revealParagraph(activeParagraphIndex); return }

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
  }, [activeParagraphIndex, ttsActive, settings.pageMode, stride, pageCount, chunked, renderLimit, revealParagraph])

  useEffect(() => () => { if (boundaryTimerRef.current !== null) window.clearTimeout(boundaryTimerRef.current) }, [])

  // 快捷键：动作与界面上那张「快捷键」表都取自 web/src/shortcuts.ts 同一份定义。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = normalizeKey(event)
      if (!key || isTypingTarget(event.target, key)) return
      const hit = shortcutFor(READER_SHORTCUTS, key)
      if (!hit) return
      const jumpWithinChapter = (end: boolean) => {
        // 漫画没有可滚的正文：章首 / 章末就是首屏 / 末屏。
        if (isMangaMode) {
          setMangaIndex(end ? Math.max(0, mangaImages.length - 1) : 0)
          return
        }
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
          if (settings.pageMode === 'paginate' || isMangaMode) goPrevPage()
          else if (isAtTopBoundary(window.scrollY)) changeChapter(chapterIndex - 1, 'last')
          else window.scrollBy({ top: -window.innerHeight * 0.85, behavior: 'smooth' })
          break
        case 'page-down':
          event.preventDefault()
          if (settings.pageMode === 'paginate' || isMangaMode) goNextPage()
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
          // T 键只在**未删除**的内置皮肤间循环（自定义皮肤不在轮换里，网格里点选）。
          // 以 resolveTheme 为起点：当前用的是自定义皮肤时，从第一套可见内置皮肤开始。
          const visible = BUILTIN_SKINS.filter(skin => !isBuiltinSkinHidden(settings, skin.id))
          if (!visible.length) break
          const current = resolveTheme(settings)
          const next = visible[(visible.findIndex(skin => skin.id === current) + 1) % visible.length]
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
  }, [activeDrawer, changeChapter, chapterIndex, goNextPage, goPrevPage, onSettingsChange, settings, toggleTts, isMangaMode, mangaImages.length])

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
    '--reader-font-family': effectiveReaderFontFamily(settings),
    ...readerBackgroundVars(settings),
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
    // 漫画即使开着"连续滚动"也是按屏翻 —— 一屏只有一张图，滚不动，点两侧该翻页而不是滚。
    const paginate = settings.pageMode === 'paginate' || isMangaMode
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
  }, [chapterIndex, changeChapter, goNextPage, goPrevPage, settings.pageMode, isMangaMode])

  /**
   * 正文区的视口矩形。
   *
   * 点击分区的范围必须按它算，不能按整窗 —— 版面内容居中时正文两侧留白，
   * 按整窗算的话"左边一列"有一半落在留白或覆盖式抽屉下面，点在正文左缘会算成别的区。
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
   * 编辑层要盖在**正文区**上，不压住两侧留白。正文区左缘由版面决定（最大宽度居中），实测而不是猜。
   */
  const [readingLeft, setReadingLeft] = useState(0)
  useEffect(() => {
    if (!tapZoneEditing) return
    const measure = () => setReadingLeft(Math.round(readerMainRef.current?.getBoundingClientRect().left ?? 0))
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [tapZoneEditing])

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const start = pointerStartRef.current
    pointerStartRef.current = null
    if (event.button !== 0) return
    if (!start || loading || isInteractiveReaderTarget(event.target) || isInteractiveReaderTarget(start.target) || window.getSelection()?.toString()) return

    if (activeDrawer) {
      setActiveDrawer(null)
      return
    }

    // 漫画按屏翻：与分页同一套手势与分区（滚动模式下也走这一支，见 runTapAction）。
    if (settings.pageMode === 'paginate' || isMangaMode) {
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
      const built = notesApi.buildSelectionDraft()
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
              created => { if (created) { notesApi.setNotes(list => [...list, created]); toast.success('已划线') } },
              () => toast.warning('划线失败'),
            )
          },
        })
        items.push({
          label: '笔记',
          icon: 'file',
          onSelect: () => { notesApi.setNoteDraft(draft); notesApi.setNoteEditorOpen(true) },
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
  return (
    <TtsContext.Provider value={ttsCtx}>
  <main className={`reader-workspace ${themeClassNames(settings).join(' ')} ${toolbarsVisible ? 'toolbars-open' : 'toolbars-hidden'} ${activeDrawer ? 'drawer-open' : ''}`} style={readerStyle}>
    <ReaderChrome
      uiV2={uiV2}
      activeDrawer={activeDrawer}
      bookName={bookName}
      bookAuthor={currentBook.details.author ?? ''}
      sourceId={currentBook.details.sourceId}
      chapter={chapter}
      chapterIndex={chapterIndex}
      totalChapters={currentBook.chapters.length}
      isFullscreen={isFullscreen}
      mediaDisabled={!!mediaSrc}
      ttsActive={ttsActive}
      ttsPlayState={ttsPlayState}
      notesCount={notesApi.notes.length}
      notesPanel={notesApi.notesPanel}
      inShelf={inShelf}
      tapZoneEditing={tapZoneEditing}
      readingLeft={readingLeft}
      settings={settings}
      chapters={currentBook.chapters}
      cachedChapterUrls={cachedChapterUrls}
      chapterWordCounts={chapterWordCounts}
      convert={convert}
      notes={notesApi.notes}
      chapterTitles={Object.fromEntries(currentBook.chapters.map((item, index) => [index, item.title]))}
      localBook={currentBook.details.sourceId === 'loc_book' ? { name: bookName, tocRule: shelfTocRule } : null}
      tocRuleOptions={tocRuleOptions}
      actions={{
        onBack: () => { persist(); stopTts(); onClose() },
        onToggleToc: () => setActiveDrawer(d => d === 'toc' ? null : 'toc'),
        onToggleSettings: () => setActiveDrawer(d => d === 'settings' ? null : 'settings'),
        onToggleFullscreen: toggleFullscreen,
        onToggleTts: toggleTts,
        onBookSearch: () => setBookSearchOpen(true),
        onToggleNotes: () => { setActiveDrawer('toc'); notesApi.setNotesPanel(true) },
        onToggleBookmark: () => void toggleBookmark(),
        onPrevChapter: goPrevChapter,
        onNextChapter: goNextChapter,
        onSelectChapter: index => { changeChapter(index); setActiveDrawer(null) },
        onCloseDrawer: () => setActiveDrawer(null),
        onBackToToc: () => notesApi.setNotesPanel(false),
        onOpenSourceSwitch: () => { setActiveDrawer(null); setShowSourceSwitch(true) },
        onOpenRefresh: currentBook.details.sourceId === 'loc_book' ? undefined : () => setShowRefreshChapters(true),
        onToggleShelf: () => void toggleShelf(),
        onJumpNote: jumpToNote,
        onOpenReplaceRules: () => setShowReplaceRules(true),
        onEditTapZones: () => { setActiveDrawer(null); setTapZoneEditing(true) },
        onCloseTapZone: () => setTapZoneEditing(false),
        onTapZoneMap: map => onSettingsChange({
          ...settings,
          tapZones: settings.pageMode === 'paginate'
            ? { ...settings.tapZones, paginate: map }
            : { ...settings.tapZones, scroll: map },
        }),
        onTapZoneMode: mode => onSettingsChange({ ...settings, pageMode: mode }),
        onTapZonePreset: (paginate, scroll) => onSettingsChange({ ...settings, tapZones: { paginate, scroll } }),
        onSettingsChange,
        onReparseLocal: currentBook.details.sourceId === 'loc_book' ? reparseLocalBook : undefined,
      }}
    />

    {/* Central Reading Canvas */}
    <ReaderBody
      pageMode={settings.pageMode}
      uiV2={uiV2}
      flowKey={flowKey}
      refs={{ main: readerMainRef, viewport: viewportRef, body: bodyRef, anchor: anchorSectionRef, sentinel: chunkSentinelRef }}
      events={{ onMouseUp: notesApi.onReaderMouseUp, onPointerDown, onPointerUp, onWheel: onWheelPaginate, onContextMenu: onBodyContextMenu }}
      pagination={{
        pageIndex, pageCount, stride, columnWidth, columnGap, isDoubleColumn,
        pageAnim, fading, slideAnimOn, coverTurn, coverEntered, onCoverTransitionEnd,
        footerTitle: paginatedFooterTitle,
      }}
      content={{
        chapter, chapterIndex, totalChapters: currentBook.chapters.length,
        head: flowHead, tail: flowTail, pageFillers,
        shownTitle: shownChapterTitle ?? '', incomingTitle: incomingChapterTitle,
        stale: isStaleContent, loading, hasContent: !!content,
        chapterLoaded: loadedChapterUrl === chapter?.url,
        message, mediaSrc, sourceType, isMangaMode,
        paragraphs, shownParagraphs, chunked, renderLimit, nextChapterTitle,
        chapterProgress, shownChapterIndex, scrubIndex,
      }}
      actions={{
        convert, splitBody, renderLine: renderContentBlock, renderManga: renderMangaContent,
        onMediaEnded: () => { if (chapterIndex < currentBook.chapters.length - 1) changeChapter(chapterIndex + 1) },
        onNextChapter: changeChapter,
        onMore: () => setRenderLimit(limit => growLimit(limit, paragraphs.length)),
        onScrub: setScrubIndex,
        onScrubCommit: () => { if (scrubIndex !== null && scrubIndex !== chapterIndex) changeChapter(scrubIndex); setScrubIndex(null) },
      }}
    >
      {boundaryMessage && <p className="reader-boundary-message" role="status">{boundaryMessage}</p>}
    </ReaderBody>

    {/* 旧界面的移动底栏：MD3 外壳自己有 `.md3-bottombar`（目录 / 搜书 / 笔记 / 朗读 / 设置）。
        两条同时渲染时，旧的这条固定在 `bottom:0` 会压住新的那条与分页页脚（390px 实测
        底栏 696–780、旧导航 722–780、页脚 744–780，三层叠在一起），所以 uiV2 下不再挂它。 */}
    {!uiV2 && <nav className="mobile-reader-nav">
      <button onClick={() => setActiveDrawer('toc')}><Icon name="list" /><span>目录</span></button>
      <button onClick={() => setShowSourceSwitch(true)}><Icon name="sliders" /><span>换源</span></button>
      <button onClick={toggleTts} disabled={!!mediaSrc}><Icon name={ttsActive && ttsPlayState === 'playing' ? 'pause' : 'volume2'} /><span>{ttsActive ? (ttsPlayState === 'playing' ? '暂停' : '继续') : '朗读'}</span></button>
      <button onClick={() => setActiveDrawer('settings')}><span className="aa">Aa</span><span>设置</span></button>
      {!isBuiltinSkinHidden(settings, 'dark') && !isBuiltinSkinHidden(settings, 'light') && (
        <button onClick={() => onSettingsChange({ ...settings, theme: resolveTheme(settings) === 'dark' ? 'light' : 'dark' })}><Icon name="moon" /><span>夜读</span></button>
      )}
    </nav>}

    <ReaderOverlays
      dialogs={{
        sourceSwitch: showSourceSwitch,
        ttsActive,
        ttsSettings: showTtsSettings,
        replaceRules: showReplaceRules,
        offlineStats: offlineStatsModal,
        refreshChapters: showRefreshChapters,
        offlineTtsConfirm: offlineTtsConfirmOpen,
        lightboxSrc,
        bookSearch: bookSearchOpen,
        noteDraft: notesApi.noteDraft,
        noteEditor: notesApi.noteEditorOpen,
      }}
      book={{ name: bookName, details: currentBook.details, bookUrl: currentBook.bookUrl, chapter, chapterIndex, chapters: currentBook.chapters }}
      reader={{ settings, sleepTimer, remainingSeconds, cachedChapterUrls }}
      actions={{
        onCloseSourceSwitch: () => setShowSourceSwitch(false),
        onSwitchSource: handleSwitchSource,
        onSettingsChange,
        onSleepTimerChange: setSleepTimer,
        onCloseTtsSettings: () => setShowTtsSettings(false),
        onRulesChanged: handleReplaceRulesChanged,
        onCloseReplaceRules: () => setShowReplaceRules(false),
        onCloseOfflineStats: () => { setOfflineStatsModal(false); void syncCacheStatus() },
        onCloseRefreshChapters: () => setShowRefreshChapters(false),
        onRefreshed: handleChaptersRefreshed,
        onCloseOfflineTtsConfirm: () => setOfflineTtsConfirmOpen(false),
        onUseWebSpeech: handleUseWebSpeech,
        onCloseLightbox: () => setLightboxSrc(null),
        onJumpSearchHit: jumpToSearchHit,
        onCloseBookSearch: () => setBookSearchOpen(false),
        onHighlight: notesApi.highlightFromMenu,
        onNote: notesApi.openNoteEditor,
        onCopy: notesApi.copySelection,
        onAi: notesApi.sendSelectionToAi,
        onDismissMarking: notesApi.dismissMarkingMenu,
        onChangeNoteText: text => notesApi.setNoteDraft(current => (current ? { ...current, text } : current)),
        onSaveNote: () => void notesApi.saveNote(),
        onRemoveNote: () => void notesApi.removeNote(),
        onDismissNote: clearSelection => { notesApi.setNoteEditorOpen(false); notesApi.setNoteDraft(null); setSelection(null); if (clearSelection) window.getSelection()?.removeAllRanges() },
      }}
    />
  </main>
    </TtsContext.Provider>
  )
}
