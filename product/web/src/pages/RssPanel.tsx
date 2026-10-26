import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type ExploreTab, type RssArticle, type RssSourceSummary } from '../lib/api'
import { Icon } from '../icons'
import { useEscapeClose } from '../lib/useEscapeClose'
import { Notice } from '../components/Notice'
import { EmptyGuide } from '../shelf/EmptyGuide'
import { Select } from '../components/Select'
import { exploreLabel } from '../lib/exploreLabel'
import { rssImageSrc } from '../lib/rssImage'

/**
 * 「订阅」页的主体：手机 Legado「订阅」页那一栏（`rssSources.json`），即要**读**的 RSS 源。
 *
 * 书源订阅（远程书源 JSON 直链，上游 `RuleSub`）不在这张页里 —— 它的产物是书源，
 * 在「书源」页的「订阅地址」档（`sources/SourceSubscriptionPanel.tsx`）。
 */
export function RssPanel({ onOpenBackup }: { onOpenBackup: () => void }) {
  const [sources, setSources] = useState<RssSourceSummary[]>([])
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState('')
  /**
   * 默认只看"配了列表规则、真能读出文章"的那批。
   *
   * 依据是普查（tools/verify/rss-census.mjs + 读库核对字段名）：本机 176 条 RSS 源里
   * 只有 65 条带非空 `ruleArticles`，16 条真能出文章。剩下 111 条不是"我们解析不了"，
   * 是手机那侧本来就没给它们配列表规则 —— 在 App 上它们也只能打开原页。
   * 让 111 条读不出东西的行占满列表，用户滚两屏就得出"这功能坏了"的结论；
   * 所以默认收起来，但**不删数据**，勾一下就能看见（它们是可以自己补规则的模板）。
   */
  const [onlyReadable, setOnlyReadable] = useState(true)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')
  const [opened, setOpened] = useState<RssSourceSummary | null>(null)
  const [article, setArticle] = useState<RssArticle | null>(null)
  const [importing, setImporting] = useState(false)
  const [importText, setImportText] = useState('')
  /**
   * 第一份列表到手之前不许说"还没有 RSS 订阅源"。
   * 本机有 178 条，但负载下这一屏会先闪一张空态卡 —— 那就是把"还没载入完"
   * 渲染成"你一条都没有"（书架分组那条 `.catch(() => [])` 是同一个病，见能力波 v27）。
   */
  const [loaded, setLoaded] = useState(false)
  const importRef = useRef<HTMLTextAreaElement>(null)

  const load = useCallback(async () => {
    try { setSources(await api.rssSources()) }
    catch (error) { setNotice(error instanceof Error ? error.message : '无法载入订阅源') }
    finally { setLoaded(true) }
  }, [])
  useEffect(() => { void load() }, [load])

  // 搜索交服务端做（源可能有几百个），输入停顿 250ms 再发，边打边查会打爆接口
  useEffect(() => {
    const timer = setTimeout(() => { void load() }, 250)
    return () => clearTimeout(timer)
  }, [query, load])

  const groups = useMemo(() => {
    const counts = new Map<string, number>()
    sources.forEach(item => item.group?.split(',').forEach(raw => {
      const name = raw.trim()
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
    }))
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN'))
  }, [sources])

  const readableCount = useMemo(() => sources.filter(item => item.hasListRule).length, [sources])
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const text = needle ? sources.filter(item =>
      item.name.toLowerCase().includes(needle) || item.sourceUrl.toLowerCase().includes(needle) || (item.group ?? '').toLowerCase().includes(needle)) : sources
    const byGroup = group ? text.filter(item => (item.group ?? '').split(',').map(name => name.trim()).includes(group)) : text
    return onlyReadable ? byGroup.filter(item => item.hasListRule) : byGroup
  }, [sources, query, group, onlyReadable])

  const toggle = async (item: RssSourceSummary) => {
    setBusy(item.sourceUrl)
    try { await api.setRssSourceEnabled(item.sourceUrl, !item.enabled); await load() }
    catch (error) { setNotice(error instanceof Error ? error.message : '更新失败') }
    finally { setBusy('') }
  }

  const remove = async (item: RssSourceSummary) => {
    if (!confirm(`删除订阅源“${item.name}”？`)) return
    setBusy(item.sourceUrl)
    try { await api.removeRssSource(item.sourceUrl); await load() }
    catch (error) { setNotice(error instanceof Error ? error.message : '删除失败') }
    finally { setBusy('') }
  }

  const openImport = () => {
    setImporting(true)
    window.setTimeout(() => importRef.current?.focus(), 0)
  }

  const submitImport = async (event: React.FormEvent) => {
    event.preventDefault()
    const raw = importText.trim()
    if (!raw) return
    let payloads: string[]
    try {
      const parsed: unknown = JSON.parse(raw)
      const list = Array.isArray(parsed) ? parsed : [parsed]
      payloads = list.map(item => JSON.stringify(item))
    } catch {
      setNotice('粘贴的内容不是合法 JSON：可以是单个 RSS 源对象，也可以是数组')
      return
    }
    setBusy('import')
    try {
      const result = await api.addRssSources(payloads)
      setNotice(`导入完成：新增 ${result.imported}，更新 ${result.updated}${result.errors.length ? `，失败 ${result.errors.length} 项（${result.errors[0]}）` : ''}`)
      setImportText('')
      setImporting(false)
      await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '导入失败') }
    finally { setBusy('') }
  }

  if (opened) {
    return <RssArticles source={opened} onBack={() => setOpened(null)} onOpenArticle={setArticle} article={article} />
  }

  return (
    <section className="subscription-panel rss-panel">
      <header>
        <div>
          <h2>RSS 订阅源</h2>
          <p>备份包里的 <code>rssSources.json</code> 会直接恢复到这张列表；条目是现取上游站点的，源站挂了会在这一行直说取不到。</p>
        </div>
        <button type="button" className="subtle-button" onClick={() => (importing ? setImporting(false) : openImport())}>{importing ? '收起' : '粘贴 JSON 添加'}</button>
      </header>
      {importing && (
        <form className="rss-import" onSubmit={submitImport}>
          <textarea
            ref={importRef}
            value={importText}
            onChange={event => setImportText(event.target.value)}
            placeholder={'[{"sourceUrl":"https://example.com","sourceName":"示例","ruleArticles":"…","ruleTitle":"…"}]'}
            rows={6}
          />
          <button type="button" className="primary-button" disabled={busy === 'import'} onClick={event => void submitImport(event)}>
            {busy === 'import' ? '导入中…' : '导入这批订阅源'}
          </button>
        </form>
      )}
      {sources.length > 0 && (
        <div className="rss-filter">
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索订阅源名称或地址" aria-label="搜索订阅源" />
          {groups.length > 0 && (
            <Select
              ariaLabel="按分组筛选订阅源"
              value={group}
              onChange={setGroup}
              placeholder="全部分组"
              options={[
                { value: '', label: `全部分组（${sources.length}）` },
                ...groups.map(([name, count]) => ({ value: name, label: `${name}（${count}）` })),
              ]}
            />
          )}
          {/* 默认收掉"没配列表规则"的那批：它们不是坏源，但也确实读不出东西 */}
          {sources.length > readableCount && (
            <label className="rss-readable-toggle" title="没配 ruleArticles 的源列不出条目、只能打开原页，默认先收起来">
              <input type="checkbox" checked={onlyReadable} onChange={event => setOnlyReadable(event.target.checked)} />
              只看能读的（{readableCount} / {sources.length}）
            </label>
          )}
        </div>
      )}
      <Notice text={notice} />
      <div className="subscription-list">
        {sources.length === 0 && loaded && !notice && (
          <EmptyGuide
            icon="rss"
            title="还没有 RSS 订阅源"
            body={<>这张列表对应 Legado「订阅」页那一栏（备份包里的 <code>rssSources.json</code>）。源存在本机，条目要现取上游站点。</>}
            actions={[
              { label: '粘贴 RSS JSON 添加', onClick: openImport, primary: true, icon: 'plus' },
              { label: '去导入备份包', onClick: () => onOpenBackup(), icon: 'importFile' },
            ]}
          />
        )}
        {visible.length === 0 && sources.length > 0 && (
          <p className="rss-no-match">
            没有匹配的订阅源。
            {(query || group || onlyReadable) && (
              <button type="button" className="link-button" onClick={() => { setQuery(''); setGroup(''); setOnlyReadable(true) }}>清空筛选</button>
            )}
            {onlyReadable && readableCount < sources.length && (
              <button type="button" className="link-button" onClick={() => setOnlyReadable(false)}>
                连读不出的 {sources.length - readableCount} 条一起看
              </button>
            )}
          </p>
        )}
        {visible.map(item => (
          <article key={item.sourceUrl} className={item.enabled ? '' : 'rss-source-off'}>
            <button type="button" className="rss-source-main" onClick={() => setOpened(item)}>
              <strong>{item.name}</strong>
              <small>{item.sourceUrl}</small>
              {(item.group || !item.hasListRule) && (
                <span className="rss-source-tags">
                  {item.group && item.group.split(',').map(name => <em key={name}>{name}</em>)}
                  {!item.hasListRule && <em className="rss-warn">没写列表规则，只能打开原页</em>}
                </span>
              )}
            </button>
            <div className="subscription-actions">
              <button type="button" className="subtle-button" onClick={() => void toggle(item)} disabled={busy === item.sourceUrl}>{item.enabled ? '已启用' : '已停用'}</button>
              <button type="button" className="shelf-remove" aria-label={`删除订阅源 ${item.name}`} onClick={() => void remove(item)} disabled={busy === item.sourceUrl}><Icon name="close" /></button>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

/** 一个 RSS 源的栏目 + 文章列表（对应上游 `RssSortActivity` 与 `RssArticlesFragment`）。 */
function RssArticles({ source, onBack, onOpenArticle, article }: {
  source: RssSourceSummary
  onBack: () => void
  onOpenArticle: (item: RssArticle | null) => void
  article: RssArticle | null
}) {
  const [tabs, setTabs] = useState<ExploreTab[]>([])
  const [tab, setTab] = useState<ExploreTab | null>(null)
  const [articles, setArticles] = useState<RssArticle[]>([])
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [message, setMessage] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 45000)
    setStatus('loading')
    setMessage('')
    void api.rssTabs(source.sourceUrl, controller.signal).then(list => {
      if (cancelled) return
      setTabs(list)
      setTab(list[0] ?? null)
      if (!list.length) { setStatus('idle'); setMessage('这个订阅源没有返回栏目。') }
    }).catch(error => {
      if (cancelled) return
      setStatus('failed')
      setMessage(controller.signal.aborted ? '读取栏目超时（有的源整段栏目由脚本生成，会慢）。' : String(error instanceof Error ? error.message : '栏目读取失败'))
    }).finally(() => clearTimeout(timer))
    return () => { cancelled = true; clearTimeout(timer); controller.abort() }
  }, [source.sourceUrl])

  useEffect(() => {
    if (!tab) return
    let cancelled = false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30000)
    setStatus('loading')
    setMessage('')
    setPage(1)
    setArticles([])
    void api.rssArticles(source.sourceUrl, tab.url, 1, controller.signal).then(list => {
      if (cancelled) return
      setArticles(list)
      setHasMore(list.length > 0)
      setStatus('ready')
      if (!list.length) setMessage('这一栏没有返回文章。')
    }).catch(error => {
      if (cancelled) return
      setStatus('failed')
      setMessage(controller.signal.aborted ? '这一栏 30 秒内没有响应，换个栏目试试。' : String(error instanceof Error ? error.message : '取文章失败'))
    }).finally(() => clearTimeout(timer))
    return () => { cancelled = true; clearTimeout(timer); controller.abort() }
  }, [source.sourceUrl, tab])

  const loadMore = async () => {
    if (!tab || loadingMore) return
    setLoadingMore(true)
    const next = page + 1
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30000)
    try {
      const list = await api.rssArticles(source.sourceUrl, tab.url, next, controller.signal)
      const seen = new Set(articles.map(item => item.link || item.title))
      const added = list.filter(item => !seen.has(item.link || item.title))
      if (added.length) setArticles(prev => [...prev, ...added])
      setPage(next)
      if (!list.length || !added.length) setHasMore(false)
    } catch {
      setHasMore(false)
    } finally {
      clearTimeout(timer)
      setLoadingMore(false)
    }
  }

  return (
    <section className="subscription-panel rss-articles">
      <header>
        <div>
          <span className="section-kicker">RSS 订阅</span>
          <h2>{source.name}</h2>
          <p>{source.group || source.sourceUrl}</p>
        </div>
        <button type="button" className="subtle-button" onClick={onBack}><Icon name="arrowLeft" />订阅源</button>
      </header>
      {tabs.length > 1 && (
        <nav className="explore-tabs" aria-label="RSS 栏目">
          {tabs.map(item => (
            <button type="button" key={`${item.title}::${item.url}`} className={tab?.url === item.url ? 'explore-tab active' : 'explore-tab'} onClick={() => setTab(item)}>{exploreLabel(item.title)}</button>
          ))}
        </nav>
      )}
      {message && <p className="explore-message">{message}</p>}
      {status === 'loading' && <div className="explore-loading"><Icon name="refresh" /><span>正在读取文章…</span></div>}
      {articles.length > 0 && (
        <div className="rss-article-list">
          {articles.map((item, index) => (
            <button type="button" key={`${item.link || item.title}::${index}`} className="rss-article" onClick={() => onOpenArticle(item)}>
              {rssImageSrc(item.image, item.link)
                ? <img className="rss-article-image" src={rssImageSrc(item.image, item.link)!} alt="" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.display = 'none' }} />
                : null}
              <span className="rss-article-body">
                <strong>{item.title}</strong>
                {item.description && <small>{item.description.slice(0, 160)}</small>}
                {item.pubDate && <em>{item.pubDate}</em>}
              </span>
            </button>
          ))}
        </div>
      )}
      {/* 「下一页」只在服务端判定这一栏吃页码时出现（与发现页同一条判据，见 `PagingRule.kt`） */}
      {hasMore && articles.length > 0 && status === 'ready' && tab?.supportsPaging !== false && (
        <div className="explore-more-row">
          <button type="button" className="ghost-button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? '加载中…' : '下一页'}</button>
        </div>
      )}
      {article && <RssReader source={source} article={article} onClose={() => onOpenArticle(null)} />}
    </section>
  )
}

