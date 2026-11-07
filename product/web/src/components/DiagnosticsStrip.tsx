import React, { useEffect, useState } from 'react'
import { api, type DiagnosticsSnapshot } from '../lib/api'

/** 阶段 id → 中文名。没登记的原样显示，免得新阶段被藏起来。 */
const STAGE_LABEL: Record<string, string> = {
  search: '搜索',
  explore: '发现',
  details: '详情',
  toc: '目录',
  content: '正文',
  js: '脚本',
  http: '网络',
}

/**
 * 「这次运行到底慢在哪」。
 *
 * 日志回答"出了什么事"，这里回答"时间花在哪"：按阶段（搜索/详情/目录/正文/脚本/网络）
 * 看调用数、失败率与平均耗时，再按书源看谁最慢。两块都来自同一个 `/api/diagnostics`，
 * 所以这里只发一次请求。
 *
 * 默认收起：它是诊断用的第二眼信息，摊开会把日志列表挤到屏幕外。
 */
export function DiagnosticsStrip() {
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let alive = true
    api.diagnostics()
      .then((data: DiagnosticsSnapshot) => { if (alive) setSnapshot(data) })
      .catch(() => { if (alive) setSnapshot(null) })
    return () => { alive = false }
  }, [])

  // 取不到就整块不出现：诊断是加分项，不能因为它没数据就在日志页留一块空白。
  if (!snapshot) return null
  const stages = snapshot.stages ?? []
  const slowest = stages.reduce<{ stage: string; avgLatencyMs: number } | null>(
    (worst, item) => (worst && worst.avgLatencyMs >= item.avgLatencyMs ? worst : item),
    null,
  )
  const totalCalls = stages.reduce((sum, item) => sum + item.calls, 0)

  return (
    <div className="logs-diagnostics">
      <button
        type="button"
        className="logs-diagnostics-summary"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <span>运行诊断</span>
        <span className="logs-diagnostics-facts">
          搜索 {snapshot.searchRequests} 次
          {snapshot.truncatedSearchRequests > 0 ? `（截断 ${snapshot.truncatedSearchRequests}）` : ''}
          {` · 跟踪 ${snapshot.trackedSources} 个源`}
          {` · 阶段调用 ${totalCalls} 次`}
          {slowest ? ` · 最慢 ${STAGE_LABEL[slowest.stage] ?? slowest.stage} 平均 ${slowest.avgLatencyMs}ms` : ''}
        </span>
        <span className="logs-diagnostics-toggle">{open ? '收起' : '展开'}</span>
      </button>
      {open && (
        <div className="logs-diagnostics-body">
          {stages.length === 0 ? (
            <p className="logs-empty">这次运行还没有解析记录。</p>
          ) : (
            <>
              <p className="logs-diagnostics-note">
                阶段是包含关系（正文 ⊃ 脚本 ⊃ 网络），读法是「外层减内层」＝这一层自己的开销，别把几行相加当总时间。
              </p>
              <table className="logs-diagnostics-table">
                <thead>
                  <tr><th>阶段</th><th>调用</th><th>失败</th><th>平均</th><th>最慢</th></tr>
                </thead>
                <tbody>
                  {stages.map(item => (
                    <tr key={item.stage}>
                      <td>{STAGE_LABEL[item.stage] ?? item.stage}</td>
                      <td>{item.calls}</td>
                      <td>{item.failures > 0 ? item.failures : '—'}</td>
                      <td>{item.avgLatencyMs}ms</td>
                      <td>{item.maxLatencyMs}ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {snapshot.topSources.length > 0 && (
            <table className="logs-diagnostics-table">
              <thead>
                <tr><th>书源</th><th>搜索</th><th>失败</th><th>超时</th><th>平均</th></tr>
              </thead>
              <tbody>
                {snapshot.topSources.slice(0, 8).map(item => (
                  <tr key={item.sourceId}>
                    <td>{item.sourceId}</td>
                    <td>{item.calls}</td>
                    <td>{item.failures > 0 ? item.failures : '—'}</td>
                    <td>{item.timeouts > 0 ? item.timeouts : '—'}</td>
                    <td>{item.avgLatencyMs}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
