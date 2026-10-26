import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  putOfflineChapter,
  getOfflineChapter,
  getOfflineChaptersSet,
  clearOfflineBook,
  clearAllOffline,
  saveShelfSnapshot,
  getShelfSnapshot,
  enqueueOfflineProgress,
  flushOfflineProgress,
  getOfflineStorageStats,
  accumulateBookStats,
  evictLruOfflineBooks
} from '../src/lib/offlineStorage.js'

// Mock IndexedDB implementation for test runner
class MockIDBRequest {
  result: any = null
  error: any = null
  onsuccess: ((e: any) => void) | null = null
  onerror: ((e: any) => void) | null = null
}

class MockIDBCursor {
  records: any[]
  index = 0
  req: MockIDBRequest
  constructor(records: any[], req: MockIDBRequest) {
    this.records = records
    this.req = req
  }
  get value() {
    return this.records[this.index]
  }
  get primaryKey() {
    const rec = this.records[this.index]
    return rec?.key ?? `${rec?.sourceId}_${rec?.bookUrl}_${rec?.chapterUrl}`
  }
  continue() {
    this.index++
    setTimeout(() => {
      if (this.index < this.records.length) {
        this.req.result = this
      } else {
        this.req.result = null
      }
      this.req.onsuccess?.({ target: this.req })
    }, 0)
  }
}

class MockIDBKeyCursor {
  rows: { key: any[]; primaryKey: any }[]
  pos = 0
  req: MockIDBRequest
  constructor(rows: { key: any[]; primaryKey: any }[], req: MockIDBRequest) {
    this.rows = rows
    this.req = req
  }
  get key() {
    return this.rows[this.pos].key
  }
  get primaryKey() {
    return this.rows[this.pos].primaryKey
  }
  continue() {
    this.pos++
    setTimeout(() => {
      this.req.result = this.pos < this.rows.length ? this : null
      this.req.onsuccess?.({ target: this.req })
    }, 0)
  }
}

/** 复合键按逐列升序排 —— 真实 IndexedDB 还带类型序，但统计与顺序无关，这里只管稳定。 */
function compareIndexKeys(a: any[], b: any[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue
    return a[i] < b[i] ? -1 : 1
  }
  return 0
}

class MockIDBIndex {
  store: MockIDBObjectStore
  name: string
  constructor(store: MockIDBObjectStore, name: string) {
    this.store = store
    this.name = name
  }
  openCursor(range?: any) {
    return this.store.openCursor(range)
  }
  /**
   * 只交回索引的那几列 + 主键，且**缺任何一列的记录不进索引** —— 真实 IndexedDB 就是这个语义，
   * 统计的快路径靠它，而"少了一条"必须由 store.count() 对账兜住，所以这里不能宽容。
   * `range` 是 `IDBKeyRange.only([...])` 的桩（mock 直接把数组当 range）：按整条键逐列相等筛，
   * clearOfflineBook 就是靠它取一本书的全部章节主键。
   */
  openKeyCursor(range?: any) {
    this.store.keyCursorCalls++
    const req = new MockIDBRequest()
    const keyPath = this.store.indexes.get(this.name)
    const rows: { key: any[]; primaryKey: any }[] = []
    if (keyPath) {
      const wantRange = Array.isArray(range) ? range : null
      for (const rec of this.store.data.values()) {
        const key = keyPath.map(p => rec?.[p])
        if (!key.every(v => v !== undefined && v !== null)) continue
        if (wantRange && (wantRange.length !== keyPath.length || !wantRange.every((v, i) => v === key[i]))) continue
        rows.push({
          key,
          primaryKey: rec.key ?? `${rec.sourceId}_${rec.bookUrl}_${rec.chapterUrl}`,
        })
      }
      rows.sort((a, b) => compareIndexKeys(a.key, b.key))
    }
    setTimeout(() => {
      req.result = rows.length > 0 ? new MockIDBKeyCursor(rows, req) : null
      req.onsuccess?.({ target: req })
    }, 0)
    return req
  }
}

/** 让接下来 N 次 IndexedDB 写入抛 QuotaExceededError，用来测「配额满 → 淘汰 → 重试」。 */
let quotaFailuresLeft = 0

