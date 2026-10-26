import React, { useEffect, useMemo, useState } from 'react'
import { api, type ExploreTab, type SearchResult, type SourceSummary } from '../lib/api'
import { Icon } from '../icons'
import { Select } from '../components/Select'
import { filterByGroup, sourceGroups, UNGROUPED } from '../lib/exploreGroups'
import { labelExploreTabs } from '../lib/exploreLabel'
import { sanitizeImageUrl } from '../sources/sourceImport'
import { DeferredCover } from '../shelf/Cover'

export interface ExplorePageProps {
  onOpen: (book: SearchResult) => Promise<void>
}

/** 「发现」页：读取书源的 exploreUrl 分栏，按 Legado 语义列出推荐书籍。 */
export function ExplorePage({ onOpen }: ExplorePageProps) {
  const [sources, setSources] = useState<SourceSummary[]>([])
  // 「没取到」和「取到了但是空的」必须分开：以前只有 sources=[] 一种状态，
  // 于是列表请求失败时界面照样写着「加载中…」+「0 个书源配了发现页」—— 两句都是谎话。
  const [sourcesFailed, setSourcesFailed] = useState(false)
  const [sourceId, setSourceId] = useState('')
  const [tabs, setTabs] = useState<ExploreTab[]>([])
  const [tab, setTab] = useState<ExploreTab | null>(null)
  const [books, setBooks] = useState<SearchResult[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [message, setMessage] = useState('')
  const [tabsExpanded, setTabsExpanded] = useState(false)
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [group, setGroup] = useState('')
  // 「发现页书源也能按照分组搜索」（用户 2026-10-02）：配了发现页的源有两千多个，
  // 光靠名字搜不出来 —— 分组才是人挑源用的那把尺，和「书源」页同一套词汇与同一个「未分组」约定。
  const groupStats = useMemo(() => sourceGroups(sources), [sources])
  const pickable = useMemo(() => filterByGroup(sources, group), [sources, group])
  const chooseGroup = (next: string) => {
    setGroup(next)
    const list = filterByGroup(sources, next)
    if (!list.some(item => item.id === sourceId)) setSourceId(list[0]?.id ?? '')
  }
  // 分栏名清洗（去 emoji 与花饰）与重名编号都在 `lib/exploreLabel.ts`，判据在 `ExploreLabel.test.ts`
  const labelledTabs = useMemo(() => labelExploreTabs(tabs), [tabs])
  const activeLabel = labelledTabs.find(item => item.url === tab?.url)?.label ?? '发现'

  useEffect(() => {
    void api.exploreSources().then(list => {
      setSources(list)
      setSourcesFailed(false)
      setSourceId(current => current || list[0]?.id || '')
    // 取失败只把状态标出来：计数位与下拉占位已经写着「没取到书源列表」，
    // 不必再补一句"下面显示 0 个不是没有书源"——那种解释界面自己的话对使用者没用。
    }).catch(() => { setSourcesFailed(true) })
  }, [])

  useEffect(() => {
    if (!sourceId) return
    let cancelled = false
    const controller = new AbortController()
    // 聚合源的 exploreUrl 本身就是一段 JS（番茄那份要跑 400+ 个分栏），15 秒会误杀，给到 45 秒。
    const timer = setTimeout(() => controller.abort(), 45000)
    setBooks([])
    setTabs([])
    setTab(null)
    setStatus('loading')
    void api.exploreTabs(sourceId, controller.signal).then(list => {
      if (cancelled) return
      setTabs(list)
      setTab(list[0] ?? null)
      if (!list.length) {
        setStatus('idle')
        setMessage('这本书源没有配置发现页（exploreUrl）。')
      }
    }).catch(error => {
      if (cancelled) return
      setStatus('failed')
      setMessage(controller.signal.aborted ? '发现页配置读取超时，换个书源试试。' : String(error.message || '发现页解析失败'))
    }).finally(() => clearTimeout(timer))
    return () => { cancelled = true; clearTimeout(timer); controller.abort() }
  }, [sourceId])

  useEffect(() => {
    if (!sourceId || !tab) return
    let cancelled = false
    // 死书源会让发现页一直转圈：25 秒后主动断开并给出可重试的提示。
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 25000)
    setStatus('loading')
    setMessage('')
    setPage(1)
    setHasMore(true)
    void api.explore(sourceId, tab.url, 1, controller.signal).then(async list => {
      if (cancelled) return
      setBooks(list)
      setStatus('ready')
      setHasMore(list.length > 0)
      if (list.length) return
      // 「空」有两种完全不同的原因，混成一句"换一个试试"是在骗人：
      // 番茄的「番茄书架」那一栏打在 fanqienovel.com 的个人书架接口上，匿名访问它就是返回
      // 空数组（不报错），实测同一时刻同源的公开榜单能出 30 本 —— 所以缺的是凭据，不是栏目坏了。
      if (!tab.url.startsWith('http')) {
        setMessage('这个分栏没有返回书籍（它的地址由书源脚本生成，无法判断是否需要登录）。')
        return
      }
      try {
        const credential = await api.sourceCredential(sourceId, tab.url)
        if (cancelled) return
        setMessage(credential.has
          ? `这一栏返回 0 本：${credential.domain} 上已有凭据，可能是站点自己没内容或该书源规则不匹配。`
          : `这一栏需要登录：${credential.domain} 上还没有凭据。到书源的「登录」里用真浏览器登录或粘贴 Cookie 后再试。`)
      } catch {
        setMessage('这个分栏没有返回书籍，换一个试试。')
      }
    }).catch(error => {
      if (cancelled) return
      setStatus('failed')
      setMessage(controller.signal.aborted ? '这本书源 25 秒内没有响应，换个书源或分栏再试。' : String(error.message || '发现页取书失败'))
    }).finally(() => clearTimeout(timer))
    return () => { cancelled = true; clearTimeout(timer); controller.abort() }
  }, [sourceId, tab])

  const coverOf = (book: SearchResult) => sanitizeImageUrl(book.coverUrl)

  const open = async (book: SearchResult) => {
    setStatus('loading')
    setMessage('')
    try {
      await onOpen(book)
      setStatus('ready')
    } catch (error) {
      setStatus('failed')
      setMessage(String(error instanceof Error ? error.message : '这本书打不开'))
    }
  }

  // 发现页支持 {{page}} 翻页：下一页按 bookUrl 去重后追加；返回空或整页都是重复即判定到底。
  const loadMore = async () => {
    if (!sourceId || !tab || loadingMore || !hasMore || tab.supportsPaging === false) return
    setLoadingMore(true)
    const next = page + 1
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 25000)
    try {
      const list = await api.explore(sourceId, tab.url, next, controller.signal)
      const seen = new Set(books.map(b => b.bookUrl))
      const added = list.filter(b => !seen.has(b.bookUrl))
      if (added.length > 0) setBooks(prev => {
        const dedup = new Set(prev.map(b => b.bookUrl))
        return [...prev, ...list.filter(b => !dedup.has(b.bookUrl))]
      })
      if (list.length === 0 || added.length === 0) setHasMore(false)
      else setPage(next)
    } catch {
      // 以前这里 setHasMore(false)：一次翻页失败就把「加载更多」按钮永久收掉，
      // 界面读起来像"这一页就是最后一屏"。失败要留在原地让人能再点一次。
      setMessage('这一页没取到，可以再点一次「加载更多」')
    } finally {
      clearTimeout(timer)
      setLoadingMore(false)
    }
  }

  return (
    <main className="explore-page">
      <header className="explore-header">
        <div>
          <h1>发现</h1>
        </div>
        {/*
          用户 2026-09-30：「我发现页也用不到这个在这个源里搜书名，需要的是搜对应书源」。
          上一轮加的"源内直搜"打偏了：发现页缺的是**从两千多个配了发现页的源里挑到一个**，
          不是把书库搜索在这儿重摆一遍。所以删掉那个表单，把选源本身做成一眼看得懂的搜索口：
          标签写「搜书源」、过滤框常驻（不等选项变多才自动冒出来）、并报出可发现的总数。
        */}
        <div className="explore-source-picker">
          <span>搜书源</span>
          {groupStats.groups.length > 0 && (
            <Select
              className="explore-group-select"
              ariaLabel="按分组筛选发现页书源"
              value={group}
              onChange={chooseGroup}
              options={[
                { value: '', label: `全部分组 (${sources.length})` },
                ...groupStats.groups.map(([name, count]) => ({ value: name, label: `${name} (${count})` })),
                { value: UNGROUPED, label: `未分组 (${groupStats.ungrouped})` },
              ]}
            />
          )}
          <Select
            ariaLabel="搜索并选择发现页书源"
            placeholder={sourcesFailed ? '书源列表没取到' : sources.length ? (pickable.length ? '按名称或分组搜书源' : '这个分组里没有书源') : '加载中…'}
            value={sourceId}
            onChange={setSourceId}
            searchable
            options={pickable.map(item => ({ value: item.id, label: item.name, hint: item.group?.trim() || undefined }))}
          />
          <small className="explore-source-count">
            {sourcesFailed ? '没取到书源列表' : `${group ? `${pickable.length} / ${sources.length}` : sources.length} 个书源配了发现页`}
          </small>
        </div>
      </header>

      {tabs.length > 0 && (
        <>
          {/* 「N 本书」原来挂在下面结果卡片的表头里，跟分栏按钮离着一屏 —— 用户 2026-10-09
              「分栏按钮计数位置」，挪到分栏这一行的右端，选了哪个分栏、这个分栏几本书一眼看全。 */}
          <div className="explore-tabs-row">
            <nav className={tabsExpanded ? 'explore-tabs expanded' : 'explore-tabs'} aria-label="发现分栏">
              {(tabsExpanded ? labelledTabs : labelledTabs.slice(0, 22)).map(item => (
                <button
                  key={`${item.title}::${item.url}`}
                  type="button"
                  className={tab?.url === item.url ? 'explore-tab active' : 'explore-tab'}
                  onClick={() => setTab(item)}
                >
                  {item.label}
                </button>
              ))}
              {/* 展开开关收在分栏末尾、与分栏同尺寸（用户 2026-10-09：不要单独一行的大按钮） */}
              {tabs.length > 22 && (
                <button
                  type="button"
                  className="explore-tab explore-tabs-toggle"
                  aria-expanded={tabsExpanded}
                  onClick={() => setTabsExpanded(value => !value)}
                >
                  {tabsExpanded ? '收起' : `全部 ${tabs.length}`}
                </button>
              )}
            </nav>
            {books.length > 0 && <small className="explore-tab-count">{books.length} 本书</small>}
          </div>
        </>
      )}

      {message && <p className="explore-message">{message}</p>}

      {books.length > 0 && (
        <section className="explore-results">
          <header><h2>{activeLabel}</h2></header>
          <div className="explore-grid">
            {books.map((book, index) => (
              <button type="button" key={`${book.sourceId}::${book.bookUrl}::${index}`} className="explore-card" onClick={() => void open(book)}>
                <span className="explore-cover">
                  <DeferredCover cover={coverOf(book) ?? null} name={book.name} author={book.author} referer={book.sourceId} />
                </span>
                <strong title={book.name}>{book.name}</strong>
                <small>{book.author || '未知作者'}</small>
                {(book.kind || book.lastChapter || book.wordCount) && (
                  <small>{[book.kind, book.wordCount, book.lastChapter].filter(Boolean).join(' · ')}</small>
                )}
              </button>
            ))}
          </div>
          {/* 这一栏吃不吃页码由服务端按规则写法判（`supportsPaging`）：不吃就不挂这颗永远白发一次请求的按钮。 */}
          {tab?.supportsPaging !== false && hasMore && (
            <div className="explore-more-row">
              <button type="button" className="ghost-button" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? '加载中…' : '加载更多'}
              </button>
            </div>
          )}
        </section>
      )}

      {status === 'loading' && (
        <div className="explore-loading"><Icon name="refresh" /><span>正在读取发现页…</span></div>
      )}
    </main>
  )
}
