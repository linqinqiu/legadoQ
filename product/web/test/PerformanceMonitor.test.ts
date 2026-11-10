import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performanceMonitor, fetchWithMetrics, dbTransaction } from '../src/lib/performance'

// 导入这个模块就会构造单例并 `init()`（起定时器 + 两个 PerformanceObserver）。
// 跑完必须收摊：`observe()` 在 Node 里是持有事件循环的句柄，不收的话
// 「用例全绿、`npm test` 却退不出去」——这正是本次重写要修的那个现象。
after(() => performanceMonitor.dispose())

/**
 * `lib/performance.ts` 的判据。
 *
 * ## 这份文件被重写过
 *
 * 原版是 `PerformanceMonitor.test.ts`，用 **vitest**（`describe/it/expect/vi`）——
 * 本仓库没有、也不该引入 vitest：前端测试统一是 `node:test` + `node:assert`，
 * 由 `test/run-all.ts` 用 tsx 直接跑。结果是 `ERR_MODULE_NOT_FOUND: Cannot find package 'vitest'`，
 * 而且它是在测试结束**之后**作为 uncaughtException 抛出来的 —— 486 条用例全绿，
 * `npm test` 的退出码却是 1。这种失败最难查：报告说没失败，CI 说失败。
 *
 * 重写时只断言**实现里真实成立的**行为，并且不用任何 mock 库：
 * `fetch` 本来就是个可替换的全局函数，直接换掉即可。
 */
test('report 的形状稳定，且初始为空', () => {
  performanceMonitor.reset()
  const report = performanceMonitor.report()

  assert.equal(typeof report.timestamp, 'number')
  assert.ok(Array.isArray(report.apiRequests), 'apiRequests 必须是数组')
  assert.ok(Array.isArray(report.indexedDbOps), 'indexedDbOps 必须是数组')
  assert.ok(Array.isArray(report.bottlenecks), 'bottlenecks 必须是数组')
  assert.equal(report.apiRequests.length, 0, 'reset 之后不该还有指标')
  assert.equal(report.indexedDbOps.length, 0)
})

test('fetchWithMetrics 记录一次 API 指标并原样返回响应', async () => {
  performanceMonitor.reset()
  const original = globalThis.fetch
  try {
    globalThis.fetch = (async () => ({ status: 200 })) as typeof fetch

    const response = await fetchWithMetrics('http://127.0.0.1:1234/api/healthz')

    assert.equal((response as Response).status, 200, '响应必须原样返回')
    const report = performanceMonitor.report()
    assert.equal(report.apiRequests.length, 1, '一次请求应对应一条 api 指标')
    assert.equal(report.apiRequests[0].category, 'api')
  } finally {
    globalThis.fetch = original
  }
})

test('fetchWithMetrics 在请求失败时也留痕，并把异常抛回去', async () => {
  performanceMonitor.reset()
  const original = globalThis.fetch
  try {
    globalThis.fetch = (async () => {
      throw new Error('boom')
    }) as typeof fetch

    await assert.rejects(() => fetchWithMetrics('http://127.0.0.1:1234/api/broken'), /boom/)
    // 失败也要记账：只统计成功请求等于把「慢/错」藏起来
    assert.equal(performanceMonitor.report().apiRequests.length, 1, '失败请求同样要留一条指标')
  } finally {
    globalThis.fetch = original
  }
})

test('dbTransaction 把回调结果透传，并按 store 名记账', async () => {
  performanceMonitor.reset()
  const result = await dbTransaction('legado-reader', ['book_shelf'], async () => [{ id: 1 }])

  assert.deepEqual(result, [{ id: 1 }], '回调结果必须原样透传')
  const ops = performanceMonitor.report().indexedDbOps
  assert.equal(ops.length, 1)
  assert.ok(ops[0].name.includes('book_shelf'), `指标名要带上 store，实际 ${ops[0].name}`)
})

test('record 记录调用方自计的指标，慢的会进 bottlenecks', () => {
  performanceMonitor.reset()
  performanceMonitor.record('pagination_measure', 'render', 42)
  let report = performanceMonitor.report()
  assert.equal(report.bottlenecks.length, 0, '42ms 不该算瓶颈')
  assert.equal(report.apiRequests.length, 0, 'render 指标不该混进 apiRequests')

  performanceMonitor.record('pagination_measure', 'render', 600)
  report = performanceMonitor.report()
  assert.equal(report.bottlenecks.length, 1, '超过 500ms 要能被 report 点出来')
  assert.ok(report.bottlenecks[0].includes('pagination_measure'))
})