class MockIDBObjectStore {
  data = new Map<string, any>()
  indexes = new Map<string, string[]>()
  indexNames = {
    contains: (name: string) => this.indexes.has(name)
  }
  /** 统计走哪条路要看这两个计数：快路径只该碰 openKeyCursor，全表游标只在退回时出现。 */
  keyCursorCalls = 0
  fullCursorCalls = 0
  name: string
  constructor(name: string) {
    this.name = name
  }
  createIndex(name: string, keyPath: string | string[]) {
    this.indexes.set(name, Array.isArray(keyPath) ? keyPath : [keyPath])
  }
  put(value: any, key?: any) {
    const actualKey = key ?? value.key ?? `${value.sourceId}_${value.bookUrl}_${value.chapterUrl}`
    const req = new MockIDBRequest()
    if (quotaFailuresLeft > 0) {
      // 模拟设备存储配额已满：第一次写失败，逼出「淘汰别的书 → 重试」这条恢复路径
      quotaFailuresLeft -= 1
      req.error = { name: 'QuotaExceededError' }
      setTimeout(() => req.onerror?.({ target: req }), 0)
      return req
    }
    this.data.set(String(actualKey), value)
    req.result = actualKey
    setTimeout(() => req.onsuccess?.({ target: req }), 0)
    return req
  }
  get(key: any) {
    const req = new MockIDBRequest()
    req.result = this.data.get(String(key))
    setTimeout(() => req.onsuccess?.({ target: req }), 0)
    return req
  }
  delete(key: any) {
    this.data.delete(String(key))
    const req = new MockIDBRequest()
    setTimeout(() => req.onsuccess?.({ target: req }), 0)
    return req
  }
  clear() {
    this.data.clear()
    const req = new MockIDBRequest()
    setTimeout(() => req.onsuccess?.({ target: req }), 0)
    return req
  }
  index(name: string) {
    return new MockIDBIndex(this, name)
  }
  count() {
    const req = new MockIDBRequest()
    req.result = this.data.size
    setTimeout(() => req.onsuccess?.({ target: req }), 0)
    return req
  }
  openCursor(range?: any) {
    this.fullCursorCalls++
    const req = new MockIDBRequest()
    let records = Array.from(this.data.values())
    if (Array.isArray(range) && range.length === 2) {
      const [src, bUrl] = range
      records = records.filter(r => r.sourceId === src && r.bookUrl === bUrl)
    }
    setTimeout(() => {
      if (records.length > 0) {
        req.result = new MockIDBCursor(records, req)
      } else {
        req.result = null
      }
      req.onsuccess?.({ target: req })
    }, 0)
    return req
  }
}

class MockIDBTransaction {
  store: MockIDBObjectStore
  constructor(store: MockIDBObjectStore) {
    this.store = store
  }
  objectStore(_name: string) {
    return this.store
  }
}

class MockIDBDatabase {
  stores = new Map<string, MockIDBObjectStore>()
  // 生产代码会在连接上挂这两个回调（版本被别的标签升级 / 连接被回收时重开），桩得留着位子
  onversionchange?: ((e: any) => void) | null
  onclose?: ((e: any) => void) | null
  objectStoreNames = {
    contains: (name: string) => this.stores.has(name)
  }
  createObjectStore(name: string) {
    const store = new MockIDBObjectStore(name)
    this.stores.set(name, store)
    return store
  }
  transaction(name: string, _mode: string) {
    let store = this.stores.get(name)
    if (!store) {
      store = new MockIDBObjectStore(name)
      this.stores.set(name, store)
    }
    return new MockIDBTransaction(store)
  }
}

let currentDbInstance: MockIDBDatabase | null = null

/**
 * @param existingV1Store 造一个"用户已经缓存过书、库还是 v1"的场景：
 *   chapters 表和老的两条索引已在、还带着记录。生产代码的升级分支必须只补新索引、
 *   既不重建表也不动存量记录 —— 版本号 +1 唯一的真风险就是这个。
 */
