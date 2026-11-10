import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { bookStats, dayLabel, formatDuration, groupByDay, READING_LOG_RANGES, summarize } from '../src/plugins/reading-log/ReadingLogPage'
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
  // 计时逻辑搬进了 useReadingLog；判据盯真实实现，不盯它住在哪个文件。
  const reader = fs.readFileSync(path.resolve(import.meta.dirname, '../src/features/reader/useReadingLog.ts'), 'utf8')
  assert.match(reader, /api\.addReadingLog\(/, '阅读页要上报停留')
  assert.match(reader, /pending >= 30/, '每攒够 30 秒上报一段')
  assert.match(reader, /visibilitychange/, '切走标签页 / 锁屏不算在读')
})

test('接线：「我的」菜单有「阅读记录」入口，且开的是同一个悬浮层', () => {
  const header = fs.readFileSync(path.resolve(import.meta.dirname, '../src/app/AppHeader.tsx'), 'utf8')
  assert.match(header, /onOpenReadingLog/, '菜单要能触发')
  assert.match(header, /阅读记录/)
  const main = fs.readFileSync(path.resolve(import.meta.dirname, '../src/main.tsx'), 'utf8')
  // 「阅读记录」是**插件**（plugins/），可独立卸载。
  // 入口直接开对应浮层，接线形态是 setOpenModal。
  assert.match(main, /openModalDirect\('reading-log'\)/, '入口要开阅读记录浮层')
  const panel = fs.readFileSync(path.resolve(import.meta.dirname, '../src/plugins/reading-log/ReadingLogModal.tsx'), 'utf8')
  assert.match(panel, /<ReadingLogPage \/>/, '浮层里要真的渲染这一页，不是挂个空组件')
})

/** 借自 HapeLee/legado-with-MD3 的「阅读记录」：时间轴之外要有汇总与章节维度。 */
const logEntry = (
  day: string,
  bookUrl: string,
  seconds: number,
  chapterIndex = 0,
  bookName = bookUrl,
): ReadingLogEntry => ({ day, sourceId: 'src', bookUrl, bookName, chapterIndex, seconds, updatedAt: 0 })

const today = new Date(2026, 9, 13) // 2026-10-13

test('summarize：总时长 / 阅读天数 / 日均 / 最久一天 / 书数', () => {
  const entries = [
    logEntry('2026-10-12', 'a', 30, 2),
    logEntry('2026-10-12', 'b', 80, 0),
    logEntry('2026-10-11', 'a', 60, 5),
    logEntry('2026-10-10', 'c', 10, 0),
  ]
  const summary = summarize(entries, today)
  assert.equal(summary.totalSeconds, 180)
  assert.equal(summary.activeDays, 3, '同一天多本只算一天')
  assert.equal(summary.avgSecondsPerDay, 60, '日均按「读过书的天数」摊，不是按 30 天')
  assert.equal(summary.bookCount, 3)
  assert.deepEqual(summary.bestDay, { day: '2026-10-12', seconds: 110 }, '最久一天按当天合计算')
})

test('summarize：连续天数从昨天起算，断一天就停', () => {
  const continuous = summarize([
    logEntry('2026-10-12', 'a', 30),
    logEntry('2026-10-11', 'a', 30),
    logEntry('2026-10-10', 'a', 30),
  ], today)
  assert.equal(continuous.streakDays, 3, '今天还没读，不该把昨晚的记录抹掉')

  const broken = summarize([
    logEntry('2026-10-12', 'a', 30),
    logEntry('2026-10-10', 'a', 30),
  ], today)
  assert.equal(broken.streakDays, 1, '中间断了一天就只算断点之前的')

  const stale = summarize([logEntry('2026-10-10', 'a', 30)], today)
  assert.equal(stale.streakDays, 0, '今天和昨天都没读，连续天数是 0')
})

test('summarize：空输入全零，不出现 NaN', () => {
  const summary = summarize([], today)
  assert.equal(summary.totalSeconds, 0)
  assert.equal(summary.activeDays, 0)
  assert.equal(summary.avgSecondsPerDay, 0)
  assert.equal(summary.streakDays, 0)
  assert.equal(summary.bookCount, 0)
  assert.equal(summary.bestDay, null)
})

test('bookStats：按书累计、取最大章号、按累计时长降序', () => {
  const books = bookStats([
    logEntry('2026-10-12', 'a', 30, 2, '甲'),
    logEntry('2026-10-12', 'b', 80, 0, '乙'),
    logEntry('2026-10-11', 'a', 60, 5, '甲'),
  ])
  assert.deepEqual(books.map(book => book.bookUrl), ['a', 'b'], '累计久的排前面')
  assert.equal(books[0].seconds, 90)
  assert.equal(books[0].maxChapterIndex, 5, '章号取最大，不是最后一条')
  assert.equal(books[0].days, 2)
  assert.equal(books[0].lastDay, '2026-10-12')
  assert.equal(books[1].maxChapterIndex, 0)
})

test('接线：页面把汇总与「读到第几章」真的画出来', () => {
  const page = fs.readFileSync(path.resolve(import.meta.dirname, '../src/plugins/reading-log/ReadingLogPage.tsx'), 'utf8')
  assert.match(page, /summarize\(entries\)/, '汇总要走纯函数')
  assert.match(page, /bookStats\(entries\)/, '按书统计要走纯函数')
  assert.match(page, /读到第 \{book\.maxChapterIndex \+ 1\} 章/, '章号 0 起，展示时 +1')
  assert.match(page, /streakDays/, '连续阅读要出现在汇总里')
})

test('统计范围：30 / 90 / 365 三档可切，切了要按新窗口重新取数', () => {
  assert.deepEqual([...READING_LOG_RANGES], [30, 90, 365], '三档是页面常量，别散落在 JSX 里')

  const page = fs.readFileSync(path.resolve(import.meta.dirname, '../src/plugins/reading-log/ReadingLogPage.tsx'), 'utf8')
  assert.match(page, /api\.readingLog\(range\)/, '取数要跟着选中的窗口走，不能写死 30')
  assert.match(page, /\}, \[range\]\)/, 'range 变了 effect 要重跑')
  assert.doesNotMatch(page, /最近 30 天/, '窗口文案要跟着 range 变，不能写死')
  assert.match(page, /aria-pressed=/, '切换按钮要暴露选中态')
  assert.match(page, /role="group"/, '三档按钮是一组')
})
