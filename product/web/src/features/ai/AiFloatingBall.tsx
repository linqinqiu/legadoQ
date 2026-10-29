import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api, type AgentChatMessage, type AgentConnection } from '../../lib/api'
import { Icon } from '../../icons'
import { EMPTY_UI_CONTEXT, uiContextMessage, type UiContext } from '../../lib/uiContext'
import { aiToolTitle, loadAiToolGroups, rememberToolIndex, toolRoundGroups } from '../../lib/aiToolGroups'
import { streamAgentChat, type AgentStreamDraft } from './agentStream'
import {
  activeSession,
  appendAiLine,
  clearAiChat,
  DEFAULT_SYSTEM_PROMPT,
  deleteAiSession,
  newAiSession,
  renameAiSession,
  setAiChatOpen,
  setAiSystemPrompt,
  switchAiSession,
  SYSTEM_PROMPT_TEMPLATES,
  toggleAiChat,
  useAiChat,
  type ChatLine,
} from './aiChatStore'

/**
 * 全局 AI 悬浮球 —— 解决用户说的「不能随时随地使用，不能在对应地点研究」。
 *
 * 以前 AI 只能从「设置 → AI 接入」打开一个模态弹窗：人要离开当前正在看的书/书源，
 * 走三层才能问一句话，问完还得再走回来。位置错了，于是"在对应地点研究"做不到。
 *
 * 现在它挂在应用最外层（`main.tsx` 的根节点里），**每个页面都在**：
 * - 右下角一个球，点一下展开成对话面板；再点收起。球可以**拖动**，位置记在本机。
 * - 面板带着当前页面的 `uiContext`（在书源页就带书源、在阅读器就带这本书与章节），
 *   所以「这个源为什么搜不到」「这一章讲了什么」问的就是眼前这个东西。
 * - 对话历史存在 `aiChatStore`（跨页面、跨会话、多会话），关掉再开、换页再回来都不丢。
 *
 * 与「设置 → AI 接入」的关系：那里仍然是**配置**入口（登记外部模型、看书源校验），
 * 这个球是**使用**入口。两边共用同一个 `/api/agent/chat`，不是两套 AI。
 */

const FAB_SIZE = 52
const EDGE = 8
const POS_KEY = 'legado.ai.fab.pos.v1'
const HIDDEN_KEY = 'legado.ai.fab.hidden.v1'

type Pos = { x: number; y: number }

function readPos(): Pos | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(POS_KEY) : null
    if (!raw) return null
    const p = JSON.parse(raw) as Partial<Pos> | null
    if (p && typeof p.x === 'number' && typeof p.y === 'number') return { x: p.x, y: p.y }
  } catch { /* 读不到就用默认位置 */ }
  return null
}

function writePos(p: Pos): void {
  try { localStorage.setItem(POS_KEY, JSON.stringify(p)) } catch { /* 存不下就只在本次生效 */ }
}

function readHidden(): boolean {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(HIDDEN_KEY) === '1' } catch { return false }
}

function writeHidden(hidden: boolean): void {
  try { localStorage.setItem(HIDDEN_KEY, hidden ? '1' : '0') } catch { /* 忽略 */ }
}

/** 夹在视口内，别让球被拖到看不见的地方。 */
function clampPos(p: Pos): Pos {
  if (typeof window === 'undefined') return p
  const maxX = Math.max(EDGE, window.innerWidth - FAB_SIZE - EDGE)
  const maxY = Math.max(EDGE, window.innerHeight - FAB_SIZE - EDGE)
  return { x: Math.min(Math.max(EDGE, p.x), maxX), y: Math.min(Math.max(EDGE, p.y), maxY) }
}