/**
 * 文章正文。服务端只在源写了 `ruleContent` 时才提取，取不到就退回列表里已有的描述，
 * 并始终给出「打开原页」——RSS 的站点千差万别，不假装我们都能抽干净。
 */
function RssReader({ source, article, onClose }: { source: RssSourceSummary; article: RssArticle; onClose: () => void }) {
  const [content, setContent] = useState('')
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [message, setMessage] = useState('')

  useEscapeClose(onClose)

  useEffect(() => {
    if (!article.link) {
      // 规则没写 ruleLink 的源不少见：条目本身没有可取的地址，只能给摘要 + 原页
      setState('failed')
      setMessage('这一条没有解析出文章地址（ruleLink 为空）。')
      return
    }
    let cancelled = false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30000)
    setState('loading')
    setContent('')
    void api.rssContent(source.sourceUrl, article.link, controller.signal).then(result => {
      if (cancelled) return
      setContent(result.content)
      setState('ready')
    }).catch(error => {
      if (cancelled) return
      setMessage(controller.signal.aborted ? '正文读取超时。' : String(error instanceof Error ? error.message : '正文读取失败'))
      setState('failed')
    }).finally(() => clearTimeout(timer))
    return () => { cancelled = true; clearTimeout(timer); controller.abort() }
  }, [source.sourceUrl, article.link])

  return (
    <div className="overlay-backdrop is-flush" role="presentation" onClick={event => { if (event.target === event.currentTarget) onClose() }}>
      <article className="dialog-shell size-m rss-reader" role="dialog" aria-modal="true" aria-label={article.title}>
        <header>
          <div>
            <h2>{article.title}</h2>
            <small>{source.name}{article.pubDate ? ` · ${article.pubDate}` : ''}</small>
          </div>
          <button type="button" className="overlay-close" onClick={onClose} aria-label="关闭文章"><Icon name="close" /></button>
        </header>
        {rssImageSrc(article.image, article.link || source.sourceUrl) && <img className="rss-reader-image" src={rssImageSrc(article.image, article.link || source.sourceUrl)!} alt="" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.display = 'none' }} />}
        {state === 'loading' && <p className="explore-message">正在取正文…</p>}
        {state === 'ready' && content.split(/\n{2,}/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}
        {state === 'failed' && (
          <>
            <p className="explore-message">{message}</p>
            {article.description && <div className="rss-reader-fallback"><h3>列表里的摘要</h3><p>{article.description}</p></div>}
          </>
        )}
        {article.link && <footer><a href={article.link} target="_blank" rel="noopener noreferrer">打开原页</a></footer>}
      </article>
    </div>
  )
}
