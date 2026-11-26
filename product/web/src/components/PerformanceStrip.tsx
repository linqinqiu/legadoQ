import React, { useEffect, useState } from 'react'
import { Icon } from '../icons'
import { performanceMonitor } from '../lib/performance'
import {
  appendSnapshot,
  clearSnapshots,
  readSnapshots,
  type PerfSnapshot,
} from '../lib/perfSnapshots'
import { toast } from './Toast'

/**
 * 「界面自己卡不卡」。
 *
 * 运行诊断（DiagnosticsStrip）回答"后端解析慢在哪"，这里回答"前端等待与渲染慢在哪"：
 * 页面加载、TTI、慢 API、瓶颈，数据来自 `performanceMonitor`，与日志页同一个弹窗。
 *
 * 快照要手动点「记录此刻」才落盘（localStorage，最近 8 份）——卡顿是不确定的，
 * 自动定时存会攒一堆没用的平稳样本，真出问题时反而淹没在噪声里。
 * 记录后跨刷新还在，下次打开弹窗还能翻到"刚才那一下"。
 *
 * 默认收起：这是排障用的第二眼信息，摊开会把日志列表挤走。
 */
const clock = (at: number) => {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function PerformanceStrip() {
  const [snapshots, setSnapshots] = useState<PerfSnapshot[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => { setSnapshots(readSnapshots()) }, [])

  const record = () => {
    const list = appendSnapshot(performanceMonitor.report())
    setSnapshots(list)
    toast.success(list.length > 0 ? '已记录当前性能快照' : '已记录（当前存储不可用，仅本次可见）')
  }

  const clear = () => {
    clearSnapshots()
    setSnapshots([])
    toast.success('已清空性能快照')
  }

  const latest = snapshots[snapshots.length - 1]

  return (
    <div className="logs-diagnostics">
      <button
        type="button"
        className="logs-diagnostics-summary"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <span>界面性能</span>
        <span className="logs-diagnostics-facts">
          {latest
            ? `${snapshots.length} 份快照 · 最近加载 ${latest.pageLoadMs}ms · 慢请求 ${latest.slowApiCount} 条`
            : '还没记录过；卡顿时点右侧「记录此刻」，跨刷新可查'}
        </span>
        <span className="logs-diagnostics-toggle">{open ? '收起' : '展开'}</span>
      </button>
      {open && (
        <div className="logs-diagnostics-body">
          <div className="logs-modal-actions">
            <button type="button" className="logs-btn" onClick={record}>
              <Icon name="activity" /><span>记录此刻</span>
            </button>
            <button type="button" className="logs-btn danger" onClick={clear} disabled={snapshots.length === 0}>
              <Icon name="trash" /><span>清空</span>
            </button>
          </div>
          {snapshots.length === 0 ? (
            <p className="logs-empty">还没有快照。遇到卡顿时点「记录此刻」，会连同时间一起留下来。</p>
          ) : (
            <table className="logs-diagnostics-table">
              <thead>
                <tr><th>时间</th><th>加载</th><th>可交互</th><th>请求</th><th>慢</th><th>最慢</th></tr>
              </thead>
              <tbody>
                {snapshots.slice().reverse().map(snapshot => (
                  <tr key={snapshot.at} title={snapshot.slowest.map(item => `${item.url} ${item.ms}ms`).join('\n') || undefined}>
                    <td>{clock(snapshot.at)}</td>
                    <td>{snapshot.pageLoadMs}ms</td>
                    <td>{snapshot.ttiMs}ms</td>
                    <td>{snapshot.apiCount}</td>
                    <td>{snapshot.slowApiCount > 0 ? snapshot.slowApiCount : '—'}</td>
                    <td>{snapshot.maxApiMs > 0 ? `${snapshot.maxApiMs}ms` : '—'}</td>
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
