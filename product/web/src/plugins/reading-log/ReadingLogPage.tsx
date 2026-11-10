import React, { useEffect, useState } from 'react'
import { api, ReadingLogEntry } from '../../lib/api'

/**
 * 阅读记录（PROPOSAL-019 D）。上半屏是「按书 / 按天」的聚合，下半屏是按天时间轴。
 *
 * 记录是「一天 · 一本书」一行、只增不改（服务端 `reading_log` 表），所以这里只做聚合展示，
 * 不提供编辑/删除 —— 统计是给「我最近读了些什么、读到哪了」看的，不是账本。
 *
 * 口径借自 HapeLee/legado-with-MD3 的「阅读记录」：它把时间轴与章节维度分开算。
 * 我们没有新表，`chapterIndex` 就在每一行里，所以「读到第几章」= 这本书记录到的最大章号 + 1。
 */

/** 秒 → 「2 小时 5 分」/「12 分 30 秒」/「40 秒」。到分就不显秒，免得一眼看去全是数字。 */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`
  if (minutes > 0) return `${minutes} 分`
  return `${total} 秒`
}

export type ReadingDay = { day: string; seconds: number; books: ReadingLogEntry[] }

/** 把「一天一本书」的行聚成「一天 → 若干本」，按天倒序（服务端已按天倒序、天内按秒数倒序）。 */
export function groupByDay(entries: ReadingLogEntry[]): ReadingDay[] {
  const days: ReadingDay[] = []
  for (const entry of entries) {
    const last = days[days.length - 1]
    if (last && last.day === entry.day) {
      last.seconds += entry.seconds
      last.books.push(entry)
    } else {
      days.push({ day: entry.day, seconds: entry.seconds, books: [entry] })
    }
  }
  return days
}

/** 今天 / 昨天 / 2026-10-08 —— 近两天说人话，更早给日期。 */
export function dayLabel(day: string, today = new Date()): string {
  const stamp = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (day === stamp(today)) return '今天'
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (day === stamp(yesterday)) return '昨天'
  return day
}

const dayKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

/** 在 `YYYY-MM-DD` 上加减天数；只做本地日，不碰时区。 */
function shiftDay(day: string, delta: number): string {
  const [year, month, date] = day.split('-').map(Number)
  const value = new Date(year, (month || 1) - 1, date || 1)
  value.setDate(value.getDate() + delta)
  return dayKey(value)
}

export type ReadingSummary = {
  totalSeconds: number
  activeDays: number
  /** 连续阅读天数：从今天（或昨天）往回数，断一天就停。 */
  streakDays: number
  avgSecondsPerDay: number
  /** 读得最久的那一天；没有记录时为 null。 */
  bestDay: { day: string; seconds: number } | null
  bookCount: number
}

/**
 * 汇总口径：总时长 / 阅读天数 / 连续天数 / 日均 / 最久的一天 / 涉及书数。
 *
 * 连续天数从「今天」往回数；今天还没读就从「昨天」起算 —— 早上打开页面时
 * 不该显示「连续 0 天」把昨晚的记录抹掉。昨天也没读才是真的断了。
 */
export function summarize(entries: ReadingLogEntry[], today: Date = new Date()): ReadingSummary {
  const dayTotals = new Map<string, number>()
  const books = new Set<string>()
  let totalSeconds = 0
  for (const entry of entries) {
    totalSeconds += entry.seconds
    dayTotals.set(entry.day, (dayTotals.get(entry.day) ?? 0) + entry.seconds)
    books.add(`${entry.sourceId}\u0000${entry.bookUrl}`)
  }
  const activeDays = dayTotals.size
  let bestDay: ReadingSummary['bestDay'] = null
  for (const [day, seconds] of dayTotals) {
    if (!bestDay || seconds > bestDay.seconds) bestDay = { day, seconds }
  }
  const todayKey = dayKey(today)
  let cursor = dayTotals.has(todayKey) ? todayKey : shiftDay(todayKey, -1)
  let streakDays = 0
  while (dayTotals.has(cursor)) {
    streakDays += 1
    cursor = shiftDay(cursor, -1)
  }
  return {
    totalSeconds,
    activeDays,
    streakDays,
    avgSecondsPerDay: activeDays ? Math.round(totalSeconds / activeDays) : 0,
    bestDay,
    bookCount: books.size,
  }
}

export type BookReadingStat = {
  sourceId: string
  bookUrl: string
  bookName: string
  seconds: number
  /** 记录到的最大章号（0 起）；展示时 +1 说「读到第 N 章」。 */
  maxChapterIndex: number
  lastDay: string
  days: number
}

/** 按书聚合：累计时长、读到第几章、读过多少天、最近一天；按累计时长降序。 */
export function bookStats(entries: ReadingLogEntry[]): BookReadingStat[] {
  const stats = new Map<string, BookReadingStat>()
  for (const entry of entries) {
    const key = `${entry.sourceId}\u0000${entry.bookUrl}`
    const current = stats.get(key)
    if (!current) {
      stats.set(key, {
        sourceId: entry.sourceId,
        bookUrl: entry.bookUrl,
        bookName: entry.bookName,
        seconds: entry.seconds,
        maxChapterIndex: entry.chapterIndex,
        lastDay: entry.day,
        days: 1,
      })
      continue
    }
    current.seconds += entry.seconds
    current.maxChapterIndex = Math.max(current.maxChapterIndex, entry.chapterIndex)
    if (entry.bookName) current.bookName = entry.bookName
    if (entry.day > current.lastDay) current.lastDay = entry.day
    current.days += 1
  }
  return [...stats.values()].sort((a, b) => b.seconds - a.seconds)
}

export function ReadingLogPage() {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [entries, setEntries] = useState<ReadingLogEntry[]>([])

  useEffect(() => {
    let alive = true
    api.readingLog(30)
      .then(list => { if (alive) { setEntries(list); setState('ready') } })
      .catch(() => { if (alive) setState('error') })
    return () => { alive = false }
  }, [])

  if (state === 'loading') return <p className="reading-log-status">正在读取…</p>
  if (state === 'error') return <p className="reading-log-status">没能取到阅读记录，稍后再试。</p>

  const days = groupByDay(entries)
  if (days.length === 0) return <p className="reading-log-status">最近 30 天还没有阅读记录。</p>

  const summary = summarize(entries)
  const books = bookStats(entries)
  return (
    <div className="reading-log">
      <div className="reading-log-summary">
        <div className="reading-log-stat">
          <span className="reading-log-stat-value">{formatDuration(summary.totalSeconds)}</span>
          <span className="reading-log-stat-label">最近 30 天</span>
        </div>
        <div className="reading-log-stat">
          <span className="reading-log-stat-value">{summary.activeDays} 天</span>
          <span className="reading-log-stat-label">读过书的天数</span>
        </div>
        <div className="reading-log-stat">
          <span className="reading-log-stat-value">{summary.streakDays} 天</span>
          <span className="reading-log-stat-label">连续阅读</span>
        </div>
        <div className="reading-log-stat">
          <span className="reading-log-stat-value">{formatDuration(summary.avgSecondsPerDay)}</span>
          <span className="reading-log-stat-label">平均每天</span>
        </div>
      </div>
      {summary.bestDay && (
        <p className="reading-log-total">
          共读了 <strong>{summary.bookCount}</strong> 本；读得最久的一天是 {dayLabel(summary.bestDay.day)}，
          <strong>{formatDuration(summary.bestDay.seconds)}</strong>。
        </p>
      )}

      <section className="reading-log-section">
        <h3 className="reading-log-section-title">按书</h3>
        <ul className="reading-log-book-list">
          {books.map(book => (
            <li key={`${book.sourceId}\u0000${book.bookUrl}`} className="reading-log-book-row">
              <span className="reading-log-book-name">{book.bookName || '（未知书名）'}</span>
              <span className="reading-log-book-meta">
                读到第 {book.maxChapterIndex + 1} 章 · {book.days} 天 · 累计 {formatDuration(book.seconds)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="reading-log-section">
        <h3 className="reading-log-section-title">按天</h3>
        <ol className="reading-log-timeline">
          {days.map(day => (
            <li key={day.day} className="reading-log-day">
              <div className="reading-log-day-head">
                <span className="reading-log-day-label">{dayLabel(day.day)}</span>
                <span className="reading-log-day-total">{formatDuration(day.seconds)}</span>
              </div>
              <ul className="reading-log-books">
                {day.books.map(book => (
                  <li key={`${book.sourceId}\u0000${book.bookUrl}`} className="reading-log-book">
                    <span className="reading-log-book-name">{book.bookName || '（未知书名）'}</span>
                    <span className="reading-log-book-time">{formatDuration(book.seconds)}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
