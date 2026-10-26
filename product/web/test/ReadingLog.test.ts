import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { dayLabel, formatDuration, groupByDay } from '../src/pages/ReadingLogPage'
import type { ReadingLogEntry } from '../src/lib/api'

/**
 * 阅读记录（PROPOSAL-019 D）。纯函数 + 接线判据，不起浏览器。
 * 「停留 30 秒 → 记录 +1」那一条是浏览器门禁（tools/verify/reading-log-check.mjs），
 * 这里钉的是聚合口径与"产品真的在上报 / 真的有入口"。
 */

const entry = (day: string, bookUrl: string, seconds: number, bookName = bookUrl): ReadingLogEntry =>
  ({ day, sourceId: 'src', bookUrl, bookName, chapterIndex: 0, seconds, updatedAt: 0 })

test('formatDuration：秒 / 分 / 小时三档，到分就不显秒', () => {
  assert.equal(formatDuration(0), '0 秒')
  assert.equal(formatDuration(40), '40 秒')
  assert.equal(formatDuration(59), '59 秒')
  assert.equal(formatDuration(60), '1 分')
  assert.equal(formatDuration(750), '12 分')
  assert.equal(formatDuration(3600), '1 小时')
  assert.equal(formatDuration(7500), '2 小时 5 分')
  assert.equal(formatDuration(-10), '0 秒', '负数不该算出怪东西')
})

test('groupByDay：同一天聚成一条，顺序照服务端给的（天倒序、天内秒数倒序）', () => {
  const days = groupByDay([
    entry('2026-10-12', 'a', 30),
    entry('2026-10-12', 'b', 90),
    entry('2026-10-11', 'c', 10),
  ])
  assert.equal(days.length, 2)
  assert.equal(days[0].day, '2026-10-12')
  assert.equal(days[0].seconds, 120, '同一天要把各书的秒数加起来')
  assert.deepEqual(days[0].books.map(b => b.bookUrl), ['a', 'b'], '天内顺序不动')
  assert.equal(days[1].day, '2026-10-11')
})

test('groupByDay：空输入给空数组，不是一条空记录', () => {
  assert.deepEqual(groupByDay([]), [])
})

test('dayLabel：今天 / 昨天说人话，更早给日期', () => {
  const today = new Date(2026, 9, 12) // 2026-10-12
  assert.equal(dayLabel('2026-10-12', today), '今天')
  assert.equal(dayLabel('2026-10-11', today), '昨天')
  assert.equal(dayLabel('2026-10-08', today), '2026-10-08')
})

test('接线：阅读页真的按停留上报（api.addReadingLog + 30 秒一段）', () => {
  const reader = fs.readFileSync(path.resolve(import.meta.dirname, '../src/reader/ReaderScreen.tsx'), 'utf8')
  assert.match(reader, /api\.addReadingLog\(/, '阅读页要上报停留')
  assert.match(reader, /pending >= 30/, '每攒够 30 秒上报一段')
  assert.match(reader, /visibilitychange/, '切走标签页 / 锁屏不算在读')
})

test('接线：「我的」菜单有「阅读记录」入口，且开的是同一个悬浮层', () => {
  const header = fs.readFileSync(path.resolve(import.meta.dirname, '../src/components/AppHeader.tsx'), 'utf8')
  assert.match(header, /onOpenReadingLog/, '菜单要能触发')
  assert.match(header, /阅读记录/)
  const main = fs.readFileSync(path.resolve(import.meta.dirname, '../src/main.tsx'), 'utf8')
  // 「阅读记录」是**插件**（plugins/），可独立卸载。
  // 入口直接开对应浮层，接线形态是 setOpenModal。
  assert.match(main, /openModalDirect\('reading-log'\)/, '入口要开阅读记录浮层')
  const panel = fs.readFileSync(path.resolve(import.meta.dirname, '../src/plugins/reading-log/ReadingLogModal.tsx'), 'utf8')
  assert.match(panel, /<ReadingLogPage \/>/, '浮层里要真的渲染这一页，不是挂个空组件')
})
