import React, { useEffect, useState } from 'react'
import { Icon } from '../icons'
import { sourceLabel } from '../sources/sourceOrder'
import {
  clearAllOffline,
  clearOfflineBook,
  getOfflineStorageStats,
  OfflineBookStat,
  OfflineStorageStats,
} from '../lib/offlineStorage'
import { toast } from './Toast'
import { useEscapeClose } from '../lib/useEscapeClose'

/**
 * 「还没取到」「取失败了」「这台电脑确实没有缓存」是三件事（与备份页、订阅页同一口径）。
 *
 * 抽成纯函数是为了能逐条钉住：这里原先只有 `loading` 一个旗标，读失败之后 `stats` 停在 null，
 * 界面于是把第二种直接画成第三种 —— 屏幕上写"这台电脑上还没有已下载的章节"，
 * 用户以为自己把书删了。
 */
export function offlineStatsView(state: { loading: boolean; failed: boolean; books: number | null }): 'loading' | 'failed' | 'empty' | 'ready' {
  if (state.failed) return 'failed'
  if (state.loading) return 'loading'
  // 不 loading 又拿不到条数：只能算没取到，不许算"确实没有"
  if (state.books === null) return 'failed'
  return state.books === 0 ? 'empty' : 'ready'
}

interface OfflineCacheModalProps {
  onClose: () => void
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 KB'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export function OfflineCacheModal({ onClose }: OfflineCacheModalProps) {
  const [stats, setStats] = useState<OfflineStorageStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [clearing, setClearing] = useState(false)

  const loadStats = async () => {
    try {
      const data = await getOfflineStorageStats()
      setStats(data)
      setFailed(false)
    } catch {
      // 失败要留在 state 里：只弹一条 toast、界面继续按"空"排版，等于把故障说成用户的操作结果
      setStats(null)
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadStats()
  }, [])

  const view = offlineStatsView({ loading, failed, books: stats ? stats.books.length : null })

  const handleClearBook = async (book: OfflineBookStat) => {
    if (!window.confirm(`确定要清理《${book.name || book.bookUrl}》的本地离线缓存吗？`)) return
    try {
      const count = await clearOfflineBook(book.sourceId, book.bookUrl)
      toast.success(`已清理 ${count} 个本地离线章节`)
      await loadStats()
    } catch {
      toast.error('清理失败')
    }
  }

  const handleClearAll = async () => {
    if (!window.confirm('确定要清空本设备上的所有书籍离线缓存吗？清空后断网将无法脱机阅读。')) return
    setClearing(true)
    try {
      await clearAllOffline()
      toast.success('已清空全部本地离线缓存')
      await loadStats()
    } catch {
      toast.error('清空失败')
    } finally {
      setClearing(false)
    }
  }

  useEscapeClose(onClose)
  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div
        className="dialog-shell size-s"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="离线缓存"
      >
        <header className="dialog-head">
          <div className="source-login-title">
            <span><Icon name="book" /></span>
            <div>
              <h2>离线缓存</h2>
              <small>存在这台电脑的浏览器里，断网也能读已下载的部分</small>
            </div>
          </div>
          <button type="button" className="overlay-close" onClick={onClose} aria-label="关闭">
            <Icon name="close" />
          </button>
        </header>

        <div className="source-login-body">
          {view === 'loading' && (
            <p role="status">正在统计设备存储占用…</p>
          )}
          {view === 'failed' && (
            <p role="status">
              没取到本机的离线缓存清单 —— 这不代表你没有缓存，也不会删掉任何东西。
              <button type="button" className="subtle-button" onClick={() => void loadStats()}>再取一次</button>
            </p>
          )}
          {(view === 'empty' || view === 'ready') && stats && (
            <div>
              <div className="cache-overview-card">
                <div className="overview-item">
                  <span className="overview-label">已离线书籍</span>
                  <strong className="overview-value">{stats.books.length} 本</strong>
                </div>
                <div className="overview-divider" />
                <div className="overview-item">
                  <span className="overview-label">总离线章节</span>
                  <strong className="overview-value">{stats.totalChapters} 章</strong>
                </div>
                <div className="overview-divider" />
                <div className="overview-item">
                  <span className="overview-label">本地空间占用</span>
                  <strong className="overview-value text-teal">{formatBytes(stats.totalBytes)}</strong>
                </div>
              </div>

              <div>
                <div className="offline-books-header">
                  <span>已离线书籍列表</span>
                  <small>断网时可继续读</small>
                </div>
                {view === 'empty' ? (
                  <p className="empty-notice">这台电脑上还没有已下载的章节。在阅读器底部点「下载到本设备」，之后断网也能继续读。</p>
                ) : (
                  <div className="offline-books-list">
                    {stats.books.map(book => (
                      <div key={`${book.sourceId}::${book.bookUrl}`} className="offline-book-row">
                        <div className="offline-book-meta">
                          <strong>{book.name || book.bookUrl}</strong>
                          <small>{book.chapterCount} 章 · {formatBytes(book.totalBytes)} · {sourceLabel(book.sourceId)}</small>
                        </div>
                        <button
                          type="button"
                          className="subtle-button danger-btn"
                          onClick={() => void handleClearBook(book)}
                        >
                          清除
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <footer className="source-login-footer">
          <button
            type="button"
            className="danger-button"
            disabled={clearing || view !== 'ready'}
            onClick={() => void handleClearAll()}
          >
            {clearing ? '清空中…' : '清空全部本地缓存'}
          </button>
          <button type="button" className="primary-button" onClick={onClose}>
            完成
          </button>
        </footer>
      </div>
    </div>
  )
}
