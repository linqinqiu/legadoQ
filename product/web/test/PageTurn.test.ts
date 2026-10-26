import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { coverDirection, pageTurnAnim, planNextPage, planPrevPage } from '../src/reader/pageTurn'

/**
 * 翻页状态机的决策（PROPOSAL-019 A）。纯函数，不起浏览器。
 *
 * 这一层存在的意义就是"分页网格改一处容易牵动另一处"：把决策抽出来单独钉，
 * 网格那边的实测（paginate-flow-check）只管几何，不再兼职判"该不该跨章"。
 */

test('planNextPage：本章还有页就逐页，最后一页才跨章', () => {
  assert.deepEqual(planNextPage(0, 3), { kind: 'step', page: 1 })
  assert.deepEqual(planNextPage(1, 3), { kind: 'step', page: 2 })
  assert.deepEqual(planNextPage(2, 3), { kind: 'chapter', direction: 1 }, '最后一页 → 下一章')
  assert.deepEqual(planNextPage(0, 1), { kind: 'chapter', direction: 1 }, '只有一页的章 → 直接下一章')
})

test('planPrevPage：本章还有页就逐页，第一页才往前接章', () => {
  assert.deepEqual(planPrevPage(2), { kind: 'step', page: 1 })
  assert.deepEqual(planPrevPage(1), { kind: 'step', page: 0 })
  assert.deepEqual(planPrevPage(0), { kind: 'chapter', direction: -1 }, '第一页 → 往前接一章')
})

test('pageTurnAnim：只有逐页翻才播动画，大跳一律 none', () => {
  assert.equal(pageTurnAnim('slide', 0, 1), 'slide')
  assert.equal(pageTurnAnim('cover', 4, 5), 'cover')
  assert.equal(pageTurnAnim('fade', 5, 4), 'fade', '往回一页也算逐页')
  assert.equal(pageTurnAnim('slide', 0, 2), 'none', '接章补偿/挪窗口是几页的跳，不滑')
  assert.equal(pageTurnAnim('cover', 7, 3), 'none')
  assert.equal(pageTurnAnim('slide', 3, 3), 'none', '页码没变（重量了一次）不播')
})

test('pageTurnAnim：关掉就是关掉，任何档都不演', () => {
  for (const anim of ['slide', 'fade', 'cover', 'none'] as const) {
    assert.equal(pageTurnAnim('none', 0, 1), 'none')
    assert.equal(pageTurnAnim(anim, 2, 3) === 'none', anim === 'none')
  }
})

test('coverDirection：往后翻从右（+1），往回翻从左（-1）', () => {
  assert.equal(coverDirection(2, 3), 1)
  assert.equal(coverDirection(3, 2), -1)
  assert.equal(coverDirection(5, 5), 1, '同页（理论上不会发生）当往右')
})

test('与产品接线同源：ReaderScreen 用这几个函数，不自己再写一份判断', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../src/reader/ReaderScreen.tsx'), 'utf8')
  assert.match(src, /planNextPage\(/, '「下一页」要调 planNextPage')
  assert.match(src, /planPrevPage\(/, '「上一页」要调 planPrevPage')
  assert.match(src, /pageTurnAnim\(/, '动画选择要调 pageTurnAnim')
})