function setupMockIndexedDB(existingV1Store = false) {
  mockStorage.clear()
  // 上一轮的连接先关掉：offlineStorage 在 onclose 里清它自己缓存的 dbPromise，
  // 不清的话新的 mock 库根本不会被重新 open，用例会读到上一轮的存储。
  currentDbInstance?.onclose?.(null as any)

  const db = new MockIDBDatabase()
  if (existingV1Store) {
    const store = db.createObjectStore('chapters')
    store.createIndex('by_book', ['sourceId', 'bookUrl'])
    store.createIndex('by_cached_at', ['cachedAt'])
    store.data.set('src-old::book-old::c1', {
      key: 'src-old::book-old::c1', sourceId: 'src-old', bookUrl: 'book-old', chapterUrl: 'c1',
      title: '第1章', content: '老库里已经下好的一章', cachedAt: 1000, byteSize: 27,
    })
  }
  currentDbInstance = db

  const mockFactory = {
    open: (_name: string, _version: number) => {
      const req = new MockIDBRequest() as MockIDBRequest & {
        onupgradeneeded?: ((e: any) => void) | null
        transaction: MockIDBTransaction | null
      }
      req.result = currentDbInstance
      // 真实浏览器在 versionchange 事务里给的是"已经存在的那个 store"，这里同构
      req.transaction = new MockIDBTransaction(
        currentDbInstance?.stores.get('chapters') ?? new MockIDBObjectStore('chapters'),
      )
      setTimeout(() => {
        req.onupgradeneeded?.({ target: req })
        req.onsuccess?.({ target: req })
      }, 0)
      return req
    }
  }

  ;(globalThis as any).indexedDB = mockFactory
  ;(globalThis as any).IDBKeyRange = {
    only: (val: any) => val
  }
  return db
}

// Mock localStorage
const mockStorage = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (key: string) => mockStorage.get(key) ?? null,
  setItem: (key: string, val: string) => mockStorage.set(key, String(val)),
  removeItem: (key: string) => mockStorage.delete(key),
  clear: () => mockStorage.clear()
}

test('OfflineStorage - Chapter saving, retrieving, and list cached URLs', async () => {
  setupMockIndexedDB()

  await putOfflineChapter('src-1', 'book-url-1', 'chapter-url-1', '第1章', '这是第1章正文内容')
  await putOfflineChapter('src-1', 'book-url-1', 'chapter-url-2', '第2章', '这是第2章正文内容')

  const result1 = await getOfflineChapter('src-1', 'book-url-1', 'chapter-url-1')
  assert.ok(result1)
  assert.equal(result1?.title, '第1章')
  assert.equal(result1?.content, '这是第1章正文内容')

  const cachedUrls = await getOfflineChaptersSet('src-1', 'book-url-1')
  assert.equal(cachedUrls.size, 2)
  assert.ok(cachedUrls.has('chapter-url-1'))
  assert.ok(cachedUrls.has('chapter-url-2'))

  // Delete single book
  await clearOfflineBook('src-1', 'book-url-1')
  const cachedUrlsAfterDelete = await getOfflineChaptersSet('src-1', 'book-url-1')
  assert.equal(cachedUrlsAfterDelete.size, 0)
})

test('OfflineStorage - Shelf Snapshot persistence and retrieval', () => {
  mockStorage.clear()
  const dummyShelf: any = [
    { sourceId: 'src-1', bookUrl: 'b1', title: '测试书1', author: '作者1', durChapterTitle: '第1章' },
    { sourceId: 'src-2', bookUrl: 'b2', title: '测试书2', author: '作者2', durChapterTitle: '第2章' }
  ]

  saveShelfSnapshot(dummyShelf)
  const retrieved = getShelfSnapshot()

  assert.ok(retrieved)
  assert.equal(retrieved?.length, 2)
  assert.equal(retrieved?.[0].title, '测试书1')
})

test('OfflineStorage - Offline Reading Progress Queue Lifecycle and Flush', async () => {
  mockStorage.clear()

  enqueueOfflineProgress({
    sourceId: 'src-1',
    bookUrl: 'b1',
    chapterUrl: 'c1',
    chapterIndex: 5,
    scrollPosition: 0.8,
    updatedAt: Date.now()
  })

  enqueueOfflineProgress({
    sourceId: 'src-2',
    bookUrl: 'b2',
    chapterUrl: 'c2',
    chapterIndex: 10,
    scrollPosition: 0.2,
    updatedAt: Date.now() + 100
  })

  let syncCount = 0
  const syncCallback = async (_item: any) => {
    syncCount++
  }

  await flushOfflineProgress(syncCallback)
  assert.equal(syncCount, 2)

  // Flush again should be empty
  let syncCount2 = 0
  await flushOfflineProgress(async () => { syncCount2++ })
  assert.equal(syncCount2, 0)
})

