import test from 'node:test'
import assert from 'node:assert/strict'
import { api, SearchResult } from '../src/lib/api.ts'
import {
  searchStore,
  bookKey,
  loadSourceBook,
  SourceChoice,
} from '../src/lib/searchStore.ts'
import { mergeStreamedResults, PROGRESS_FLUSH_MS, progressCanCoalesce, streamDedupeKey, SearchGroup } from '../src/lib/searchFilters.ts'
import { assertScalesLinearly, warmUp } from './perfCriteria.ts'

test('searchStore - bookKey and loadSourceBook helper', async () => {
  assert.equal(bookKey('【校对版】凡人修仙传', '忘语'), '凡人修仙传\u0000忘语')
  assert.equal(bookKey('未知小说', undefined), '未知小说\u0000')

  const originalDetails = api.details
  const originalChapters = api.chapters
  const originalProgress = api.progress

  try {
    api.details = async () => ({
      sourceId: 'https://src1.com',
      name: '凡人修仙传',
      author: '忘语',
      tocUrl: '/toc',
    })
    api.chapters = async () => [{ index: 0, title: '第一章', url: '/c1' }]
    api.progress = async () => ({
      sourceId: 'https://src1.com',
      bookUrl: '/book/1',
      chapterUrl: '/c1',
      chapterIndex: 0,
      scrollPosition: 0.2,
      updatedAt: 123456,
    })

    const book = await loadSourceBook({
      sourceId: 'https://src1.com',
      name: '凡人修仙传',
      bookUrl: '/book/1',
    })

    assert.equal(book.details.name, '凡人修仙传')
    assert.equal(book.chapters.length, 1)
    assert.equal(book.progress?.chapterIndex, 0)

    // Test that placeholder details name "未命名书籍" falls back to search result title
    api.details = async () => ({
      sourceId: 'https://src1.com',
      name: '未命名书籍',
      author: '爱潜水的乌贼',
      tocUrl: '/toc',
    })
    const bookWithFallback = await loadSourceBook({
      sourceId: 'https://src1.com',
      name: '诡秘之主',
      bookUrl: '/book/2',
    })
    assert.equal(bookWithFallback.details.name, '诡秘之主', 'Should fallback to search result title when details.name is 未命名书籍')
  } finally {
    api.details = originalDetails
    api.chapters = originalChapters
    api.progress = originalProgress
  }
})

test('searchStore - openGroup and candidate source fallback', async () => {
  const originalDetails = api.details
  const originalChapters = api.chapters
  const originalProgress = api.progress

  try {
    searchStore.reset()

    // 1st candidate fails, 2nd candidate succeeds
    api.details = async (sourceId) => {
      if (sourceId.includes('bad')) throw new Error('网络连接超时')
      return {
        sourceId,
        name: '完美世界',
        author: '辰东',
        tocUrl: '/toc',
      }
    }
    api.chapters = async () => [{ index: 0, title: '第一章 荒村', url: '/c1' }]
    api.progress = async () => undefined

    const group: SearchGroup = {
      key: '完美世界\u0000辰东',
      name: '完美世界',
      author: '辰东',
      sources: [
        { sourceId: 'https://bad.com', name: '完美世界', bookUrl: '/b/bad' },
        { sourceId: 'https://good.com', name: '完美世界', bookUrl: '/b/good' },
      ],
    }

    await searchStore.openGroup(group)

    const state = searchStore.getSnapshot()
    assert.ok(state.openBook !== null)
    assert.equal(state.openBook?.details.sourceId, 'https://good.com')
    assert.equal(state.choices.length, 2)
    assert.equal(state.choices[0].status, 'error')
    assert.equal(state.choices[1].status, 'loaded')

    // Test chooseSource with cached choice
    const goodChoice: SourceChoice = state.choices[1]
    await searchStore.chooseSource(goodChoice, group.sources)
    assert.equal(searchStore.getSnapshot().openBook?.details.sourceId, 'https://good.com')
  } finally {
    api.details = originalDetails
    api.chapters = originalChapters
    api.progress = originalProgress
    searchStore.reset()
  }
})

test('searchStore - state mutators and reset lifecycle', () => {
  searchStore.reset()
  searchStore.setKeyword('大奉打更人')
  searchStore.setSelectedSourceId('https://src.com')
  // 契约按 searchFilters.ts 的 SearchFilters 写：现在只有 query + sortMode 两项。
  // 这里原本喂的是 { category, minChapters, author, sortMode:'relevance' } —— 四个字段产品里都没有，
  // 而 setFilters 是整对象存进去的，于是 assert.equal(snap.filters.minChapters, 100) 也一直"过"：
  // 它测的是自己刚塞进去的野字段，不是产品的筛选契约（web/test 不在 tsc 的 include 里，所以没人报）。
  searchStore.setFilters({ query: '大奉', sortMode: 'sources' })

  let snap = searchStore.getSnapshot()
  assert.equal(snap.keyword, '大奉打更人')
  assert.equal(snap.selectedSourceId, 'https://src.com')
  assert.equal(snap.filters.query, '大奉')
  assert.equal(snap.filters.sortMode, 'sources')

  searchStore.reset()
  snap = searchStore.getSnapshot()
  assert.equal(snap.keyword, '')
  assert.equal(snap.selectedSourceId, '')
  assert.equal(snap.loading, false)
})

