/**
 * Offline Storage & Client-side Two-tier Cache Engine
 * Uses IndexedDB for rich structured offline chapter storage,
 * localStorage for bookshelf snapshots and offline reading progress queues.
 */

export interface OfflineChapterRecord {
  key: string // `${sourceId}::${bookUrl}::${chapterUrl}`
  sourceId: string
  bookUrl: string
  chapterUrl: string
  title: string | null
  content: string
  cachedAt: number
  byteSize: number
}

export interface OfflineBookStat {
  sourceId: string
  bookUrl: string
  name?: string
  chapterCount: number
  totalBytes: number
  /**
   * 这本书最近一次写入缓存的时间。没有它就没法做真正的 LRU ——
   * `stats.books` 原本是 IndexedDB 游标顺序（键是 `sourceId::bookUrl::chapterUrl`，
   * 等于按书名排序），拿它当"最久未用"来淘汰是假的。
   */
  lastCachedAt: number
}

export interface OfflineStorageStats {
  books: OfflineBookStat[]
  totalChapters: number
  totalBytes: number
}

const DB_NAME = 'legado_offline_db'
// v2：多一条"按书统计"用的复合键索引 by_book_totals（见 BOOK_TOTALS_INDEX 的注释）。
const DB_VERSION = 2
const STORE_CHAPTERS = 'chapters'
/**
 * 按书统计走的索引：[sourceId, bookUrl, byteSize, cachedAt]。
 * 走 `openKeyCursor` 时浏览器只把这条索引的键交回来，**不会把 content 读进内存** ——
 * 全本缓存上千章时，旧的全表游标会把每条记录的正文整份物化一次，只为求一个字节数之和。
 */
const BOOK_TOTALS_INDEX = 'by_book_totals'

const SNAPSHOT_SHELF_KEY = 'legado_shelf_snapshot'
const OFFLINE_PROGRESS_QUEUE_KEY = 'legado_offline_progress_queue'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB not supported in current environment'))
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      const created = !db.objectStoreNames.contains(STORE_CHAPTERS)
      const store = created
        ? db.createObjectStore(STORE_CHAPTERS, { keyPath: 'key' })
        : (request.transaction as IDBTransaction).objectStore(STORE_CHAPTERS)
      if (created) {
        store.createIndex('by_book', ['sourceId', 'bookUrl'], { unique: false })
        store.createIndex('by_cached_at', 'cachedAt', { unique: false })
      }
      // 老库升到 v2 时只补这一条索引：建索引由浏览器扫存量记录，我们不改它们的内容
      if (!store.indexNames.contains(BOOK_TOTALS_INDEX)) {
        store.createIndex(BOOK_TOTALS_INDEX, ['sourceId', 'bookUrl', 'byteSize', 'cachedAt'], { unique: false })
      }
    }
    request.onblocked = () => reject(new Error('IndexedDB 升级被其它标签页占用，请关闭旧标签后重试'))
    request.onsuccess = () => {
      const db = request.result
      // 另一标签触发版本升级 / 浏览器回收连接时，本连接会失效：关掉并清空缓存，
      // 下次 openDb 重开新连接，避免后续事务对着 stale 连接全抛 InvalidStateError。
      db.onversionchange = () => { db.close(); if (dbPromise === promise) dbPromise = null }
      db.onclose = () => { if (dbPromise === promise) dbPromise = null }
      resolve(db)
    }
    request.onerror = () => { if (dbPromise === promise) dbPromise = null; reject(request.error) }
  })
  dbPromise = promise
  return dbPromise
}

function makeChapterKey(sourceId: string, bookUrl: string, chapterUrl: string): string {
  return `${sourceId}::${bookUrl}::${chapterUrl}`
}

/**
 * Saves a chapter to client-side IndexedDB offline pool
 */
export async function putOfflineChapter(
  sourceId: string,
  bookUrl: string,
  chapterUrl: string,
  title: string | null,
  content: string
): Promise<void> {
  const db = await openDb()
  const key = makeChapterKey(sourceId, bookUrl, chapterUrl)
  const byteSize = new Blob([content]).size
  const record: OfflineChapterRecord = {
    key,
    sourceId,
    bookUrl,
    chapterUrl,
    title,
    content,
    cachedAt: Date.now(),
    byteSize,
  }

  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_CHAPTERS, 'readwrite')
      const store = tx.objectStore(STORE_CHAPTERS)
      const req = store.put(record)
      req.onsuccess = () => resolve()
      req.onerror = () => {
        if (req.error && req.error.name === 'QuotaExceededError') {
          // 空间不足就先按最久未写淘汰别的书，再重试一次。必须把**当前这本**排除掉：
          // 否则"清一点空间"会把用户正在下载的书连同它已存好的章节一起删掉。
          void evictLruOfflineBooks(byteSize * 10, { sourceId, bookUrl }).then(() => {
            const retryTx = db.transaction(STORE_CHAPTERS, 'readwrite')
            const retryReq = retryTx.objectStore(STORE_CHAPTERS).put(record)
            retryReq.onsuccess = () => resolve()
            retryReq.onerror = () => reject(retryReq.error)
          }).catch(reject)
        } else {
          reject(req.error)
        }
      }
    } catch (err) {
      reject(err)
    }
  })
}

