import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTO_CHECK_INTERVAL_MS,
  autoCheckUpdate,
  resetUpdateHint,
  setUpdateHint,
  shouldAutoCheck,
  subscribeUpdateHint,
  getUpdateHint,
} from '../src/lib/updateHint.ts'
import type { UpdateCheckResult } from '../src/lib/api/types.ts'

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, String(v)) },
    removeItem: (k: string) => { data.delete(k) },
    _data: data,
  }
}

function result(status: string, latest: string | null = null): UpdateCheckResult {
  return { current: '0.3.0', repository: 'linqinqiu/legadoQ', status, latest }
}

test('shouldAutoCheck：从未查过、或超过窗口才查', () => {
  // now 必须大于窗口，否则"now - 窗口"为负会被当成非法/未查过。
  const now = AUTO_CHECK_INTERVAL_MS * 5
  assert.equal(shouldAutoCheck(0, now), true)
  assert.equal(shouldAutoCheck(now - AUTO_CHECK_INTERVAL_MS - 1, now), true)
  assert.equal(shouldAutoCheck(now - AUTO_CHECK_INTERVAL_MS, now), true) // 边界：刚好到窗口
  assert.equal(shouldAutoCheck(now - AUTO_CHECK_INTERVAL_MS + 1, now), false)
  assert.equal(shouldAutoCheck(now - 1000, now), false)
  assert.equal(shouldAutoCheck(NaN, now), true)
})

test('autoCheckUpdate：窗口内只查一次，第二次跳过', async () => {
  const storage = fakeStorage()
  resetUpdateHint(storage)
  let checks = 0
  const check = async () => { checks++; return result('available', '0.4.0') }

  await autoCheckUpdate('0.3.0', check, storage, 1_000)
  assert.equal(checks, 1)
  assert.equal(getUpdateHint().latest, '0.4.0')

  // 5 分钟后刷新：仍在节流窗口内，不再打 GitHub，也不改提示。
  await autoCheckUpdate('0.3.0', check, storage, 1_000 + 5 * 60_000)
  assert.equal(checks, 1)
})

test('autoCheckUpdate：先记账再发请求，上游失败也不反复重试', async () => {
  const storage = fakeStorage()
  resetUpdateHint(storage)
  let checks = 0
  const check = async () => { checks++; throw new Error('network down') }

  await autoCheckUpdate('0.3.0', check, storage, 2_000)
  await autoCheckUpdate('0.3.0', check, storage, 3_000)
  assert.equal(checks, 1, '失败后第二次仍被节流挡住')
  assert.equal(getUpdateHint().latest, null, '失败不发布提示')
})

test('autoCheckUpdate：只有 available 才发布提示，其余状态静默', async () => {
  const storage = fakeStorage()
  for (const status of ['latest', 'not_found', 'unreachable', 'not_configured']) {
    resetUpdateHint(storage)
    await autoCheckUpdate('0.3.0', async () => result(status, '9.9.9'), storage, 10_000)
    assert.equal(getUpdateHint().latest, null, `${status} 不该冒出提示`)
  }
})

test('setUpdateHint：快照变化才通知订阅者', () => {
  resetUpdateHint()
  let notified = 0
  const off = subscribeUpdateHint(() => { notified++ })
  setUpdateHint('0.5.0', 'https://example/release')
  setUpdateHint('0.5.0', 'https://example/release') // 相同值不通知
  setUpdateHint('0.6.0', 'https://example/release')
  off()
  assert.equal(notified, 2)
  resetUpdateHint()
})
