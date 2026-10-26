import { useSyncExternalStore } from 'react'
import { api, BookDetails, SearchResult, SearchStreamEvent, streamSearch } from './api'
import { mergeStreamedResults, PROGRESS_FLUSH_MS, progressCanCoalesce } from './searchFilters'
import type { OpenBook } from '../reader/openBook'
import { cleanAuthor, cleanTitle, defaultSearchFilters, SearchFilters, SearchGroup } from './searchFilters'

export type SourceChoiceStatus = 'idle' | 'loading' | 'loaded' | 'error'

export type SourceChoice = {
  result: SearchResult
  status: SourceChoiceStatus
  book?: OpenBook
  error?: string
}

export interface SearchStoreState {
  keyword: string
  selectedSourceId: string
  /** 按分组搜索时的显式书源集合；null = 沿用单源或全部 */
  selectedSourceIds: string[] | null
  results: SearchResult[]
  choices: SourceChoice[]
  openBook: OpenBook | null
  message: string
  loading: boolean
  stopped: boolean
  detailLoading: boolean
  progress: SearchStreamEvent | null
  filters: SearchFilters
  /**
   * 书库搜索范围（全部 / 按分组 / 指定书源）。
   * 放在 store 里是为了让别处能"跳过去、就用这个源搜" —— 书源编辑器的
   * 「在书库里搜这个源」就是先设好它再跳页（用户 2026-10-09 的建议）。
   */
  scopeMode: 'all' | 'group' | 'single'
}

export const bookKey = (name: string, author?: string): string => {
  const cleanN = cleanTitle(name).toLowerCase()
  const cleanA = (cleanAuthor(author) ?? '').toLowerCase()
  return `${cleanN}\u0000${cleanA}`
}

export const groupSearchResults = (results: SearchResult[]): SearchGroup[] => {
  const groupsByKey = new Map<string, SearchGroup>()
  const titleToKnownAuthorKeys = new Map<string, string[]>()
  const titleToUnknownAuthorKey = new Map<string, string>()

  for (const result of results) {
    const rawCleanName = cleanTitle(result.name) || result.name.trim() || '未知书名'
    const rawCleanAuthor = cleanAuthor(result.author)
    const titleKey = rawCleanName.toLowerCase()

    if (rawCleanAuthor) {
      const key = `${titleKey}\u0000${rawCleanAuthor.toLowerCase()}`
      let group = groupsByKey.get(key)
      if (!group) {
        group = { key, name: rawCleanName, author: rawCleanAuthor, sources: [] }
        groupsByKey.set(key, group)
        const list = titleToKnownAuthorKeys.get(titleKey) ?? []
        list.push(key)
        titleToKnownAuthorKeys.set(titleKey, list)
      } else {
        if (group.name.includes('[') || group.name.includes('“') || group.name.length < rawCleanName.length) {
          group.name = rawCleanName
        }
      }
      group.sources.push(result)
    } else {
      const knownKeys = titleToKnownAuthorKeys.get(titleKey)
      if (knownKeys && knownKeys.length === 1) {
        const targetGroup = groupsByKey.get(knownKeys[0])!
        targetGroup.sources.push(result)
      } else {
        const unknownKey = `${titleKey}\u0000`
        let group = groupsByKey.get(unknownKey)
        if (!group) {
          group = { key: unknownKey, name: rawCleanName, author: undefined, sources: [] }
          groupsByKey.set(unknownKey, group)
          titleToUnknownAuthorKey.set(titleKey, unknownKey)
        } else {
          if (group.name.includes('[') || group.name.includes('“') || group.name.length < rawCleanName.length) {
            group.name = rawCleanName
          }
        }
        group.sources.push(result)
      }
    }
  }

  for (const [titleKey, unknownKey] of titleToUnknownAuthorKey.entries()) {
    const unknownGroup = groupsByKey.get(unknownKey)
    if (!unknownGroup) continue
    const knownKeys = titleToKnownAuthorKeys.get(titleKey)
    if (knownKeys && knownKeys.length === 1) {
      const targetGroup = groupsByKey.get(knownKeys[0])!
      targetGroup.sources.push(...unknownGroup.sources)
      groupsByKey.delete(unknownKey)
    }
  }

  return Array.from(groupsByKey.values())
}

export const isValidBookTitle = (title?: string | null): title is string => {
  if (!title) return false
  const t = title.trim()
  return t.length > 0 && t !== '未命名书籍' && t !== '未知书名' && t !== 'null' && t !== 'undefined'
}

