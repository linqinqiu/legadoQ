import React, { useEffect, useRef, useState } from 'react'
import { api, type AgentChatMessage } from '../../lib/api'
import { EMPTY_UI_CONTEXT, uiContextMessage, type UiContext } from '../../lib/uiContext'
import { loadAiToolPrefs, toolRoundGroups, aiToolTitle } from '../../lib/aiToolGroups'
import { activeSession, setAiSystemPrompt, useAiChat } from '../../lib/aiChatStore'
import { streamAgentChat, type AgentStreamDraft } from './agentStream'
import { AiPanel } from './AiPanel'

/**
 * 「AI 对话助手」浮层：说话 → 模型带着工具去查去改 → 回答。
 *
 * 它只负责**用**。配哪模型、给哪组能力、注入哪些技能与提示词，各自在设置「服务与接入」
 * 里的独立入口（那里内容长，混进这一档就又是一屏滚不到底）。没有模型连接时输入框禁用，
 * 并给一颗直接去登记的按钮 —— 不写"请去设置里找一找"这种让人自己摸的话。
 *
 * 对话不落库：历史只存在这台浏览器里（`aiChatStore`），发出去的内容不写进数据库。
 */
export function AiChatModal({
  onClose,
  uiContext,
  onOpenConnections,
}: {
  onClose: () => void
  uiContext?: UiContext
  /** 去「模型连接」那一档；由宿主决定是换浮层还是新窗口。 */
  onOpenConnections?: () => void
}) {
  return (
    <AiPanel title="AI 对话助手" icon="sparkles" onClose={onClose}>
      <ChatPanel uiContext={uiContext} onOpenConnections={onOpenConnections} />
    </AiPanel>
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

function ChatPanel({
  uiContext,
  onOpenConnections,
}: {
  uiContext?: UiContext
  onOpenConnections?: () => void
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

  /** 生效中的那条连接（与「模型连接」那一档同一条判据：标了「默认」优先，否则第一条）。 */
  const [activeName, setActiveName] = useState<string | undefined>()
  const externalConnected = !!activeName

  useEffect(() => {
    let alive = true
    api.listAgentConnections()
      .then(list => {
        if (!alive) return
        const active = list.find(c => c.options?.default === '1' || c.options?.default === 'true') ?? list[0]
        setActiveName(active?.name)
      })
      .catch(() => { if (alive) setActiveName(undefined) })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])
  useEffect(() => {
    if (!draft) return
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [draft?.text, draft?.tools.length])
  useEffect(() => () => abortRef.current?.abort(), [])

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
      const prefs = loadAiToolPrefs()
      const result = await streamAgentChat(payload, {
        toolGroups: prefs.groups,
        disabledTools: prefs.disabledTools,
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
            <span className="ai-tag">正在使用：{activeName}</span>
            {onOpenConnections && (
              <button type="button" className="link-button" onClick={onOpenConnections}>换一条 / 看状态</button>
            )}
          </>
        ) : (
          <>
            <span className="ai-tag ai-tag-warn">还没有模型连接，AI 不可用</span>
            {onOpenConnections && (
              <button type="button" className="link-button" onClick={onOpenConnections}>去登记模型连接</button>
            )}
          </>
        )}
      </div>

      <details className="ai-chat-system">
        <summary>助手人设（可选）</summary>
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
            {externalConnected ? '在下面输入消息开始对话。' : '先登记一个模型连接，才能对话。'}
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
          placeholder={externalConnected ? '输入消息，Enter 发送，Shift+Enter 换行' : '先登记模型连接'}
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
        对话内容只发给模型，不存进本机；生成中随时可以停止，已生成的部分会留下。
      </p>
    </section>
  )
}
