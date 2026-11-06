/** 阅读器、书架、笔记、缓存、分章规则、封面、本地书相关 API。 */
import { request } from '../client'
import type {
  BackupImportSummary,
  BookshelfItem,
  BookshelfSourceSwitch,
  BookshelfWrite,
  BookNote,
  BookNoteWrite,
  BookSearchHit,
  Chapter,
  LocalBookImportResponse,
  ReadingLogEntry,
  ReadingProgress,
  ReplaceRule,
  ReplaceRuleImportResponse,
  ReplaceRulePreviewRequest,
  ReplaceRulePreviewResponse,
  SourceSummary,
  TocRuleApplyResult,
  TocRuleList,
  LocalBookReparseResult,
} from '../types'

/** 书架。 */
export const bookshelf = {
  list: async () => {
    try {
      const list = await request<BookshelfItem[]>('/api/bookshelf')
      return list
    } catch (err) {
      // 降级到本地快照
      throw err
    }
  },
  add: (book: BookshelfWrite) =>
    request<BookshelfItem>('/api/bookshelf', {
      method: 'POST',
      body: JSON.stringify(book),
    }),
  remove: (sourceId: string, bookUrl: string) =>
    request<void>(
      `/api/bookshelf?sourceId=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}`,
      { method: 'DELETE' },
    ),
  batchDelete: (books: Array<{ sourceId: string; bookUrl: string }>) =>
    request<{ deleted: number; total: number }>('/api/bookshelf/batch-delete', {
      method: 'POST',
      body: JSON.stringify({ books }),
    }),
  batchMoveToGroup: (
    books: Array<{ sourceId: string; bookUrl: string }>,
    groupId: number | null,
  ) =>
    request<{ moved: number; total: number }>('/api/bookshelf/batch-move-group', {
      method: 'POST',
      body: JSON.stringify({ books, groupId }),
    }),
  batchMarkAsRead: (
    books: Array<{ sourceId: string; bookUrl: string }>,
    isRead: boolean,
  ) =>
    request<{ marked: number; total: number }>('/api/bookshelf/batch-mark-read', {
      method: 'POST',
      body: JSON.stringify({ books, isRead }),
    }),
  cacheBook: (sourceId: string, bookUrl: string) =>
    request<{ status: string }>('/api/bookshelf/cache', {
      method: 'POST',
      body: JSON.stringify({ sourceId, bookUrl }),
    }),
  cacheRange: (data: {
    sourceId: string
    bookUrl: string
    startIndex?: number
    endIndex?: number
    count?: number
  }) =>
    request<{ status: string }>('/api/bookshelf/cache', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getCachedChapters: (sourceId: string, bookUrl: string) =>
    request<{
      sourceId: string
      bookUrl: string
      cachedChapterUrls: string[]
      cachedCount: number
      totalChapters: number
      cachedWordCounts?: number[]
    }>(
      `/api/bookshelf/cached-chapters?sourceId=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}`,
    ),
  clearCacheData: (sourceId: string, bookUrl: string) =>
    request<void>(
      `/api/bookshelf/cache?sourceId=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}&clearData=true`,
      { method: 'DELETE' },
    ),
  cancelCache: (sourceId: string, bookUrl: string) =>
    request<void>(
      `/api/bookshelf/cache?sourceId=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}`,
      { method: 'DELETE' },
    ),
  setCompleted: (sourceId: string, bookUrl: string, completed: boolean) =>
    request<BookshelfItem>('/api/bookshelf/status', {
      method: 'PUT',
      body: JSON.stringify({ sourceId, bookUrl, completed }),
    }),
  updateInfo: (data: {
    sourceId: string
    bookUrl: string
    name: string
    author?: string
    coverUrl?: string
  }) =>
    request<BookshelfItem>('/api/bookshelf/info', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  switchSource: (value: BookshelfSourceSwitch) =>
    request<BookshelfItem>('/api/bookshelf/switch-source', {
      method: 'POST',
      body: JSON.stringify(value),
    }),
}

/** 分组。 */
export const bookshelfGroups = {
  list: () => request<Array<{ id: number; name: string; bookCount: number }>>(
    '/api/bookshelf/groups',
  ),
  create: (name: string) =>
    request<{ id: number; name: string; bookCount: number }>(
      '/api/bookshelf/groups',
      { method: 'POST', body: JSON.stringify({ name }) },
    ),
  remove: (id: number) =>
    request<void>(`/api/bookshelf/groups/${id}`, { method: 'DELETE' }),
  setBookGroup: (sourceId: string, bookUrl: string, groupId: number) =>
    request<BookshelfItem>('/api/bookshelf/group', {
      method: 'PUT',
      body: JSON.stringify({ sourceId, bookUrl, groupId }),
    }),
}

/** 阅读进度。 */
export const progress = {
  get: (sourceId: string, bookUrl: string, signal?: AbortSignal) =>
    request<ReadingProgress | undefined>(
      `/api/reading-progress?sourceId=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}`,
      { signal },
    ),
  save: async (
    sourceId: string,
    bookUrl: string,
    chapterUrl: string,
    chapterIndex: number,
    scrollPosition: number,
    position?: {
      charOffset?: number
      paragraphAnchor?: string | null
      positionChecksum?: string | null
    },
  ) => {
    const progressItem = {
      sourceId,
      bookUrl,
      chapterUrl,
      chapterIndex,
      scrollPosition,
      ...(position
        ? {
            ...(position.charOffset != null ? { charOffset: position.charOffset } : {}),
            paragraphAnchor: position.paragraphAnchor ?? null,
            positionVersion: 1,
            positionChecksum: position.positionChecksum ?? null,
          }
        : {}),
      updatedAt: Date.now(),
    }
    return request<ReadingProgress>('/api/reading-progress', {
      method: 'PUT',
      body: JSON.stringify(progressItem),
    })
  },
}

/** 阅读记录。 */
export const readingLog = {
  list: (days = 30, signal?: AbortSignal) =>
    request<ReadingLogEntry[]>(`/api/reading-log?days=${days}`, { signal }),
  add: (entry: {
    sourceId: string
    bookUrl: string
    bookName?: string
    chapterIndex?: number
    seconds: number
  }) =>
    request<ReadingLogEntry>('/api/reading-log', {
      method: 'POST',
      body: JSON.stringify(entry),
    }),
}

/** 笔记 / 划线。 */
export const notes = {
  list: (sourceId: string, bookUrl: string, signal?: AbortSignal) =>
    request<BookNote[]>(
      `/api/notes?sourceId=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}`,
      { signal },
    ),
  add: (write: BookNoteWrite) =>
    request<BookNote>('/api/notes', {
      method: 'POST',
      body: JSON.stringify(write),
    }),
  update: (id: number, note: string) =>
    request<void>(`/api/notes/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ note }),
    }),
  remove: (id: number) =>
    request<void>(`/api/notes/${id}`, { method: 'DELETE' }),
}

/** 离线缓存（书架章节缓存）。 */
export const cache = {
  book: (sourceId: string, bookUrl: string) =>
    request<{ status: string }>('/api/bookshelf/cache', {
      method: 'POST',
      body: JSON.stringify({ sourceId, bookUrl }),
    }),
  range: (data: {
    sourceId: string
    bookUrl: string
    startIndex?: number
    endIndex?: number
    count?: number
  }) =>
    request<{ status: string }>('/api/bookshelf/cache', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getCachedChapters: (sourceId: string, bookUrl: string) =>
    request<{
      sourceId: string
      bookUrl: string
      cachedChapterUrls: string[]
      cachedCount: number
      totalChapters: number
      cachedWordCounts?: number[]
    }>(
      `/api/bookshelf/cached-chapters?sourceId=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}`,
    ),
  clearData: (sourceId: string, bookUrl: string) =>
    request<void>(
      `/api/bookshelf/cache?sourceId=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}&clearData=true`,
      { method: 'DELETE' },
    ),
  cancel: (sourceId: string, bookUrl: string) =>
    request<void>(
      `/api/bookshelf/cache?sourceId=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}`,
      { method: 'DELETE' },
    ),
}

/** 分章规则。 */
export const tocRules = {
  list: () => request<TocRuleList>('/api/books/toc-rules'),
  applyBackup: () =>
    request<TocRuleApplyResult>('/api/books/toc-rules/apply-backup', {
      method: 'POST',
    }),
  reset: () =>
    request<{ cleared: boolean; total: number }>('/api/books/toc-rules/reset', {
      method: 'POST',
    }),
  toggle: (key: string, enable: boolean) =>
    request<{ id: number; name: string; enable: boolean }>(
      '/api/books/toc-rules/toggle',
      { method: 'POST', body: JSON.stringify({ key, enable }) },
    ),
  save: (rule: {
    key?: string
    name: string
    rule: string
    example?: string
    enable: boolean
  }) =>
    request<{
      id: number
      name: string
      rule: string
      enable: boolean
      total: number
    }>('/api/books/toc-rules/save', {
      method: 'POST',
      body: JSON.stringify(rule),
    }),
  delete: (key: string) =>
    request<{ removed: boolean; total: number }>(
      '/api/books/toc-rules/delete',
      { method: 'POST', body: JSON.stringify({ key, enable: true }) },
    ),
  reparse: (sourceId: string, bookUrl: string, ruleKey: string) =>
    request<LocalBookReparseResult>('/api/books/reparse-local', {
      method: 'POST',
      body: JSON.stringify({ sourceId, bookUrl, ruleKey }),
    }),
}

/** 本地书。 */
export const localBooks = {
  import: async (files: File[], tocRule?: string) => {
    const formData = new FormData()
    for (const file of files) {
      formData.append('file', file, file.name)
    }
    const headers = new Headers()
    const response = await fetch(
      `/api/bookshelf/import-local${tocRule && tocRule !== 'auto' ? `?tocRule=${encodeURIComponent(tocRule)}` : ''}`,
      {
        method: 'POST',
        headers,
        credentials: 'same-origin',
        body: formData,
      },
    )
    if (!response.ok) {
      const err = await response.json().catch(() => ({ message: response.statusText }))
      throw new Error(err.message ?? '本地书籍上传失败')
    }
    return response.json() as Promise<LocalBookImportResponse>
  },
}

/** 封面代理。 */
export const cover = {
  /** 封面 key → 同源地址（服务端按 key 落盘缓存的那一份）。
   *
   * 与 `proxy` 分工别混：`key` 收的是**库里的封面键**（可能含 `?`），一直编码成
   * `/api/covers/<key>`；`proxy` 收的是**外域完整 URL**，非 http(s) 原样返回。
   * 拆域时把两者合并会静默改掉封面地址（`api.cover('covers/b1?x=1')` 会变成原样返回）。
   */
  key: (key: string) => `/api/covers/${encodeURIComponent(key)}`,
  proxy: (url: string, referer?: string) => {
    if (!/^https?:\/\//i.test(url)) return url
    const params = new URLSearchParams({ url })
    if (referer) params.set('referer', referer)
    return `/api/covers/proxy?${params.toString()}`
  },
  refresh: (url: string, page?: string) =>
    request<{ key: string; contentType: string }>(
      `/api/book/image/refresh?url=${encodeURIComponent(url)}${page ? `&page=${encodeURIComponent(page)}` : ''}`,
      { method: 'POST' },
    ),
}

/** 书籍正文/条目配图代取。 */
export const bookImage = {
  url: (url: string, page?: string, version?: string, sourceId?: string) => {
    if (!/^https?:\/\//i.test(url)) return url
    const params = new URLSearchParams({ url })
    if (page) params.set('page', page)
    if (version) params.set('v', version)
    if (sourceId) params.set('sourceId', sourceId)
    return `/api/book/image?${params.toString()}`
  },
}

/** 媒体流式代理。 */
export const bookMedia = {
  url: (url: string, referer?: string) => {
    if (!/^https?:\/\//i.test(url)) return url
    const params = new URLSearchParams({ url })
    if (referer) params.set('referer', referer)
    return `/api/book/media?${params.toString()}`
  },
}

/** 替换净化规则。 */
export const replaceRules = {
  list: (params?: { q?: string; group?: string; scope?: string }) => {
    const sp = new URLSearchParams()
    if (params?.q) sp.set('q', params.q)
    if (params?.group) sp.set('group', params.group)
    if (params?.scope) sp.set('scope', params.scope)
    const qs = sp.toString()
    return request<ReplaceRule[]>(`/api/replace-rules${qs ? `?${qs}` : ''}`)
  },
  get: (id: string) =>
    request<ReplaceRule>(`/api/replace-rules/${encodeURIComponent(id)}`),
  create: (rule: Partial<ReplaceRule>) =>
    request<ReplaceRule>('/api/replace-rules', {
      method: 'POST',
      body: JSON.stringify(rule),
    }),
  update: (id: string, rule: Partial<ReplaceRule>) =>
    request<ReplaceRule>(`/api/replace-rules/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(rule),
    }),
  remove: (id: string) =>
    request<void>(`/api/replace-rules/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  removeBatch: (ids: string[]) =>
    request<{ deleted: number }>('/api/replace-rules/delete-batch', {
      method: 'POST',
      body: JSON.stringify(ids),
    }),
  toggle: (ids: string[], enabled: boolean) =>
    request<{ updated: number }>('/api/replace-rules/toggle', {
      method: 'POST',
      body: JSON.stringify({ ids, enabled }),
    }),
  importText: (text: string) =>
    request<ReplaceRuleImportResponse>('/api/replace-rules/import', {
      method: 'POST',
      body: text,
    }),
  importUrl: (url: string) =>
    request<ReplaceRuleImportResponse>('/api/replace-rules/import', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),
  preview: (req: ReplaceRulePreviewRequest) =>
    request<ReplaceRulePreviewResponse>('/api/replace-rules/preview', {
      method: 'POST',
      body: JSON.stringify(req),
    }),
}

/** TTS 朗读。 */
export const tts = {
  voices: () => request<Array<{
    id: string
    name: string
    lang: string
    gender: string
    localeName: string
    engine: string
    description?: string
  }>>('/api/tts/voices'),
  createSession: (signal?: AbortSignal) =>
    request<{
      sessionId: string
      audioUrl: string
      eventsUrl: string
    }>('/api/tts/session', { method: 'POST', body: '{}', signal }),
  appendChunk: (sessionId: string, chunk: {
    text: string
    chapterIndex: number
    paragraphIndex: number
    engine: string
    voice: string
    rate: number
    pitch: number
    customUrl?: string
    customHeader?: string
    customMethod?: string
    customBody?: string
  }) =>
    request<{ accepted: boolean }>(
      `/api/tts/session/${encodeURIComponent(sessionId)}/chunks`,
      { method: 'POST', body: JSON.stringify(chunk) },
    ),
  control: (sessionId: string, action: 'pause' | 'resume' | 'stop') =>
    request<{ accepted: boolean }>(
      `/api/tts/session/${encodeURIComponent(sessionId)}/control`,
      { method: 'POST', body: JSON.stringify({ action }) },
    ),
  delete: (sessionId: string) =>
    request<void>(`/api/tts/session/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    }),
  speak: async (req: {
    text: string
    voice?: string
    rate?: number
    pitch?: number
    engine?: string
    customUrl?: string
    customHeader?: string
    customMethod?: string
    customBody?: string
  }): Promise<Blob> => {
    const headers = new Headers({ 'Content-Type': 'application/json' })
    const response = await fetch('/api/tts/speak', {
      method: 'POST',
      headers,
      credentials: 'same-origin',
      body: JSON.stringify(req),
    })
    if (!response.ok) {
      const err = await response.json().catch(() => ({ message: response.statusText }))
      throw new Error(err.message ?? '语音合成失败')
    }
    return response.blob()
  },
}