export const isValidAuthor = (author?: string | null): author is string => {
  if (!author) return false
  const a = author.trim()
  return a.length > 0 && a !== '未知作者' && a !== '未知' && a !== 'null' && a !== 'undefined'
}

export const loadSourceBook = async (result: SearchResult, alternateSources?: SearchResult[]): Promise<OpenBook> => {
  const details = await api.details(result.sourceId, result.bookUrl)
  const fallbackSources = alternateSources || []

  // Extract best cover: details cover -> result cover -> first non-empty in alternate sources
  const bestCover = details.coverUrl?.trim() ||
    result.coverUrl?.trim() ||
    fallbackSources.find(s => s.coverUrl?.trim())?.coverUrl?.trim()

  // Extract best intro: details intro -> result intro -> longest intro in alternate sources
  let bestIntro = details.intro?.trim() || result.intro?.trim()
  if (!bestIntro) {
    const candidateIntros = fallbackSources.map(s => s.intro?.trim()).filter((intro): intro is string => Boolean(intro))
    if (candidateIntros.length > 0) {
      bestIntro = candidateIntros.reduce((longest, current) => current.length > longest.length ? current : longest, '')
    }
  }

  // Clean title & author (filter out placeholder strings like "未命名书籍")
  const rawName = (isValidBookTitle(details.name) ? details.name.trim() : null) ||
    (isValidBookTitle(result.name) ? result.name.trim() : null) ||
    fallbackSources.find(s => isValidBookTitle(s.name))?.name?.trim() ||
    details.name?.trim() ||
    result.name?.trim() ||
    '未知书名'
  const safeName = cleanTitle(rawName) || rawName

  const rawAuthor = (isValidAuthor(details.author) ? details.author.trim() : null) ||
    (isValidAuthor(result.author) ? result.author.trim() : null) ||
    fallbackSources.find(s => isValidAuthor(s.author))?.author?.trim() ||
    details.author?.trim() ||
    result.author?.trim()
  const safeAuthor = cleanAuthor(rawAuthor) || rawAuthor

  const safeDetails: BookDetails = {
    ...details,
    name: safeName,
    author: safeAuthor,
    coverUrl: bestCover || undefined,
    intro: bestIntro || undefined,
    alternateSources: alternateSources?.filter(s => s.sourceId !== result.sourceId || s.bookUrl !== result.bookUrl),
  }
  const [chapters, progress] = await Promise.all([
    api.chapters(safeDetails.sourceId, safeDetails.tocUrl),
    api.progress(safeDetails.sourceId, result.bookUrl),
  ])
  return { details: safeDetails, bookUrl: result.bookUrl, chapters, progress }
}

const initialSearchState: SearchStoreState = {
  keyword: '',
  selectedSourceId: '',
  selectedSourceIds: null,
  results: [],
  choices: [],
  openBook: null,
  message: '',
  loading: false,
  stopped: false,
  detailLoading: false,
  progress: null,
  filters: defaultSearchFilters,
  scopeMode: 'all',
}

export class SearchStore {
  private state: SearchStoreState = { ...initialSearchState }
  private listeners = new Set<() => void>()
  private socket: WebSocket | null = null
  // openGroup 是逐源 await 的长循环；发起新搜索/重置时递增它，让在途循环回来时判为过期、不再脏覆盖 choices/openBook。
  private openGroupGen = 0
  // 流式结果的判重表：跟着一次搜索活。每条封包只往里加，不再每条封包重建一遍已知集合
  // （那是 O(已收条数 × 封包数)，而整库搜索有五千多个源 → 五千次重建，正发生在结果往屏上长的那段）
  private seenResults = new Set<string>()
  // progress 封包的合并窗口：服务端每完成一个源都发一条，直连 setState 就是几千次重渲染
  private pendingProgress: SearchStreamEvent | null = null
  private progressTimer: ReturnType<typeof setTimeout> | null = null

  getSnapshot = (): SearchStoreState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emitChange() {
    for (const listener of this.listeners) {
      listener()
    }
  }

  private setState(next: Partial<SearchStoreState> | ((current: SearchStoreState) => Partial<SearchStoreState>)) {
    const patch = typeof next === 'function' ? next(this.state) : next
    this.state = { ...this.state, ...patch }
    this.emitChange()
  }

