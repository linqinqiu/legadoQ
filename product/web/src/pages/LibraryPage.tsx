// 书库页：多源搜索、关键词高亮、搜索历史
// 从 main.tsx 拆出（0.8.2 结构重排）：组件体逐字未动，import 由脚本按导出面索引补全。

import { FormEvent, useMemo, useState } from 'react'
import { CoverFallback, SearchCover } from '../shelf/Cover'
import { Icon } from '../icons'
import type { OpenBook } from '../reader/openBook'
import { Select } from '../components/Select'
import { ShelfLayout, readSearchLayout, writeSearchLayout } from '../shelf/shelfLayout'
import { SortMode, cleanTitle, filterSearchGroups, isExactMatch, pickBlurb } from '../lib/searchFilters'
import { SourceSummary } from '../lib/api'
import { bookTypeMeta, commonBookType } from '../shelf/bookType'
import { groupSearchResults, useSearchStore } from '../lib/searchStore'
import { sanitizeImageUrl } from '../sources/sourceImport'
import { sourcePickerOptions } from '../sources/sourceOrder'
import { toast } from '../components/Toast'
import { splitSourceGroups } from '../sources/sourceGrouping'
import { BookDetailModal } from '../components/BookDetailModal'

export const highlightRegexCache = new Map<string, RegExp>()
export function keywordRegex(keyword: string): RegExp {
  let re = highlightRegexCache.get(keyword)
  if (!re) {
    re = new RegExp(`(${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
    if (highlightRegexCache.size > 20) highlightRegexCache.clear()
    highlightRegexCache.set(keyword, re)
  }
  return re
}

export function HighlightText({ text, keyword }: { text: string; keyword: string }) {
  const cleanK = cleanTitle(keyword).trim()
  if (!cleanK || !text) return <>{text}</>

  const parts = text.split(keywordRegex(cleanK))

  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === cleanK.toLowerCase() ? (
          <mark key={i} className="search-highlight">{part}</mark>
        ) : (
          part
        )
      )}
    </>
  )
}

export const SEARCH_HISTORY_KEY = 'legado-search-history'
export const readSearchHistory = (): string[] => {
  try {
    if (typeof localStorage === 'undefined') return []
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
export const writeSearchHistory = (list: string[]): void => {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(list.slice(0, 10)))
  } catch {
    /* 隐私模式或配额满时静默忽略 */
  }
}

export function LibraryPage({ sources, onSourcesChanged, onOpen }: { sources: SourceSummary[]; onSourcesChanged: () => void; onOpen: (book: OpenBook, index: number) => void }) {
  const search = useSearchStore()
  // 范围模式放进 store：书源编辑器的「在书库里搜这个源」要能设好它再跳过来（用户 2026-10-09）
  const scopeMode = search.scopeMode
  const setScopeMode = search.setScopeMode
  const [scopeGroup, setScopeGroup] = useState('')
  const [includeDisabledSources, setIncludeDisabledSources] = useState(false)
  const enabledSourceCount = useMemo(() => sources.filter(source => source.enabled).length, [sources])
  const [history, setHistory] = useState<string[]>(readSearchHistory)
  const recordHistory = (keyword: string) => {
    const kw = keyword.trim()
    if (!kw) return
    setHistory(prev => {
      const next = [kw, ...prev.filter(h => h !== kw)].slice(0, 10)
      writeSearchHistory(next)
      return next
    })
  }
  /**
   * 发起一次搜索：范围闸门 + 记历史。历史词那颗 chip 与表单提交走同一条路 ——
   * chip 以前自己拼一遍，绕过了"零个源就别搜"的守卫，于是被服务端当成"不限制"搜完全库。
   */
  const runSearch = (keyword?: string) => {
    const query = (keyword ?? search.keyword).trim()
    if (!query) return
    if (scopeMode !== 'all' && !scopeIds.length) {
      toast.warning(scopeMode === 'group' ? '这个分组里没有处于启用状态的书源，换一组或先去「书源」页启用' : '先选一个书源，或改用「全部书源」')
      return
    }
    if (keyword !== undefined) search.setKeyword(keyword)
    search.setSelectedSourceIds(scopeMode === 'all' ? null : scopeIds)
    recordHistory(query)
    search.startSearch()
  }
  const handleSearch = (event: FormEvent) => {
    event.preventDefault()
    runSearch()
  }
  const groupOptions = useMemo(() => {
    const tally = new Map<string, { total: number; ready: number }>()
    for (const source of sources) {
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
  }, [sources])
  const scopeIds = useMemo(() => {
    if (scopeMode === 'single') return search.selectedSourceId ? [search.selectedSourceId] : []
    if (scopeMode === 'group') return scopeGroup ? sources.filter(source => source.enabled && splitSourceGroups(source.group).includes(scopeGroup)).map(source => source.id) : []
    return []
  }, [scopeMode, scopeGroup, sources, search.selectedSourceId])
  // 提示要跟着本机状态走：一个停用源都没有时还写"停用的搜不到，需要时勾「含已停用」"，
  // 用户只会去找那个勾 —— 而它括号里明明写着 0。
  const disabledSourceCount = sources.length - enabledSourceCount
  const scopeHint = scopeMode === 'all'
    ? (disabledSourceCount === 0
        ? `库里 ${sources.length} 个书源全部处于启用状态，「全部书源」会挨个搜过去`
        : `库里 ${sources.length} 个书源，其中 ${enabledSourceCount} 个处于启用状态；「全部书源」只搜启用的这些`)
    : scopeMode === 'group'
      ? (scopeIds.length ? `将搜索该分组下 ${scopeIds.length} 个启用书源` : '该分组当前没有可搜的启用书源')
      : (search.selectedSourceId
        ? `只搜「${sources.find(source => source.id === search.selectedSourceId)?.name ?? '该书源'}」这一个源，结果最干净但也最容易空`
        : (disabledSourceCount === 0
            ? `下拉里是本机全部 ${sources.length} 个源，都在启用状态`
            : `下拉里只有启用中的 ${enabledSourceCount} 个源（停用的搜不到，需要时勾「含已停用」）`))
  const resumeIndex = search.openBook?.progress ? Math.min(Math.max(search.openBook.progress.chapterIndex, 0), Math.max(0, search.openBook.chapters.length - 1)) : 0
  const groups = useMemo(() => groupSearchResults(search.results), [search.results])
  const visibleGroups = useMemo(() => filterSearchGroups(groups, search.filters, search.keyword), [groups, search.filters, search.keyword])
  const hasFilters = !!search.filters.query.trim()
  // 三档展示形态与书架同一套词汇，但各存各的偏好（在书架看封面 ≠ 搜索时也想先看封面）。
  const [resultLayout, setResultLayout] = useState<ShelfLayout>(() => readSearchLayout())
  const chooseResultLayout = (next: ShelfLayout) => {
    setResultLayout(next)
    writeSearchLayout(next)
  }
  const completed = search.progress?.completedSources ?? 0
  const total = search.progress?.totalSources ?? 0
  const failures = search.progress?.failedSources ?? 0
  const empty = search.progress?.emptySources ?? 0

  return (
    <main className="library-page">
      <section className="library-hero">
        <span className="section-kicker">在线书库</span>
        <h1>找一本书，安静地读下去。</h1>
        <p>从已配置的书源搜索并继续上次阅读。</p>
        <form onSubmit={handleSearch}>
          <Icon name="search" />
          <input
            value={search.keyword}
            onChange={event => search.setKeyword(event.target.value)}
            placeholder="输入书名或作者"
          />
          {search.loading ? (
            <button
              key="stop-search-btn"
              type="button"
              className="primary-button"
              onClick={e => {
                e.preventDefault()
                e.stopPropagation()
                search.stopSearch()
              }}
            >
              停止搜索
            </button>
          ) : (
            <button
              key="start-search-btn"
              type="submit"
              className="primary-button"
            >
              搜索
            </button>
          )}
        </form>
        {history.length > 0 && (
          <div className="library-history" role="group" aria-label="最近搜索">
            <span className="library-history-label">最近搜索</span>
            <div className="library-history-chips">
              {history.map(item => (
                <button
                  key={item}
                  type="button"
                  className="library-history-chip"
                  onClick={() => runSearch(item)}
                >
                  {item}
                </button>
              ))}
              <button type="button" className="library-history-clear" onClick={() => { setHistory([]); writeSearchHistory([]) }} title="清空搜索历史">清空</button>
            </div>
          </div>
        )}
        <div className="library-scope">
          <span className="library-scope-label">搜索范围</span>
          <div className="library-scope-modes" role="group" aria-label="搜索范围">
            {([['all', '全部书源'], ['group', '按分组'], ['single', '指定书源']] as const).map(([key, label]) => (
              <button key={key} type="button" className={scopeMode === key ? 'active' : ''} onClick={() => setScopeMode(key)}>{label}</button>
            ))}
          </div>
          {scopeMode === 'group' && (
            <Select
              ariaLabel="按分组搜索"
              placeholder="选择分组"
              value={scopeGroup}
              onChange={setScopeGroup}
              options={groupOptions.map(item => ({ value: item.name, label: item.name, hint: `可搜 ${item.ready} / 共 ${item.total}` }))}
            />
          )}
          {scopeMode === 'single' && (
            <>
              <Select
                ariaLabel="指定书源搜索"
                placeholder={sources.length ? '选择书源' : '书源还在载入'}
                value={search.selectedSourceId}
                onChange={search.setSelectedSourceId}
                options={sourcePickerOptions(sources, includeDisabledSources)}
              />
              {/* 默认只列启用中的：停用的源选了必然搜不到，那正是"这个功能不能正常使用"的来源。
                  一个停用源都没有时这条勾不出现 —— 留着它只是让人去勾一个括号里写 0 的开关。 */}
              {disabledSourceCount > 0 && (
                <label className="library-scope-toggle">
                  <input type="checkbox" checked={includeDisabledSources} onChange={event => setIncludeDisabledSources(event.target.checked)} />
                  含已停用（{disabledSourceCount}）
                </label>
              )}
            </>
          )}
          <small className="library-scope-hint">{scopeHint}</small>
        </div>
        {/*
          搜完了但一本都没命中时也必须给一句结论。原来这一行只在 loading/stopped 时渲染，
          搜完空结果就整行消失、这一屏退回「快速入口」，用户看不出刚才发生过搜索
          （用户 2026-10-01：「指定源搜索还没做好」里就有这一半）。
        */}
        {(search.loading || search.stopped || (search.progress !== null && groups.length === 0)) && (
          <p className="library-search-status" role="status">
            {search.stopped
              ? `已停止，已获得 ${groups.length} 本书。`
              : search.loading
                ? `已获得 ${groups.length} 本书，已检查 ${completed} / ${total} 个书源${failures || empty ? `，失败 ${failures} 个、无结果 ${empty} 个` : ''}…`
                : `搜完了：检查 ${completed} / ${total} 个书源，命中 ${search.progress?.matchedSources ?? 0} 本`
                  + `${failures || empty ? `（失败 ${failures} · 无结果 ${empty}）` : ''}。`
                  + (scopeMode === 'single'
                    ? '这个源没返回这本书，换个书源或改个关键词再搜。'
                    : '没有一本书命中，换个关键词、换一组书源，或改用「全部书源」再搜。')}
          </p>
        )}
      </section>
      {groups.length === 0 && !search.loading && (
        <section className="library-idle" aria-label="快速入口">
          <a href="#shelf">
            <strong><Icon name="bookmark" /> 书架</strong>
          </a>
          <a href="#explore">
            <strong><Icon name="activity" /> 发现</strong>
          </a>
          <a href="#sources">
            <strong><Icon name="list" /> 书源</strong>
          </a>
        </section>
      )}
      {search.message && <p className="form-error library-message">{search.message}</p>}
      {groups.length > 0 && (
        <section className="library-results">
          <header>
            <h2>搜索结果</h2>
            <div className="library-results-tools">
              {/* 筛选与排序原来单独占一条工具条（用户 2026-10-09：挪进结果表头，省一整行） */}
              <label className="library-filter-inline">
                <Icon name="search" />
                <input
                  value={search.filters.query}
                  onChange={event => search.setFilters(current => ({ ...current, query: event.target.value }))}
                  placeholder="筛选书名或作者"
                  aria-label="筛选书名或作者"
                />
              </label>
              <small>{visibleGroups.length} 本书{hasFilters && ` / ${groups.length}`}</small>
              <span className="library-sort-picker">
                排序
                <Select
                  ariaLabel="搜索结果排序"
                  value={search.filters.sortMode}
                  onChange={value => search.setFilters(current => ({ ...current, sortMode: value as SortMode }))}
                  options={[
                    { value: 'smart', label: '智能推荐' },
                    { value: 'sources', label: '书源最多' },
                    { value: 'exact', label: '精准优先' },
                    { value: 'name', label: '书名 A-Z' },
                  ]}
                />
              </span>
              {/* 与书架同一套三档：网格看封面、列表看简介、紧凑列表一屏塞最多。 */}
              <div className="shelf-layout-picker" role="group" aria-label="搜索结果布局">
                <button
                  type="button"
                  className={resultLayout.mode === 'grid' ? 'active' : ''}
                  aria-label="封面网格"
                  title="封面网格：一行多张封面，挑书先看脸"
                  onClick={() => chooseResultLayout({ mode: 'grid' })}
                >
                  <Icon name="columns" />
                </button>
                <button
                  type="button"
                  className={resultLayout.mode === 'list' ? 'active' : ''}
                  aria-label="列表"
                  title="列表：一行一本，右边显示简介"
                  onClick={() => chooseResultLayout({ mode: 'list' })}
                >
                  <Icon name="list" />
                </button>
                <button
                  type="button"
                  className={resultLayout.mode === 'compact' ? 'active' : ''}
                  aria-label="紧凑列表"
                  title="紧凑列表：只看书名、作者与来源数，一屏放最多"
                  onClick={() => chooseResultLayout({ mode: 'compact' })}
                >
                  <Icon name="menu" />
                </button>
              </div>
            </div>
          </header>
            {/*
              三档共用同一份 DOM（与书架同一套做法）：切换只改容器类名，
              由 CSS 决定封面、简介、hover 层谁显示 —— 换档不重新拉数据，也不改变点击行为。
            */}
            <div className={`search-grid search-mode-${resultLayout.mode}`}>
              {visibleGroups.map(group => {
                const isExact = isExactMatch(group, search.keyword)
                // 同书多源的类型：全部一致才挂徽标（音频/漫画/文件/视频）
                const groupType = commonBookType(group.sources.map(source => source.sourceType))
                const groupTypeMeta = bookTypeMeta(groupType)
                // 封面取第一个真给了地址的源；referer 也用它 —— 防盗链图站按来源放行
                const coverSource = group.sources.find(source => source.coverUrl?.trim())
                const cover = sanitizeImageUrl(coverSource?.coverUrl)
                const blurb = pickBlurb(group)
                return (
                  <button
                    key={group.key}
                    type="button"
                    className={`search-card ${isExact ? 'exact-match' : ''}`}
                    onClick={() => void search.openGroup(group)}
                    aria-label={`打开《${group.name}》${group.author ? `，作者 ${group.author}` : ''}，${group.sources.length} 个书源`}
                  >
                    <span className="search-card-cover">
                      <SearchCover cover={cover} name={group.name} author={group.author} referer={coverSource?.sourceId} />
                      {/* 列表态封面只有 48px，完整文字书封塞不下 —— 换两字版（DOM 共用，CSS 按档切换） */}
                      <span className="search-card-cover-mini"><CoverFallback name={group.name} author={group.author} compact /></span>
                      <span className="search-card-hover">
                        <strong>{group.name}</strong>
                        <p>{group.author || '未知作者'}</p>
                        <dl>
                          <div><dt>来源</dt><dd>{group.sources.length} 个书源</dd></div>
                          {isExact && <div><dt>匹配</dt><dd>书名与关键词一致</dd></div>}
                          <div><dt>简介</dt><dd>{group.sources.some(source => source.intro?.trim()) ? '有' : '无'}</dd></div>
                        </dl>
                        <span>点击查看这本书</span>
                      </span>
                    </span>
                    <strong className="search-card-name" title={group.name}><HighlightText text={group.name} keyword={search.keyword} /></strong>
                    {groupTypeMeta && <span className={`book-type-badge type-${groupType}`}>{groupTypeMeta.label}</span>}
                    <small className="search-card-author">{group.author || '未知作者'}</small>
                    <small className="search-card-sources">{group.sources.length} 个书源{isExact ? ' · 精准匹配' : ''}</small>
                    {/* 只有列表档显示：挑书时最该看的是这本书讲什么，而不是又一个书名。没简介也没最新章就整栏不渲染。 */}
                    {blurb && <small className="search-card-intro">{blurb}</small>}
                  </button>
                )
              })}
            </div>
            {visibleGroups.length === 0 && <p className="library-filter-empty">没有符合当前筛选条件的书籍。</p>}
          </section>
      )}
      {search.openBook && (
        <BookDetailModal
          book={search.openBook}
          choices={search.choices}
          sources={sources}
          onSourcesChanged={onSourcesChanged}
          resumeIndex={resumeIndex}
          onOpen={index => onOpen(search.openBook!, index)}
          onChooseSource={choice => void search.chooseSource(choice)}
          onClose={() => search.setOpenBook(null)}
        />
      )}
    </main>
  )
}