export function AiFloatingBall({ uiContext }: { uiContext?: UiContext }) {
  const chat = useAiChat()
  const [pos, setPos] = useState<Pos | null>(() => {
    const saved = readPos()
    return saved ? clampPos(saved) : null
  })
  const [hidden, setHidden] = useState<boolean>(() => readHidden())
  // 连没连外部模型：决定球上的状态点（灰=未连，绿=已连）。与面板各自取，互不阻塞。
  const [connected, setConnected] = useState(false)
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null)
  const draggedRef = useRef(false)

  useEffect(() => {
    api.listAgentConnections()
      .then(list => setConnected(list.length > 0))
      .catch(() => setConnected(false))
  }, [])
  // 工具 id → 组：气泡里只显示"用了哪些能力"，得先知道每个 id 属于哪一组。
  // 读不到清单就回落成 id 本身，不让气泡空着。
  useEffect(() => {
    api.agentManifest()
      .then(manifest => rememberToolIndex(manifest.tools ?? []))
      .catch(() => undefined)
  }, [])

  // 视口变化时把球拉回来（否则缩放窗口后球可能停在外面）
  useEffect(() => {
    const onResize = () => setPos(p => (p ? clampPos(p) : p))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const hide = useCallback(() => {
    setHidden(true)
    writeHidden(true)
    setAiChatOpen(false)
  }, [])

  const restore = useCallback(() => {
    setHidden(false)
    writeHidden(false)
  }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    dragRef.current = { startX: e.clientX, startY: e.clientY, originX: rect.left, originY: rect.top, moved: false }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.moved && Math.hypot(dx, dy) < 4) return // 手抖不算拖
    d.moved = true
    setPos(clampPos({ x: d.originX + dx, y: d.originY + dy }))
  }

  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    if (d.moved) {
      draggedRef.current = true
      setPos(p => { if (p) writePos(p); return p })
    }
  }

  const onFabClick = () => {
    if (draggedRef.current) { draggedRef.current = false; return }
    toggleAiChat()
  }

  if (hidden) {
    // 完全收起时留一个极小的边缘把手，点一下能回来 —— 否则用户找不到恢复入口。
    return (
      <button
        type="button"
        className="ai-fab-restore"
        onClick={restore}
        aria-label="显示 AI 助手"
        title="显示 AI 助手"
      >
        <Icon name="sparkles" />
      </button>
    )
  }

  const fabStyle: React.CSSProperties | undefined = pos
    ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' }
    : undefined

  return (
    <>
      <button
        type="button"
        className={`ai-fab${chat.open ? ' ai-fab-open' : ''}${connected ? ' ai-fab-connected' : ' ai-fab-offline'}`}
        style={fabStyle}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={onFabClick}
        aria-label={chat.open ? '收起 AI 助手' : '打开 AI 助手'}
        title={chat.open ? '收起 AI 助手' : `打开 AI 助手（任意页面可用）${connected ? '' : ' · 未连接外部模型'}`}
      >
        <Icon name={chat.open ? 'close' : 'sparkles'} />
        <span className={`ai-fab-dot ${connected ? 'on' : 'off'}`} aria-hidden="true" />
      </button>
      {chat.open && <AiFloatingPanel uiContext={uiContext} onHide={hide} fabPos={pos} />}
    </>
  )
}

