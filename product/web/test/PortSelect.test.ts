import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SCAN_LIMIT, pickPort } from '../../scripts/port-select.mjs'

/**
 * 「默认端口被占时自己往上找一个能用的端口」的判据（2026-11-12）。
 *
 * 用户原话：「当前固定的 1234 是否不好，应该让其自己找合适的端口」。
 * 这件事的失败方式很阴：扫太大范围会占用一堆无关端口（探测不 bind 就不会，但逻辑要保证边界），
 * 扫过头会命中系统保留段、看起来成功却绑不上；全都占着时若抛错，启动器崩溃比换端口更糟。
 * 所以这里把「从哪开始、往后几个、到哪停、全占着怎么办」逐条钉住。
 */

test('首选端口可用就直接用它（不为了一点不确定性随机跳号）', async () => {
  const tried: number[] = []
  const port = await pickPort(1234, (p) => { tried.push(p); return true })
  assert.equal(port, 1234)
  assert.deepEqual(tried, [1234], '首选可用时不该探测第二个')
})

test('首选被占就往上找，且按顺序探测（不跳号、不并行）', async () => {
  const tried: number[] = []
  const busy = new Set([1234, 1235, 1236])
  const port = await pickPort(1234, (p) => { tried.push(p); return !busy.has(p) })
  assert.equal(port, 1237)
  assert.deepEqual(tried, [1234, 1235, 1236, 1237])
})

test('探测异步也算数（真实探测是 bind 回调，本来就异步）', async () => {
  const port = await pickPort(5000, async (p) => { await new Promise((r) => setTimeout(r, 1)); return p !== 5000 })
  assert.equal(port, 5001)
})

test('探测抛错按「不可用」处理：探测失败不该让启动器崩', async () => {
  const port = await pickPort(7000, (p) => { if (p === 7000) throw new Error('EACCES'); return true })
  assert.equal(port, 7001)
})

test('一个都没有时返回 null，而不是抛错（全占着是正常结果，要给一句人话）', async () => {
  assert.equal(await pickPort(1234, () => false), null)
  assert.equal(await pickPort(1234, () => false, { limit: 3 }), null)
})

test('扫描加上限：limit 只试这么多个（含首选），试满就放弃', async () => {
  const tried: number[] = []
  const port = await pickPort(1234, (p) => { tried.push(p); return false }, { limit: 3 })
  assert.equal(port, null)
  assert.deepEqual(tried, [1234, 1235, 1236])
  assert.equal(DEFAULT_SCAN_LIMIT, 20, '默认上限是 20；改它要说明为什么机器上会连续 20 个端口都占着')
})

test('不越过 max：到 65535 就停，绝不绕回低位端口（会命中系统保留段）', async () => {
  const tried: number[] = []
  const port = await pickPort(65534, (p) => { tried.push(p); return false }, { limit: 5 })
  assert.equal(port, null)
  assert.deepEqual(tried, [65534, 65535], '超过 65535 之后不该再探测')
  assert.ok(tried.every((p) => p <= 65535))

  const exact = await pickPort(65535, (p) => p === 65535)
  assert.equal(exact, 65535, '65535 本身是合法端口')
})

test('非法输入立刻拒绝：端口不像端口就抛，不静默改用一个随机值', async () => {
  // 注意：pickPort 是 async，抛出来的错是 rejected promise，所以用 rejects 而不是 throws
  // （用 throws 会断言不到，静默通过 —— 写这条判据时正好踩过一次）。
  await assert.rejects(() => pickPort(0, () => true), RangeError)
  await assert.rejects(() => pickPort(70000, () => true), RangeError)
  await assert.rejects(() => pickPort(1234.5, () => true), RangeError)
  await assert.rejects(() => pickPort(1234, null as unknown as () => boolean), TypeError)
})
