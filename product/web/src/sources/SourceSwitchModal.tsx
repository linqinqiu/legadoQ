import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, Chapter, SearchResult, SearchStreamEvent, SourceSummary, streamSearch } from '../lib/api'
import { cleanTitle } from '../lib/searchFilters'
import { sourceLabel, sourcePickerOptions } from './sourceOrder'
import { splitSourceGroups } from './sourceGrouping'
import { Icon } from '../icons'
import { Select } from '../components/Select'
import { toast } from '../components/Toast'
import { useEscapeClose } from '../lib/useEscapeClose'


export type SourceCandidate = {
  result: SearchResult
  isKnownAlternate?: boolean
  isCurrent?: boolean
  status: 'idle' | 'loading' | 'loaded' | 'error'
  latestChapter?: string
  totalChapters?: number
  matchedChapterIndex?: number
  matchedChapterTitle?: string
  chapters?: Chapter[]
  error?: string
}

export type SourceSwitchModalProps = {
  bookName: string
  author?: string
  currentSourceId: string
  currentBookUrl: string
  currentChapterTitle?: string
  currentChapterIndex?: number
  knownAlternateSources?: SearchResult[]
  /**
   * 换源搜索的范围选择（用户 2026-10-23：「书籍内部换源允许指定书源和分组，像搜索页面一样」）。
   * 传了就在弹窗里摆出与搜索页同款那条"全部书源 / 按分组 / 指定书源"；
   * **没传时保持历史行为**：书架入口已经持有整张表，会传；
   * 阅读器入口没有这张表（不为了一个弹窗把它塞进 2700 行的 ReaderScreen 与 main.tsx 的 props 链），
   * 由弹窗自己拉 `api.sources()` —— 拉之前那一拍按老语义搜全库，拉到后换范围条接管。
   */
  sources?: SourceSummary[]
  onSwitch: (chosen: { result: SearchResult; chapters: Chapter[]; targetChapterIndex: number }) => Promise<void>
  onClose: () => void
}

