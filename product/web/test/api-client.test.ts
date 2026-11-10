import test from 'node:test'
import assert from 'node:assert/strict'
import { api, streamSearch } from '../src/lib/api.ts'
import { requestArrayBuffer, requestBlob, requestText } from '../src/lib/api/client.ts'

test('api client - 不设身份：请求里不再带任何令牌，但 Content-Type 与错误传递照旧', async () => {
  const originalFetch = globalThis.fetch
  const capturedRequests: { url: string; method?: string; headers: Headers; body?: any }[] = []

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers)
    capturedRequests.push({
      url: input.toString(),
      method: init?.method,
      headers,
      body: init?.body,
    })

    if (init?.method === 'DELETE') {
      return new Response(null, { status: 204 })
    }
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    // GET 请求：什么头都不该带
    await api.sources()
    assert.equal(capturedRequests[0].headers.get('X-CSRF-Token'), null)

    // POST 请求：带 Content-Type，但**不带**令牌（写操作由服务端的同源闸门把关）
    await api.import(['{"bookSourceUrl":"https://source1.com"}'])
    assert.equal(capturedRequests[1].method, 'POST')
    assert.equal(capturedRequests[1].headers.get('X-CSRF-Token'), null)
    assert.equal(capturedRequests[1].headers.get('Content-Type'), 'application/json')

    // DELETE 请求：204 要落成 undefined，调用方才能直接 await
    const delResult = await api.remove('https://source1.com')
    assert.equal(delResult, undefined)

    // 登录/会话这套客户端 API 必须已经不存在
    assert.equal((api as Record<string, unknown>).login, undefined)
    assert.equal((api as Record<string, unknown>).logout, undefined)
    assert.equal((api as Record<string, unknown>).session, undefined)

    // Error handling when response is not ok
    globalThis.fetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({ message: '自定义错误原因' }), { status: 400 })
    }
    await assert.rejects(
      async () => {
        await api.sources()
      },
      (err: Error) => {
        assert.equal(err.message, '自定义错误原因')
        return true
      }
    )

    // Error handling fallback when response body is not JSON
    globalThis.fetch = async (): Promise<Response> => {
      return new Response('<html>502 Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' })
    }
    await assert.rejects(
      async () => {
        await api.sources()
      },
      (err: Error) => {
        assert.equal(err.message, 'Bad Gateway')
        return true
      }
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('api client - cover helper URL encoding', () => {
  const coverUrl = api.cover('covers/book1?key=val')
  assert.equal(coverUrl, '/api/covers/covers%2Fbook1%3Fkey%3Dval')
})

test('api client - streamSearch WebSocket lifecycle and error handling', async () => {
  const listeners: Record<string, ((event?: any) => void)[]> = {}
  const sentMessages: string[] = []
  let socketClosed = false

  class MockWebSocket {
    static OPEN = 1
    readyState = 1

    addEventListener(event: string, cb: (event?: any) => void) {
      listeners[event] = listeners[event] || []
      listeners[event].push(cb)
    }

    send(data: string) {
      sentMessages.push(data)
    }

    close() {
      socketClosed = true
      listeners['close']?.forEach(cb => cb())
    }
  }

  const originalWebSocket = globalThis.WebSocket
  const originalLocation = globalThis.location
  ;(globalThis as any).WebSocket = MockWebSocket
  ;(globalThis as any).location = { protocol: 'http:', host: 'localhost:8080' }

  try {
    const events: any[] = []
    let reportedError: string | null = null
    let closed = false

    const socket = streamSearch(
      '凡人修仙传',
      ['https://src1.com'],
      evt => events.push(evt),
      err => { reportedError = err },
      () => { closed = true }
    )

    assert.ok(socket)

    // Trigger open event
    listeners['open']?.forEach(cb => cb())
    // Wait microtask
    // 保持"排一个 microtask 再往下"的原语义：直接把 resolve 交给 queueMicrotask 会让
  // resolve 收到一个值参数（TS 的 Promise<void> 重载不接受），改成显式调用。
  await new Promise<void>(resolve => { queueMicrotask(() => resolve()) })
    assert.equal(sentMessages.length, 1)
    assert.deepEqual(JSON.parse(sentMessages[0]), { keyword: '凡人修仙传', sourceIds: ['https://src1.com'] })

    // Trigger valid message event
    listeners['message']?.forEach(cb => cb({ data: JSON.stringify({ type: 'results', results: [{ name: '凡人' }] }) }))
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'results')

    // Trigger invalid json message -> onError
    listeners['message']?.forEach(cb => cb({ data: 'not-valid-json{{{' }))
    assert.equal(reportedError, '搜索响应格式无效')

    // Close event
    socket.close()
    assert.equal(socketClosed, true)
  } finally {
    globalThis.WebSocket = originalWebSocket
    globalThis.location = originalLocation
  }
})

test('api client - 文本 / Blob / ArrayBuffer 助手共用同源凭据与错误口径', async () => {
  const originalFetch = globalThis.fetch
  const captured: { url: string; credentials?: RequestCredentials }[] = []
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input.toString()
    captured.push({ url, credentials: init?.credentials })
    if (url === '/missing') {
      return new Response(JSON.stringify({ message: '服务器上没有这个条目' }), { status: 404 })
    }
    if (url === '/text') return new Response('更新日志正文', { status: 200 })
    if (url === '/blob') return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    return new Response(new Uint8Array([4, 5]), { status: 200 })
  }
  try {
    assert.equal(await requestText('/text'), '更新日志正文')
    assert.equal((await requestBlob('/blob')).size, 3)
    assert.deepEqual([...new Uint8Array(await requestArrayBuffer('/bytes'))], [4, 5])
    await assert.rejects(() => requestText('/missing'), /服务器上没有这个条目/,
      '非 2xx 要把服务端那句 message 抛出来，不能静默回空串')
    assert.ok(captured.every(item => item.credentials === 'same-origin'), '三条都要带同源凭据')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('api.saveProgress - no logical position omits all fields; explicit zero still sent', async () => {
  const originalFetch = globalThis.fetch
  const bodies: any[] = []
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    bodies.push(init?.body ? JSON.parse(String(init.body)) : null)
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    await api.saveProgress('src', 'book', 'ch', 1, 0.25)
    const legacy = bodies.at(-1)
    assert.equal(Object.hasOwn(legacy, 'charOffset'), false)
    assert.equal(Object.hasOwn(legacy, 'paragraphAnchor'), false)
    assert.equal(Object.hasOwn(legacy, 'positionChecksum'), false)

    await api.saveProgress('src', 'book', 'ch', 1, 0.25, {
      charOffset: 0,
      paragraphAnchor: 'p0',
      positionChecksum: 'cs',
    })
    const logical = bodies.at(-1)
    assert.equal(logical.charOffset, 0)
    assert.equal(logical.paragraphAnchor, 'p0')
    assert.equal(logical.positionVersion, 1)
    assert.equal(logical.positionChecksum, 'cs')
  } finally {
    globalThis.fetch = originalFetch
  }
})
