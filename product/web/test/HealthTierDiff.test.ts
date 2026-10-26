import test from 'node:test'
import assert from 'node:assert/strict'
import { diffHealthTiers, tierOf } from '../src/sources/sourceGrouping'

/**
 * 重测后"哪些源和上次不一样"的判断（Issue #3）。
 * 纯函数：previous 是 id → 上次 statusCategory；current 是本轮结论。
 * 红线：新出现的源不算变；同一档位内的细分（valid/slow 都是 good）不算变；
 * 变差/变好按档位判，不是按原始字符串判。
 */

const cats = (rows: Array<{ id: string; statusCategory: string }>) =>
  Object.fromEntries(rows.map(r => [r.id, r.statusCategory]))

test('没有上次基线时：全是新出现，changed=0', () => {
  const diff = diffHealthTiers({}, [
    { id: 'a', statusCategory: 'valid' },
    { id: 'b', statusCategory: 'unreachable' },
  ])
  assert.equal(diff.changed, 0)
  assert.equal(diff.worse, 0)
  assert.equal(diff.better, 0)
})

test('同一种结论不变（含同档细分 valid→slow 都算 good）', () => {
  const prev = cats([
    { id: 'a', statusCategory: 'valid' },
    { id: 'b', statusCategory: 'slow' },
  ])
  const diff = diffHealthTiers(prev, [
    { id: 'a', statusCategory: 'valid' }, // 原样
    { id: 'b', statusCategory: 'slow' }, // 原样
  ])
  assert.equal(diff.changed, 0, '同档细分不应算作变化')
})

test('good → bad 算变差；bad → good 算变好；计数分开记', () => {
  const prev = cats([
    { id: 'a', statusCategory: 'valid' }, // good
    { id: 'b', statusCategory: 'unreachable' }, // bad
  ])
  const diff = diffHealthTiers(prev, [
    { id: 'a', statusCategory: 'unreachable' }, // good -> bad：变差
    { id: 'b', statusCategory: 'valid' }, // bad -> good：变好
  ])
  assert.equal(diff.changed, 2)
  assert.equal(diff.worse, 1)
  assert.equal(diff.better, 1)
  assert.deepEqual(diff.items.map(i => i.id).sort(), ['a', 'b'])
})

test('pending → bad 算变差，bad → pending 算变好（都不等于"修了死的"误判）', () => {
  const prev = cats([{ id: 'x', statusCategory: 'needs_login' }]) // pending
  const worse = diffHealthTiers(prev, [{ id: 'x', statusCategory: 'broken' }]) // bad
  assert.equal(worse.changed, 1)
  assert.equal(worse.worse, 1)
  assert.equal(worse.better, 0)

  const better = diffHealthTiers(
    cats([{ id: 'x', statusCategory: 'broken' }]),
    [{ id: 'x', statusCategory: 'needs_login' }],
  )
  assert.equal(better.changed, 1)
  assert.equal(better.better, 1)
  assert.equal(better.worse, 0)
})

test('档位映射在 diff 里是唯一的判断依据', () => {
  // 同档位的任何细分互换都不应触发"变化"
  assert.equal(tierOf('valid'), tierOf('slow'))
  assert.equal(tierOf('unreachable'), tierOf('invalid'))
  assert.equal(tierOf('needs_login'), tierOf('needs_webview'))
})
