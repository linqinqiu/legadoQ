import React, { useEffect, useState } from 'react'
import { api, ReadingLogEntry } from '../lib/api'

/**
 * 阅读记录（PROPOSAL-019 D）。按天画一条时间轴：每天读了多久、读了哪几本。
 *
 * 记录是「一天 · 一本书」一行、只增不改（服务端 `reading_log` 表），所以这里只做聚合展示，
 * 不提供编辑/删除 —— 时间轴是给「我最近读了些什么」看的，不是账本。
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

  const totalSeconds = entries.reduce((sum, entry) => sum + entry.seconds, 0)
  return (
    <div className="reading-log">
      <p className="reading-log-total">最近 30 天共读了 <strong>{formatDuration(totalSeconds)}</strong>，覆盖 {days.length} 天。</p>
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
    </div>
  )
}
