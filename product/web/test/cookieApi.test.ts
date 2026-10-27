import test from 'node:test'
import assert from 'node:assert/strict'
import { cookieApi } from '../src/lib/cookieApi.ts'

/**
 * 全局 Cookie 客户端的行为判据：路径、方法、请求体与错误传递。
 *
 * 这几个端点没有类型层面的守护（服务端是 Kotlin），拼错一段 query 只有真调一次才会暴露，
 * 所以在这里把四个调用各跑一遍，把实际发出去的请求抓下来比对。
 */
type Captured = { url: string; method?: string; headers: Headers; body?: string }

test('cookieApi - 四条调用发到正确的路径与方法，写操作带 JSON 体', async () => {
  const originalFetch = globalThis.fetch
  const captured: Captured[] = []
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    captured.push({
      url: input.toString(),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    })
    const payload = init?.method === 'DELETE'
      ? { ok: true, removed: true }
      : { count: 0, cookies: [] }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    await cookieApi.list()
    await cookieApi.detail('example.com')
    await cookieApi.save('https://www.example.com/', 'sid=1; token=2')
    await cookieApi.remove('example.com')
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.deepEqual(captured.map(item => [item.url, item.method]), [
    ['/api/cookies', undefined],
    ['/api/cookies/detail?u=example.com', undefined],
    ['/api/cookies', 'POST'],
    ['/api/cookies?u=example.com', 'DELETE'],
  ])
  // 写操作必须带 JSON 体，读操作不该平白多一个 Content-Type
  assert.equal(captured[0].headers.get('Content-Type'), null)
  assert.equal(captured[2].headers.get('Content-Type'), 'application/json')
  assert.deepEqual(JSON.parse(captured[2].body ?? '{}'), { url: 'https://www.example.com/', cookie: 'sid=1; token=2' })
  assert.equal(captured[3].body, undefined)
})

test('cookieApi - 域名进 query 前要编码（中文 / 空格不能把参数截断）', async () => {
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
    urls.push(input.toString())
    return new Response(JSON.stringify({ domain: '', cookie: '' }), { status: 200 })
  }
  try {
    await cookieApi.detail('例子 站点.com')
    await cookieApi.remove('例子 站点.com')
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.deepEqual(urls, [
    '/api/cookies/detail?u=%E4%BE%8B%E5%AD%90%20%E7%AB%99%E7%82%B9.com',
    '/api/cookies?u=%E4%BE%8B%E5%AD%90%20%E7%AB%99%E7%82%B9.com',
  ])
})

test('cookieApi - 非 2xx 抛服务端那句 message；没有 JSON 体时退回 statusText', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ message: '缺少 url（这份凭据属于哪个站点）' }), { status: 400 })
    await assert.rejects(() => cookieApi.save('', 'k=v'), /缺少 url/)

    globalThis.fetch = async (): Promise<Response> =>
      new Response('<html>502 Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' })
    await assert.rejects(() => cookieApi.list(), /Bad Gateway/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
