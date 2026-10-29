import React, { useEffect, useRef, useState } from 'react'
import { api, AgentChatMessage, AgentConnection, AgentPrompt, AgentPromptInput, AgentSkill, AgentSkillInput } from '../../lib/api'
import { Icon } from '../../icons'
import { useEscapeClose } from '../../lib/useEscapeClose'
import { EMPTY_UI_CONTEXT, uiContextMessage, type UiContext } from '../../lib/uiContext'
import { aiToolTitle, loadAiToolGroups, toolRoundGroups } from '../../lib/aiToolGroups'
import { activeSession, setAiSystemPrompt, useAiChat } from './aiChatStore'
import { streamAgentChat, type AgentStreamDraft } from './agentStream'
import { AiToolsSection } from '../../settings/AiToolsSection'

/**
 * 「AI 接入」（自定义接入面 /api/agent/*）。
 *
 * 这一页把后端那套**已在 127.0.0.1:1234 跑起来的** HTTP 接口做成本地设置入口。
 * 主形态是**对话助手**：在输入框里说话，消息走 `POST /api/agent/chat`。
 * **必须有外部模型（openai-compatible）连接**：没有连接时 AI 明确不可用，
 * 外呼失败直接报错——不做本地抽取兜底，也不假装能对话。
 *
 * 连接管理（登记 / 删除外部模型）收进「高级」折叠区：要对话，先在那里登记一个
 * openai-compatible 地址（或在 agent-profiles.json 里配置）。书源只读校验也放在折叠区。
 *
 * 写操作由服务端同源闸门把关（浏览器自动带 Origin），这里不注入令牌。
 *
 * 浮层形态自带 overlay + dialog-shell + 关闭键（一档浮层，见 UiContract 判据）。
 * `AiModal` 直接复用这一形态，不再经实验室套壳。
 */
export function AiConnectionsModal({ onClose, uiContext }: { onClose: () => void; uiContext?: UiContext }) {
  useEscapeClose(onClose)
  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div
        className="dialog-shell size-l page-dialog"
        onClick={event => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="AI 接入"
      >
        <header className="dialog-head">
          <h2><Icon name="sliders" /> AI 接入 · 对话助手</h2>
          <button type="button" className="overlay-close" aria-label="关闭" onClick={onClose}><Icon name="close" /></button>
        </header>
        <div className="page-dialog-body">
          <AiConnectionsPanel uiContext={uiContext} />
        </div>
      </div>
    </div>
  )
}

type ChatLine = {
  role: 'system' | 'user' | 'assistant'
  content: string
  pending?: boolean
  engine?: string
  /** AI 这一轮实际执行过的工具（`工具id:结果码`）。 */
  toolRounds?: string[]
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
  skillsUsed?: string[]
  /** 本轮实际注入的提示词预设 id（按注入顺序）。 */
  promptsUsed?: string[]
  /** 为塞进上下文预算丢掉的旧消息条数；没裁就不出现。 */
  trimmed?: number
}

