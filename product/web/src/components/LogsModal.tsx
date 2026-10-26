import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type LogEntry } from '../lib/api'
import { Icon } from '../icons'
import { Select } from './Select'
import { toast } from './Toast'
import { useEscapeClose } from '../lib/useEscapeClose'

/**
 * 「运行日志」弹窗：把服务端 LogService 收集的结构化日志摊开给人看。
 *
 * 之前这套日志只写文件 + 内存队列，界面上没有任何入口，等于收集了却看不见。
 * 现在落库后从这里按类别/等级筛、翻历史、清空、导出。
 *
 * 三条来自实测的界面要求（一次 4000 行采样里 3,039 行 ERROR、2,112 行空行）：
 * - **合并计数要看得见**：服务端把同类日志并成一行带 `count`，这里念成「×N」，
 *   用户才分得清"一个坏源在刷"和"很多地方都在坏"。
 * - **没取到 ≠ 没有**：取失败要显式说取失败并给重试，不许先闪一张"这个条件下没有日志"。
 * - **上下文要能在行里看见**：域名/状态码/书源是定位用的，藏在"点开才有"里等于没有。
 */
const CATEGORIES = [
  ['ENGINE', '规则引擎'], ['NETWORK', '网络请求'], ['PARSING', '内容解析'],
  ['RULE_EXECUTION', '书源规则'], ['DATABASE', '数据库'], ['CACHE', '缓存'],
  ['GUARD', '同源闸门'], ['SYSTEM', '系统'],
] as const

const LEVELS = [['ERROR', '错误'], ['WARN', '警告'], ['INFO', '信息'], ['DEBUG', '调试']] as const

const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(CATEGORIES)

/** context 的键是服务端写的英文/拼音混排，界面上给中文名；没登记的键原样显示。 */
const CONTEXT_LABEL: Record<string, string> = {
  host: '域名',
  statusCode: '状态码',
  sourceId: '书源',
  url: '地址',
  原因: '原因',
  尝试: '第几次',
  片段: '原文',
  rule: '规则',
  size: '大小',
  path: '路径',
  method: '方法',
  version: '版本',
  host_: '监听',
  port: '端口',
}

/** 一行里最值得先看到的排前面；其余按原顺序跟在后面。 */
const CONTEXT_ORDER = ['host', 'statusCode', 'sourceId', '原因', 'size', 'url', '片段']

