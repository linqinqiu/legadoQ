import React, { useEffect, useRef, useState } from 'react'
import { api, type AgentConnection, type AgentTaskModel } from '../../lib/api'
import { Icon } from '../../icons'
import { AiPanel } from './AiPanel'

/**
 * 「模型连接」浮层：登记 / 编辑 / 设为默认 / 删除外部模型，并实测此刻通不通。
 *
 * 从前的「AI 接入」一档浮层里堆着六块（连接、工具、技能、提示词、书源校验、对话），
 * 打开就是一屏滚不到底。现在按能力各自一档，这一档只管**连哪个模型**。
 *
 * 三条约定（都与服务端一致，不在这儿另写一套）：
 * - 连接存在本机，重启后仍然可用；多个连接时用标了「默认」的那条，没标就用最先登记的那条
 *   （`FirstProfileSelector` 同一条规则，界面与服务端不许各猜一次）；
 * - 「设为默认」走同一条 upsert 接口，不额外开"当前连接"端点 —— 多一个全局状态
 *   就多一处会与列表不一致的地方；
 * - 编辑时不回传密钥就等于不改（服务端 `apiKey` 缺省沿用原值），所以表单里的密钥
 *   留空是「保持原样」，不是「清空」。
 *
 * 写操作由服务端同源闸门把关（浏览器自动带 Origin），这里不注入令牌。
 */
export function AiConnectionsModal({ onClose }: { onClose: () => void }) {
  return (
    <AiPanel title="模型连接" icon="sliders" onClose={onClose}>
      <ConnectionsPanel />
    </AiPanel>
  )
}