function AiConnectionsPanel({ uiContext }: { uiContext?: UiContext }) {
  const [connections, setConnections] = useState<AgentConnection[]>([])
  const [loadError, setLoadError] = useState('')
  /** 正在编辑哪一条；`null` = 表单处于"新建"。 */
  const [editing, setEditing] = useState<AgentConnection | null>(null)
  /** 真正生效的那条：标了「默认」的优先，否则第一条（与服务端选择策略同一条规则）。 */
  const active = connections.find(c => c.options?.default === '1' || c.options?.default === 'true') ?? connections[0]
  const external = active

  const refresh = () => {
    api.listAgentConnections()
      .then(setConnections)
      .catch(err => setLoadError(err instanceof Error ? err.message : '读取连接失败'))
  }
  useEffect(() => { refresh() }, [])

  /**
   * 把某条标成默认：给它的 options 加 `default=1`，其余清掉。
   *
   * 走的是同一条 upsert 接口（不带 apiKey = 服务端沿用原密钥），不额外开"当前连接"端点 ——
   * 多一个全局状态就多一处会与列表不一致的地方。
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
      <ChatPanel externalConnected={!!external} externalName={external?.name} uiContext={uiContext} onConnectionsChanged={refresh} />
      <details className="ai-advanced">
        <summary>连接与工具（登记外部模型、选择能力、校验书源）</summary>
        <section className="ai-section">
          <h3>连接</h3>
          <p className="ai-section-hint">
            连接会写入 <code>agent-profiles.json</code>，重启后保留。多个连接时走标了「默认」的那条，
            没标就走第一条；没有连接时 AI 不可用，不会用本地抽取冒充模型结果。
          </p>
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
        <section className="ai-section">
          <h3>工具</h3>
          <p className="ai-section-hint">
            这些能力全部由程序内置提供（没有插件注册工具）。勾掉哪一组，模型就看不到那组工具。
          </p>
          <AiToolsSection />
        </section>
        <PromptsSection />
        <SkillsSection />
        <SourceValidatePanel />
      </details>
    </div>
  )
}

function ChatPanel({
  externalConnected,
  externalName,
  onConnectionsChanged,
  uiContext,
}: {
  externalConnected: boolean
  externalName?: string
  onConnectionsChanged: () => void
  /** 当前界面上下文：随对话发出，让模型知道用户在哪、在看什么。 */
  uiContext?: UiContext
}) {
  const [messages, setMessages] = useState<ChatLine[]>([])
  // 人设与悬浮球共用同一份（aiChatStore 的活动会话）：两个入口各存一份的话，
  // 在这边改完、去悬浮球聊，用的还是旧人设 —— 看起来就是"人设没作用"。
  const chat = useAiChat()
  const systemPrompt = activeSession(chat).systemPrompt
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [draft, setDraft] = useState<AgentStreamDraft | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const [error, setError] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  // 实测便携状态：真正发一条探测消息走 /api/agent/chat，看外部模型此刻是否可达。
  // 与上方「显示状态」（仅看是否登记了外部连接）不同，这里是实时连通性实测。
  const [probe, setProbe] = useState<'idle' | 'probing' | 'ok' | 'fail'>('idle')
  const [probeEngine, setProbeEngine] = useState('')

  const runProbe = async () => {
    setProbe('probing')
    try {
      const res = await api.agentChat([{ role: 'user', content: 'ping' }])
      if (res.engine.startsWith('external:')) {
        setProbe('ok')
        setProbeEngine(res.engine.replace('external:', ''))
      } else {
        setProbe('fail')
      }
    } catch {
      setProbe('fail')
    }
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])
  useEffect(() => {
    if (!draft) return
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [draft?.text, draft?.tools.length])
  useEffect(() => () => abortRef.current?.abort(), [])

  // 打开且已登记外部模型时，自动实测一次连通性。
  useEffect(() => {
    if (externalConnected) { void runProbe() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalConnected])

  const stop = () => abortRef.current?.abort()

  const send = async () => {
    const text = input.trim()
    if (!text || sending || !externalConnected) return
    setError('')
    const userLine: ChatLine = { role: 'user', content: text }
    const history: ChatLine[] = [...messages, userLine]
    setMessages(history)
    setInput('')

    const payload: AgentChatMessage[] = []
    if (systemPrompt.trim()) payload.push({ role: 'system', content: systemPrompt.trim() })
    // 界面上下文：让模型知道用户此刻在哪、在看什么（"这本书讲了什么"才知道指哪本）。
    // 采集层只描述真实状态、不给指令，见 lib/uiContext.ts。
    const ctxMsg = uiContextMessage(uiContext ?? EMPTY_UI_CONTEXT)
    if (ctxMsg) payload.push(ctxMsg)
    for (const m of history) payload.push({ role: m.role, content: m.content })

    const controller = new AbortController()
    abortRef.current = controller
    setSending(true)
    try {
      const result = await streamAgentChat(payload, {
        toolGroups: loadAiToolGroups(),
        signal: controller.signal,
        onUpdate: setDraft,
      })
      const content = (result.content || result.text).trim()
      const toolRounds = result.toolRounds
        ?? (result.tools.length > 0
          ? result.tools.map(tool => `${tool.toolId}:${tool.status === 'error' ? (tool.code ?? 'error') : 'ok'}`)
          : undefined)
      const line: ChatLine = {
        role: 'assistant',
        content,
        engine: result.engine || undefined,
        toolRounds,
        usage: result.usage,
        skillsUsed: result.skills.length > 0 ? result.skills : undefined,
        promptsUsed: result.prompts.length > 0 ? result.prompts : undefined,
        trimmed: result.trimmed > 0 ? result.trimmed : undefined,
      }
      if (result.error) {
        setError(result.error.message)
        line.content = content || `（请求失败：${result.error.message}）`
      } else if (result.aborted) {
        line.content = content ? `${content}\n\n（已停止）` : '（已停止，未生成内容）'
      }
      setMessages(prev => [...prev, line])
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : '未知错误'
      setMessages(prev => [...prev, { role: 'assistant', content: `（请求失败：${message}）` }])
      setError(message)
    } finally {
      abortRef.current = null
      setDraft(null)
      setSending(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <section className="ai-chat">
      <div className="ai-chat-status">
        {externalConnected ? (
          <>
            <span className="ai-tag">已连接外部模型{externalName ? `：${externalName}` : ''}</span>
            <span className="ai-status-sep">·</span>
            {probe === 'probing' ? (
              <span className="ai-tag ai-tag-testing">实测中…</span>
            ) : probe === 'ok' ? (
              <span className="ai-tag ai-tag-ok">实测可达{probeEngine ? `（${probeEngine}）` : ''}</span>
            ) : probe === 'fail' ? (
              <span className="ai-tag ai-tag-warn">实测不可达</span>
            ) : (
              <span className="ai-tag">待实测</span>
            )}
            <button type="button" className="link-button ai-probe-btn" onClick={() => void runProbe()} disabled={probe === 'probing'}>
              重新实测
            </button>
          </>
        ) : (
          <span className="ai-tag ai-tag-warn">未连接外部模型，AI 不可用</span>
        )}
      </div>

      <details className="ai-chat-system">
        <summary>系统提示词（可选，设定助手人设）</summary>
        <textarea
          className="ai-chat-system-input"
          value={systemPrompt}
          onChange={e => setAiSystemPrompt(e.target.value)}
          rows={2}
          placeholder="例如：你是书源调试助手…"
        />
      </details>

      <div className="ai-chat-log" ref={scrollRef}>
        {messages.length === 0 && (
          <p className="ai-chat-empty">
            {externalConnected ? '在下面输入消息开始对话。' : '先在「连接与工具」里登记一个模型连接，才能对话。'}
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`ai-bubble ai-bubble-${m.role}${m.pending ? ' ai-bubble-pending' : ''}`}>
            <div className="ai-bubble-role">{m.role === 'user' ? '我' : '助手'}</div>
            <div className="ai-bubble-content">{m.content || (m.pending ? '思考中…' : '')}</div>
            {m.role === 'assistant' && !m.pending && m.toolRounds && m.toolRounds.length > 0 && (
              <div className="ai-bubble-tools">
                <span className="ai-bubble-tools-label">用了 {m.toolRounds.length} 次能力</span>
                <ul className="ai-tool-list">
                  {toolRoundGroups(m.toolRounds).map(item => (
                    <li key={item.label} className="ai-tool-item" title={item.ids}>{item.label}</li>
                  ))}
                </ul>
              </div>
            )}
            {m.role === 'assistant' && !m.pending && m.engine && (
              <div className="ai-bubble-meta">
                <span className="ai-tag">
                  {m.engine.startsWith('external:') ? `外部模型 ${m.engine.replace('external:', '')}` : '未返回模型结果'}
                </span>
                {m.usage?.totalTokens ? <span>{m.usage.totalTokens} tokens</span> : null}
                {m.skillsUsed && m.skillsUsed.length > 0 ? <span>技能 {m.skillsUsed.length} 条</span> : null}
                {m.promptsUsed && m.promptsUsed.length > 0 ? <span>提示词 {m.promptsUsed.length} 条</span> : null}
                {m.trimmed ? <span>已裁历史 {m.trimmed} 条</span> : null}
              </div>
            )}
          </div>
        ))}
        {draft && (
          <div className="ai-bubble ai-bubble-assistant ai-bubble-streaming">
            <div className="ai-bubble-role">助手</div>
            {!!draft.reasoning && (
              <details className="ai-bubble-reasoning">
                <summary>思考过程</summary>
                <div>{draft.reasoning}</div>
              </details>
            )}
            <div className="ai-bubble-content">
              {draft.text || (draft.tools.length > 0 ? '正在调用能力…' : '思考中…')}
            </div>
            {draft.tools.length > 0 && (
              <div className="ai-bubble-tools">
                <ul className="ai-tool-list">
                  {draft.tools.map((tool, index) => (
                    <li
                      key={`${tool.callId}-${index}`}
                      className={`ai-tool-item ai-tool-${tool.status}`}
                      title={tool.message ?? tool.toolId}
                    >
                      {aiToolTitle(tool.toolId)}
                      <span className="ai-tool-state">
                        {tool.status === 'running' ? ' · 进行中' : tool.status === 'error' ? ' · 失败' : ' · 完成'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      {!!error && <p className="customize-error" role="alert">{error}</p>}

      <div className="ai-chat-input">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          disabled={!externalConnected}
          placeholder={externalConnected ? '输入消息，Enter 发送，Shift+Enter 换行' : '先登记外部模型连接'}
        />
        {sending ? (
          <button type="button" className="ghost-button" onClick={stop} title="停止生成，已生成的部分会保留">
            停止
          </button>
        ) : (
          <button type="button" className="primary-button" onClick={() => void send()} disabled={!externalConnected || !input.trim()}>
            发送
          </button>
        )}
      </div>
      <p className="ai-muted ai-chat-hint">
        快捷键：Enter 发送，Shift+Enter 换行。对话走 <code>POST /api/agent/chat/stream</code>（SSE 流式，可随时停止），不落库。
        {!externalConnected && ' 没有连接时不会用本地抽取代替模型回答。'}
      </p>
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
        : `已登记「${saved.name}」（id: ${saved.id}）。多个连接时走标了「默认」的那条，需要它生效就点「设为默认」。`)
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
      <h4>{editing ? `编辑连接：${editing.name}` : '登记外部连接（三种协议）'}</h4>
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
            placeholder="http://127.0.0.1:5591/v1"
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
            placeholder={editing ? '不改就留空' : 'sk-…（留空则不带 Authorization）'}
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
    </div>
  )
}

function SourceValidatePanel() {
  const [json, setJson] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ valid: boolean; errors: string[]; warnings: string[] } | null>(null)

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
      <p className="ai-section-hint">只读校验书源 JSON 结构，不写入数据库。</p>
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
        </div>
      )}
    </section>
  )
}

/**
 * 技能库：按关键词命中注入 system 的一段专业说明。
 *
 * 借自 refgd/legado 的 SKILL.md 思路，但放在本地磁盘（`agent-skills/<id>.md`），
 * 用户可以直接改。内置技能能覆盖、不能删 —— 删了下次还会出现，只会让人困惑。
 * 列表默认单行，正文点开才展开，和书源列表同一套紧凑习惯。
 */
function SkillsSection() {
  const [skills, setSkills] = useState<AgentSkill[]>([])
  const [loadError, setLoadError] = useState('')
  const [expanded, setExpanded] = useState('')
  const [editing, setEditing] = useState<AgentSkill | null>(null)
  const [creating, setCreating] = useState(false)

  const refresh = () => {
    api.listAgentSkills()
      .then(result => { setSkills(result.skills); setLoadError('') })
      .catch(err => setLoadError(err instanceof Error ? err.message : '读取技能失败'))
  }
  useEffect(() => { refresh() }, [])

  const remove = async (skill: AgentSkill) => {
    if (!window.confirm(`删除技能「${skill.name}」？会移到 agent-skills/.trash，可以找回。`)) return
    try {
      await api.deleteAgentSkill(skill.id)
      if (editing?.id === skill.id) setEditing(null)
      refresh()
    } catch (failure) {
      setLoadError(failure instanceof Error ? failure.message : '删除失败')
    }
  }

  const openEditor = (skill: AgentSkill | null) => {
    setEditing(skill)
    setCreating(skill === null)
  }

  return (
    <section className="ai-section">
      <h3>技能</h3>
      <p className="ai-section-hint">
        技能是一段按需注入的方法说明：用户的话命中关键词才进入上下文，一次最多 3 条。
        内置技能可以「覆盖」保存成自己的版本，但不能删除。
      </p>
      {loadError ? (
        <p className="customize-error" role="alert">{loadError}</p>
      ) : (
        <ul className="ai-skill-list">
          {skills.map(skill => (
            <li key={skill.id} className={`ai-skill-item${expanded === skill.id ? ' expanded' : ''}`}>
              <div className="ai-skill-main">
                <button
                  type="button"
                  className="ai-skill-name"
                  onClick={() => setExpanded(current => (current === skill.id ? '' : skill.id))}
                  title="展开/收起技能正文"
                >
                  {skill.name}
                </button>
                {skill.builtin && <span className="ai-tag ai-skill-badge">内置</span>}
                {!skill.enabled && <span className="ai-tag ai-tag-warn ai-skill-badge">已停用</span>}
                <span className="ai-skill-desc">{skill.description || '—'}</span>
                {skill.keywords.length > 0 && (
                  <span className="ai-skill-keywords">{skill.keywords.slice(0, 4).join(' / ')}</span>
                )}
              </div>
              <div className="ai-skill-actions">
                <button type="button" className="link-button" onClick={() => openEditor(skill)}>
                  {skill.builtin ? '覆盖' : '编辑'}
                </button>
                {!skill.builtin && (
                  <button type="button" className="link-button ai-conn-del" onClick={() => void remove(skill)}>删除</button>
                )}
              </div>
              {expanded === skill.id && <pre className="ai-skill-content">{skill.content}</pre>}
            </li>
          ))}
        </ul>
      )}
      {(creating || editing) ? (
        <SkillForm
          key={editing?.id ?? 'new'}
          skill={editing}
          onCancel={() => { setCreating(false); setEditing(null) }}
          onSaved={() => { setCreating(false); setEditing(null); refresh() }}
        />
      ) : (
        <div className="customize-actions">
          <button type="button" className="ghost-button" onClick={() => openEditor(null)}>新建技能</button>
        </div>
      )}
    </section>
  )
}

function SkillForm({ skill, onCancel, onSaved }: { skill: AgentSkill | null; onCancel: () => void; onSaved: () => void }) {
  const [name, setName] = useState(skill?.name ?? '')
  const [description, setDescription] = useState(skill?.description ?? '')
  const [keywords, setKeywords] = useState((skill?.keywords ?? []).join(','))
  const [content, setContent] = useState(skill?.content ?? '')
  const [enabled, setEnabled] = useState(skill?.enabled ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    if (!name.trim() || !content.trim()) { setError('名称与正文都要填'); return }
    setBusy(true)
    setError('')
    const req: AgentSkillInput = {
      // 覆盖内置技能时带上同 id；新建时不带，由服务端按名称生成。
      id: skill?.id,
      name: name.trim(),
      description: description.trim(),
      keywords: keywords.split(/[,，\s]+/).map(item => item.trim()).filter(Boolean),
      content: content.trim(),
      enabled,
    }
    try {
      await api.saveAgentSkill(req)
      onSaved()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ai-skill-form">
      <h4>{skill ? (skill.builtin ? `覆盖内置技能：${skill.name}` : `编辑技能：${skill.name}`) : '新建技能'}</h4>
      <div className="ai-field-grid">
        <label className="customize-field">
          <span>名称</span>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="如 书源排错" />
        </label>
        <label className="customize-field">
          <span>关键词（逗号分隔，命中才注入）</span>
          <input value={keywords} onChange={e => setKeywords(e.target.value)} placeholder="书源,搜不到,目录为空" />
        </label>
      </div>
      <label className="customize-field">
        <span>说明（一句话）</span>
        <input value={description} onChange={e => setDescription(e.target.value)} placeholder="按「结构 → 搜索 → 目录 → 正文」定位问题" />
      </label>
      <label className="customize-field">
        <span>正文（会作为 system 注入，最多 4000 字）</span>
        <textarea
          rows={6}
          value={content}
          onChange={e => setContent(e.target.value.slice(0, 4000))}
          placeholder="写清先查什么、给什么格式、哪些动作必须先问。"
        />
      </label>
      <label className="ai-check">
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
        <span>启用（停用后不会被关键词命中）</span>
      </label>
      {!!error && <p className="customize-error" role="alert">{error}</p>}
      <div className="customize-actions">
        <button type="button" className="primary-button" onClick={() => void submit()} disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </button>
        <button type="button" className="ghost-button" onClick={onCancel} disabled={busy}>取消</button>
      </div>
    </div>
  )
}

/** 把一条预设原样折成保存请求（同 id 覆盖）；停用与排序都只改其中一个字段。 */
function toPromptInput(preset: AgentPrompt): AgentPromptInput {
  return {
    id: preset.id,
    name: preset.name,
    instruction: preset.instruction,
    enabled: preset.enabled,
    order: preset.order,
  }
}

/**
 * 提示词预设：管「怎么说话」的一段全局 system 说明（语气、字数、格式）。
 *
 * 与上面的技能不是一回事，这里把分工写在提示里，否则用户会把两者当成两个 system 输入框：
 * 预设**对所有对话生效**（开关控制，按顺序注入），技能按关键词命中、一次最多 3 条。
 * 借自 legado-with-MD3 的 `AiPromptPreset`，但落到本地 `agent-prompts.json`，可排序可停用。
 *
 * 列表沿用技能那套紧凑习惯：默认一行，正文点开才展开。
 */
function PromptsSection() {
  const [prompts, setPrompts] = useState<AgentPrompt[]>([])
  const [loadError, setLoadError] = useState('')
  const [expanded, setExpanded] = useState('')
  const [editing, setEditing] = useState<AgentPrompt | null>(null)
  const [creating, setCreating] = useState(false)

  const refresh = () => {
    api.listAgentPrompts()
      .then(result => { setPrompts(result.prompts); setLoadError('') })
      .catch(err => setLoadError(err instanceof Error ? err.message : '读取提示词失败'))
  }
  useEffect(() => { refresh() }, [])

  const remove = async (preset: AgentPrompt) => {
    if (!window.confirm(`删除提示词「${preset.name}」？删除前会把整份 agent-prompts.json 备份到 .trash，可以找回。`)) return
    try {
      await api.deleteAgentPrompt(preset.id)
      if (editing?.id === preset.id) setEditing(null)
      refresh()
    } catch (failure) {
      setLoadError(failure instanceof Error ? failure.message : '删除失败')
    }
  }

  /** 停用/启用：只改 enabled，其余字段原样回存（同 id 覆盖）。 */
  const toggle = async (preset: AgentPrompt) => {
    try {
      await api.saveAgentPrompt({ ...toPromptInput(preset), enabled: !preset.enabled })
      refresh()
    } catch (failure) {
      setLoadError(failure instanceof Error ? failure.message : '切换失败')
    }
  }

  /**
   * 上移/下移：与相邻那条交换 order。
   * 交换而不是重算全部序号：预设最多 30 条，一次只改两条最省请求。
   * 两条 order 相同（列表靠名称决胜）时，给被移动的那条让出一个空位（上移减一、下移加一），
   * 否则换了也看不出来。
   *
   * **必须一条一条发**：服务端这份文件是「读 → 改 → 写」，两条并发请求会各自读到
   * 旧快照再整份写回，后落盘的那条把先落盘的顶掉（实测点一次上移，两条 order 变成同一个数）。
   * 服务端已加写锁兜底，这里仍按顺序发 —— 少一处竞态就少一处要解释的行为。
   */
  const move = async (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= prompts.length) return
    const a = prompts[index]
    const b = prompts[target]
    const orderForA = a.order === b.order ? b.order + delta : b.order
    try {
      await api.saveAgentPrompt({ ...toPromptInput(a), order: orderForA })
      await api.saveAgentPrompt({ ...toPromptInput(b), order: a.order })
      refresh()
    } catch (failure) {
      setLoadError(failure instanceof Error ? failure.message : '调整顺序失败')
      refresh()
    }
  }

  return (
    <section className="ai-section">
      <h3>提示词</h3>
      <p className="ai-section-hint">
        提示词是「怎么说话」：语气、字数、格式这类要求，启用的都会按顺序注入每一次对话。
        与技能不同 —— 技能是「这类任务怎么做」，只在命中关键词时才进来。
        单条最多 2000 字，全部预设每轮合计最多 6000 字，放不下的整条不注入。
      </p>
      {loadError ? (
        <p className="customize-error" role="alert">{loadError}</p>
      ) : (
        <ul className="ai-skill-list">
          {prompts.map((preset, index) => (
            <li key={preset.id} className={`ai-skill-item${expanded === preset.id ? ' expanded' : ''}`}>
              <div className="ai-skill-main">
                <button
                  type="button"
                  className="ai-skill-name"
                  onClick={() => setExpanded(current => (current === preset.id ? '' : preset.id))}
                  title="展开/收起提示词正文"
                >
                  {preset.name}
                </button>
                {!preset.enabled && <span className="ai-tag ai-tag-warn ai-skill-badge">已停用</span>}
                <span className="ai-skill-desc">{preset.instruction}</span>
              </div>
              <div className="ai-skill-actions">
                <button type="button" className="link-button" onClick={() => void toggle(preset)}>
                  {preset.enabled ? '停用' : '启用'}
                </button>
                <button type="button" className="link-button" onClick={() => void move(index, -1)} disabled={index === 0}>
                  上移
                </button>
                <button type="button" className="link-button" onClick={() => void move(index, 1)} disabled={index === prompts.length - 1}>
                  下移
                </button>
                <button type="button" className="link-button" onClick={() => { setEditing(preset); setCreating(false) }}>编辑</button>
                <button type="button" className="link-button ai-conn-del" onClick={() => void remove(preset)}>删除</button>
              </div>
              {expanded === preset.id && <pre className="ai-skill-content">{preset.instruction}</pre>}
            </li>
          ))}
        </ul>
      )}
      {(creating || editing) ? (
        <PromptForm
          key={editing?.id ?? 'new'}
          preset={editing}
          onCancel={() => { setCreating(false); setEditing(null) }}
          onSaved={() => { setCreating(false); setEditing(null); refresh() }}
        />
      ) : (
        <div className="customize-actions">
          <button type="button" className="ghost-button" onClick={() => { setEditing(null); setCreating(true) }}>新建提示词</button>
        </div>
      )}
    </section>
  )
}

function PromptForm({ preset, onCancel, onSaved }: { preset: AgentPrompt | null; onCancel: () => void; onSaved: () => void }) {
  const [name, setName] = useState(preset?.name ?? '')
  const [instruction, setInstruction] = useState(preset?.instruction ?? '')
  const [enabled, setEnabled] = useState(preset?.enabled ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    if (!name.trim() || !instruction.trim()) { setError('名称与正文都要填'); return }
    setBusy(true)
    setError('')
    const req: AgentPromptInput = {
      // 改已有条目时带上 id 覆盖；新建时不带，由服务端按名称生成。
      id: preset?.id,
      name: name.trim(),
      instruction: instruction.trim(),
      enabled,
      // order 只在改已有条目时回传，新建交给服务端排到末尾。
      ...(preset ? { order: preset.order } : {}),
    }
    try {
      await api.saveAgentPrompt(req)
      onSaved()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ai-skill-form">
      <h4>{preset ? `编辑提示词：${preset.name}` : '新建提示词'}</h4>
      <label className="customize-field">
        <span>名称</span>
        <input value={name} onChange={e => setName(e.target.value.slice(0, 60))} placeholder="如 结论先行" />
      </label>
      <label className="customize-field">
        <span>正文（会作为 system 注入，最多 2000 字）</span>
        <textarea
          rows={5}
          value={instruction}
          onChange={e => setInstruction(e.target.value.slice(0, 2000))}
          placeholder="例：先给结论，再给理由；不超过 100 字；不要用列表。"
        />
      </label>
      <label className="ai-check">
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
        <span>启用（停用的预设不注入，但保留在列表里）</span>
      </label>
      {!!error && <p className="customize-error" role="alert">{error}</p>}
      <div className="customize-actions">
        <button type="button" className="primary-button" onClick={() => void submit()} disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </button>
        <button type="button" className="ghost-button" onClick={onCancel} disabled={busy}>取消</button>
      </div>
    </div>
  )
}
