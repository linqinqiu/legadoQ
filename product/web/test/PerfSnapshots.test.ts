import test from 'node:test'
import assert from 'node:assert/strict'
import type { PerformanceMetric, PerformanceReport } from '../src/lib/performance'
import {
  appendSnapshot,
  clearSnapshots,
  readSnapshots,
  summarize,
  type PerfSnapshot,
} from '../src/lib/perfSnapshots'

/** 装一个可控的 localStorage，跑完还原（node:test 同进程共享 globalThis，别污染别的用例）。 */
function withStorage(run: (store: Record<string, string>) => void) {
  const store: Record<string, string> = {}
  const original = (globalThis as any).localStorage
  ;(globalThis as any).localStorage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
  }
  try {
    run(store)
  } finally {
    ;(globalThis as any).localStorage = original
  }
}

const apiMetric = (name: string, duration?: number): PerformanceMetric => ({
  name,
  startTime: 0,
  value: duration ?? 0,
  ...(duration === undefined ? {} : { duration }),
  category: 'api',
})

const report = (overrides: Partial<PerformanceReport> = {}): PerformanceReport => ({
  timestamp: 1000,
  pageLoadTime: 120.6,
  tti: 234.4,
  apiRequests: [],
  indexedDbOps: [],
  bottlenecks: [],
  ...overrides,
})

test('summarize 压出稳定摘要：慢 API 按 300ms 计、最慢 3 条降序、缺 duration 当 0', () => {
  const snapshot = summarize(report({
    apiRequests: [
      apiMetric('/api/slow', 900),
      apiMetric('/api/mid', 350),
      apiMetric('/api/fast', 40),
      apiMetric('/api/no-duration'),
    ],
    bottlenecks: ['/api/slow: 900ms'],
  }), 5555)

  assert.equal(snapshot.at, 5555)
  assert.equal(snapshot.pageLoadMs, 121, '耗时取整，别把小数存进 localStorage')
  assert.equal(snapshot.ttiMs, 234)
  assert.equal(snapshot.apiCount, 4)
  assert.equal(snapshot.slowApiCount, 2, '900 与 350 超过 300ms')
  assert.equal(snapshot.maxApiMs, 900)
  assert.equal(snapshot.bottleneckCount, 1)
  assert.deepEqual(
    snapshot.slowest.map(item => item.url),
    ['/api/slow', '/api/mid', '/api/fast'],
    '最慢的排前面，缺 duration 的不进榜',
  )
})

test('append/read 往返，且只保留最近 8 份（丢最旧）', () => {
  withStorage(() => {
    for (let i = 0; i < 10; i += 1) appendSnapshot(report(), i)
    const list = readSnapshots()
    assert.equal(list.length, 8, '上限 8 份')
    assert.deepEqual(list.map(item => item.at), [2, 3, 4, 5, 6, 7, 8, 9], '丢掉最旧的两份')
  })
})

test('readSnapshots 跳过坏数据，不让一条脏记录毁掉面板', () => {
  withStorage(store => {
    const bad = { at: 'not-a-number', apiCount: 1, slowest: [] }
    const good = summarize(report(), 1)
    store['legado-perf-snapshots'] = JSON.stringify([bad, good])
    const list = readSnapshots()
    assert.equal(list.length, 1)
    assert.equal(list[0].at, 1)
  })
})

test('隐私模式存储不可用时静默降级，不抛错', () => {
  const original = (globalThis as any).localStorage
  ;(globalThis as any).localStorage = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('denied') },
    removeItem: () => { throw new Error('denied') },
  }
  try {
    assert.deepEqual(readSnapshots(), [])
    const list = appendSnapshot(report(), 1)
    assert.equal(list.length, 1, '存不下也返回本次摘要，内存里的 report 仍可用')
    assert.doesNotThrow(() => clearSnapshots())
  } finally {
    ;(globalThis as any).localStorage = original
  }
})

test('clearSnapshots 清空全部', () => {
  withStorage(() => {
    appendSnapshot(report(), 1)
    assert.equal(readSnapshots().length, 1)
    clearSnapshots()
    assert.deepEqual(readSnapshots(), [])
  })
})
