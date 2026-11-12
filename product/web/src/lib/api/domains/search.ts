/** 搜索、发现、书籍详情、目录、正文相关 API。 */
import { request } from '../client'
import { putOfflineChapter, getOfflineChapter } from '../../offlineStorage'
import type {
  BookDetails,
  BookSearchHit,
  Chapter,
  ChapterReview,
  ExploreTab,
  RssArticle,
  RssArticleContent,
  RssSourceSummary,
  SearchResult,
  SearchStreamEvent,
} from '../types'

/** 搜索。 */
export const search = {
  /** 同步搜索：到点截断返回已搜到的部分。 */
  run: (
    keyword: string,
    sourceIds?: string[],
    signal?: AbortSignal,
  ) =>
    request<SearchResult[]>('/api/search', {
      method: 'POST',
      body: JSON.stringify({ keyword, sourceIds }),
      signal,
    }),
  /** 流式搜索：WebSocket，逐帧回调 SearchStreamEvent。 */
  stream: (
    keyword: string,
    sourceIds: string[] | undefined,
    onEvent: (event: SearchStreamEvent) => void,
    onError: (message: string) => void,
    onClose: () => void,
  ): WebSocket => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${location.host}/api/search/stream`)
    let reported = false
    socket.addEventListener('open', () => {
      queueMicrotask(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ keyword, sourceIds }))
        }
      })
    })
    socket.addEventListener('message', (event) => {
      try {
        onEvent(JSON.parse(event.data) as SearchStreamEvent)
      } catch {
        reported = true
        onError('搜索响应格式无效')
      }
    })
    socket.addEventListener('error', () => {
      if (!reported) {
        reported = true
        onError('搜索连接中断，请重试')
      }
    })
    socket.addEventListener('close', () => {
      if (!reported) onClose()
    })
    return socket
  },
}

/** 发现页。 */
export const explore = {
  list: () => request<ExploreTab[]>('/api/explore/sources'),
  run: (sourceId: string, url: string, page = 1, signal?: AbortSignal) =>
    request<SearchResult[]>('/api/explore', {
      method: 'POST',
      body: JSON.stringify({ sourceId, url, page }),
      signal,
    }),
}

/** 书籍详情。 */
export const book = {
  details: (sourceId: string, bookUrl: string, signal?: AbortSignal) =>
    request<BookDetails>('/api/books/details', {
      method: 'POST',
      body: JSON.stringify({ sourceId, bookUrl }),
      signal,
    }),
  chapters: (sourceId: string, bookUrl: string, signal?: AbortSignal) =>
    request<Chapter[]>('/api/books/chapters', {
      method: 'POST',
      body: JSON.stringify({ sourceId, bookUrl }),
      signal,
    }),
  content: async (
    sourceId: string,
    chapterUrl: string,
    bookUrl?: string,
    signal?: AbortSignal,
    force = false,
  ) => {
    try {
      const res = await request<{
        title?: string
        content: string
        mediaUrl?: string
      }>('/api/books/content', {
        method: 'POST',
        body: JSON.stringify({ sourceId, chapterUrl, bookUrl, ...(force ? { force: true } : {}) }),
        signal,
      })
      if (res?.content && bookUrl) {
        void putOfflineChapter(sourceId, bookUrl, chapterUrl, res.title || null, res.content)
      }
      return res
    } catch (err) {
      // 手动刷新（force）失败时要让调用方看到错误：拿 IndexedDB 里的旧正文当成功，
      // 用户会以为"刷新了还是这些字"，实际是回源失败。
      if (!force && bookUrl) {
        const offline = await getOfflineChapter(sourceId, bookUrl, chapterUrl)
        if (offline && offline.content) {
          return { title: offline.title ?? undefined, content: offline.content }
        }
      }
      throw err
    }
  },
  refreshChapters: (
    sourceId: string,
    bookUrl: string,
    chapterUrls: string[],
  ) =>
    request<{
      refreshed: string[]
      failed: Array<{ chapterUrl: string; message: string }>
      remaining: number
    }>('/api/books/content-refresh', {
      method: 'POST',
      body: JSON.stringify({ sourceId, bookUrl, chapterUrls }),
    }),
  /** 段评详情列表（S0/C-03，只读）。书源须配 ruleReview.detailListRule。 */
  reviews: (sourceId: string, url: string, page = 1, signal?: AbortSignal) =>
    request<ChapterReview[]>('/api/books/reviews', {
      method: 'POST',
      body: JSON.stringify({ sourceId, url, page }),
      signal,
    }),
}

/** 本书正文检索（已缓存章节正文）。 */
export const bookSearch = {
  run: (
    sourceId: string,
    bookUrl: string,
    query: string,
    signal?: AbortSignal,
  ) =>
    request<BookSearchHit[]>(
      `/api/book-search?sourceId=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}&q=${encodeURIComponent(query)}`,
      { signal },
    ),
}

/** RSS 订阅源（手机「订阅」页）。 */
export const rss = {
  list: (query?: string) =>
    request<RssSourceSummary[]>(
      `/api/rss/sources${query?.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''}`,
    ),
  add: (sources: string[]) =>
    request<{
      imported: number
      updated: number
      skipped: number
      errors: string[]
    }>('/api/rss/sources', {
      method: 'POST',
      body: JSON.stringify({ sources }),
    }),
  setEnabled: (sourceUrl: string, enabled: boolean) =>
    request<void>('/api/rss/sources/enabled', {
      method: 'POST',
      body: JSON.stringify({ sourceUrl, enabled }),
    }),
  remove: (sourceUrl: string) =>
    request<void>(
      `/api/rss/sources?sourceUrl=${encodeURIComponent(sourceUrl)}`,
      { method: 'DELETE' },
    ),
  tabs: (sourceUrl: string, signal?: AbortSignal) =>
    request<ExploreTab[]>(`/api/rss/tabs?sourceUrl=${encodeURIComponent(sourceUrl)}`, { signal }),
  articles: (sourceUrl: string, url: string, page = 1, signal?: AbortSignal) =>
    request<RssArticle[]>('/api/rss/articles', {
      method: 'POST',
      body: JSON.stringify({ sourceUrl, url, page }),
      signal,
    }),
  content: (sourceUrl: string, link: string, signal?: AbortSignal) =>
    request<RssArticleContent>('/api/rss/content', {
      method: 'POST',
      body: JSON.stringify({ sourceUrl, link }),
      signal,
    }),
}
