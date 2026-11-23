import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clearAccessToken,
  getAccessToken,
  setAccessToken,
  tokenQuery,
  withTokenQuery,
} from '../src/lib/accessToken.ts'

/** 装一个可控的 localStorage，跑完还原（与 reader-interactions-settings.test.ts 同一套）。 */
function withStorage(run: (store: Record<string, string>) => void) {
  const store: Record<string, string> = {}
  const originalWindow = globalThis.window
  ;(globalThis as any).window = {
    localStorage: {
      getItem: (key: string) => store[key] || null,
      setItem: (key: string, value: string) => { store[key] = value },
      removeItem: (key: string) => { delete store[key] },
    },
  }
  try {
    run(store)
  } finally {
    globalThis.window = originalWindow
  }
}

test('未存 token 时取值为 null，且不产生任何 query 后缀', () => {
  withStorage(() => {
    assert.equal(getAccessToken(), null)
    assert.equal(tokenQuery(), '')
    assert.equal(withTokenQuery('/api/probe'), '/api/probe')
    assert.equal(withTokenQuery('/api/debug?keyword=x'), '/api/debug?keyword=x')
  })
})

test('存取往返：首尾空格被去掉；query 值做 URL 编码', () => {
  withStorage(() => {
    setAccessToken('  abc&def=1  ')
    assert.equal(getAccessToken(), 'abc&def=1')
    assert.equal(tokenQuery(), 'token=abc%26def%3D1')
    assert.equal(withTokenQuery('/api/probe'), '/api/probe?token=abc%26def%3D1')
    clearAccessToken()
    assert.equal(getAccessToken(), null)
  })
})

test('withTokenQuery 对已有 query 的 URL 用 & 追加', () => {
  withStorage(() => {
    setAccessToken('secret')
    assert.equal(withTokenQuery('/api/debug?keyword=x'), '/api/debug?keyword=x&token=secret')
    assert.equal(withTokenQuery('wss://host/api/search/stream'), 'wss://host/api/search/stream?token=secret')
  })
})

test('全空白 token 当作未设', () => {
  withStorage(() => {
    setAccessToken('   ')
    assert.equal(getAccessToken(), null)
    assert.equal(tokenQuery(), '')
  })
})

test('localStorage 不可用（隐私模式）时静默降级为未设，不抛错', () => {
  const originalWindow = globalThis.window
  ;(globalThis as any).window = {
    localStorage: {
      getItem: () => { throw new Error('SecurityError') },
      setItem: () => { throw new Error('SecurityError') },
      removeItem: () => { throw new Error('SecurityError') },
    },
  }
  try {
    assert.equal(getAccessToken(), null)
    assert.doesNotThrow(() => setAccessToken('x'))
    assert.doesNotThrow(() => clearAccessToken())
    assert.equal(tokenQuery(), '')
  } finally {
    globalThis.window = originalWindow
  }
})