test('OfflineStorage - Storage Stats, LRU Toggle and Eviction', async () => {
  setupMockIndexedDB()

  // Save chapters for book 1
  await putOfflineChapter('src-1', 'b1', 'c1', '第1章', '内容1'.repeat(100))
  
  const statsBefore = await getOfflineStorageStats()
  assert.equal(statsBefore.books.length, 1)
  assert.equal(statsBefore.books[0].chapterCount, 1)
  assert.ok(statsBefore.totalBytes > 0)

  // Clean data
  await clearAllOffline()
  const statsAfter = await getOfflineStorageStats()
  assert.equal(statsAfter.books.length, 0)
  assert.equal(statsAfter.totalBytes, 0)
})

test('Reader Offline Cache Range Math Calculation', () => {
  const totalChapters = 350

  // 1. 全本
  const fullStart = 0
  const fullEnd = totalChapters - 1
  const fullCount = totalChapters
  assert.equal(fullStart, 0)
  assert.equal(fullEnd, 349)
  assert.equal(fullCount, 350)

  // 2. 自定义：跨中段与贴到末尾都被夹在 [0, 末章]，且起点不会盖过终点
  const customStart = Math.max(0, 121 - 1)
  const customEnd = Math.max(customStart, 171 - 1)
  assert.equal(customStart, 120)
  assert.equal(customEnd, 170)

  const reversedStart = Math.max(0, 300 - 1)
  const reversedEnd = Math.max(reversedStart, 10 - 1)
  assert.equal(reversedEnd, reversedStart)

  const beyondEnd = Math.min(totalChapters - 1, 340 + 60)
  assert.equal(beyondEnd, 349)
})

/**
 * 淘汰不能碰「正在缓存的那本」：调用点是某章落库时配额爆了，若把它自己也清掉，
 * 用户会发现下载的书白下了。
 *
 * `targetBytesToFree` 故意给到无穷大，逼循环走完所有书 —— 给小目标的话第一本就 break，
 * exclude 那条断言就成了空判（我第一版就是这么写的，负对照撤掉修复仍全绿）。
 * 同理不声称这里在验「时间序 vs 游标序」：MockIDB 的游标顺序就是插入顺序，
 * 与写入时间同序，这个基座区分不了，硬写只会自欺。
 */
test('LRU eviction: 绝不淘汰正在写入的那本书', async () => {
  await clearAllOffline()
  await putOfflineChapter('src-lru', 'other-old', 'c1', '第一章', '别的书'.repeat(200))
  await putOfflineChapter('src-lru', 'current-book', 'c1', '第一章', '正在下的这本'.repeat(200))
  await putOfflineChapter('src-lru', 'other-new', 'c1', '第一章', '又一本'.repeat(200))

  const stats = await getOfflineStorageStats()
  assert.ok(stats.books.every(b => b.lastCachedAt > 0), 'lastCachedAt 必须被统计出来，否则无从判断新旧')

  await evictLruOfflineBooks(Number.POSITIVE_INFINITY, { sourceId: 'src-lru', bookUrl: 'current-book' })
  const left = (await getOfflineStorageStats()).books.map(b => b.bookUrl)
  assert.ok(left.includes('current-book'), '正在写入的书被自动淘汰清掉了')
  assert.ok(!left.includes('other-old') && !left.includes('other-new'), '其余书没被清 —— 说明测试根本没走到淘汰逻辑')

  // 对照组：同一批数据不给 exclude 时应连本带主一起清光，证明上一条断言真的在判事
  await evictLruOfflineBooks(Number.POSITIVE_INFINITY)
  const afterNoExclude = (await getOfflineStorageStats()).books.map(b => b.bookUrl)
  assert.ok(!afterNoExclude.includes('current-book'), '对照组失效：无 exclude 时它也没被清，那前面的断言不算证据')
  await clearAllOffline()
})

/**
 * 配额爆掉时的恢复路径必须**无条件**生效：以前它挂在一个默认关闭、界面上也几乎
 * 没人会去开的开关上（`legado_lru_evict_enabled` 不存在即 false），所以这条路径出厂休眠。
 * 若那个开关还在，这里第一次 put 失败后 promise 会直接 reject，测试当场变红。
 */
