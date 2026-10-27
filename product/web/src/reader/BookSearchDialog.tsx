import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type BookSearchHit } from '../lib/api'
import { useEscapeClose } from '../lib/useEscapeClose'

/**
 * 本书正文检索（搜索本书 feature，2026-10）：在**已离线缓存**的章节正文里按关键词找命中。
 *
 * 为什么要强调「已缓存」：正文不在本地库时不落盘，检索只能扫 `book_content_cache`
 * 里这本书缓存到的章节；没缓存的自然搜不到。前端这里如实提示，不假装全文检索引擎。
 *
 * 复用既有的 `.overlay-backdrop` + `.dialog-shell.size-m` + `.dialog-head` 一档外壳
 * （UiContract 要求几何走这一档，不另写），只新增内容样式，不新增令牌。
 */
export function BookSearchDialog({ sourceId, bookUrl, onJump, onClose }: {
  sourceId: string
  bookUrl: string
  /** 跳到命中章：调用方负责切章并关弹窗。 */
  onJump: (chapterIndex: number) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<BookSearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // 打开即聚焦。
  useEffect(() => { inputRef.current?.focus() }, [])
  // Esc 关闭（统一走项目那套 useEscapeClose，UiContract 判据盯着这个 token）。
  useEscapeClose(onClose)

  // 输入防抖后检索；空词不查。
  const debounced = useMemo(() => query.trim(), [query])
  useEffect(() => {
    if (!debounced) { setResults([]); setDone(false); setLoading(false); return }
    const handle = window.setTimeout(async () => {
      setLoading(true)
      const hits = await api.bookSearch(sourceId, bookUrl, debounced).catch(() => [])
      // 仅当这次的结果对应最新一次输入时才落状态（避免竞态把旧结果盖回新词）。
      setResults(hits)
      setDone(true)
      setLoading(false)
    }, 300)
    return () => window.clearTimeout(handle)
  }, [debounced, sourceId, bookUrl])

  return (
    <div className="overlay-backdrop" onClick={onClose} role="dialog" aria-label="搜索本书" aria-modal="true">
      <div className="dialog-shell size-m reader-book-search" onClick={event => event.stopPropagation()}>
        <header className="dialog-head">
          <h2>搜索本书</h2>
          <small>只在已离线缓存的章节正文里检索；没缓存的章节搜不到。</small>
        </header>
        <div className="reader-book-search-body">
          <div className="reader-book-search-input">
            <input
              ref={inputRef}
              type="search"
              value={query}
              placeholder="输入关键词，回车或停顿即检索"
              onChange={event => setQuery(event.target.value)}
            />
          </div>
          {loading && <p className="reader-book-search-status">检索中…</p>}
          {!loading && done && results.length === 0 && (
            <p className="reader-book-search-status">没有命中。可能这一章还没缓存，或换个词试试。</p>
          )}
          {!debounced && <p className="reader-book-search-status">输入关键词开始检索。</p>}
          <ul className="reader-book-search-list">
            {results.map(hit => (
              <li key={`${hit.chapterUrl}-${hit.chapterIndex}`} className="reader-book-search-item">
                <button type="button" className="reader-book-search-main" onClick={() => onJump(hit.chapterIndex)}>
                  <span className="reader-book-search-chapter">第 {hit.chapterIndex + 1} 章 · {hit.title || '（无标题）'}</span>
                  <span className="reader-book-search-snippet">{hit.snippet}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
