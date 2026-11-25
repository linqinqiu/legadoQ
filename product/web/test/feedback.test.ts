import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { feedback } from '../src/lib/api/domains/feedback.ts'
import { ApiRequestError } from '../src/lib/api/client.ts'
import { feedbackCooldownRemaining, getFeedbackTokenHash, markFeedbackCooldown } from '../src/lib/feedbackToken.ts'

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    values,
  }
}

test('反馈 token 只保存本地随机值，接口层只拿 64 位哈希', async () => {
  const storage = memoryStorage()
  const first = await getFeedbackTokenHash(storage)
  assert.match(first, /^[0-9a-f]{64}$/)
  assert.equal(first, await getFeedbackTokenHash(storage))
  assert.equal(storage.values.size, 1)
  assert.ok(!storage.values.has(first))
})

test('已有 token 的 SHA-256 与 Node 标准实现一致', async () => {
  const storage = memoryStorage({ 'legado-feedback-token-v1': 'known-token' })
  const expected = createHash('sha256').update('known-token').digest('hex')
  assert.equal(await getFeedbackTokenHash(storage), expected)
})

test('提交冷却按时间戳持久化，到期自动解除', () => {
  const storage = memoryStorage()
  const until = markFeedbackCooldown(storage, 1_000)
  assert.equal(until, 31_000)
  assert.equal(feedbackCooldownRemaining(storage, 1_000), 30_000)
  assert.equal(feedbackCooldownRemaining(storage, 30_999), 1)
  assert.equal(feedbackCooldownRemaining(storage, 31_000), 0)
})

test('反馈客户端提交字段最小化，查询只带 token 哈希头', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: input.toString(), init })
    return init?.method === 'POST'
      ? new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      : new Response(JSON.stringify([{ id: 1, created_at: '2026-11-24T00:00:00Z', category: 'bug', content: '建议' }]), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  try {
    const hash = 'a'.repeat(64)
    assert.deepEqual(await feedback.submit({ category: 'bug', content: '建议', contact: '回复方式', tokenHash: hash }), { ok: true })
    assert.equal(calls[0].url, '/api/feedback')
    assert.equal(calls[0].init?.method, 'POST')
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      category: 'bug',
      content: '建议',
      contact: '回复方式',
      tokenHash: hash,
    })

    const items = await feedback.mine(hash)
    assert.equal(calls[1].url, '/api/feedback/mine')
    assert.equal(new Headers(calls[1].init?.headers).get('x-feedback-token'), hash)
    assert.equal(items[0].content, '建议')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('未配置反馈通道的错误保留 status 与 code，供界面回退 GitHub', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (): Promise<Response> => new Response(
    JSON.stringify({ code: 'feedback_not_configured', message: '这台服务没有开启匿名反馈通道' }),
    { status: 409, headers: { 'Content-Type': 'application/json' } },
  )

  try {
    await assert.rejects(
      () => feedback.submit({ category: 'general', content: '建议', tokenHash: 'a'.repeat(64) }),
      (error: unknown) => {
        assert.ok(error instanceof ApiRequestError)
        assert.equal(error.status, 409)
        assert.equal(error.code, 'feedback_not_configured')
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
