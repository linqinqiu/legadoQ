import test from 'node:test'
import assert from 'node:assert/strict'
import { request } from '../src/lib/api/client.ts'
import { getAppBusySourceCount, isAppBusy } from '../src/lib/appBusy.ts'

const MUTATION_SOURCE = 'api-mutation'

function deferredResponse() {
  let resolve!: (response: Response) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Response>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function jsonResponse() {
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('并发写请求引用计数，GET 不阻塞，全部结束才空闲', async () => {
  const originalFetch = globalThis.fetch
  const pending: ReturnType<typeof deferredResponse>[] = []
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if ((init?.method ?? 'GET').toUpperCase() === 'GET') return jsonResponse()
    const deferred = deferredResponse()
    pending.push(deferred)
    return deferred.promise
  }

  const first = request('/first', { method: 'POST' })
  const second = request('/second', { method: 'PATCH' })
  try {
    assert.equal(getAppBusySourceCount(MUTATION_SOURCE), 2)
    assert.equal(isAppBusy(), true)

    await request('/read', { method: 'GET' })
    assert.equal(getAppBusySourceCount(MUTATION_SOURCE), 2, 'GET 不应改变写请求计数')

    pending[0].resolve(jsonResponse())
    await first
    assert.equal(getAppBusySourceCount(MUTATION_SOURCE), 1)
    assert.equal(isAppBusy(), true, '一个写请求结束不能误判空闲')

    pending[1].resolve(jsonResponse())
    await second
    assert.equal(getAppBusySourceCount(MUTATION_SOURCE), 0)
    assert.equal(isAppBusy(), false)
  } finally {
    for (const deferred of pending) deferred.resolve(jsonResponse())
    await Promise.allSettled([first, second])
    globalThis.fetch = originalFetch
  }
})

test('写请求的响应体解析也属于 pending mutation', async () => {
  const originalFetch = globalThis.fetch
  let resolveBody!: (value: { success: boolean }) => void
  const body = new Promise<{ success: boolean }>(resolve => { resolveBody = resolve })
  let markJsonStarted!: () => void
  const jsonStarted = new Promise<void>(resolve => { markJsonStarted = resolve })
  globalThis.fetch = async (): Promise<Response> => {
    const response = jsonResponse()
    response.json = () => {
      markJsonStarted()
      return body
    }
    return response
  }

  const pending = request('/slow-body', { method: 'POST' })
  try {
    await jsonStarted
    assert.equal(getAppBusySourceCount(MUTATION_SOURCE), 1, '响应体未解析完仍应阻止刷新')
    resolveBody({ success: true })
    await pending
    assert.equal(getAppBusySourceCount(MUTATION_SOURCE), 0)
  } finally {
    resolveBody({ success: true })
    await pending.catch(() => undefined)
    globalThis.fetch = originalFetch
  }
})

test('POST/PUT/PATCH/DELETE 都跟踪，默认与 GET 不跟踪', async () => {
  const originalFetch = globalThis.fetch
  const observed: number[] = []
  globalThis.fetch = async (): Promise<Response> => {
    observed.push(getAppBusySourceCount(MUTATION_SOURCE))
    return jsonResponse()
  }
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      await request(`/${method}`, { method })
      assert.equal(getAppBusySourceCount(MUTATION_SOURCE), 0, `${method} 完成后必须注销`)
    }
    await request('/default')
    await request('/lowercase-get', { method: 'get' })
    assert.deepEqual(observed, [1, 1, 1, 1, 0, 0])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('写请求取消、网络异常与 HTTP 失败都准确注销', async () => {
  const originalFetch = globalThis.fetch
  try {
    const controller = new AbortController()
    globalThis.fetch = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => (
      new Promise((_resolve, reject) => {
        const signal = init?.signal
        if (signal?.aborted) reject(new DOMException('Aborted', 'AbortError'))
        else signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
    )
    const cancelled = request('/cancel', { method: 'POST', signal: controller.signal })
    assert.equal(getAppBusySourceCount(MUTATION_SOURCE), 1)
    controller.abort()
    await assert.rejects(cancelled, { name: 'AbortError' })
    assert.equal(getAppBusySourceCount(MUTATION_SOURCE), 0)
    assert.equal(isAppBusy(), false)

    globalThis.fetch = async (): Promise<Response> => { throw new Error('network down') }
    await assert.rejects(request('/network-error', { method: 'PUT' }), /network down/)
    assert.equal(getAppBusySourceCount(MUTATION_SOURCE), 0)
    assert.equal(isAppBusy(), false)

    globalThis.fetch = async (): Promise<Response> => new Response(JSON.stringify({ message: 'write failed' }), { status: 500 })
    await assert.rejects(request('/http-error', { method: 'DELETE' }), /write failed/)
    assert.equal(getAppBusySourceCount(MUTATION_SOURCE), 0)
    assert.equal(isAppBusy(), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})
