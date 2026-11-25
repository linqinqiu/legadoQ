import test from 'node:test'
import assert from 'node:assert/strict'
import { createSourceCatalog } from '../src/lib/sourceCatalog'
import type { SourceSummary } from '../src/lib/api/types'

function source(id: string, name = id): SourceSummary {
  return {
    id,
    name,
    url: `https://example.com/${id}`,
    enabled: true,
    isJsSource: false,
    hasLogin: false,
    updatedAt: 1,
    version: 1,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('初始快照稳定，订阅与退订只走公开接口', () => {
  const catalog = createSourceCatalog(async () => [])
  const initial = catalog.getSnapshot()
  assert.equal(initial.status, 'idle')
  assert.deepEqual(initial.items, [])
  assert.equal(initial.error, null)
  assert.equal(initial.updatedAt, null)
  assert.equal(catalog.getSnapshot(), initial)

  let calls = 0
  const unsubscribe = catalog.subscribe(() => { calls += 1 })
  catalog.subscribe(() => { calls += 1 })()
  assert.equal(calls, 0)
  unsubscribe()
})

test('并发 load 合流一次请求，成功后缓存快照', async () => {
  const pending = deferred<SourceSummary[]>()
  let calls = 0
  const catalog = createSourceCatalog(() => {
    calls += 1
    return pending.promise
  })
  const items = [source('a')]

  const first = catalog.load()
  const second = catalog.load()
  assert.equal(first, second)
  assert.equal(calls, 1)
  assert.equal(catalog.getSnapshot().status, 'loading')

  pending.resolve(items)
  assert.equal(await first, items)
  assert.equal(catalog.getSnapshot().status, 'ready')
  assert.equal(catalog.getSnapshot().items, items)
  assert.equal(await catalog.load(), items)
  assert.equal(calls, 1)
})

test('invalidate 强制刷新，并让等待中的刷新合流', async () => {
  const first = deferred<SourceSummary[]>()
  const second = deferred<SourceSummary[]>()
  const responses = [first.promise, second.promise]
  let calls = 0
  const catalog = createSourceCatalog(() => responses[calls++])

  const initial = catalog.load()
  const refreshA = catalog.invalidate()
  const refreshB = catalog.invalidate()
  assert.equal(refreshA, refreshB)
  assert.equal(calls, 2)

  second.resolve([source('new')])
  const refreshed = await refreshA
  first.resolve([source('old')])
  await initial
  assert.deepEqual(refreshed.map(item => item.id), ['new'])
  assert.deepEqual(catalog.getSnapshot().items.map(item => item.id), ['new'])
})

test('失败保留上一份清单，后续 load 可以重试', async () => {
  const items = [source('kept')]
  let calls = 0
  const catalog = createSourceCatalog(async () => {
    calls += 1
    if (calls === 2) throw new Error('network down')
    return items
  })

  await catalog.load()
  await assert.rejects(catalog.invalidate(), /network down/)
  assert.equal(catalog.getSnapshot().status, 'failed')
  assert.equal(catalog.getSnapshot().items, items)
  assert.equal(catalog.getSnapshot().error, 'network down')

  await catalog.load()
  assert.equal(calls, 3)
  assert.equal(catalog.getSnapshot().status, 'ready')
  assert.equal(catalog.getSnapshot().error, null)
})

test('replace 发布乐观清单，并阻止在途旧响应覆盖它', async () => {
  const oldResponse = deferred<SourceSummary[]>()
  let calls = 0
  const catalog = createSourceCatalog(() => {
    calls += 1
    return oldResponse.promise
  })

  const oldLoad = catalog.load()
  const optimistic = [source('optimistic')]
  catalog.replace(optimistic)
  assert.equal(catalog.getSnapshot().items, optimistic)
  assert.equal(await catalog.load(), optimistic)
  assert.equal(calls, 1)

  oldResponse.resolve([source('stale')])
  await oldLoad
  assert.equal(catalog.getSnapshot().items, optimistic)
})

test('旧响应晚到不覆盖 invalidate 后的新清单', async () => {
  const oldResponse = deferred<SourceSummary[]>()
  const newResponse = deferred<SourceSummary[]>()
  const responses = [oldResponse.promise, newResponse.promise]
  let calls = 0
  const catalog = createSourceCatalog(() => responses[calls++])

  const oldLoad = catalog.load()
  const refresh = catalog.invalidate()
  assert.equal(calls, 2)

  newResponse.resolve([source('new')])
  await refresh
  oldResponse.resolve([source('old')])
  await oldLoad
  assert.deepEqual(catalog.getSnapshot().items.map(item => item.id), ['new'])
})
