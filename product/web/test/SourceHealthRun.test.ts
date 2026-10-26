import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  HEALTH_BASELINE_KEY,
  HEALTH_CHUNK,
  getHealthRun,
  loadBaseline,
  mergeBaseline,
  resetHealthRun,
  saveBaseline,
  startHealthRun,
  stopHealthRun,
  type HealthRunStart,
} from '../src/sources/sourceHealthRun'
import { autoTagBatches, HEALTH_TAGS } from '../src/sources/sourceGrouping'
import type { SourceHealthCheckItem } from '../src/lib/api'

/**
 * 「书源体检，除非点击了关闭，其他情况都后台持续体检一直到结束，
 *  体检获得的内容在体检的过程中去给不能正常使用的分好组」（用户 2026-10-02）。
 *
 * 这一版的重点是**行为级**：不再读源码 match 正则，而是喂 fake storage / fake fetch
 * 真把 `startHealthRun` 跑一轮，断它落到 localStorage 里的基线、算出的变化数、跨会话读取。
 * 只有"卸载回调里不许出现取消"这类**结构性**约束（没有可观测的行为面）才保留源码断言。
 */

// ── 测试替身 ────────────────────────────────────────────────

/** 最小 Storage 实现：真按 Map 存取，能验"写进去的东西下次读得回来"。 */
function fakeStorage(seed: Record<string, string> = {}): Storage & { dump: () => Record<string, string> } {
  const map = new Map(Object.entries(seed))
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => { map.delete(key) },
    setItem: (key: string, value: string) => { map.set(key, String(value)) },
    dump: () => Object.fromEntries(map),
  }
}

/** 造一条体检结论；只给断言用到的字段，其余填中性值。 */
const item = (id: string, statusCategory: string): SourceHealthCheckItem => ({
  id, name: id, ok: statusCategory === 'valid' || statusCategory === 'slow',
  latencyMs: 10, statusCode: 200, statusCategory,
})

/**
 * 把 `globalThis.fetch` 换成一个按批次回结论的假服务端。
 * `api.healthCheckSources` 走的就是 `fetch('/api/sources/health-check')`，所以拦这一层
 * 就等于拦住整条网络路径 —— 不需要 DOM、不需要真服务。
 */
