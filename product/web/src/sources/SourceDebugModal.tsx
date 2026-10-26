import React, { useEffect, useRef, useState } from 'react'
import { api, type DebugStep } from '../lib/api'
import { Icon } from '../icons'
import { useEscapeClose } from '../lib/useEscapeClose'


export interface SourceDebugModalProps {
  sourceId: string
  sourceName: string
  onClose: () => void
}

const STAGES = ['结构', '搜索', '详情', '目录', '正文']

/** 书源分阶段调试台：把「搜索 0 条」拆成能看懂的每一步 —— 实际地址、规则原文、取到了什么、为什么失败。 */
export function SourceDebugModal({ sourceId, sourceName, onClose }: SourceDebugModalProps) {
  const [keyword, setKeyword] = useState('都市')
  const [bookUrl, setBookUrl] = useState('')
  const [chapterIndex, setChapterIndex] = useState(0)
  const [steps, setSteps] = useState<DebugStep[]>([])
  const [running, setRunning] = useState(false)
  const [note, setNote] = useState('')
  const streamRef = useRef<EventSource | null>(null)

  const stop = () => {
    streamRef.current?.close()
    streamRef.current = null
    setRunning(false)
  }

  // 卸载时收流；Esc 走下面 useEscapeClose 那一套。
  // 这里原来还另挂了一份 window keydown：一次 Esc 调两次 onClose，且不参与"一次只关最上面一层"的让位约定。
  useEffect(() => () => { streamRef.current?.close() }, [])

  const start = () => {
    streamRef.current?.close()
    setSteps([])
    setNote('')
    setRunning(true)
    const stream = new EventSource(api.debugStreamUrl(sourceId, keyword, bookUrl, chapterIndex))
    streamRef.current = stream
    stream.addEventListener('step', event => {
      const step = JSON.parse((event as MessageEvent).data) as DebugStep
      setSteps(previous => [...previous, step])
    })
    stream.addEventListener('done', () => {
      stream.close()
      if (streamRef.current === stream) streamRef.current = null
      setRunning(false)
    })
    // EventSource 断线会自动重连，那等于把整条链路再跑一遍：必须显式关掉。
    stream.onerror = () => {
      stream.close()
      if (streamRef.current === stream) {
        streamRef.current = null
        setRunning(false)
        setNote('调试流中断：服务端无响应或已被停止。')
      }
    }
  }

  const reached = new Set(steps.map(step => step.stage))
  const failedAt = steps.find(step => !step.ok)?.stage

  useEscapeClose(onClose)
  return (
    <div className="overlay-backdrop is-topped" onClick={onClose}>
      <div className="dialog-shell size-l source-debug-modal" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-label={`调试书源 ${sourceName}`}>
        <header className="dialog-head source-debug-header">
          <div>
            <span className="section-kicker">分阶段调试</span>
            <h2>{sourceName}</h2>
          </div>
          <button type="button" className="overlay-close" aria-label="关闭调试面板" onClick={onClose}><Icon name="close" /></button>
        </header>

        <div className="source-debug-form">
          <label><span>关键词</span><input value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="用来跑搜索阶段" /></label>
          <label><span>书籍地址（留空用第一条命中）</span><input value={bookUrl} onChange={event => setBookUrl(event.target.value)} placeholder="https://…" /></label>
          <label><span>第几章</span>
            <input type="number" min={0} value={chapterIndex} onChange={event => setChapterIndex(Math.max(0, Number(event.target.value) || 0))} />
          </label>
          {running
            ? <button type="button" className="subtle-button" onClick={stop}>停止</button>
            : <button type="button" className="primary-button" onClick={start}>开始调试</button>}
        </div>

        <div className="source-debug-track" aria-label="调试进度">
          {STAGES.map(stage => (
            <span key={stage} className={`debug-node ${reached.has(stage) ? (steps.find(s => s.stage === stage)?.ok === false ? 'fail' : 'done') : ''}`}>{stage}</span>
          ))}
        </div>

        {note && <p className="source-debug-note">{note}</p>}

        <div className="source-debug-steps">
          {steps.length === 0 && !running && <p className="source-debug-hint">点「开始调试」跑一遍 结构 → 搜索 → 详情 → 目录 → 正文。慢源最坏要等满各阶段超时。</p>}
          {running && steps.length === 0 && <p className="source-debug-hint">正在跑结构校验…</p>}
          {steps.map((step, index) => (
            <article key={index} className={`source-debug-step ${step.ok ? 'ok' : 'fail'}`}>
              <header>
                <strong>{step.stage}</strong>
                <span className="source-debug-label">{step.label}</span>
                {step.elapsedMs > 0 && <small>{step.elapsedMs} ms</small>}
              </header>
              {step.detail && <pre className="source-debug-detail">{step.detail}</pre>}
              {step.traces.length > 0 && (
                <table className="source-debug-traces">
                  <thead><tr><th>字段</th><th>规则原文</th><th>取到</th></tr></thead>
                  <tbody>
                    {step.traces.map((trace, traceIndex) => (
                      <tr key={traceIndex} className={trace.value ? '' : 'empty'}>
                        <td>{trace.field}</td>
                        <td><code>{trace.rule || '未配置'}</code></td>
                        <td>{trace.value ? trace.value.replace(/\s+/g, ' ').slice(0, 90) : <em>{trace.failure || '空'}</em>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </article>
          ))}
          {failedAt && <p className="source-debug-conclusion">卡点在「{failedAt}」阶段：先修这一步，后面的阶段才有意义。</p>}
        </div>
      </div>
    </div>
  )
}