test('searchStore - stopSearch lifecycle and status flag', () => {
  const originalWebSocket = globalThis.WebSocket
  const originalLocation = globalThis.location

  class MockWebSocket {
    static OPEN = 1
    readyState = 1
    sentMessages: string[] = []
    closed = false

    addEventListener(_event: string, _cb: any) {}
    send(data: string) { this.sentMessages.push(data) }
    close() { this.closed = true }
  }

  ;(globalThis as any).WebSocket = MockWebSocket
  ;(globalThis as any).location = { protocol: 'http:', host: 'localhost:8080' }

  try {
    searchStore.reset()
    searchStore.setKeyword('凡人修仙传')
    
    // Directly simulate loading state
    searchStore.startSearch('凡人修仙传')
    let snap = searchStore.getSnapshot()
    assert.equal(snap.loading, true)
    assert.equal(snap.stopped, false)

    // Call stopSearch
    searchStore.stopSearch()
    snap = searchStore.getSnapshot()
    assert.equal(snap.loading, false)
    assert.equal(snap.stopped, true)

    // Subsequent startSearch resets stopped flag
    searchStore.startSearch('凡人修仙传')
    snap = searchStore.getSnapshot()
    assert.equal(snap.loading, true)
    assert.equal(snap.stopped, false)
    
    searchStore.stopSearch()
  } finally {
    globalThis.WebSocket = originalWebSocket
    globalThis.location = originalLocation
    searchStore.reset()
  }
})


// ———— 流式搜索的判重与攒批（AI-2 任务 C·模块 2「搜索 UI」，也是 R4 第一项）————

test('mergeStreamedResults - 判重表跨封包持有：同源同地址只收一次，跨源同书都要留', () => {
  const seen = new Set<string>()
  const fresh = [
    { sourceId: 's1', bookUrl: '/b1' } as any,
    { sourceId: 's1', bookUrl: '/b2' } as any,
  ]
  assert.equal(mergeStreamedResults(seen, fresh).length, 2)
  assert.equal(mergeStreamedResults(seen, [{ sourceId: 's1', bookUrl: '/b1' } as any]).length, 0, '重复的不再进')
  // 跨书源的同一本书必须都留着：用户就是在这排结果里挑源
  assert.equal(mergeStreamedResults(seen, [{ sourceId: 's2', bookUrl: '/b1' } as any]).length, 1)
  // 反向对照：判重只认这张表。换新表（新一次搜索 / reset）同一条又能进来 ——
  // 这条钉住"store 忘了换表会让第二次搜结果凭空少一半"
  assert.equal(mergeStreamedResults(new Set<string>(), [{ sourceId: 's1', bookUrl: '/b1' } as any]).length, 1)
})

test('progressCanCoalesce - 只有 progress 能攒，start/done/error 必须立刻（否则状态行会说谎）', () => {
  assert.equal(progressCanCoalesce('progress'), true)
  for (const type of ['start', 'done', 'error']) {
    assert.equal(progressCanCoalesce(type), false, `${type} 不可以攒`)
  }
  assert.ok(PROGRESS_FLUSH_MS >= 120 && PROGRESS_FLUSH_MS <= 500, `合并窗口要够短（看不出停顿）又够长（真能攒）：当前 ${PROGRESS_FLUSH_MS}`)
})