test('配额满时自动淘汰别的书并重试成功，且不动正在写的这本', async () => {
  await clearAllOffline()
  await putOfflineChapter('src-q', 'other-1', 'c1', '第一章', '别的书'.repeat(400))
  await putOfflineChapter('src-q', 'current', 'c1', '第一章', '正在下的这本'.repeat(400))

  quotaFailuresLeft = 1
  await putOfflineChapter('src-q', 'current', 'c2', '第二章', '新的一章'.repeat(400))
  quotaFailuresLeft = 0

  const books = (await getOfflineStorageStats()).books
  const current = books.find(b => b.bookUrl === 'current')
  assert.ok(current, '重试后当前这本的章节应写进去')
  assert.equal(current.chapterCount, 2, '已有的和新写的两章都该在')
  assert.ok(!books.some(b => b.bookUrl === 'other-1'), '应已淘汰别的书腾出空间')
  await clearAllOffline()
})

// ———— 离线缓存弹窗的三态（AI-2 任务 C·模块 5）————

test('offlineStatsView - 取失败不许画成"你确实没有缓存"', async () => {
  const { offlineStatsView } = await import('../src/components/OfflineCacheModal')
  assert.equal(offlineStatsView({ loading: true, failed: false, books: null }), 'loading')
  assert.equal(offlineStatsView({ loading: false, failed: false, books: 0 }), 'empty', '真取到 0 本才叫空')
  assert.equal(offlineStatsView({ loading: false, failed: false, books: 3 }), 'ready')
  assert.equal(offlineStatsView({ loading: false, failed: true, books: 0 }), 'failed',
    '即使条数是 0，失败过就不能报"没有"')
  // 反向对照：修前只有 loading 一个旗标 —— 不 loading 且 stats 为 null（读失败）会被判成 empty
  assert.equal(offlineStatsView({ loading: false, failed: false, books: null }), 'failed',
    '没取到又不在转圈时只能算没取到；这一条红了就说明界面又会把故障说成用户的操作结果')
})

// ———— 离线统计不再整表读正文（AI-2：修掉全表游标）————

const TOTALS_INDEX = 'by_book_totals'

test('accumulateBookStats - 分组、字节求和与最近时间', () => {
  const r = accumulateBookStats([
    ['s1', 'bA', 100, 5],
    ['s1', 'bA', 200, 9],
    ['s1', 'bB', 50, 7],
  ])
  assert.equal(r.totalChapters, 3)
  assert.equal(r.totalBytes, 350)
  assert.equal(r.books.length, 2)
  const a = r.books.find(b => b.bookUrl === 'bA')
  assert.ok(a)
  assert.equal(a.chapterCount, 2)
  assert.equal(a.totalBytes, 300)
  assert.equal(a.lastCachedAt, 9, '取的是这本书最后一次写入的时间，不是第一次')
})

/**
 * 分组的键必须比"能拼出来"更严：bookUrl 里本来就可能带 `::`（带注解的书源地址、
 * 聚合源的拼接地址都不是稀奇事），用 `::` 拼 (sourceId, bookUrl) 会把两本不同的书并成一本 ——
 * 少报一本，而章数与体积还都看着合理。生产代码用的是不可见分隔符，这里带反向对照。
 */
test('accumulateBookStats - 分组键不许用 :: 拼', () => {
  const r = accumulateBookStats([
    ['x', 'a::b', 7, 3],
    ['x::a', 'b', 7, 4],
    ['x', 'plain', 1, 1],
  ])
  assert.equal(r.books.length, 3, '两本不同的书被并成了一本')
  assert.equal(r.totalChapters, 3)
  assert.ok(r.books.some(b => b.sourceId === 'x::a' && b.bookUrl === 'b'), '分组不许改写两边的值')
  assert.ok(r.books.every(b => b.chapterCount === 1), '谁也没被算成谁的第二章')
  // 反向对照：同样这三条按 `::` 拼键，前两对确实会撞成一个 —— 证明上面那条在判事，不是空判
  const naive = new Set(['x' + '::' + 'a::b', 'x::a' + '::' + 'b', 'x' + '::' + 'plain'])
  assert.equal(naive.size, 2, '若 :: 拼接本来就分得开，这条判据就是空判')
})

