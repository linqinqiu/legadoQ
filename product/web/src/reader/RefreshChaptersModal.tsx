import { useMemo, useRef, useState } from 'react'
import { Icon } from '../icons'
import type { Chapter } from '../lib/api'
import { api } from '../lib/api'
import { useEscapeClose } from '../lib/useEscapeClose'

/**
 * 手动刷新正文（0.2.0）：正文平时一律先吃缓存，站点改了错字/补了内容时读者只能干等。
 *
 * 这里只做一件事 —— 把选中的章节**明确**回源重取并覆盖缓存，单章或一批都行。
 * 不碰目录、不碰进度：刷新不是重新拉书。
 */
type RefreshMode = 'current' | 'count' | 'range' | 'cached'

interface RefreshChaptersModalProps {
  sourceId: string
  bookUrl: string
  chapters: Chapter[]
  currentIndex: number
  cachedUrls: Set<string>
  onClose: () => void
  /** 刷新成功（或被停止前已完成）的章节地址；调用方据此重载当前正文与续接段。 */
  onRefreshed: (chapterUrls: string[]) => void
}

const CHUNK_SIZE = 5
const MAX_COUNT = 200

function readableChapters(chapters: Chapter[]): Chapter[] {
  return chapters.filter(chapter => !chapter.isVolume && !!chapter.url)
}