export function ConnectionsPanel() {
  const [connections, setConnections] = useState<AgentConnection[]>([])
  const [loadError, setLoadError] = useState('')
  /** 正在编辑哪一条；`null` = 表单处于"新建"。 */
  const [editing, setEditing] = useState<AgentConnection | null>(null)
  /** 真正生效的那条：标了「默认」的优先，否则第一条（与服务端选择策略同一条规则）。 */
  const active = connections.find(c => c.options?.default === '1' || c.options?.default === 'true') ?? connections[0]

  /** 实测状态：真的发一条探测消息，看外部模型此刻可达不可达。 */
  const [probe, setProbe] = useState<'idle' | 'probing' | 'ok' | 'fail'>('idle')
  const [probeEngine, setProbeEngine] = useState('')
  /** 失败原因：只说"不可达"时，用户不知道是超时、地址被闸门拒了，还是密钥不对。 */
  const [probeReason, setProbeReason] = useState('')

  const refresh = () => {
    api.listAgentConnections()
      .then(setConnections)
      .catch(err => setLoadError(err instanceof Error ? err.message : '读取连接失败'))
  }
  useEffect(() => { refresh() }, [])

  const runProbe = async () => {
    setProbe('probing')
    setProbeReason('')
    try {
      // 20 秒上限：浏览器 fetch 没有超时，上游半开连接会让「实测中…」永远转下去，
      // 用户既不知道通不通、也不知道该改什么。超时由统一客户端换算成一句人话。
      const res = await api.agentChat([{ role: 'user', content: 'ping' }], undefined, undefined, undefined, { timeoutMs: 20_000 })
      if (res.engine.startsWith('external:')) {
        setProbe('ok')
        setProbeEngine(res.engine.replace('external:', ''))
      } else {
        setProbe('fail')
        setProbeReason(res.error || '模型没有返回可用结果')
      }
    } catch (failure) {
      setProbe('fail')
      setProbeReason(failure instanceof Error ? failure.message : '探测失败')
    }
  }

  // 有连接时自动实测一次：用户想知道的是"现在能不能用"，而不是"配了没有"。
  useEffect(() => {
    if (active) void runProbe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id])

  /**
   * 把某条标成默认：给它的 options 加 `default=1`，其余清掉。
   * 走同一条 upsert 接口（不带 apiKey = 服务端沿用原密钥）。
   */
  const makeDefault = async (id: string) => {
    try {
      await Promise.all(connections.map(c => {
        const options = { ...(c.options ?? {}) }
        if (c.id === id) options.default = '1'
        else delete options.default
        return api.registerAgentConnection({
          id: c.id,
          name: c.name,
          kind: c.kind,
          baseUrl: c.baseUrl ?? '',
          model: c.model ?? '',
          options,
        })
      }))
      refresh()
    } catch (failure) {
      setLoadError(failure instanceof Error ? failure.message : '设为默认失败')
    }
  }

  return (
    <div className="ai-connections">
      <section className="ai-section">
        <h3>模型连接</h3>
        <p className="ai-section-hint">
          连接保存在本机，重启后仍然可用。有多个时，走标了「默认」的那条；没标就用最先登记的那条。
        </p>
        <div className="ai-chat-status">
          {active ? (
            <>
              <span className="ai-tag">正在使用：{active.name}</span>
              <span className="ai-status-sep">·</span>
              {probe === 'probing' ? (
                <span className="ai-tag ai-tag-testing">实测中…</span>
              ) : probe === 'ok' ? (
                <span className="ai-tag ai-tag-ok">实测可达{probeEngine ? `（${probeEngine}）` : ''}</span>
              ) : probe === 'fail' ? (
                <span className="ai-tag ai-tag-warn" title={probeReason || undefined}>
                  实测不可达{probeReason ? `（${probeReason}）` : ''}
                </span>
              ) : (
                <span className="ai-tag">待实测</span>
              )}
              <button type="button" className="link-button ai-probe-btn" onClick={() => void runProbe()} disabled={probe === 'probing'}>
                重新实测
              </button>
            </>
          ) : (
            <span className="ai-tag ai-tag-warn">还没有模型连接，AI 不可用</span>
          )}
        </div>
        {loadError ? (
          <p className="customize-error" role="alert">{loadError}</p>
        ) : connections.length === 0 ? (
          <p className="ai-muted">还没有登记连接。下面选协议、填地址与模型即可。</p>
        ) : (
          <ul className="ai-conn-list">
            {connections.map(c => {
              const isActive = c.id === active?.id
              return (
                <li key={c.id} className="ai-conn-item">
                  <div className="ai-conn-main">
                    <strong>
                      {c.name}
                      {isActive && <span className="ai-tag ai-tag-ok ai-conn-badge">正在使用</span>}
                    </strong>
                    <small>外部 · {c.model ?? '—'}{c.baseUrl ? ` · ${c.baseUrl}` : ''}</small>
                    {!!describeOptions(c.options) && <small className="ai-conn-opts">{describeOptions(c.options)}</small>}
                  </div>
                  <div className="ai-conn-actions">
                    <button type="button" className="link-button" onClick={() => setEditing(c)}>编辑</button>
                    {!isActive && (
                      <button type="button" className="link-button" onClick={() => void makeDefault(c.id)}>设为默认</button>
                    )}
                    <button
                      type="button"
                      className="link-button ai-conn-del"
                      onClick={() => void api.deleteAgentConnection(c.id)
                        .then(() => { if (editing?.id === c.id) setEditing(null); refresh() })
                        .catch(() => setLoadError('删除失败'))}
                    >删除</button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        <RegisterConnection
          editing={editing}
          onCancel={() => setEditing(null)}
          onRegistered={() => { setEditing(null); refresh() }}
        />
      </section>
      <TaskModelSection connections={connections} />
    </div>
  )
}

/**
 * 「按任务选模型」。
 *
 * 连接解决的是"连哪一家"，这里解决"哪个任务用哪个模型"：摘要可以走便宜的，
 * 书源排错走强的，互不影响。任务由服务端定：`chat` / `comprehend` / `skill:<技能id>`，
 * 技能那几项就是技能库里每一条（命中关键词时按它路由）。
 *
 * 两列都可以留空：只选连接 = 用那条连接自己的模型；只填模型 = 仍走默认连接、只换模型名；
 * 两个都留空 = 跟随默认（服务端把那一条路由整条删掉，不留空壳）。
 */
function TaskModelSection({ connections }: { connections: AgentConnection[] }) {
  const [rows, setRows] = useState<AgentTaskModel[]>([])
  const [drafts, setDrafts] = useState<Record<string, { connectionId: string; model: string }>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  const adopt = (list: AgentTaskModel[]) => {
    setRows(list)
    setDrafts(Object.fromEntries(list.map(row => [row.task, {
      connectionId: row.routed ? row.connectionId ?? '' : '',
      model: row.routed ? row.model ?? '' : '',
    }])))
  }
  // 连接增删之后要重新取：某条路由可能指向刚被删掉的连接。
  useEffect(() => {
    api.listAgentTaskModels()
      .then(res => adopt(res.tasks))
      .catch(err => setError(err instanceof Error ? err.message : '读取任务路由失败'))
  }, [connections.length])

  const submit = async (task: string, connectionId: string, model: string) => {
    setBusy(task)
    setError('')
    try {
      const res = await api.saveAgentTaskModel({
        task,
        connectionId: connectionId || null,
        model: model.trim() || null,
      })
      adopt(res.tasks)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="ai-section">
      <h3>按任务选模型</h3>
      <p className="ai-section-hint">
        不同任务可以用不同的模型：摘要走便宜的、书源排错走强的。没配的任务跟随默认连接。
      </p>
      {error && <p className="customize-error" role="alert">{error}</p>}
      {rows.length === 0 ? (
        <p className="ai-muted">还没有可配的任务。</p>
      ) : (
        <ul className="ai-task-list">
          {rows.map(row => {
            const draft = drafts[row.task] ?? { connectionId: '', model: '' }
            const modelHint = connections.find(c => c.id === draft.connectionId)?.model
            const dirty = draft.connectionId !== (row.routed ? row.connectionId ?? '' : '')
              || draft.model !== (row.routed ? row.model ?? '' : '')
            return (
              <li key={row.task} className="ai-task-item">
                <div className="ai-task-head">
                  <strong>{row.label}</strong>
                  {row.routed
                    ? <span className="ai-tag ai-tag-ok">已单独指定</span>
                    : <span className="ai-tag">跟随默认</span>}
                </div>
                <div className="ai-task-fields">
                  <select
                    aria-label={`${row.label} 用哪条连接`}
                    value={draft.connectionId}
                    onChange={event => setDrafts(current => ({ ...current, [row.task]: { ...draft, connectionId: event.target.value } }))}
                  >
                    <option value="">默认连接</option>
                    {connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <input
                    aria-label={`${row.label} 用哪个模型`}
                    value={draft.model}
                    placeholder={modelHint || '该连接自己的模型'}
                    onChange={event => setDrafts(current => ({ ...current, [row.task]: { ...draft, model: event.target.value } }))}
                  />
                  <button
                    type="button"
                    className="link-button"
                    disabled={!dirty || busy === row.task}
                    onClick={() => void submit(row.task, draft.connectionId, draft.model)}
                  >{busy === row.task ? '保存中…' : '保存'}</button>
                  {row.routed && (
                    <button
                      type="button"
                      className="link-button"
                      disabled={busy === row.task}
                      onClick={() => void submit(row.task, '', '')}
                    >跟随默认</button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/** 三种协议的显示名；kind 用服务端 wire 值，保存后不用再翻译。 */
const PROTOCOL_OPTIONS = [
  { value: 'openai-compatible', title: 'OpenAI 兼容（chat/completions）' },
  { value: 'anthropic', title: 'Anthropic Messages' },
  { value: 'openai-responses', title: 'OpenAI Responses' },
]

/** 常见网关的地址预设：选一家只填地址与常用模型，其余照旧可改。 */
const PROVIDER_PRESETS = [
  { id: 'openai', name: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { id: 'openai-responses', name: 'OpenAI Responses', kind: 'openai-responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' },
  { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' },
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'moonshot', name: 'Moonshot', kind: 'openai-compatible', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
  { id: 'siliconflow', name: '硅基流动', kind: 'openai-compatible', baseUrl: 'https://api.siliconflow.cn/v1', model: '' },
  { id: 'ollama', name: 'Ollama（本机）', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: '' },
]

/** 连接 options 里用户看得见的那部分摘要（不含 default 标记）。 */
function describeOptions(options?: Record<string, string>): string {
  if (!options) return ''
  const headers = Object.keys(options).filter(key => key.startsWith('header.')).length
  const parts: string[] = []
  if (headers > 0) parts.push(`${headers} 个自定义头`)
  if (options.thinking) parts.push(`思考 ${options.thinking}`)
  if (options.timeoutMs) parts.push(`超时 ${options.timeoutMs}ms`)
  return parts.join(' · ')
}

/** 把 "Name: Value" 多行文本解析成 options.header.*。 */
function parseHeaders(text: string): Record<string, string> {
  const options: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    const name = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (name && value) options[`header.${name}`] = value
  }
  return options
}

function RegisterConnection({ editing, onRegistered, onCancel }: {
  editing: AgentConnection | null
  onRegistered: () => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState('openai-compatible')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  /** 高级项：自定义请求头（一行一个 Name: Value）、超时、思考强度。 */
  const [headersText, setHeadersText] = useState('')
  const [timeoutMs, setTimeoutMs] = useState('')
  const [thinking, setThinking] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  /** 服务端代拉的模型清单：可以点按钮拉，也可以在填完地址后自动拉一次。 */
  const [models, setModels] = useState<string[]>([])
  const [modelsBusy, setModelsBusy] = useState(false)
  const [modelsNote, setModelsNote] = useState('')
  /** 已经为哪个地址拉过清单：同一个地址失焦不重复打网关。 */
  const fetchedFor = useRef('')

  // 进入编辑：把这条连接的值铺回表单。密钥不回填（接口也不返回它），留空 = 沿用原密钥。
  useEffect(() => {
    if (!editing) return
    setName(editing.name)
    setKind(editing.kind || 'openai-compatible')
    setBaseUrl(editing.baseUrl ?? '')
    setModel(editing.model ?? '')
    setApiKey('')
    const options = editing.options ?? {}
    setHeadersText(Object.entries(options)
      .filter(([key]) => key.startsWith('header.'))
      .map(([key, value]) => `${key.slice('header.'.length)}: ${value}`)
      .join('\n'))
    setTimeoutMs(options.timeoutMs ?? '')
    setThinking(options.thinking ?? '')
    setError('')
    setNote('')
    fetchedFor.current = ''
  }, [editing])

  const buildOptions = (): Record<string, string> => {
    const options = parseHeaders(headersText)
    if (thinking) options.thinking = thinking
    if (timeoutMs.trim() && Number(timeoutMs) > 0) options.timeoutMs = timeoutMs.trim()
    // 编辑时保留「默认」标记：改个模型不该把它从默认位上踢下来。
    if (editing?.options?.default) options.default = editing.options.default
    return options
  }

  const reset = () => {
    setName(''); setKind('openai-compatible'); setBaseUrl(''); setModel(''); setApiKey('')
    setHeadersText(''); setTimeoutMs(''); setThinking('')
    setModels([]); setModelsNote(''); fetchedFor.current = ''
  }

  const fetchModels = async () => {
    const url = baseUrl.trim()
    if (!url) { setModelsNote('先填接口地址'); return }
    setModelsBusy(true)
    setModelsNote('')
    try {
      // 带上高级项：有些中转站要自定义头才允许列模型。
      const result = await api.listAgentModels(url, apiKey.trim() || undefined, buildOptions(), kind)
      setModels(result.models)
      fetchedFor.current = `${url}|${apiKey.trim()}|${kind}`
      setModelsNote(result.supported
        ? `已拿到 ${result.models.length} 个模型；从下拉里挑，或直接填清单外的名字。`
        : '这个协议不提供模型清单（如 Anthropic），直接填模型名即可。')
    } catch (failure) {
      setModels([])
      // 失败不记住"已拉过"：填上密钥后失焦要能自动再试一次（401 多半就是还没填 key）。
      fetchedFor.current = ''
      setModelsNote(failure instanceof Error ? failure.message : '拿不到模型清单')
    } finally {
      setModelsBusy(false)
    }
  }

  /** 地址或密钥填完就自动拉一次 —— 用户不用先知道要按哪个按钮。 */
  const autoFetch = () => {
    const url = baseUrl.trim()
    if (!/^https?:\/\//i.test(url)) return
    if (fetchedFor.current === `${url}|${apiKey.trim()}|${kind}`) return
    void fetchModels()
  }

  const submit = async () => {
    if (!name.trim() || !baseUrl.trim() || !model.trim()) {
      setError('名称、接口地址、模型名都要填')
      return
    }
    setBusy(true)
    setError('')
    setNote('')
    try {
      const saved = await api.registerAgentConnection({
        id: editing?.id,
        name: name.trim(),
        kind,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim() || undefined,
        options: buildOptions(),
      })
      setNote(editing
        ? `已更新「${saved.name}」。`
        : `已登记「${saved.name}」。要用它对话，多个连接时记得点「设为默认」。`)
      reset()
      onRegistered()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '登记失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ai-register">
      <h4>{editing ? `编辑连接：${editing.name}` : '登记模型连接（三种协议）'}</h4>
      {!editing && (
        <label className="customize-field">
          <span>从预设开始（可选）</span>
          <select
            className="settings-search"
            value=""
            onChange={event => {
              const preset = PROVIDER_PRESETS.find(item => item.id === event.target.value)
              if (!preset) return
              if (!name.trim()) setName(preset.name)
              setKind(preset.kind)
              setBaseUrl(preset.baseUrl)
              if (preset.model) setModel(preset.model)
            }}
          >
            <option value="">选一家自动填地址…</option>
            {PROVIDER_PRESETS.map(preset => (
              <option key={preset.id} value={preset.id}>{preset.name} · {preset.baseUrl}</option>
            ))}
          </select>
        </label>
      )}
      <div className="ai-field-grid">
        <label className="customize-field">
          <span>名称</span>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="如 我的网关" />
        </label>
        <label className="customize-field">
          <span>协议</span>
          <select
            className="settings-search"
            value={kind}
            onChange={event => {
              setKind(event.target.value)
              // 换协议后旧清单不再适用，清掉免得选了一个对不上的模型名。
              setModels([])
              setModelsNote('')
              fetchedFor.current = ''
            }}
          >
            {PROTOCOL_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>{option.title}</option>
            ))}
          </select>
        </label>
        <label className="customize-field">
          <span>接口地址（到 /v1）</span>
          <input
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
            onBlur={autoFetch}
            placeholder="https://api.example.com/v1"
          />
        </label>
        <label className="customize-field">
          <span>模型名（可挑可自填）</span>
          <input
            value={model}
            onChange={e => setModel(e.target.value)}
            placeholder="gpt-4o"
            list="ai-model-options"
          />
          <datalist id="ai-model-options">
            {models.map(id => <option key={id} value={id} />)}
          </datalist>
        </label>
        <label className="customize-field">
          <span>密钥{editing ? '（留空 = 不改）' : '（可空）'}</span>
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            onBlur={autoFetch}
            placeholder={editing ? '不改就留空' : 'sk-…（留空则不带密钥）'}
          />
        </label>
      </div>
      <details className="ai-register-advanced">
        <summary>高级（自定义请求头 / 超时 / 思考强度）</summary>
        <label className="customize-field">
          <span>自定义请求头，一行一个 <code>Name: Value</code></span>
          <textarea
            rows={3}
            spellCheck={false}
            value={headersText}
            onChange={e => setHeadersText(e.target.value)}
            placeholder={'X-Api-Key: abc\nHTTP-Referer: https://example.com'}
          />
        </label>
        <div className="ai-field-grid">
          <label className="customize-field">
            <span>思考强度</span>
            <select className="settings-search" value={thinking} onChange={e => setThinking(e.target.value)}>
              <option value="">默认（不发这个字段）</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="xhigh">xhigh</option>
              <option value="max">max</option>
            </select>
          </label>
          <label className="customize-field">
            <span>超时（毫秒，留空用默认 30s）</span>
            <input
              inputMode="numeric"
              value={timeoutMs}
              onChange={e => setTimeoutMs(e.target.value)}
              placeholder="30000"
            />
          </label>
        </div>
      </details>
      <div className="ai-model-fetch">
        <button
          type="button"
          className="link-button"
          onClick={() => void fetchModels()}
          disabled={modelsBusy || !baseUrl.trim()}
        >
          {modelsBusy ? '正在获取模型…' : '拉取模型清单'}
        </button>
        <small className="ai-muted">
          {modelsNote || '填完接口地址会自动获取一次；也可以直接填清单里没有的模型名。'}
        </small>
      </div>
      {!!error && <p className="customize-error" role="alert">{error}</p>}
      {!!note && <p className="customize-note">{note}</p>}
      <div className="customize-actions">
        <button type="button" className="primary-button" onClick={() => void submit()} disabled={busy}>
          {editing ? '保存' : '登记'}
        </button>
        {editing && (
          <button type="button" className="ghost-button" onClick={() => { reset(); onCancel() }}>取消</button>
        )}
      </div>
      <p className="ai-muted">
        <Icon name="info" /> 接口地址要公网可达；填本机或内网地址需先在本机环境变量里放开
        <code> LEGADO_AI_ALLOW_LOOPBACK_BASEURL=1</code>。
      </p>
    </div>
  )
}