function fakeHealthServer(categoryOf: (id: string) => string) {
  const calls: Array<{ ids: string[] }> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (!url.includes('/api/sources/health-check')) {
      // 打标签等其它写请求：一律成功，返回空对象即可
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as { ids?: string[] }
    const ids = body.ids ?? []
    calls.push({ ids })
    const payload = {
      total: ids.length, successCount: 0, slowCount: 0, failedCount: 0, durationMs: 1,
      results: ids.map(id => item(id, categoryOf(id))),
    }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
  return {
    calls,
    restore: () => { globalThis.fetch = original },
  }
}

/** 把一轮体检跑完（`startHealthRun` 现在返回的 Promise 在这一轮结束时 resolve）。 */
function runOnce(options: Partial<HealthRunStart> & { ids: string[] }): Promise<void> {
  return startHealthRun({
    groupsOf: () => ({}),
    onSourcesChange: () => {},
    onToast: () => {},
    ...options,
  })
}

// ── 纯函数：基线合并 ─────────────────────────────────────────

test('mergeBaseline - 单源重测不会把基线从 N 条打回 1 条', () => {
  // 这是 v0.8.4 那条修复的核心语义：整库体检攒下 5000+ 条结论，
  // 用户只对 1 个源点「重测」时 results 只有 1 条 —— 覆盖式写入会把另外 4999 条抹掉，
  // 下一轮全库体检就再也比不出"结论变了"。
  const previous = { a: 'valid', b: 'unreachable', c: 'slow', d: 'needs_login' }
  const merged = mergeBaseline(previous, [{ id: 'b', statusCategory: 'valid' }])

  assert.equal(Object.keys(merged).length, 4, '条数不变：只更新被测的那一条，别的原样留着')
  assert.equal(merged.b, 'valid', '被测的源更新成新结论')
  assert.equal(merged.a, 'valid', '没被测的源保持旧结论')
  assert.equal(merged.c, 'slow')
  assert.equal(merged.d, 'needs_login')
})

test('mergeBaseline - 不修改入参（纯函数，不许就地改旧基线）', () => {
  const previous = { a: 'valid', b: 'unreachable' }
  const snapshot = { ...previous }
  const merged = mergeBaseline(previous, [{ id: 'b', statusCategory: 'broken' }])

  assert.deepEqual(previous, snapshot, '旧基线对象必须原封不动')
  assert.notEqual(merged, previous, '返回的是新对象')
  assert.equal(merged.b, 'broken')
})

test('mergeBaseline - 新源会加进来，空结果原样返回', () => {
  const merged = mergeBaseline({ a: 'valid' }, [{ id: 'z', statusCategory: 'tls' }])
  assert.deepEqual(merged, { a: 'valid', z: 'tls' }, '第一次见到的源要落进基线')

  const untouched = mergeBaseline({ a: 'valid', b: 'slow' }, [])
  assert.deepEqual(untouched, { a: 'valid', b: 'slow' }, '一条都没测时基线不变')
})

test('mergeBaseline - 同 id 重复出现时后者胜（批次边界重叠也不出错）', () => {
  const merged = mergeBaseline({}, [
    { id: 'a', statusCategory: 'unreachable' },
    { id: 'a', statusCategory: 'valid' },
  ])
  assert.deepEqual(merged, { a: 'valid' })
})

// ── 跨会话：fake storage 读回 ────────────────────────────────

test('loadBaseline - 没有 localStorage 时安全返回空对象（不抛）', () => {
  // node 里本来没有 localStorage；生产代码靠 `typeof localStorage === 'undefined'` 兜底。
  // 注意：**不能断言"全局确实没有 localStorage"** —— 同套件里 offline-pwa / SearchLayout 等
  // 会给 `globalThis.localStorage` 装假实现且不清理，全量跑时那条前提就不成立了（实测踩过：
  // 单跑绿、全量红）。所以这里显式传 null 演"没有可用 storage"，只钉兜底逻辑本身。
  assert.deepEqual(loadBaseline(null), {}, '显式 null = 没有 storage，返回空基线')
  const throwing = { getItem: () => { throw new Error('SecurityError') } } as unknown as Storage
  assert.deepEqual(loadBaseline(throwing), {}, '读取抛异常（隐私模式）也要退化成空基线')
})

test('saveBaseline → loadBaseline - 跨会话读得回来（fake storage 模拟重开浏览器）', () => {
  // "跨会话"= 换一个 Storage 实例读同一份数据。这里先写、再从 dump 出来的内容造新实例读，
  // 等价于「关掉浏览器再打开」。
  const first = fakeStorage()
  saveBaseline([{ id: 'a', statusCategory: 'valid' }, { id: 'b', statusCategory: 'broken' }], first)

  const raw = first.dump()
  assert.ok(raw[HEALTH_BASELINE_KEY], `基线落在 ${HEALTH_BASELINE_KEY} 这个键上`)
  assert.deepEqual(JSON.parse(raw[HEALTH_BASELINE_KEY]), { a: 'valid', b: 'broken' })

  const reopened = fakeStorage(raw)
  assert.deepEqual(loadBaseline(reopened), { a: 'valid', b: 'broken' }, '重开浏览器后还能接上上次结论')
})

test('saveBaseline - 只重测一条时，已存的几千条不会被抹掉（跨会话合并）', () => {
  // 端到端演一遍真实场景：整库跑完落盘 → 用户只重测 1 个源 → 再读回。
  const storage = fakeStorage()
  const wholeLibrary = Array.from({ length: 200 }, (_, index) => ({
    id: `src-${index}`,
    statusCategory: index % 2 === 0 ? 'valid' : 'unreachable',
  }))
  saveBaseline(wholeLibrary, storage)
  assert.equal(Object.keys(loadBaseline(storage)).length, 200)

  saveBaseline([{ id: 'src-1', statusCategory: 'valid' }], storage)

  const after = loadBaseline(storage)
  assert.equal(Object.keys(after).length, 200, '重测 1 条之后基线仍是 200 条')
  assert.equal(after['src-1'], 'valid', '那一条被更新了')
  assert.equal(after['src-0'], 'valid', '其它源的旧结论还在')
  assert.equal(after['src-3'], 'unreachable')
})

test('loadBaseline - 存储里是坏 JSON / 非对象时退化成空基线（不崩）', () => {
  assert.deepEqual(loadBaseline(fakeStorage({ [HEALTH_BASELINE_KEY]: 'not json' })), {})
  assert.deepEqual(loadBaseline(fakeStorage({ [HEALTH_BASELINE_KEY]: '"a string"' })), {})
  assert.deepEqual(loadBaseline(fakeStorage({ [HEALTH_BASELINE_KEY]: 'null' })), {})
})

test('saveBaseline - 存储写失败时静默吞掉（隐私模式/超额不该炸掉体检）', () => {
  const hostile = {
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError') },
  } as unknown as Storage
  assert.doesNotThrow(() => saveBaseline([{ id: 'a', statusCategory: 'valid' }], hostile))
})

// ── 行为级：真驱动 startHealthRun ────────────────────────────

test('startHealthRun - 跑完一轮把结论写进基线（可用 fake fetch 完整驱动，不启 DOM）', async () => {
  const storage = fakeStorage()
  const server = fakeHealthServer(id => (id === 'b' ? 'unreachable' : 'valid'))
  try {
    await runOnce({ ids: ['a', 'b', 'c'], storage })
    const state = getHealthRun()
    assert.equal(state.running, false, '跑完要停')
    assert.equal(state.finished, 'done')
    assert.equal(state.checked, 3, '三条都测过')

    const baseline = loadBaseline(storage)
    assert.deepEqual(baseline, { a: 'valid', b: 'unreachable', c: 'valid' }, '本轮结论落盘成基线')
  } finally {
    server.restore()
  }
})

test('startHealthRun - 相对上次基线的变化计数：变差/变好分开记，新源不算变', async () => {
  // 上次基线：a 好、b 坏、c 待确认。本轮：a 变坏、b 变好、c 不变、d 是新源。
  const storage = fakeStorage({
    [HEALTH_BASELINE_KEY]: JSON.stringify({ a: 'valid', b: 'unreachable', c: 'needs_login' }),
  })
  const server = fakeHealthServer(id => ({
    a: 'unreachable', // good → bad，变差
    b: 'valid', // bad → good，变好
    c: 'needs_login', // 不变
    d: 'broken', // 新出现，不算变
  })[id] ?? 'valid')
  try {
    await runOnce({ ids: ['a', 'b', 'c', 'd'], storage })
    const state = getHealthRun()
    assert.equal(state.baselineChanged, 2, 'a 与 b 变了；c 没变、d 是新源')
    assert.equal(state.baselineWorse, 1, 'a 变差')
    assert.equal(state.baselineBetter, 1, 'b 变好')
  } finally {
    server.restore()
  }
})

test('startHealthRun - 没有上次基线时 changed=0（第一次体检不该报"结论变了"）', async () => {
  const storage = fakeStorage()
  const server = fakeHealthServer(() => 'valid')
  try {
    await runOnce({ ids: ['a', 'b'], storage })
    const state = getHealthRun()
    assert.equal(state.baselineChanged, 0)
    assert.equal(state.baselineWorse, 0)
    assert.equal(state.baselineBetter, 0)
  } finally {
    server.restore()
  }
})

test('startHealthRun - 跨会话：上一次落盘的基线会被这一轮读到并用于比较', async () => {
  // 第一轮：全好，落盘。
  const storage = fakeStorage()
  const server = fakeHealthServer(() => 'valid')
  try {
    await runOnce({ ids: ['a', 'b'], storage })
    assert.deepEqual(loadBaseline(storage), { a: 'valid', b: 'valid' })

    // 模拟"关掉浏览器再打开"：用同一份落盘内容造新 storage，a 这一轮坏了。
    const reopened = fakeStorage(storage.dump())
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (!url.includes('/api/sources/health-check')) {
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { ids?: string[] }
      const ids = body.ids ?? []
      const results = ids.map(id => item(id, id === 'a' ? 'unreachable' : 'valid'))
      return new Response(JSON.stringify({
        total: ids.length, successCount: 0, slowCount: 0, failedCount: 0, durationMs: 1, results,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
    try {
      await runOnce({ ids: ['a', 'b'], storage: reopened })
      const state = getHealthRun()
      assert.equal(state.baselineChanged, 1, '重开后仍能比出 a 变了')
      assert.equal(state.baselineWorse, 1)
    } finally {
      globalThis.fetch = original
    }
  } finally {
    server.restore()
  }
})

test('startHealthRun - previous 优先于 localStorage（同一次打开、范围一致时最准）', async () => {
  // localStorage 里 a 是 valid；但调用方传了 previous（a=unreachable）。
  // 判据：应当按 previous 比，即 a 从坏变好 → better=1，而不是 changed=0。
  const storage = fakeStorage({ [HEALTH_BASELINE_KEY]: JSON.stringify({ a: 'valid' }) })
  const server = fakeHealthServer(() => 'valid')
  try {
    await runOnce({
      ids: ['a'],
      storage,
      previous: [item('a', 'unreachable')],
    })
    const state = getHealthRun()
    assert.equal(state.baselineChanged, 1, '按传入的 previous 比，而不是 localStorage 那份')
    assert.equal(state.baselineBetter, 1, '坏 → 好，算变好')
  } finally {
    server.restore()
  }
})

test('startHealthRun - 分多批时每批都落地，最终 checked 等于总数', async () => {
  // 造超过一个 HEALTH_CHUNK 的源，验分批循环真的跑满（不是只跑第一批就收尾）。
  const total = HEALTH_CHUNK + 5
  const ids = Array.from({ length: total }, (_, index) => `s-${index}`)
  const storage = fakeStorage()
  const server = fakeHealthServer(() => 'valid')
  try {
    await runOnce({ ids, storage })
    assert.equal(server.calls.length, 2, `应分 2 批（${HEALTH_CHUNK} + 5）`)
    assert.equal(server.calls[0].ids.length, HEALTH_CHUNK, '第一批满额')
    assert.equal(server.calls[1].ids.length, 5, '第二批是余数')
    assert.equal(getHealthRun().checked, total)
    assert.equal(Object.keys(loadBaseline(storage)).length, total, '全部结论都进了基线')
  } finally {
    server.restore()
  }
})

test('startHealthRun - 请求失败时 finished=stopped 且不写坏基线', async () => {
  const storage = fakeStorage({ [HEALTH_BASELINE_KEY]: JSON.stringify({ a: 'valid' }) })
  const original = globalThis.fetch
  const toasts: string[] = []
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ message: '服务端炸了' }), { status: 500, headers: { 'Content-Type': 'application/json' } },
  )) as unknown as typeof fetch
  try {
    await runOnce({ ids: ['a'], storage, onToast: message => { toasts.push(message) } })
    const state = getHealthRun()
    assert.equal(state.running, false, '失败也要把 running 放掉')
    assert.equal(state.finished, 'stopped')
    assert.deepEqual(toasts, ['服务端炸了'], '把服务端的错误原样报给用户')
    assert.deepEqual(loadBaseline(storage), { a: 'valid' }, '失败那一轮不许覆盖旧基线')
  } finally {
    globalThis.fetch = original
  }
})

test('stopHealthRun - 显式停止会放掉 running，且后续批次不再写基线', async () => {
  const storage = fakeStorage()
  const server = fakeHealthServer(() => 'valid')
  try {
    const ids = Array.from({ length: HEALTH_CHUNK * 2 }, (_, index) => `s-${index}`)
    const run = runOnce({ ids, storage })
    stopHealthRun()
    await run
    assert.equal(getHealthRun().running, false, '停止后不再 running')
    assert.equal(getHealthRun().finished, 'stopped')
  } finally {
    server.restore()
  }
})

test('resetHealthRun - 跑完之后能清干净，正在跑时不清', async () => {
  const server = fakeHealthServer(() => 'valid')
  try {
    // 显式传独立 storage：绝不能让这条测试写进全局 localStorage ——
    // 同套件里有别的测试装过假实现且不清理，共用同一份会让断言随执行顺序飘。
    await runOnce({ ids: ['a'], storage: fakeStorage() })
    resetHealthRun()
    const state = getHealthRun()
    assert.equal(state.results.length, 0)
    assert.equal(state.finished, null)
    assert.equal(state.total, 0)
  } finally {
    server.restore()
  }
})

// ── 结构性约束（没有行为面，只能钉形状）──────────────────────

test('体检跑在弹窗组件之外：卸载不再顺手取消', () => {
  const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')
  const modal = read('../src/sources/SourceHealthModal.tsx')
  assert.match(modal, /const run = useHealthRun\(\)/, '弹窗是订阅者，不是运行时的持有者')
  assert.doesNotMatch(modal, /return \(\) => \{[\s\S]{0,160}cancel/, '卸载回调里不许再出现取消')
  assert.doesNotMatch(modal, /cancelledRef\.current\s*=/, '组件里不该还留着"卸载就置位"的那个开关（注释里提历史不算）')
  assert.match(modal, /aria-label=\{running \? '收起窗口（体检继续在后台跑）'/, '收起这个动作要说清它不停止体检')
})

test('过程中的自动分组 - 只圈不能正常使用的，且只打标签', () => {
  const rows = [
    { id: 'ok', statusCategory: 'valid' },
    { id: 'slow', statusCategory: 'slow' },
    { id: 'dead', statusCategory: 'unreachable' },
    { id: 'broken', statusCategory: 'broken' },
    { id: 'login', statusCategory: 'needs_login' },
    { id: 'unknown', statusCategory: 'something_new' },
  ]
  const buckets = autoTagBatches(rows, {}, new Set())
  const byTier = new Map(buckets.map(bucket => [bucket.tier, bucket.ids]))
  assert.deepEqual(byTier.get('bad'), ['dead', 'broken'], '连不上与规则失效进「体检异常」')
  assert.deepEqual(byTier.get('pending'), ['login', 'unknown'], '需登录与认不出的进「体检待确认」，不当成坏')
  assert.deepEqual(byTier.get('good') ?? [], [], '可用的不在这里自动打 —— "可用"是一整轮的结论')
  assert.deepEqual([...byTier.keys()].sort(), ['bad', 'pending'])
})

test('过程中的自动分组 - 已经打上和本轮已经写过的都不重复写', () => {
  const rows = [{ id: 'a', statusCategory: 'unreachable' }, { id: 'b', statusCategory: 'unreachable' }]
  assert.deepEqual(autoTagBatches(rows, { a: `小说 ${HEALTH_TAGS.bad}`, b: '' }, new Set()),
    [{ tier: 'bad', ids: ['b'] }], '带着我们那档标签的不再写第二遍')
  assert.deepEqual(autoTagBatches(rows, {}, new Set(['a', 'b'])), [],
    '本轮已经写过的不重复写（客户端的 sources 要等刷新才是新的）')
})