/**
 * Retrieves a chapter from client-side IndexedDB offline pool
 */
export async function getOfflineChapter(
  sourceId: string,
  bookUrl: string,
  chapterUrl: string
): Promise<{ title: string | null; content: string } | null> {
  const db = await openDb()
  const key = makeChapterKey(sourceId, bookUrl, chapterUrl)

  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_CHAPTERS, 'readonly')
      const store = tx.objectStore(STORE_CHAPTERS)
      const req = store.get(key)
      req.onsuccess = () => {
        const record = req.result as OfflineChapterRecord | undefined
        if (record && record.content) {
          resolve({ title: record.title, content: record.content })
        } else {
          resolve(null)
        }
      }
      req.onerror = () => reject(req.error)
    } catch (err) {
      reject(err)
    }
  })
}

/**
 * Returns a Set of cached chapterUrls for a specific book in client IndexedDB
 */
export async function getOfflineChaptersSet(
  sourceId: string,
  bookUrl: string
): Promise<Set<string>> {
  const db = await openDb()

  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_CHAPTERS, 'readonly')
      const store = tx.objectStore(STORE_CHAPTERS)
      const index = store.index('by_book')
      const range = IDBKeyRange.only([sourceId, bookUrl])
      const req = index.openCursor(range)
      const result = new Set<string>()

      req.onsuccess = () => {
        const cursor = req.result
        if (cursor) {
          const record = cursor.value as OfflineChapterRecord
          if (record && record.chapterUrl) {
            result.add(record.chapterUrl)
          }
          cursor.continue()
        } else {
          resolve(result)
        }
      }
      req.onerror = () => reject(req.error)
    } catch (err) {
      reject(err)
    }
  })
}

/**
 * 一本书的统计累加（纯算式，不碰 IndexedDB）。
 *
 * 快路径交回来的不是记录而是四列键，分组/求和/取最近时间全在这几列上 ——
 * 算错了界面就显示"7 本 31 章"这种看着合理其实不对的数字，所以单独钉住。
 */
export type BookStatsEntry = readonly [string, string, number, number]

export function accumulateBookStats(entries: readonly BookStatsEntry[]): {
  books: OfflineBookStat[]
  totalChapters: number
  totalBytes: number
} {
  const byBook = new Map<string, OfflineBookStat>()
  let totalChapters = 0
  let totalBytes = 0
  for (const [sourceId, bookUrl, byteSize, cachedAt] of entries) {
    const key = sourceId + String.fromCharCode(0) + bookUrl
    const stat = byBook.get(key) || { sourceId, bookUrl, chapterCount: 0, totalBytes: 0, lastCachedAt: 0 }
    const bytes = Number.isFinite(byteSize) && byteSize > 0 ? byteSize : 0
    stat.chapterCount += 1
    stat.totalBytes += bytes
    stat.lastCachedAt = Math.max(stat.lastCachedAt, Number.isFinite(cachedAt) ? cachedAt : 0)
    byBook.set(key, stat)
    totalChapters += 1
    totalBytes += bytes
  }
  return { books: Array.from(byBook.values()), totalChapters, totalBytes }
}

/**
 * 快路径：沿复合键索引走一遍，游标交回的是那四列键本身，不含 content。
 *
 * 返回 null 表示这条路不可信 —— 索引还没建、或有记录缺了四列之一（复合索引要求每列都是
 * 合法键，缺列的那条根本进不了索引）。那种情况退回全表扫描：宁可慢一次，也不能少报数字。
 */
