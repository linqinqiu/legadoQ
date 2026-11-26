/**
 * 前端性能快照的本地持久化。
 *
 * `performanceMonitor.report()` 只在内存里，刷新页面就归零；控制台 `__legadoPerf.report()`
 * 又只有开发者会开。这里把一份 report 提炼成**小摘要**落到 localStorage，让"上次卡的那一刻"
 * 跨刷新还在，运行日志弹窗里的性能面板才能给用户看。
 *
 * 三条约束来自实测：
 * - **只存摘要不存全量指标**：report 的 apiRequests 按唯一请求 accumulate，跑久了几十条，
 *   整份塞进 localStorage 又慢又占额度；面板要的只是"几次、最慢多少、哪条最慢"。
 * - **只留最近 N 份**：无上限追加迟早撑爆配额（隐私模式更严）。
 * - **隐私模式静默降级**：`localStorage` 的读写在禁用存储时会抛，观测是加分项，
 *   不该因为存不下就把界面搞崩；读不到就当没有。
 */
import type { PerformanceReport } from './performance'

const STORAGE_KEY = 'legado-perf-snapshots'
const MAX_SNAPSHOTS = 8
/** 与 performance.ts「慢 API」同一条线，面板里只统计超过它的请求。 */
const SLOW_MS = 300

export interface PerfSnapshot {
  /** 记录时刻（epoch ms）。 */
  at: number
  pageLoadMs: number
  ttiMs: number
  apiCount: number
  slowApiCount: number
  maxApiMs: number
  bottleneckCount: number
  /** 最慢的几条请求（URL + 耗时），按耗时降序，最多 3 条。 */
  slowest: { url: string; ms: number }[]
}

/** 把一份完整 report 压成可持久化的摘要。纯函数，at 可注入便于判据。 */
export function summarize(report: PerformanceReport, at: number = Date.now()): PerfSnapshot {
  const api = report.apiRequests ?? []
  const durations = api.map(m => (typeof m.duration === 'number' ? m.duration : 0))
  const slowest = api
    .map((m, i) => ({ url: m.name, ms: durations[i] }))
    .filter(item => item.ms > 0)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 3)
    .map(item => ({ url: item.url, ms: Math.round(item.ms) }))

  return {
    at,
    pageLoadMs: Math.round(report.pageLoadTime ?? 0),
    ttiMs: Math.round(report.tti ?? 0),
    apiCount: api.length,
    slowApiCount: durations.filter(ms => ms > SLOW_MS).length,
    maxApiMs: Math.round(durations.reduce((max, ms) => Math.max(max, ms), 0)),
    bottleneckCount: (report.bottlenecks ?? []).length,
    slowest,
  }
}

/** 读回快照；坏数据/旧版本形状直接丢掉，不让一条脏记录毁掉整个面板。 */
export function readSnapshots(): PerfSnapshot[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isSnapshot)
  } catch {
    return []
  }
}

/** 追加一份快照（由 report 生成），丢掉最旧的，返回写后的完整列表。 */
export function appendSnapshot(report: PerformanceReport, at?: number): PerfSnapshot[] {
  const list = [...readSnapshots(), summarize(report, at)].slice(-MAX_SNAPSHOTS)
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch {
    /* 隐私模式/配额满：存不下就算了，内存里的 report 仍是好的 */
  }
  return list
}

/** 清空全部快照。 */
export function clearSnapshots(): void {
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY)
  } catch {
    /* 同上 */
  }
}

function isSnapshot(value: unknown): value is PerfSnapshot {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.at === 'number'
    && typeof item.pageLoadMs === 'number'
    && typeof item.apiCount === 'number'
    && Array.isArray(item.slowest)
}