test('统计走复合键索引，不再把正文整表读进内存', async () => {
  const db = setupMockIndexedDB()
  await putOfflineChapter('s1', 'bA', 'c1', '第1章', '甲'.repeat(500))
  const store = db.stores.get('chapters')
  assert.ok(store, '空库由生产代码的 onupgradeneeded 建表')
  assert.ok(store!.indexNames.contains(TOTALS_INDEX), '新库要有 by_book_totals，否则快路径永远不生效')

  await putOfflineChapter('s1', 'bA', 'c2', '第2章', '乙'.repeat(500))
  await putOfflineChapter('s1', 'bB', 'c1', '第1章', '丙'.repeat(500))

  const keyBefore = store!.keyCursorCalls
  const fullBefore = store!.fullCursorCalls
  const stats = await getOfflineStorageStats()
  assert.ok(store!.keyCursorCalls > keyBefore, '统计没走键游标 —— 那条快路径根本没被执行过')
  assert.equal(store!.fullCursorCalls, fullBefore, '统计还在整表读记录，正文被物化进内存')
  assert.equal(stats.totalChapters, 3)
  assert.equal(stats.books.length, 2)
  assert.equal(stats.books.find(b => b.bookUrl === 'bA')?.chapterCount, 2)
  assert.ok(stats.totalBytes > 0)
})

/**
 * 老记录缺列时键游标会少一条（复合索引要求每列都是合法键）。
 * 少了 store.count() 那次对账，这里会安静地少报一章 —— 所以退回全表扫描，宁可慢一次。
 */
test('统计对账不过就退回全表扫描，数字不许变', async () => {
  const db = setupMockIndexedDB()
  await putOfflineChapter('s1', 'bA', 'c1', '第1章', '甲'.repeat(100))
  const store = db.stores.get('chapters')!
  // 直接塞一条没有 byteSize 的记录，模拟 v1 时代写进去、没带这一列的旧缓存
  store.data.set('s1::bA::legacy', {
    key: 's1::bA::legacy', sourceId: 's1', bookUrl: 'bA', chapterUrl: 'legacy',
    title: '旧', content: 'old'.repeat(40), cachedAt: 1,
  })

  const keyBefore = store.keyCursorCalls
  const stats = await getOfflineStorageStats()
  assert.equal(stats.totalChapters, 2, '缺列的那条被索引漏掉后必须靠全表扫描补回来')
  assert.equal(stats.books.find(b => b.bookUrl === 'bA')?.chapterCount, 2)
  assert.equal(store.fullCursorCalls, 1, '退回时走的正是整表游标')
  assert.ok(store.keyCursorCalls > keyBefore, '先试过快路径、对账不过才退回')
})

test('索引没建起来时统计照样出数（退回全表扫描）', async () => {
  const db = setupMockIndexedDB()
  await putOfflineChapter('s1', 'bA', 'c1', '第1章', '甲'.repeat(100))
  const store = db.stores.get('chapters')!
  store.indexes.delete(TOTALS_INDEX)

  const stats = await getOfflineStorageStats()
  assert.equal(stats.totalChapters, 1)
  assert.equal(store.keyCursorCalls, 0, '没有索引就不该去开键游标')
  assert.equal(store.fullCursorCalls, 1)
})

/**
 * DB_VERSION 1→2 唯一的真实风险：用户设备上已经下了几十本书。
 * 升级必须只补新索引 —— 重建表等于把离线缓存清空，老记录一条都不能少。
 */
test('v1 库升到 v2 只补索引，不动表也不清老缓存', async () => {
  const db = setupMockIndexedDB(true)
  const old = await getOfflineChapter('src-old', 'book-old', 'c1')
  assert.ok(old, '升级把老缓存弄丢了')
  assert.equal(old!.content, '老库里已经下好的一章')

  const store = db.stores.get('chapters')!
  assert.equal(store.data.size, 1, '升级后老记录还在')
  assert.ok(store.indexNames.contains(TOTALS_INDEX), '升级要补上 by_book_totals')
  assert.ok(store.indexNames.contains('by_book'), '原有索引不许被重建掉')
  assert.ok(store.indexNames.contains('by_cached_at'), '原有索引不许被重建掉')

  await putOfflineChapter('s1', 'bA', 'c1', '第1章', '甲'.repeat(100))
  const stats = await getOfflineStorageStats()
  assert.equal(stats.totalChapters, 2, '老记录也要被新索引统计到')
  assert.equal(stats.books.length, 2)
  assert.equal(store.fullCursorCalls, 0, '升级后的库应当直接吃上快路径')
})