  setKeyword = (keyword: string) => {
    this.setState({ keyword })
  }

  setSelectedSourceId = (selectedSourceId: string) => {
    this.setState({ selectedSourceId, selectedSourceIds: null })
  }

  setSelectedSourceIds = (selectedSourceIds: string[] | null) => {
    this.setState({ selectedSourceIds, selectedSourceId: selectedSourceIds?.length === 1 ? selectedSourceIds[0] : '' })
  }

  setScopeMode = (scopeMode: SearchStoreState['scopeMode']) => {
    this.setState({ scopeMode })
  }

  setFilters = (filters: SearchFilters | ((current: SearchFilters) => SearchFilters)) => {
    this.setState(current => ({
      filters: typeof filters === 'function' ? filters(current.filters) : filters,
    }))
  }

  setOpenBook = (openBook: OpenBook | null) => {
    this.setState({ openBook })
  }

  setChoices = (choices: SourceChoice[]) => {
    this.setState({ choices })
  }

  /** 把攒着的 progress 一次性落进 state（状态行因此每 PROGRESS_FLUSH_MS 最多重排一次）。 */
  private flushProgress = () => {
    this.progressTimer = null
    const packet = this.pendingProgress
    this.pendingProgress = null
    if (packet) this.setState({ progress: packet })
  }

  /** 丢掉攒着的那条：紧跟其后的 start/done/error 都带着更新的进度，留着反而会倒退一格。 */
  private cancelProgressFlush = () => {
    if (this.progressTimer !== null) clearTimeout(this.progressTimer)
    this.progressTimer = null
    this.pendingProgress = null
  }