test('流式合并的规模：常驻判重表线性，整表重建（修前那版写法）超线性', () => {
  const batches = (packets: number, per: number) =>
    Array.from({ length: packets }, (_, p) =>
      Array.from({ length: per }, (_, i) => ({ sourceId: `s${p}`, bookUrl: `/b/${p}-${i}` }) as any))

  // 修后：判重表跨封包持有，每条封包只看自己那几项
  const merged = (list: ReturnType<typeof batches>) => {
    const seen = new Set<string>()
    let count = 0
    for (const batch of list) count += mergeStreamedResults(seen, batch).length
    return count
  }
  // 修前：每条封包把已收结果整份重建成一个 Set 再 filter —— 产品代码原本就是这么写的
  const rebuilt = (list: ReturnType<typeof batches>) => {
    const out: any[] = []
    for (const batch of list) {
      const known = new Set(out.map(streamDedupeKey))
      out.push(...batch.filter(item => !known.has(streamDedupeKey(item))))
    }
    return out.length
  }

  const small = batches(500, 12) // 6,000 条
  const big = batches(2500, 12)  // 30,000 条 = 5 倍数据
  // 取三次最小值：一次小 GC 混进单次墙上时间就能把比值从 5× 推到 17×（第一版就是这么被推红的）
  const time = (fn: () => void) => {
    let best = Number.POSITIVE_INFINITY
    for (let round = 0; round < 3; round += 1) {
      const started = performance.now()
      fn()
      best = Math.min(best, performance.now() - started)
    }
    return best
  }

  warmUp(() => merged(small), 3)
  warmUp(() => merged(big), 2)
  assertScalesLinearly({
    name: '流式合并（常驻判重表）',
    smallMs: time(() => merged(small)),
    bigMs: time(() => merged(big)),
    dataFactor: 5,
  })

  // 反向对照：整表重建那版在同样数据上必须明显更贵，否则"当初为什么要改"没有量化理由。
  // 刻意只用一档小数据：修前那版是 O(已收 × 封包)，按上面 30,000 条跑一次要几十秒 —— 用例不该把机器拖死
  const contrast = batches(300, 12) // 3,600 条
  assert.equal(merged(contrast), rebuilt(contrast), '两版必须收下同样多的条数，否则比时间毫无意义')
  const contrastMergedMs = time(() => merged(contrast))
  const contrastRebuiltMs = time(() => rebuilt(contrast))
  assert.ok(
    contrastRebuiltMs > contrastMergedMs * 10,
    `整表重建 ${contrastRebuiltMs.toFixed(1)}ms vs 常驻判重表 ${contrastMergedMs.toFixed(1)}ms —— 拉不开 10 倍就是空判`,
  )
})

test('流式 progress 攒批：600 条进度封包只换几次渲染，终态与结果仍要立刻可见', () => {
  const originalWebSocket = globalThis.WebSocket
  const originalLocation = globalThis.location
  const created: any[] = []
  class MockWebSocket {
    static OPEN = 1
    readyState = 1
    closed = false
    listeners: Record<string, ((e: any) => void)[]> = {}
    constructor() { created.push(this) }
    addEventListener(type: string, cb: any) { (this.listeners[type] ||= []).push(cb) }
    send() {}
    close() { this.closed = true }
    emit(type: string, detail: any) { for (const cb of this.listeners[type] || []) cb(detail) }
  }
  ;(globalThis as any).WebSocket = MockWebSocket
  ;(globalThis as any).location = { protocol: 'http:', host: 'localhost:1299' }

  let emits = 0
  let off: (() => void) | null = null
  const packet = (body: unknown) => ({ data: JSON.stringify(body) })
  const total = 5574
  try {
    searchStore.reset()
    off = searchStore.subscribe(() => { emits += 1 })
    searchStore.startSearch('攒批测试')
    const socket = created[created.length - 1]
    assert.ok(socket, 'store 没建出流式连接')
    socket.emit('open', {})

    const before = emits
    socket.emit('message', packet({ type: 'start', totalSources: total }))
    assert.equal(emits, before + 1, 'start 立刻落一次')

    for (let i = 1; i <= 600; i += 1) {
      socket.emit('message', packet({ type: 'progress', totalSources: total, completedSources: i }))
    }
    assert.equal(emits, before + 1, '600 条 progress 一条都不该立刻重渲染（攒进窗口里）')

    socket.emit('message', packet({ type: 'results', totalSources: total, results: [{ sourceId: 's1', bookUrl: '/b1', name: '甲', author: 'x' }] }))
    socket.emit('message', packet({ type: 'results', totalSources: total, results: [
      { sourceId: 's1', bookUrl: '/b1', name: '甲', author: 'x' },
      { sourceId: 's2', bookUrl: '/b1', name: '甲', author: 'x' },
    ] }))
    assert.equal(searchStore.getSnapshot().results.length, 2, '两条 results 里同源重复的那条不重复收')

    const beforeDup = emits
    socket.emit('message', packet({ type: 'results', totalSources: total, results: [{ sourceId: 's1', bookUrl: '/b1', name: '甲', author: 'x' }] }))
    assert.equal(emits, beforeDup, '全是重复的封包不该引发一次空重渲染')

    socket.emit('message', packet({ type: 'done', totalSources: total, completedSources: total, resultCount: 2 }))
    const snap = searchStore.getSnapshot()
    assert.equal(snap.loading, false, 'done 之后不能再挂着搜索中')
    assert.equal(snap.progress?.type, 'done', '终态不等窗口，立刻可见')
    assert.equal(snap.progress?.completedSources, total)
    assert.ok(emits <= 8, `六千条源的真实节奏下这里只发生了 ${emits} 次渲染`)
  } finally {
    if (off) off()
    globalThis.WebSocket = originalWebSocket
    globalThis.location = originalLocation
    searchStore.reset()
  }
})