function statsViaKeyIndex(db: IDBDatabase): Promise<OfflineStorageStats | null> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_CHAPTERS, 'readonly')
      const store = tx.objectStore(STORE_CHAPTERS)
      if (!store.indexNames.contains(BOOK_TOTALS_INDEX)) { resolve(null); return }
      const entries: BookStatsEntry[] = []
      let recordTotal = -1
      let unusable = false
      const finish = () => {
        if (unusable || recordTotal < 0) { resolve(null); return }
        resolve(entries.length === recordTotal ? accumulateBookStats(entries) : null)
      }
      const counted = store.count()
      counted.onsuccess = () => { recordTotal = counted.result }
      counted.onerror = () => { unusable = true; finish() }
      const cursorRequest = store.index(BOOK_TOTALS_INDEX).openKeyCursor()
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result
        if (!cursor) { finish(); return }
        const key = cursor.key as unknown as BookStatsEntry
        if (!Array.isArray(key) || key.length !== 4) { unusable = true; finish(); return }
        entries.push([String(key[0]), String(key[1]), Number(key[2]), Number(key[3])])
        cursor.continue()
      }
      cursorRequest.onerror = () => { unusable = true; finish() }
      tx.onabort = () => { unusable = true; finish() }
    } catch {
      resolve(null)
    }
  })
}

/**
 * Calculates storage stats across all offline books
 */
export async function getOfflineStorageStats(): Promise<OfflineStorageStats> {
  const db = await openDb()
  const fast = await statsViaKeyIndex(db)
  if (fast) return fast
  return scanAllChaptersForStats(db)
}

/** 慢路径：整表游标，会把每条记录的 content 读进内存。只在快路径不可信时走。 */
async function scanAllChaptersForStats(db: IDBDatabase): Promise<OfflineStorageStats> {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_CHAPTERS, 'readonly')
      const store = tx.objectStore(STORE_CHAPTERS)
      const req = store.openCursor()
      const entries: BookStatsEntry[] = []

      req.onsuccess = () => {
        const cursor = req.result
        if (cursor) {
          const record = cursor.value as OfflineChapterRecord
          // 老库里可能没写 byteSize，这一条退回按正文字符数估 —— 分组与求和交给 accumulateBookStats，
          // 两条路径只有"字节怎么估"这一处不同，不许再各写一份分组算式
          const bytes = record.byteSize || (record.content?.length || 0) * 2
          entries.push([record.sourceId, record.bookUrl, bytes, record.cachedAt || 0])
          cursor.continue()
        } else {
          resolve(accumulateBookStats(entries))
        }
      }
      req.onerror = () => reject(req.error)
      // 事务被中止时 cursor 不会再回 onsuccess（另一个标签页触发 versionchange、库被外部关闭都会走到这里）：
      // 少了这一行这个 Promise 永远不 settle，界面就永远停在"正在统计设备存储占用…"
      tx.onabort = () => reject(tx.error ?? new Error('离线存储事务被中断'))
    } catch (err) {
      reject(err)
    }
  })
}

/**
 * Clears offline chapters for a specific book
 */
export async function clearOfflineBook(sourceId: string, bookUrl: string): Promise<number> {
  const db = await openDb()

  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_CHAPTERS, 'readwrite')
      const store = tx.objectStore(STORE_CHAPTERS)
      const index = store.index('by_book')
      const range = IDBKeyRange.only([sourceId, bookUrl])
      const req = index.openKeyCursor(range)
      const keysToDelete: IDBValidKey[] = []

      req.onsuccess = () => {
        const cursor = req.result
        if (cursor) {
          keysToDelete.push(cursor.primaryKey)
          cursor.continue()
        } else {
          for (const key of keysToDelete) {
            store.delete(key)
          }
          resolve(keysToDelete.length)
        }
      }
      req.onerror = () => reject(req.error)
    } catch (err) {
      reject(err)
    }
  })
}

/**
 * Clears all offline chapters
 */
export async function clearAllOffline(): Promise<void> {
  const db = await openDb()

  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_CHAPTERS, 'readwrite')
      const store = tx.objectStore(STORE_CHAPTERS)
      const req = store.clear()
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    } catch (err) {
      reject(err)
    }
  })
}

/**
 * 空间不足时的自动淘汰：按**最久未写入**的顺序清掉整本离线书，直到腾出 `targetBytesToFree`。
 *
 * `exclude` 是必须的：调用点是"某本书的某一章正要落库时配额爆了"，
 * 不排除的话这里会把**用户正在下载的那一本**（含它已经存好的章节）一起清掉。
 * 排序也不能省 —— `stats.books` 是 IndexedDB 游标顺序（按书名），不排就等于随机淘汰。
 */