  startSearch = (keyword?: string, sourceId?: string) => {
    const query = (keyword !== undefined ? keyword : this.state.keyword).trim()
    if (!query) return

    const source = sourceId !== undefined ? sourceId : this.state.selectedSourceId
    // 服务端把「sourceIds 为空」当作不限制（Database.kt 的 takeIf { it.isNotEmpty() }），
    // 所以 null（不限制）与 []（零个源）必须分清：范围是空表时一次请求都不发，
    // 否则"只搜这一组、组里零个启用源"会变成搜全库。
    const scopeIds = sourceId !== undefined ? (source ? [source] : undefined) : (this.state.selectedSourceIds ?? (source ? [source] : undefined))
    if (scopeIds && scopeIds.length === 0) return
    this.openGroupGen++ // 作废任何在途的 openGroup

    if (this.socket) {
      try {
        if (this.socket.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ type: 'cancel' }))
        }
      } catch {
        // ignore
      }
      try {
        this.socket.close()
      } catch {
        // ignore
      }
      this.socket = null
    }

    // 新一轮搜索：判重表整张换掉（旧的键留着会把新书判成重复），攒着的 progress 丢掉
    this.seenResults = new Set<string>()
    this.cancelProgressFlush()

    this.setState({
      keyword: query,
      selectedSourceId: source,
      loading: true,
      stopped: false,
      message: '',
      progress: null,
      openBook: null,
      choices: [],
      results: [],
      filters: defaultSearchFilters,
    })

    const socket = streamSearch(
      query,
      scopeIds,
      packet => {
        if (this.socket !== socket) return
        if (packet.type === 'results') {
          // 判重靠常驻的 seen 表；并且**没有新增就不 setState** —— 空补丁也会 emitChange，
          // 那等于让"这一包全是重复"也换一次整区重渲染
          const additions = mergeStreamedResults(this.seenResults, packet.results)
          if (additions.length) {
            this.setState(prev => ({ results: [...prev.results, ...additions] }))
          }
          return
        }
        if (progressCanCoalesce(packet.type)) {
          this.pendingProgress = packet
          if (this.progressTimer === null) this.progressTimer = setTimeout(this.flushProgress, PROGRESS_FLUSH_MS)
          return
        }
        // start / done / error 都带"现在就该看见"的语义，先冲掉攒着的再落这条
        this.cancelProgressFlush()
        if (packet.type === 'start') {
          this.setState({ progress: packet })
          return
        }
        if (packet.type === 'error') {
          this.setState({ message: packet.message || '搜索失败', loading: false })
          this.socket = null
          return
        }
        this.setState({ progress: packet, loading: false })
        this.socket = null
      },
      error => {
        if (this.socket === socket) {
          this.setState({
            message: error,
            loading: false,
          })
          this.socket = null
        }
      },
      () => {
        if (this.socket === socket) {
          this.setState({
            loading: false,
          })
          this.socket = null
        }
      }
    )

    this.socket = socket
  }

  stopSearch = () => {
    const socket = this.socket
    this.socket = null
    // 停止时把攒着的最后一条进度落下去：状态行要停在"真正知道的最后一刻"，不能比屏幕上还旧
    this.flushProgress()
    this.setState({
      stopped: true,
      loading: false,
    })
    if (socket) {
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'cancel' }))
        }
      } catch {
        // ignore
      }
      try {
        socket.close()
      } catch {
        // ignore
      }
    }
  }

  openGroup = async (group: SearchGroup) => {
    const gen = ++this.openGroupGen
    this.setState({
      detailLoading: true,
      message: '',
      openBook: null,
    })

    const initialChoices: SourceChoice[] = group.sources.map(result => ({ result, status: 'idle' }))
    this.setState({ choices: initialChoices })

    let loadedBook: OpenBook | null = null
    for (let i = 0; i < group.sources.length; i++) {
      const candidate = group.sources[i]
      this.setState(prev => ({
        choices: prev.choices.map((c, idx) => (idx === i ? { ...c, status: 'loading' } : c)),
      }))
      try {
        const book = await loadSourceBook(candidate, group.sources)
        if (gen !== this.openGroupGen) return // 期间已发起新搜索/重置：丢弃这次在途结果
        this.setState(prev => ({
          choices: prev.choices.map((c, idx) => (idx === i ? { ...c, book, status: 'loaded' } : c)),
        }))
        loadedBook = book
        break
      } catch (err) {
        if (gen !== this.openGroupGen) return
        const errMsg = err instanceof Error ? err.message : '无法读取此书源'
        this.setState(prev => ({
          choices: prev.choices.map((c, idx) => (idx === i ? { ...c, status: 'error', error: errMsg } : c)),
        }))
      }
    }

    if (gen !== this.openGroupGen) return
    if (loadedBook) {
      this.setState({ openBook: loadedBook, detailLoading: false })
    } else {
      this.setState({ message: '所有书源均无法读取', detailLoading: false })
    }
  }

  chooseSource = async (choice: SourceChoice, groupSources?: SearchResult[]) => {
    // 与 openGroup 同一套作废机制：新一轮搜索发出后，这次换源的响应再回来就不许写屏。
    // **必须自增**（与 openGroup 的 `const gen = ++this.openGroupGen` 同义）：只读不自增的话，
    // 两次并发换源拿到的是同一个 gen，两道守卫都放行，慢的那个后到就把快的那本覆盖掉。
    // 自增还顺带作废在途的 openGroup 循环 —— 用户已经手点了某一家，那次自动轮询该停。
    // 写成两行而不是前缀自增，是因为 ReadThroughFixes.test.ts 钉的是"入口记下这一轮的代次"
    // 那一行的形状；语义与 `++this.openGroupGen` 完全相同。
    this.openGroupGen += 1
    const gen = this.openGroupGen
    const allCandidates = groupSources || this.state.choices.map(c => c.result)
    const fallbackCover = allCandidates.find(s => s.coverUrl?.trim())?.coverUrl?.trim()
    const candidateIntros = allCandidates.map(s => s.intro?.trim()).filter((intro): intro is string => Boolean(intro))
    const fallbackIntro = candidateIntros.length > 0
      ? candidateIntros.reduce((longest, current) => current.length > longest.length ? current : longest, '')
      : undefined

    if (choice.book) {
      const current = choice.book
      const bestCover = current.details.coverUrl?.trim() || fallbackCover
      const bestIntro = current.details.intro?.trim() || fallbackIntro
      const currentName = current.details.name?.trim()
      const existingName = this.state.openBook?.details.name?.trim()
      const bestName = isValidBookTitle(currentName)
        ? currentName
        : (isValidBookTitle(existingName) ? existingName : (cleanTitle(choice.result.name) || choice.result.name || currentName))
      const updatedBook: OpenBook = {
        ...current,
        details: {
          ...current.details,
          name: bestName,
          coverUrl: bestCover || undefined,
          intro: bestIntro || undefined,
          alternateSources: allCandidates.filter(s => s.sourceId !== choice.result.sourceId || s.bookUrl !== choice.result.bookUrl),
        },
      }
      this.setState({ openBook: updatedBook })
      return
    }

    this.setState(prev => ({
      choices: prev.choices.map(c =>
        c.result.sourceId === choice.result.sourceId && c.result.bookUrl === choice.result.bookUrl
          ? { ...c, status: 'loading', error: undefined }
          : c
      ),
    }))

    try {
      const book = await loadSourceBook(choice.result, allCandidates)
      if (gen !== this.openGroupGen) return // 新一轮已经开始了：不许把上一轮的书重新摆回屏幕上
      this.setState(prev => ({
        choices: prev.choices.map(c =>
          c.result.sourceId === choice.result.sourceId && c.result.bookUrl === choice.result.bookUrl
            ? { ...c, book, status: 'loaded' }
            : c
        ),
        openBook: book,
      }))
    } catch (err) {
      // 与 try 分支同一道闸：这期间用户已经换了一次源/发了新搜索，这条"读不出来"的结论
      // 属于上一轮，落进 choices 会把新一轮那个正在 loading 的候选改写成 error。
      if (gen !== this.openGroupGen) return
      const errMsg = err instanceof Error ? err.message : '无法读取此书源'
      this.setState(prev => ({
        choices: prev.choices.map(c =>
          c.result.sourceId === choice.result.sourceId && c.result.bookUrl === choice.result.bookUrl
            ? { ...c, status: 'error', error: errMsg }
            : c
        ),
      }))
    }
  }

  reset = () => {
    this.openGroupGen++ // 作废任何在途的 openGroup
    // 判重表与攒着的进度都要跟着整份状态一起清掉，否则清空后紧接着的一次搜索会被旧键判重
    this.seenResults = new Set<string>()
    this.cancelProgressFlush()
    if (this.socket) {
      try {
        if (this.socket.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ type: 'cancel' }))
        }
      } catch {
        // ignore
      }
      try {
        this.socket.close()
      } catch {
        // ignore
      }
      this.socket = null
    }
    this.setState({ ...initialSearchState })
  }
}