export function RefreshChaptersModal({ sourceId, bookUrl, chapters, currentIndex, cachedUrls, onClose, onRefreshed }: RefreshChaptersModalProps) {
  const list = useMemo(() => readableChapters(chapters), [chapters])
  const currentChapter = useMemo(() => chapters.find(chapter => chapter.index === currentIndex && !chapter.isVolume && chapter.url) ?? null, [chapters, currentIndex])
  const cachedList = useMemo(() => list.filter(chapter => cachedUrls.has(chapter.url)), [list, cachedUrls])
  const currentPos = useMemo(() => {
    if (!currentChapter) return 0
    const index = list.findIndex(chapter => chapter.url === currentChapter.url)
    return index >= 0 ? index : 0
  }, [list, currentChapter])

  const [mode, setMode] = useState<RefreshMode>('current')
  const [count, setCount] = useState(Math.min(10, Math.max(1, list.length - currentPos)))
  const [rangeStart, setRangeStart] = useState(Math.min(Math.max(1, list.length), currentPos + 1))
  const [rangeEnd, setRangeEnd] = useState(Math.min(list.length, currentPos + 10) || 1)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [successCount, setSuccessCount] = useState(0)
  const [failures, setFailures] = useState<Array<{ url: string; message: string }>>([])
  const [finished, setFinished] = useState(false)
  const [retryUrls, setRetryUrls] = useState<string[] | null>(null)
  const stoppedRef = useRef(false)
  const runningRef = useRef(false)

  const selection = useMemo((): Chapter[] => {
    if (retryUrls) return retryUrls.map(url => list.find(chapter => chapter.url === url)).filter((chapter): chapter is Chapter => !!chapter)
    if (mode === 'current') return currentChapter ? [currentChapter] : []
    if (mode === 'cached') return cachedList
    if (mode === 'count') {
      const n = Math.max(1, Math.min(MAX_COUNT, Math.floor(count) || 1))
      return list.slice(currentPos, currentPos + n)
    }
    const start = Math.max(1, Math.min(list.length, Math.floor(rangeStart) || 1))
    const end = Math.max(start, Math.min(list.length, Math.floor(rangeEnd) || start))
    return list.slice(start - 1, end)
  }, [retryUrls, mode, currentChapter, cachedList, count, currentPos, rangeStart, rangeEnd, list])

  const selectionLabel = selection.length === 0
    ? '没有可刷新的章节'
    : selection.length === 1
      ? `第 ${selection[0].index + 1} 章 · ${selection[0].title}`
      : `第 ${selection[0].index + 1} ~ ${selection[selection.length - 1].index + 1} 章，共 ${selection.length} 章`

  useEscapeClose(() => {
    if (!runningRef.current) onClose()
  })

  const run = async () => {
    if (!selection.length || running) return
    const urls = selection.map(chapter => chapter.url)
    stoppedRef.current = false
    runningRef.current = true
    setRunning(true)
    setFinished(false)
    setFailures([])
    setSuccessCount(0)
    setRetryUrls(null)
    setProgress({ done: 0, total: urls.length })
    const refreshed: string[] = []
    const failed: Array<{ url: string; message: string }> = []
    for (let offset = 0; offset < urls.length; offset += CHUNK_SIZE) {
      if (stoppedRef.current) break
      const chunk = urls.slice(offset, offset + CHUNK_SIZE)
      try {
        const result = await api.refreshChapters(sourceId, bookUrl, chunk)
        refreshed.push(...result.refreshed)
        failed.push(...result.failed.map(item => ({ url: item.chapterUrl, message: item.message })))
      } catch (error) {
        const message = error instanceof Error ? error.message : '刷新失败'
        chunk.forEach(url => failed.push({ url, message }))
      }
      setSuccessCount(refreshed.length)
      setFailures([...failed])
      setProgress({ done: Math.min(offset + CHUNK_SIZE, urls.length), total: urls.length })
    }
    runningRef.current = false
    setRunning(false)
    setFinished(true)
    if (refreshed.length > 0) onRefreshed(refreshed)
  }

  const retry = () => {
    if (!failures.length || running) return
    setRetryUrls(failures.map(item => item.url))
    setFailures([])
    setFinished(false)
    setProgress({ done: 0, total: 0 })
    setSuccessCount(0)
    stoppedRef.current = false
  }

  // 失败行要能说清是哪一章，不能只甩一个地址。
  const chapterByUrl = useMemo(() => new Map(list.map(chapter => [chapter.url, chapter])), [list])
  const failureRows = failures.map(item => {
    const chapter = chapterByUrl.get(item.url)
    return {
      key: item.url,
      title: chapter ? `第 ${chapter.index + 1} 章 · ${chapter.title}` : item.url,
      message: item.message,
    }
  })

  const percent = progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0

  return (
    <div className="overlay-backdrop" onClick={() => { if (!running) onClose() }} role="dialog" aria-modal="true" aria-label="刷新正文">
      <div className="dialog-shell size-s refresh-chapters" onClick={event => event.stopPropagation()}>
        <header className="dialog-head">
          <div className="source-login-title">
            <span><Icon name="refresh" /></span>
            <div>
              <h2>刷新正文</h2>
              <small>绕过缓存回源重取。目录与阅读进度不动，只换这几章的正文。</small>
            </div>
          </div>
          <button type="button" className="overlay-close" onClick={onClose} disabled={running} aria-label="关闭">
            <Icon name="close" />
          </button>
        </header>

        <div className="source-login-body refresh-chapters-body">
          {!running && !finished && (
            <div className="refresh-mode-list" role="radiogroup" aria-label="刷新范围">
              <label className={`refresh-mode-row${mode === 'current' ? ' selected' : ''}`}>
                <input type="radio" name="refresh-mode" checked={mode === 'current'} onChange={() => { setMode('current'); setRetryUrls(null) }} />
                <span className="refresh-mode-copy">
                  <strong>仅当前章</strong>
                  <small>{currentChapter ? `第 ${currentChapter.index + 1} 章 · ${currentChapter.title}` : '当前没有定位到章节'}</small>
                </span>
              </label>
              <label className={`refresh-mode-row${mode === 'count' ? ' selected' : ''}`}>
                <input type="radio" name="refresh-mode" checked={mode === 'count'} onChange={() => { setMode('count'); setRetryUrls(null) }} />
                <span className="refresh-mode-copy">
                  <strong>从当前章起连续刷新</strong>
                  <small>含当前章；适合站点一次补了多章内容</small>
                </span>
                <span className="refresh-mode-input" onClick={event => event.stopPropagation()}>
                  <input
                    type="number"
                    min={1}
                    max={MAX_COUNT}
                    value={count}
                    disabled={mode !== 'count'}
                    onChange={event => setCount(Number(event.target.value))}
                    aria-label="连续刷新章数"
                  />
                  <em>章</em>
                </span>
              </label>
              <label className={`refresh-mode-row${mode === 'range' ? ' selected' : ''}`}>
                <input type="radio" name="refresh-mode" checked={mode === 'range'} onChange={() => { setMode('range'); setRetryUrls(null) }} />
                <span className="refresh-mode-copy">
                  <strong>指定范围</strong>
                  <small>按章节序号选一段；超出范围的数字会夹到 1 ~ {list.length}</small>
                </span>
              </label>
              {mode === 'range' && (
                <div className="refresh-range-inputs">
                  <label>从 <input type="number" min={1} max={Math.max(1, list.length)} value={rangeStart} onChange={event => setRangeStart(Number(event.target.value))} aria-label="起始章序号" /></label>
                  <label>到 <input type="number" min={1} max={Math.max(1, list.length)} value={rangeEnd} onChange={event => setRangeEnd(Number(event.target.value))} aria-label="结束章序号" /></label>
                  <button
                    type="button"
                    className="subtle-button compact"
                    onClick={() => { setRangeStart(Math.min(Math.max(1, list.length), currentPos + 1)); setRangeEnd(Math.min(list.length, currentPos + 10) || 1) }}
                  >当前章起 10 章</button>
                </div>
              )}
              <label className={`refresh-mode-row${mode === 'cached' ? ' selected' : ''}`}>
                <input type="radio" name="refresh-mode" checked={mode === 'cached'} onChange={() => { setMode('cached'); setRetryUrls(null) }} disabled={cachedList.length === 0} />
                <span className="refresh-mode-copy">
                  <strong>已缓存章节</strong>
                  <small>{cachedList.length > 0 ? `共 ${cachedList.length} 章有本地正文，可一次全部回源更新` : '这本书还没有已缓存的正文'}</small>
                </span>
              </label>
            </div>
          )}

          {retryUrls && !running && !finished && (
            <p className="refresh-retry-hint">将重试上次失败的 {retryUrls.length} 章。<button type="button" className="subtle-button compact" onClick={() => setRetryUrls(null)}>改选其它范围</button></p>
          )}

          {(running || finished) && (
            <div className="refresh-progress">
              <div className="refresh-progress-head">
                <strong>{running ? '正在刷新…' : stoppedRef.current ? '已停止' : '刷新完成'}</strong>
                <small>{progress.done} / {progress.total} 章</small>
              </div>
              <div className="manage-cache-bar-track"><div className="manage-cache-bar-fill" style={{ width: `${percent}%` }} /></div>
              {finished && (
                <p className={`refresh-summary${failures.length > 0 ? ' has-failure' : ''}`}>
                  {failures.length === 0
                    ? `已刷新 ${successCount} 章，正文已覆盖为站点最新内容。`
                    : `成功 ${successCount} 章，失败 ${failures.length} 章。失败章节的旧正文没有被改坏。`}
                </p>
              )}
              {failureRows.length > 0 && (
                <ul className="refresh-failure-list">
                  {failureRows.map(row => (
                    <li key={row.key}>
                      <span>{row.title}</span>
                      <small>{row.message}</small>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <footer className="source-login-footer">
          <span className="refresh-selection-label">{!running && !finished ? selectionLabel : ''}</span>
          {!running && finished && failures.length > 0 && (
            <button type="button" className="subtle-button" onClick={retry}>重试失败章节</button>
          )}
          {running
            ? <button type="button" className="danger-button" onClick={() => { stoppedRef.current = true }}>停止</button>
            : finished
              ? <button type="button" className="primary-button" onClick={onClose}>完成</button>
              : <button type="button" className="primary-button" disabled={selection.length === 0} onClick={() => void run()}>开始刷新</button>}
        </footer>
      </div>
    </div>
  )
}