export async function evictLruOfflineBooks(
  targetBytesToFree = 10 * 1024 * 1024,
  exclude?: { sourceId: string; bookUrl: string },
): Promise<number> {
  const stats = await getOfflineStorageStats()
  const candidates = stats.books
    .filter(book => !(exclude && book.sourceId === exclude.sourceId && book.bookUrl === exclude.bookUrl))
    .sort((a, b) => a.lastCachedAt - b.lastCachedAt)
  if (candidates.length === 0) return 0

  let freed = 0
  for (const book of candidates) {
    if (freed >= targetBytesToFree) break
    const count = await clearOfflineBook(book.sourceId, book.bookUrl)
    if (count > 0) {
      freed += book.totalBytes
    }
  }
  return freed
}

/**
 * Bookshelf Snapshot for instant offline display
 */
export function saveShelfSnapshot(items: any[]): void {
  try {
    localStorage.setItem(SNAPSHOT_SHELF_KEY, JSON.stringify({
      items,
      updatedAt: Date.now(),
    }))
  } catch {
    // ignore
  }
}

export function getShelfSnapshot(): any[] | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_SHELF_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.items) ? parsed.items : null
  } catch {
    return null
  }
}

/**
 * Offline Reading Progress Queue
 */
export interface OfflineProgressItem {
  sourceId: string
  bookUrl: string
  chapterUrl: string
  chapterIndex: number
  scrollPosition: number
  updatedAt: number
}

export function enqueueOfflineProgress(progress: OfflineProgressItem): void {
  try {
    const raw = localStorage.getItem(OFFLINE_PROGRESS_QUEUE_KEY)
    const queue: OfflineProgressItem[] = raw ? JSON.parse(raw) : []
    // Remove older entries for same book
    const filtered = queue.filter(
      (item) => !(item.sourceId === progress.sourceId && item.bookUrl === progress.bookUrl)
    )
    filtered.push(progress)
    localStorage.setItem(OFFLINE_PROGRESS_QUEUE_KEY, JSON.stringify(filtered))
  } catch {
    // ignore
  }
}

export async function flushOfflineProgress(
  sendProgressApi: (item: OfflineProgressItem) => Promise<any>
): Promise<number> {
  try {
    const raw = localStorage.getItem(OFFLINE_PROGRESS_QUEUE_KEY)
    if (!raw) return 0
    const queue: OfflineProgressItem[] = JSON.parse(raw)
    if (!queue.length) return 0

    let flushedCount = 0
    const remaining: OfflineProgressItem[] = []

    for (const item of queue) {
      try {
        await sendProgressApi(item)
        flushedCount++
      } catch {
        remaining.push(item)
      }
    }

    if (remaining.length > 0) {
      localStorage.setItem(OFFLINE_PROGRESS_QUEUE_KEY, JSON.stringify(remaining))
    } else {
      localStorage.removeItem(OFFLINE_PROGRESS_QUEUE_KEY)
    }

    return flushedCount
  } catch {
    return 0
  }
}

/**
 * 4-concurrency sliding window offline chapter downloader
 */
export async function downloadChaptersToOffline(
  sourceId: string,
  bookUrl: string,
  chapters: Array<{ index: number; title: string; url: string }>,
  fetchChapterContent: (chapterUrl: string) => Promise<{ title?: string | null; content: string }>,
  onProgress?: (completed: number, total: number) => void,
  signal?: AbortSignal
): Promise<{ successful: number; failed: number }> {
  const existingSet = await getOfflineChaptersSet(sourceId, bookUrl)
  const remaining = chapters.filter((c) => !existingSet.has(c.url))
  const total = remaining.length

  if (total === 0) {
    onProgress?.(chapters.length, chapters.length)
    return { successful: 0, failed: 0 }
  }

  const CONCURRENCY = 4
  let completed = 0
  let successful = 0
  let failed = 0
  let currentIndex = 0

  const runWorker = async (): Promise<void> => {
    while (currentIndex < remaining.length) {
      if (signal?.aborted) break
      const item = remaining[currentIndex++]
      if (!item) break

      try {
        const result = await fetchChapterContent(item.url)
        if (result && result.content) {
          await putOfflineChapter(sourceId, bookUrl, item.url, result.title || item.title, result.content)
          successful++
        } else {
          failed++
        }
      } catch (err) {
        if (signal?.aborted) break
        failed++
      } finally {
        completed++
        // 分子只能是"这一次切片里已经处理完几章"：existingSet 是整本书的已缓存集合，
        // 拿它当分子会在已缓存 300 章时同步 50 章时念出「350 / 50 章」。
        onProgress?.(chapters.length - total + completed, chapters.length)
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, remaining.length) }, () => runWorker())
  await Promise.all(workers)

  return { successful, failed }
}