const relativeTime = (stamp: string, now: number) => {
  const at = Date.parse(stamp.replace(' ', 'T'))
  if (Number.isNaN(at)) return stamp.slice(0, 16)
  const diff = Math.max(0, now - at)
  if (diff < 45_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`
  return stamp.slice(0, 16).replace('T', ' ')
}

export function LogsModal({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [error, setError] = useState('')
  const [category, setCategory] = useState('')
  const [level, setLevel] = useState('')
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [follow, setFollow] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async (silent = false) => {
    if (!silent) setState(current => (current === 'ready' ? 'ready' : 'loading'))
    try {
      const list = await api.logs({ category: category || undefined, level: level || undefined, limit: 300 })
      setEntries(list)
      setError('')
      setState('ready')
      setNow(Date.now())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法载入日志')
      setState('failed')
    }
  }, [category, level])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!follow) return undefined
    const timer = setInterval(() => void load(true), 5000)
    return () => clearInterval(timer)
  }, [follow, load])

  // Esc 统一走下面的 useEscapeClose：这里原先另挂了一份 window keydown，
  // 同一次按键触发两次关闭，并且不参与"一次只关最上面一层"的让位约定。

  const merged = useMemo(() => entries.reduce((sum, entry) => sum + Math.max(1, entry.count ?? 1), 0), [entries])

  const clear = async () => {
    if (!confirm('清空服务端全部运行日志？此操作不可恢复。')) return
    try {
      await api.clearLogs()
      toast.success('已清空日志')
      setExpanded(new Set())
      await load()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '清空失败')
    }
  }

  /** 导出当前筛选出来的这一份，纯文本、一行一条，方便贴给别人或丢进编辑器里搜。 */
  const exportText = () => {
    if (entries.length === 0) {
      toast.warning('当前条件下没有可导出的日志')
      return
    }
    const text = entries.map(entry => {
      const ctx = Object.entries(entry.context ?? {}).map(([key, value]) => `${CONTEXT_LABEL[key] ?? key}=${value}`).join(' ')
      const repeat = (entry.count ?? 1) > 1 ? ` ×${entry.count}` : ''
      return `${entry.timestamp.replace('T', ' ')} [${CATEGORY_LABEL[entry.category] ?? entry.category}] [${entry.level}] ${entry.message}${ctx ? ` · ${ctx}` : ''}${repeat}`
    }).join('\n')
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `青阅运行日志-${new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}.log`
    link.click()
    URL.revokeObjectURL(link.href)
    toast.success(`已导出 ${entries.length} 条（合并前共 ${merged} 条）`)
  }

  const toggle = (id: number) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  useEscapeClose(onClose)
  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div
        className="dialog-shell size-l logs-modal"
        onClick={event => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="运行日志"
      >
        <div className="dialog-head logs-modal-header">
          <h2>运行日志</h2>
          <div className="logs-modal-actions">
            <button type="button" className="logs-btn" onClick={() => void load()} disabled={state === 'loading'}>
              <Icon name="refresh" /><span>刷新</span>
            </button>
            <button
              type="button"
              className={`logs-btn ${follow ? 'active' : ''}`}
              aria-pressed={follow}
              title={follow ? '每 5 秒自动取一次，点一下停住好慢慢看' : '每 5 秒自动取一次'}
              onClick={() => setFollow(value => !value)}
            >
              <Icon name="activity" /><span>自动跟随</span>
            </button>
            <button type="button" className="logs-btn" onClick={exportText} title="按当前筛选条件导出为文本文件">
              <Icon name="download" /><span>导出</span>
            </button>
            <button type="button" className="logs-btn danger" onClick={() => void clear()}>
              <Icon name="trash" /><span>清空</span>
            </button>
            <button type="button" className="overlay-close" onClick={onClose} aria-label="关闭">
              <Icon name="close" />
            </button>
          </div>
        </div>

        <div className="logs-filters">
          <div className="logs-filter">
            <span>类别</span>
            <Select
              ariaLabel="日志类别"
              value={category}
              options={[{ value: '', label: '全部' }, ...CATEGORIES.map(([value, label]) => ({ value, label }))]}
              onChange={setCategory}
            />
          </div>
          <div className="logs-filter">
            <span>等级</span>
            <Select
              ariaLabel="日志等级"
              value={level}
              options={[{ value: '', label: '全部' }, ...LEVELS.map(([value, label]) => ({ value, label }))]}
              onChange={setLevel}
            />
          </div>
          <span className="logs-count" role="status">
            {state === 'loading' && entries.length === 0 ? '加载中…'
              : state === 'failed' ? '没取到'
                : `显示 ${entries.length} 条${merged > entries.length ? `（合并前 ${merged} 条）` : ''}`}
          </span>
        </div>

        {state === 'failed' && (
          <div className="logs-error">
            <span>取日志失败：{error || '服务端没有响应'}。</span>
            <button type="button" className="logs-btn" onClick={() => void load()}>重试</button>
          </div>
        )}

        <div className="logs-list">
          {state === 'ready' && entries.length === 0 && <p className="logs-empty">这个条件下没有日志。</p>}
          {entries.map(entry => {
            const contextEntries = Object.entries(entry.context ?? {}).sort((a, b) => {
              const left = CONTEXT_ORDER.indexOf(a[0]); const right = CONTEXT_ORDER.indexOf(b[0])
              return (left < 0 ? 99 : left) - (right < 0 ? 99 : right)
            })
            const hasStack = !!entry.stackTrace
            const expandable = contextEntries.length > 0 || hasStack
            const repeat = Math.max(1, entry.count ?? 1)
            // 按日志 id 展开，不按数组下标：点一次「刷新」列表就重排，下标会让"我刚才看的那条"变成另一条。
            const open = expanded.has(entry.id)
            // 行内只放最能定位的那一两个上下文，其余点开看：一行日志的价值在于扫得动。
            const inline = contextEntries.filter(([key]) => key === 'host' || key === 'statusCode' || key === 'sourceId').slice(0, 2)
            return (
              <div key={entry.id} className={`logs-row level-${entry.level.toLowerCase()}`}>
                <button
                  type="button"
                  className="logs-row-main"
                  onClick={() => expandable && toggle(entry.id)}
                  aria-expanded={expandable ? open : undefined}
                >
                  <span className="logs-badge">{CATEGORY_LABEL[entry.category] ?? entry.category}</span>
                  <span className="logs-level">{LEVELS.find(([value]) => value === entry.level)?.[1] ?? entry.level}</span>
                  <span className="logs-msg">
                    {entry.message}
                    {repeat > 1 && <span className="logs-repeat" title={`同样的日志在 1 分钟内出现了 ${repeat} 次，已合并成这一行`}>×{repeat}</span>}
                    {inline.map(([key, value]) => (
                      <span key={key} className="logs-chip" title={`${CONTEXT_LABEL[key] ?? key}=${value}`}>{CONTEXT_LABEL[key] ?? key} {value}</span>
                    ))}
                  </span>
                  <time className="logs-time" title={entry.timestamp.replace('T', ' ')}>{relativeTime(entry.timestamp, now)}</time>
                  {expandable && <Icon name={open ? 'chevronDown' : 'chevronRight'} />}
                </button>
                {expandable && open && (
                  <div className="logs-detail">
                    {contextEntries.length > 0 && (
                      <dl className="logs-context">
                        {contextEntries.map(([key, value]) => (
                          <div key={key}><dt>{CONTEXT_LABEL[key] ?? key}</dt><dd>{value}</dd></div>
                        ))}
                      </dl>
                    )}
                    {hasStack && <pre className="logs-stack">{entry.stackTrace}</pre>}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