const normalizeTitle = (title: string): string =>
  title
    .replace(/^第[0-9一二三四五六七八九十百千万]+[章回节集卷]\s*/gu, '')
    .replace(/^chapter\s*[0-9]+/iu, '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase()

export function matchBestChapter(
  chapters: Chapter[],
  currentTitle?: string,
  currentIndex?: number
): { index: number; title: string } {
  if (chapters.length === 0) return { index: 0, title: '' }

  if (currentTitle) {
    const normCurrent = normalizeTitle(currentTitle)
    if (normCurrent.length >= 2) {
      // 1. Exact match on raw title
      const exact = chapters.find(c => c.title.trim() === currentTitle.trim())
      if (exact) return { index: exact.index, title: exact.title }

      // 2. Exact match on normalized title
      const normExact = chapters.find(c => normalizeTitle(c.title) === normCurrent)
      if (normExact) return { index: normExact.index, title: normExact.title }

      // 3. Substring inclusion
      const substr = chapters.find(c => {
        const norm = normalizeTitle(c.title)
        return norm.length >= 2 && (norm.includes(normCurrent) || normCurrent.includes(norm))
      })
      if (substr) return { index: substr.index, title: substr.title }
    }
  }

  // Fallback to index
  const safeIdx = Math.min(Math.max(0, currentIndex ?? 0), chapters.length - 1)
  return { index: safeIdx, title: chapters[safeIdx]?.title || '' }
}

export function SourceSwitchModal({
  bookName,
  author,
  currentSourceId,
  currentBookUrl,
  currentChapterTitle,
  currentChapterIndex,
  knownAlternateSources = [],
  sources = [],
  onSwitch,
  onClose,
}: SourceSwitchModalProps) {
  const [candidates, setCandidates] = useState<SourceCandidate[]>([])
  const [searchProgress, setSearchProgress] = useState<SearchStreamEvent | null>(null)
  const [searching, setSearching] = useState(true)
  const [switchingSourceId, setSwitchingSourceId] = useState<string | null>(null)

  const socketRef = useRef<WebSocket | null>(null)
  const fetchingTocRef = useRef<Set<string>>(new Set())

  /**
   * 换源搜索范围（用户 2026-10-23：「书籍内部换源允许指定书源和分组，像搜索页面一样」）。
   * 三档词汇、算式、空范围闸门都与搜索页（LibraryPage 的 `.library-scope`）同一套，
   * 不另起一份语义 —— 两个入口说"按分组"必须是同一件事。
   */
  const [scopeMode, setScopeMode] = useState<'all' | 'group' | 'single'>('all')
  const [scopeGroup, setScopeGroup] = useState('')
  const [scopeSourceId, setScopeSourceId] = useState('')
  const [includeDisabled, setIncludeDisabled] = useState(false)
  /** 弹窗自己拉的那份书源表（调用方没传 sources 时用，见 props 注释）。 */
  const [ownSources, setOwnSources] = useState<SourceSummary[]>([])
  const table = sources.length > 0 ? sources : ownSources

  useEffect(() => {
    if (sources.length > 0) return
    let cancelled = false
    void api.sources().then(list => { if (!cancelled) setOwnSources(list) }).catch(() => undefined)
    return () => { cancelled = true }
  }, [sources.length])

  /** 分组下拉的候选：把每个源的标签串拆开聚合，与搜索页同一个算式。 */
  const groupOptions = useMemo(() => {
    const tally = new Map<string, { total: number; ready: number }>()
    for (const source of table) {
      for (const tag of splitSourceGroups(source.group)) {
        const row = tally.get(tag) ?? { total: 0, ready: 0 }
        row.total += 1
        if (source.enabled) row.ready += 1
        tally.set(tag, row)
      }
    }
    return [...tally.entries()]
      .map(([name, row]) => ({ name, ...row }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'zh-CN'))
  }, [table])

  /**
   * 范围 → 书源 id 列表。**`null` 与空数组必须分清**（与 searchStore 同一条坑）：
   * `null`/undefined = 不限制（全库启用源），空数组 = 一个源都不搜 ——
   * 把空数组当"不限制"传下去，用户选了个空分组却搜完全库，是最难查的那种错。
   * 所以空范围这里直接返回空数组，由搜索那条 effect 认出"别发起搜索"。
   */
  const scopeIds = useMemo(() => {
    if (scopeMode === 'all') return null
    if (scopeMode === 'single') return scopeSourceId ? [scopeSourceId] : []
    return scopeGroup
      ? table.filter(source => source.enabled && splitSourceGroups(source.group).includes(scopeGroup)).map(source => source.id)
      : []
  }, [scopeMode, scopeGroup, scopeSourceId, table])

  const scopeHint = scopeMode === 'all'
    ? `全库换源：会挨个搜启用中的 ${table.filter(source => source.enabled).length} 个书源`
    : scopeMode === 'group'
      ? (scopeGroup
        ? (scopeIds && scopeIds.length ? `只在「${scopeGroup}」分组内换源（${scopeIds.length} 个启用书源）` : `「${scopeGroup}」分组当前没有启用中的书源，搜不到东西`)
        : '选一个分组，换源只在该分组内进行')
      : (scopeSourceId
        ? `只在你指定的那一个书源里找同名书，最干净但也最容易空`
        : '下拉里是启用中的书源（停用的搜不到，需要时勾「含已停用」）')

  const fetchCandidateToc = useCallback(async (candidate: SourceCandidate) => {
    const key = `${candidate.result.sourceId}\u0000${candidate.result.bookUrl}`
    if (fetchingTocRef.current.has(key)) return
    fetchingTocRef.current.add(key)

    setCandidates(prev =>
      prev.map(c =>
        c.result.sourceId === candidate.result.sourceId && c.result.bookUrl === candidate.result.bookUrl
          ? { ...c, status: 'loading', error: undefined }
          : c
      )
    )

    try {
      const details = await api.details(candidate.result.sourceId, candidate.result.bookUrl)
      const chapters = await api.chapters(candidate.result.sourceId, details.tocUrl)
      const latest = chapters.at(-1)?.title
      const best = matchBestChapter(chapters, currentChapterTitle, currentChapterIndex)

      setCandidates(prev =>
        prev.map(c =>
          c.result.sourceId === candidate.result.sourceId && c.result.bookUrl === candidate.result.bookUrl
            ? {
                ...c,
                status: 'loaded',
                chapters,
                totalChapters: chapters.length,
                latestChapter: latest,
                matchedChapterIndex: best.index,
                matchedChapterTitle: best.title,
              }
            : c
        )
      )
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : '无法获取目录'
      setCandidates(prev =>
        prev.map(c =>
          c.result.sourceId === candidate.result.sourceId && c.result.bookUrl === candidate.result.bookUrl
            ? { ...c, status: 'error', error: errorMsg }
            : c
        )
      )
    } finally {
      fetchingTocRef.current.delete(key)
    }
  }, [currentChapterIndex, currentChapterTitle])

  // Initialize known alternates
  useEffect(() => {
    const initialList: SourceCandidate[] = []

    // 1. Current source (if available)
    initialList.push({
      result: {
        sourceId: currentSourceId,
        bookUrl: currentBookUrl,
        name: bookName,
        author,
      },
      isCurrent: true,
      status: 'idle',
    })

    // 2. Known alternate sources
    for (const alt of knownAlternateSources) {
      if (alt.sourceId === currentSourceId && alt.bookUrl === currentBookUrl) continue
      initialList.push({
        result: alt,
        isKnownAlternate: true,
        status: 'idle',
      })
    }

    setCandidates(initialList)

    // Trigger TOC fetch for known alternates
    initialList.forEach(cand => {
      if (!cand.isCurrent) {
        void fetchCandidateToc(cand)
      }
    })
  }, [author, bookName, currentBookUrl, currentSourceId, fetchCandidateToc, knownAlternateSources])

  // Start streaming search for other sources
  useEffect(() => {
    let cancelled = false
    // 空范围闸门：选了分组但组里 0 个启用源、或"指定书源"还没选 —— 这时**不该发起搜索**。
    // 原来 `sourceIds` 写死 undefined（= 全库），现在要按范围传：把空数组当 undefined 传下去
    // 等于"没限制"，用户选空分组却搜完全库 —— 与 searchStore 那条注释同一个坑，反过来栽。
    if (scopeIds !== null && scopeIds.length === 0) {
      setSearching(false)
      return
    }
    setSearching(true)
    // 换范围就要换候选：留着上一次（更宽范围）搜到的那批，用户会以为范围没生效。
    // 只留"当前源 + 已知备选源"这份基线 —— 它们与搜索范围无关，本来就一直该在。
    // 挂载这一趟也走这里，但那时长列表里只有这份基线，等于空操作。
    setCandidates(prev => prev.filter(c => c.isCurrent || c.isKnownAlternate))

    const socket = streamSearch(
      bookName,
      // `null` = 不限制（全库启用源）；非 null 就按这份 id 列表搜。
      scopeIds ?? undefined,
      event => {
        if (cancelled) return
        if (event.type === 'start' || event.type === 'progress' || event.type === 'done') {
          setSearchProgress(event)
        }
        if (event.type === 'results' && event.results.length > 0) {
          setCandidates(prev => {
            const existingKeys = new Set(prev.map(c => `${c.result.sourceId}\u0000${c.result.bookUrl}`))
            const newCandidates: SourceCandidate[] = []

            for (const r of event.results) {
              const key = `${r.sourceId}\u0000${r.bookUrl}`
              // Filter by book name similarity
              // 书名按清洗后比较：源站常带《》或尾随空白/副标题，全等会把同名结果整批滤掉，换源列表就成了空的。
              // 与章节匹配同款策略：相等，或任一方包含另一方（且都≥2 字符）即视为同一本书。
              const wantName = cleanTitle(bookName).trim().toLowerCase()
              const gotName = cleanTitle(r.name).trim().toLowerCase()
              const sameBook =
                gotName === wantName ||
                (gotName.length >= 2 && wantName.length >= 2 && (gotName.includes(wantName) || wantName.includes(gotName)))
              if (
                !existingKeys.has(key) &&
                sameBook
              ) {
                existingKeys.add(key)
                const candidate: SourceCandidate = {
                  result: r,
                  status: 'idle',
                }
                newCandidates.push(candidate)
                // Automatically fetch TOC for newly found candidates
                void fetchCandidateToc(candidate)
              }
            }

            return newCandidates.length > 0 ? [...prev, ...newCandidates] : prev
          })
        }
        if (event.type === 'done' || event.type === 'error') {
          setSearching(false)
        }
      },
      () => {
        if (!cancelled) setSearching(false)
      },
      () => {
        if (!cancelled) setSearching(false)
      }
    )

    socketRef.current = socket

    return () => {
      cancelled = true
      socketRef.current?.close()
      socketRef.current = null
    }
  }, [bookName, fetchCandidateToc, scopeIds])

  const handleSelect = async (candidate: SourceCandidate) => {
    if (candidate.isCurrent) {
      toast.info('当前已是该书源')
      return
    }

    setSwitchingSourceId(candidate.result.sourceId)

    try {
      let chapters = candidate.chapters
      let targetIndex = candidate.matchedChapterIndex ?? 0

      if (!chapters) {
        const details = await api.details(candidate.result.sourceId, candidate.result.bookUrl)
        chapters = await api.chapters(candidate.result.sourceId, details.tocUrl)
        const best = matchBestChapter(chapters, currentChapterTitle, currentChapterIndex)
        targetIndex = best.index
      }

      await onSwitch({
        result: candidate.result,
        chapters,
        targetChapterIndex: targetIndex,
      })

      const targetTitle = chapters[targetIndex]?.title || `第 ${targetIndex + 1} 章`
      toast.success(`已换到「${sourceLabel(candidate.result.sourceId)}」，定位到：${targetTitle}`)
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '换源失败')
    } finally {
      setSwitchingSourceId(null)
    }
  }

  const sortedCandidates = useMemo(() => {
    return [...candidates].sort((a, b) => {
      // 1. Current source first
      if (a.isCurrent) return -1
      if (b.isCurrent) return 1
      // 2. Known alternate sources second
      if (a.isKnownAlternate && !b.isKnownAlternate) return -1
      if (!a.isKnownAlternate && b.isKnownAlternate) return 1
      // 3. Loaded sources with more chapters first
      if (a.status === 'loaded' && b.status !== 'loaded') return -1
      if (a.status !== 'loaded' && b.status === 'loaded') return 1
      if (a.totalChapters && b.totalChapters) return b.totalChapters - a.totalChapters
      return 0
    })
  }, [candidates])

  const progressPercent = searchProgress?.totalSources
    ? Math.round((searchProgress.completedSources / searchProgress.totalSources) * 100)
    : 0

  useEscapeClose(onClose)
  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div
        className="dialog-shell size-m"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`切换书源: ${bookName}`}
      >
        <header className="dialog-head source-switch-header">
          <div>
            <div className="source-switch-kicker">
              <Icon name="sliders" />
              <span>换源</span>
            </div>
            <h2>{bookName}</h2>
            <small>{author ? `作者：${author}` : '未知作者'} · 当前：{sourceLabel(currentSourceId)}</small>
          </div>
          <button type="button" className="overlay-close" onClick={onClose} aria-label="关闭">
            <Icon name="close" />
          </button>
        </header>

        {/*
          换源范围（用户 2026-10-23：「书籍内部换源允许指定书源和分组，像搜索页面一样」）。
          三档 + 分组下拉 + 书源下拉 + 含已停用，形状与搜索页 `.library-scope` 一致，
          复用同一批算式（splitSourceGroups / sourcePickerOptions），不另起一份语义。
        */}
        <div className="library-scope source-switch-scope">
          <span className="library-scope-label">换源范围</span>
          <div className="library-scope-modes" role="group" aria-label="换源范围">
            {([['all', '全部书源'], ['group', '按分组'], ['single', '指定书源']] as const).map(([key, label]) => (
              <button key={key} type="button" className={scopeMode === key ? 'active' : ''} onClick={() => setScopeMode(key)}>{label}</button>
            ))}
          </div>
          {scopeMode === 'group' && (
            <Select
              ariaLabel="按分组换源"
              placeholder={table.length ? '选择分组' : '书源还在载入'}
              value={scopeGroup}
              onChange={setScopeGroup}
              options={groupOptions.map(item => ({ value: item.name, label: item.name, hint: `可搜 ${item.ready} / 共 ${item.total}` }))}
            />
          )}
          {scopeMode === 'single' && (
            <>
              <Select
                ariaLabel="指定书源换源"
                placeholder={table.length ? '选择书源' : '书源还在载入'}
                value={scopeSourceId}
                onChange={setScopeSourceId}
                options={sourcePickerOptions(table, includeDisabled)}
              />
              {/* 默认只列启用中的：停用的源选了必然搜不到（与搜索页同一个理由）。 */}
              {table.some(source => !source.enabled) && (
                <label className="library-scope-toggle">
                  <input type="checkbox" checked={includeDisabled} onChange={event => setIncludeDisabled(event.target.checked)} />
                  含已停用（{table.filter(source => !source.enabled).length}）
                </label>
              )}
            </>
          )}
          <small className="library-scope-hint">{scopeHint}</small>
        </div>

        {/* Search Stream Progress Banner */}
        <div className="source-search-banner">
          <div className="search-banner-text">
            <span>
              {searching ? (
                <>正在{scopeMode === 'all' ? '全源' : scopeMode === 'group' ? `「${scopeGroup}」分组内` : '指定书源里'}检索《{bookName}》…</>
              ) : (scopeMode === 'group' && !scopeGroup) || (scopeMode === 'single' && !scopeSourceId) ? (
                <>还没选范围：上面挑一个分组或一个书源，才会开始检索</>
              ) : (
                <>检索完成，共找到 {candidates.length} 本（一个书源可能出好几本）</>
              )}
            </span>
            <small>
              {searchProgress
                ? `已扫描 ${searchProgress.completedSources} / ${searchProgress.totalSources} 个书源`
                : '准备检索…'}
            </small>
          </div>
          {searching && (
            <div className="search-progress-bar-track">
              <div
                className="search-progress-bar-fill"
                style={{ width: `${Math.max(5, progressPercent)}%` }}
              />
            </div>
          )}
        </div>

        {/* Candidate List */}
        <div className="source-candidate-list">
          {sortedCandidates.map(c => {
            const isSwitching = switchingSourceId === c.result.sourceId
            const isLoading = c.status === 'loading'
            const isError = c.status === 'error'
            const isCurrent = c.isCurrent

            let metaText = '点击拉取目录并切换'
            if (isCurrent) {
              metaText = '当前正在阅读的书源'
            } else if (isLoading) {
              metaText = '正在提取目录与章节…'
            } else if (isError) {
              metaText = c.error || '获取目录失败'
            } else if (c.status === 'loaded') {
              metaText = `共 ${c.totalChapters ?? 0} 章 · 最新：${c.latestChapter || '无'}`
            }

            return (
              <article
                key={`${c.result.sourceId}-${c.result.bookUrl}`}
                className={`source-candidate-card ${isCurrent ? 'current' : ''} ${isError ? 'error' : ''}`}
              >
                <div className="candidate-main">
                  <div className="candidate-title-row">
                    <strong title={c.result.sourceId}>{sourceLabel(c.result.sourceId)}</strong>
                    {isCurrent && <span className="source-badge current">当前书源</span>}
                    {c.isKnownAlternate && !isCurrent && (
                      <span className="source-badge alternate">已收录候选</span>
                    )}
                  </div>
                  <p className="candidate-meta">{metaText}</p>
                  {c.matchedChapterTitle && !isCurrent && (
                    <small className="candidate-match">
                      智能定位至：第 {(c.matchedChapterIndex ?? 0) + 1} 章 · {c.matchedChapterTitle}
                    </small>
                  )}
                </div>

                <div className="candidate-action">
                  {isCurrent ? (
                    <span className="current-indicator">使用中</span>
                  ) : (
                    <button
                      className="primary-button switch-btn"
                      disabled={isSwitching}
                      onClick={() => void handleSelect(c)}
                    >
                      {isSwitching ? '切换中…' : '切换'}
                    </button>
                  )}
                </div>
              </article>
            )
          })}

          {sortedCandidates.length === 0 && !searching && (
            <div className="source-switch-empty">
              <Icon name="book" />
              <p>未在其他书源中发现匹配的《{bookName}》</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
