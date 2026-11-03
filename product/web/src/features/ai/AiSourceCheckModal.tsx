import React from 'react'
import { api } from '../../lib/api'
import { AiPanel } from './AiPanel'

/**
 * 「书源校验」浮层：粘贴一份书源 JSON，只看结构合不合法。
 *
 * 它是只读探针（服务端不落库），所以不需要确认、也不会改本机任何东西。
 * 想进一步知道"这个源到底跑不跑得通"要去书源页的逐阶段调试（`/api/sources/{id}/debug`），
 * 结构合法只说明"能存下"，不说明"能出书"。
 */
export function AiSourceCheckModal({ onClose }: { onClose: () => void }) {
  return (
    <AiPanel title="书源校验" icon="file" onClose={onClose}>
      <SourceValidatePanel />
    </AiPanel>
  )
}

function SourceValidatePanel() {
  const [json, setJson] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [result, setResult] = React.useState<{ valid: boolean; errors: string[]; warnings: string[] } | null>(null)

  const run = async () => {
    if (!json.trim()) { setError('先粘贴书源 JSON'); return }
    setBusy(true); setError(''); setResult(null)
    try {
      const r = await api.validateAgentSource(json)
      setResult(r)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '校验失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="ai-section">
      <h3>书源校验</h3>
      <p className="ai-section-hint">只检查书源 JSON 的结构，不写入数据库。</p>
      <label className="customize-field">
        <span>书源 JSON</span>
        <textarea value={json} onChange={e => setJson(e.target.value)} rows={5} placeholder='{"bookSourceUrl":"https://x.com","bookSourceName":"demo"}' />
      </label>
      {!!error && <p className="customize-error" role="alert">{error}</p>}
      <div className="customize-actions">
        <button type="button" className="primary-button" onClick={() => void run()} disabled={busy}>校验</button>
      </div>
      {result && (
        <div className="ai-result">
          <p><span className={`ai-tag ${result.valid ? '' : 'ai-tag-warn'}`}>{result.valid ? '结构合法' : '结构有误'}</span></p>
          {result.errors.map((e, i) => <p key={i} className="customize-error">{e}</p>)}
          {result.warnings.map((w, i) => <p key={i} className="ai-muted">{w}</p>)}
          <p className="ai-muted">结构合法只说明这份配置能存下来；能不能出书要用书源页的「逐阶段调试」实跑一遍。</p>
        </div>
      )}
    </section>
  )
}