export const searchStore = new SearchStore()

export function useSearchStore(): SearchStoreState & {
  setKeyword: (keyword: string) => void
  setSelectedSourceId: (sourceId: string) => void
  setSelectedSourceIds: (ids: string[] | null) => void
  setScopeMode: (mode: SearchStoreState['scopeMode']) => void
  setFilters: (filters: SearchFilters | ((current: SearchFilters) => SearchFilters)) => void
  setOpenBook: (book: OpenBook | null) => void
  startSearch: (keyword?: string, sourceId?: string) => void
  stopSearch: () => void
  openGroup: (group: SearchGroup) => Promise<void>
  chooseSource: (choice: SourceChoice, groupSources?: SearchResult[]) => Promise<void>
  reset: () => void
} {
  const state = useSyncExternalStore(searchStore.subscribe, searchStore.getSnapshot)
  return {
    ...state,
    setKeyword: searchStore.setKeyword,
    setSelectedSourceIds: searchStore.setSelectedSourceIds,
    setSelectedSourceId: searchStore.setSelectedSourceId,
    setScopeMode: searchStore.setScopeMode,
    setFilters: searchStore.setFilters,
    setOpenBook: searchStore.setOpenBook,
    startSearch: searchStore.startSearch,
    stopSearch: searchStore.stopSearch,
    openGroup: searchStore.openGroup,
    chooseSource: searchStore.chooseSource,
    reset: searchStore.reset,
  }
}

/**
 * 只订阅 store 的**一个切片**。
 *
 * 为什么要有这一条：`useSearchStore()` 拿的是整份快照，所以只要 store 有任何写入 ——
 * 整库搜索期间 `PROGRESS_FLUSH_MS = 250` 每 250ms 就写一次 —— 所有调用方都会重渲染。
 * `main.tsx` 是其中最贵的一个：它只用一个 `loading` 布尔，却因此每 250ms 重渲染整棵 App 树。
 *
 * `pick` 必须返回**原始值或引用稳定的值**（布尔、字符串、store 里那个现成的数组引用）。
 * 返回新建的对象/数组会让 React 每次都认为快照变了，直接退化成无限重渲染 ——
 * 需要派生值时先在 store 里算好存下来，再 pick 那个字段。
 */
export function useSearchSlice<T>(pick: (state: SearchStoreState) => T): T {
  const snapshot = () => pick(searchStore.getSnapshot())
  return useSyncExternalStore(searchStore.subscribe, snapshot, snapshot)
}