/**
 * 接线判据：采集器存在不等于它在工作。
 *
 * 上一轮就是「`performance.ts` 写了 296 行、测试全绿，但 API 客户端仍裸 fetch」，
 * 所以这里直接盯住两个真实调用点，防止再退回「配了但没人用」。
 */
test('API 客户端与分页测量都走性能采集器', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const client = fs.readFileSync(path.join(root, 'src/lib/api/client.ts'), 'utf8')
  assert.match(client, /fetchWithMetrics\(/, '统一 API 客户端必须走 fetchWithMetrics')

  const screen = fs.readFileSync(path.join(root, 'src/features/reader/ReaderScreen.tsx'), 'utf8')
  const measureHook = fs.readFileSync(path.join(root, 'src/features/reader/usePaginationMeasurement.ts'), 'utf8')
  assert.match(measureHook, /performanceMonitor\.record\('pagination_measure'/, '分页测量必须记指标')
  assert.match(screen, /usePaginationMeasurement\(/, '阅读器要真的用上分页测量 hook')
})

test('慢请求的两个阈值不是同一个数：300ms 报 warn，500ms 才进 bottlenecks', async () => {
  performanceMonitor.reset()
  const original = globalThis.fetch
  const originalWarn = console.warn
  const warned: string[] = []
  const slowFetch = (ms: number) => (async () => {
    // 真等，不去 mock 时钟：这条判据要的就是「墙钟过了阈值会怎样」，
    // 用假时钟验的是「如果时间走快了」，等于什么都没验。
    await new Promise(resolve => setTimeout(resolve, ms))
    return { status: 200 }
  }) as typeof fetch
  try {
    console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')) }

    // 第一次：310ms —— 过 warn 线（300），但还没过 bottlenecks 线（500）
    globalThis.fetch = slowFetch(310)
    await fetchWithMetrics('http://127.0.0.1:1234/api/slow-warn')
    assert.ok(warned.some(line => line.includes('Slow API')), '超过 300ms 必须 warn 出来')
    assert.equal(
      performanceMonitor.report().bottlenecks.length,
      0,
      '310ms 还不到 500ms，不该进 bottlenecks —— 这两个阈值本来就不是同一个数',
    )

    // 第二次：600ms —— 两条线都过
    performanceMonitor.reset()
    warned.length = 0
    globalThis.fetch = slowFetch(600)
    await fetchWithMetrics('http://127.0.0.1:1234/api/very-slow')
    const report = performanceMonitor.report()
    assert.equal(report.bottlenecks.length, 1, '超过 500ms 要进 bottlenecks，方便报告里直接点出来')
    assert.ok(report.bottlenecks[0].includes('ms'), `瓶颈描述要带耗时，实际 ${report.bottlenecks[0]}`)
  } finally {
    globalThis.fetch = original
    console.warn = originalWarn
  }
})

/**
 * 统一超时（2026-11-10）。浏览器 `fetch` 本身没有超时：上游半开连接会让界面永远转圈。
 * 这两个用例盯的是"到点真的掐断"与"别把调用方自己的取消改写成超时"。
 */
test('timeoutMs：到点 abort 请求，并抛一句能照着改的话', async () => {
  performanceMonitor.reset()
  const original = globalThis.fetch
  let aborted = false
  try {
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true
          reject(new Error('aborted'))
        })
      })) as typeof fetch

    await assert.rejects(fetchWithMetrics('/api/agent/chat', {}, 25), /请求超时/)
    assert.equal(aborted, true, '只丢 promise 不算超时 —— 请求必须真的被中止')
  } finally {
    globalThis.fetch = original
  }
})

test('timeoutMs：调用方自己的 signal 优先，不把它的中止说成超时', async () => {
  performanceMonitor.reset()
  const original = globalThis.fetch
  const controller = new AbortController()
  try {
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('caller-abort')))
      })) as typeof fetch

    setTimeout(() => controller.abort(), 10)
    await assert.rejects(fetchWithMetrics('/api/slow', { signal: controller.signal }, 5_000), /caller-abort/)
  } finally {
    globalThis.fetch = original
  }
})