function AiFloatingPanel({ uiContext, onHide, fabPos }: { uiContext?: UiContext; onHide: () => void; fabPos: Pos | null }) {
  const chat = useAiChat()
  const session = activeSession(chat)
  const [connections, setConnections] = useState<AgentConnection[]>([])
  const [loadError, setLoadError] = useState('')
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  /** 正在流式生成的回答；结束后才写进会话历史。 */
  const [draft, setDraft] = useState<AgentStreamDraft | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const [error, setError] = useState('')
  const [showSystem, setShowSystem] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const external = connections[0]

  useEffect(() => {
    api.listAgentConnections()
      .then(setConnections)
      .catch(err => setLoadError(err instanceof Error ? err.message : '读取连接失败'))
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [session.messages.length, sending])
  // 流式期间每个增量都跟到底：用 auto，平滑滚动在每帧都触发时反而像卡住。
  useEffect(() => {
    if (!draft) return
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [draft?.text, draft?.tools.length])

  // 面板被收起/切页时断开流：服务端会随之中止，不再继续烧模型额度。
  // 已经收到的半句话仍会在 send 的收尾里落库，不算白问。
  useEffect(() => () => abortRef.current?.abort(), [])

  // 展开时把焦点给输入框：随手就能问，不用再点一次
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Esc 收起面板（不关闭整页、不清对话）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAiChatOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const stop = () => abortRef.current?.abort()

  const send = async () => {
    const text = input.trim()
    if (!text || sending || !external) return
    setError('')
    setInput('')
    appendAiLine({ role: 'user', content: text })
    const history: ChatLine[] = [...session.messages, { role: 'user', content: text, at: Date.now() }]

    const payload: AgentChatMessage[] = []
    if (session.systemPrompt.trim()) payload.push({ role: 'system', content: session.systemPrompt.trim() })
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
      const engine = result.engine || undefined
      const toolRounds = result.toolRounds
        ?? (result.tools.length > 0
          ? result.tools.map(tool => `${tool.toolId}:${tool.status === 'error' ? (tool.code ?? 'error') : 'ok'}`)
          : undefined)
      const skillsUsed = result.skills.length > 0 ? result.skills : undefined
      if (result.error) {
        setError(result.error.message)
        appendAiLine({
          role: 'assistant',
          content: content || `（请求失败：${result.error.message}）`,
          engine,
          toolRounds,
          usage: result.usage,
          skillsUsed,
        })
      } else if (result.aborted) {
        appendAiLine({
          role: 'assistant',
          content: content ? `${content}\n\n（已停止）` : '（已停止，未生成内容）',
          engine,
          toolRounds,
          usage: result.usage,
          skillsUsed,
        })
      } else {
        appendAiLine({
          role: 'assistant',
          content,
          engine,
          toolRounds,
          usage: result.usage,
          skillsUsed,
        })
      }
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : '未知错误'
      appendAiLine({ role: 'assistant', content: `（请求失败：${message}）` })
      setError(message)
    } finally {
      abortRef.current = null
      setDraft(null)
      setSending(false)
      inputRef.current?.focus()
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  // 球被拖动过就贴着球开面板；没拖过沿用 CSS 的右下角。
  const panelStyle: React.CSSProperties | undefined = (() => {
    if (!fabPos || typeof window === 'undefined') return undefined
    const vw = window.innerWidth
    const vh = window.innerHeight
    const openRight = fabPos.x + FAB_SIZE / 2 < vw / 2
    const top = Math.max(EDGE, Math.min(fabPos.y - 360, vh - 220))
    return openRight
      ? { left: Math.min(fabPos.x, Math.max(EDGE, vw - 380)), top, right: 'auto', bottom: 'auto' }
      : { right: Math.min(Math.max(EDGE, vw - fabPos.x - FAB_SIZE), Math.max(EDGE, vw - 380)), top, left: 'auto', bottom: 'auto' }
  })()

  return (
    <aside className="ai-fab-panel dialog-shell size-s" style={panelStyle} role="dialog" aria-modal="false" aria-label="AI 助手">
      <header className="ai-fab-head">
        <div className="ai-fab-title">
          <Icon name="sparkles" />
          <span>AI 助手</span>
        </div>
        <div className="ai-fab-actions">
          {session.messages.length > 0 && (
            <button type="button" className="link-button" onClick={clearAiChat} title="清空当前会话（不可恢复）">
              清空
            </button>
          )}
          <button
            type="button"
            className="link-button"
            onClick={() => setShowSystem(v => !v)}
            title="系统提示词（设定助手人设）"
          >
            人设
          </button>
          <button type="button" className="link-button" onClick={onHide} title="隐藏悬浮球（可在边缘把手恢复）">
            隐藏
          </button>
          <button type="button" className="overlay-close" aria-label="收起" onClick={() => setAiChatOpen(false)}>
            <Icon name="close" />
          </button>
        </div>
      </header>

      <SessionTabs />

      <div className="ai-fab-status">
        {loadError ? (
          <span className="ai-tag ai-tag-warn" role="alert">{loadError}</span>
        ) : external ? (
          <span className="ai-tag ai-tag-ok">已连接外部模型{external.name ? `：${external.name}` : ''}</span>
        ) : (
          <span className="ai-tag ai-tag-warn">
            未连接外部模型 —— 去「设置 → AI 接入」登记一个模型连接
          </span>
        )}
        <ContextHint uiContext={uiContext} />
      </div>

      {showSystem && (
        <div className="ai-fab-system-wrap">
          <div className="ai-template-row" role="group" aria-label="系统提示词模板">
            {SYSTEM_PROMPT_TEMPLATES.map(t => (
              <button
                key={t.id}
                type="button"
                className={`ai-template-chip${session.systemPrompt === t.prompt ? ' active' : ''}`}
                onClick={() => setAiSystemPrompt(t.prompt)}
                title={t.prompt}
              >
                {t.name}
              </button>
            ))}
          </div>
          <textarea
            className="ai-fab-system"
            value={session.systemPrompt}
            onChange={e => setAiSystemPrompt(e.target.value)}
            rows={2}
            placeholder={`默认：${DEFAULT_SYSTEM_PROMPT}`}
          />
        </div>
      )}

      <div className="ai-fab-log" ref={scrollRef}>
        {session.messages.length === 0 && (
          <p className="ai-fab-empty">
            {external
              ? '在下面问点什么。助手知道你在哪个页面、在看哪本书。'
              : '先登记一个外部模型才能对话。'}
          </p>
        )}
        {session.messages.map((m, i) => (
          <div key={`${m.at}-${i}`} className={`ai-bubble ai-bubble-${m.role}`}>
            <div className="ai-bubble-role">{m.role === 'user' ? '我' : '助手'}</div>
            <div className="ai-bubble-content">{m.content || '思考中…'}</div>
            {m.role === 'assistant' && m.toolRounds && m.toolRounds.length > 0 && (
              <div className="ai-bubble-tools">
                <span className="ai-bubble-tools-label">用了 {m.toolRounds.length} 次能力</span>
                <ul className="ai-tool-list">
                  {toolRoundGroups(m.toolRounds).map(item => (
                    <li key={item.label} className="ai-tool-item" title={item.ids}>{item.label}</li>
                  ))}
                </ul>
              </div>
            )}
            {m.role === 'assistant' && (m.usage?.totalTokens || (m.skillsUsed && m.skillsUsed.length > 0)) && (
              <div className="ai-bubble-meta">
                {m.usage?.totalTokens ? <span>{m.usage.totalTokens} tokens</span> : null}
                {m.skillsUsed && m.skillsUsed.length > 0 ? <span>技能 {m.skillsUsed.length} 条</span> : null}
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

      {error && <p className="customize-error ai-fab-error" role="alert">{error}</p>}

      <div className="ai-fab-compose">
        <textarea
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder={external ? '问点什么…（Enter 发送，Shift+Enter 换行）' : '未连接外部模型，暂不可用'}
          disabled={!external || sending}
        />
        {sending ? (
          <button type="button" className="ghost-button" onClick={stop} title="停止生成，已生成的部分会保留">
            停止
          </button>
        ) : (
          <button type="button" className="primary-button" onClick={() => void send()} disabled={!external || !input.trim()}>
            发送
          </button>
        )}
      </div>
    </aside>
  )
}

/** 多会话标签：切换 / 新建 / 删除当前。 */
function SessionTabs() {
  const chat = useAiChat()
  return (
    <div className="ai-session-tabs" role="tablist" aria-label="对话会话">
      {chat.sessions.map(s => (
        <div
          key={s.id}
          className={`ai-session-tab${s.id === chat.activeSessionId ? ' active' : ''}`}
          role="tab"
          aria-selected={s.id === chat.activeSessionId}
          title={s.title}
        >
          <button
            type="button"
            className="ai-session-tab-label"
            onClick={() => switchAiSession(s.id)}
            onDoubleClick={() => {
              const next = window.prompt('重命名会话', s.title)
              if (next) renameAiSession(s.id, next)
            }}
          >
            {s.title}
          </button>
          {chat.sessions.length > 1 && s.id === chat.activeSessionId && (
            <button
              type="button"
              className="ai-session-tab-close"
              aria-label="删除这个会话"
              title="删除这个会话"
              onClick={() => deleteAiSession(s.id)}
            >
              <Icon name="close" />
            </button>
          )}
        </div>
      ))}
      <button type="button" className="ai-session-add" onClick={() => newAiSession()} title="新建会话" aria-label="新建会话">
        <Icon name="plus" />
      </button>
    </div>
  )
}

/** 让用户看见"助手现在知道什么"——否则上下文记忆是隐形的，出问题也没法判断。 */
function ContextHint({ uiContext }: { uiContext?: UiContext }) {
  const ctx = uiContext ?? EMPTY_UI_CONTEXT
  if (!ctx.book && !ctx.source && !ctx.selection && ctx.page === 'unknown') return null
  const parts: string[] = []
  if (ctx.book) parts.push(`《${ctx.book.name}》第 ${ctx.book.chapterIndex + 1} 章`)
  // 书源只在**书源页**算"正在看"：`selected` 是跨页面保留的状态，
  // 切到订阅/书架页还显示"正在看书源「x」"会让人以为助手盯错了地方。
  if (ctx.source && ctx.page === 'sources') parts.push(`书源「${ctx.source.name}」`)
  // 选中的那一段：这是"在对应地点研究"的关键 —— 助手看得见用户正盯着哪句话。
  if (ctx.selection) parts.push(`选中的 ${ctx.selection.text.length} 字`)
  if (parts.length === 0) return null
  const title = ctx.selection
    ? `这些信息会随你的问题一起发给模型。\n\n选中的原文：\n${ctx.selection.text}`
    : '这些信息会随你的问题一起发给模型'
  return <span className="ai-fab-ctx" title={title}>正在看：{parts.join(' · ')}</span>
}
