/**
 * AI 对话的全局状态 —— **跨页面、跨会话、多会话**保留。
 *
 * 用户原话：「ai 功能太差，1 是位置问题，不能随时随地使用，不能在对应地点研究，
 * 没有上下文记忆」。这一层解决后两个：
 *
 * - **跨页面**：对话不再活在某个弹窗组件的 `useState` 里 —— 悬浮球在任意页面都能开，
 *   关掉再开、切到别的页再切回来，说的话都还在。
 * - **跨会话**：落 localStorage，刷新页面/重开浏览器仍在（用户不用每次重新交代背景）。
 * - **多会话**：可以同时开几个对话（"这本小说" / "书源调试" / "代码问题"），各自独立，
 *   顶部标签切换。以前只有一个 messages 数组，问完书源再问小说会串在一起。
 *
 * 和 `uiContext` 的分工：uiContext 说的是「用户此刻在哪个界面、在看什么」，每轮随请求发；
 * 这里说的是「我们之前聊过什么」，是对话本身的历史。两者互不替代。
 */
import { useSyncExternalStore } from 'react'

export type ChatRole = 'user' | 'assistant'

export type ChatLine = {
  role: ChatRole
  content: string
  /** 这一轮实际用到的外部模型（`external:<id>`）；错误轮为空 */
  engine?: string
  /** 这一轮 AI 实际执行过的工具（`工具id:结果码`） */
  toolRounds?: string[]
  /** 上游报告的 token 用量（多轮累加） */
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
  /** 这一轮实际注入的技能 id */
  skillsUsed?: string[]
  /** 这条消息产生的时间戳，用于显示与清理 */
  at: number
}

/** 一个独立对话。多会话各自持有自己的消息与人设，互不干扰。 */
export type ChatSession = {
  id: string
  /** 标签页上显示的名字；第一条用户消息自动命名，可手动改 */
  title: string
  messages: ChatLine[]
  /** 这个会话的人设/系统提示词 */
  systemPrompt: string
  createdAt: number
  updatedAt: number
}

export type AiChatState = {
  /** 悬浮球是否展开成对话面板 */
  open: boolean
  sessions: ChatSession[]
  /** 当前显示/发送的会话 */
  activeSessionId: string
}

export type SystemPromptTemplate = {
  id: string
  name: string
  prompt: string
}

const STORAGE_KEY = 'legado.ai.chat.v2'
/** 上一版的单会话格式，读到时迁移成一条会话，别把老对话丢了。 */
const LEGACY_KEY = 'legado.ai.chat.v1'
/** 只保留最近这么多条，避免 localStorage 无限膨胀（一对问答 = 2 条）。 */
const MAX_LINES = 200
/** 会话数量上限：太多标签页也点不过来，还挤占存储。 */
const MAX_SESSIONS = 20

export const DEFAULT_SYSTEM_PROMPT = '你是 legadoQ 的阅读助手，帮助用户理解文章、管理书源、解答阅读相关的问题。'

/**
 * 系统提示词模板：用户点一下就把人设换成对应方向，不用每次手打。
 * 与"书源调试""代码解释"这些真实使用场景对应，不是凑数。
 */
export const SYSTEM_PROMPT_TEMPLATES: SystemPromptTemplate[] = [
  {
    id: 'general',
    name: '通用助手',
    prompt: DEFAULT_SYSTEM_PROMPT,
  },
  {
    id: 'novel',
    name: '小说助手',
    prompt: '你是小说阅读助手。用户会问剧情、人物、伏笔与章节内容。回答要贴着原文，不要编造没读到的情节；不确定时直接说不确定。',
  },
  {
    id: 'source-debug',
    name: '书源调试',
    prompt: '你是书源调试助手，熟悉 legadoQ/legado 书源规则（搜索、发现、详情、目录、正文的 CSS/XPath/JSONPath 规则与 JS 变量）。帮用户定位"搜不到、目录空、正文错"的原因，给出可粘贴的规则片段。',
  },
  {
    id: 'code',
    name: '代码解释',
    prompt: '你是代码解释助手。用户贴代码或描述报错时，先讲清根因，再给最小改法；不要泛泛而谈，不要重写无关部分。',
  },
]

function newId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function newSession(systemPrompt: string = DEFAULT_SYSTEM_PROMPT): ChatSession {
  const now = Date.now()
  return { id: newId(), title: '新对话', messages: [], systemPrompt, createdAt: now, updatedAt: now }
}

function sanitizeMessages(raw: unknown): ChatLine[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_LINES)
    .map(m => ({
      ...m,
      at: typeof m.at === 'number' ? m.at : Date.now(),
    }))
}

function sanitizeSession(raw: unknown): ChatSession | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<ChatSession>
  if (typeof r.id !== 'string' || !r.id) return null
  const now = Date.now()
  return {
    id: r.id,
    title: typeof r.title === 'string' && r.title.trim() ? r.title : '新对话',
    messages: sanitizeMessages(r.messages),
    systemPrompt:
      typeof r.systemPrompt === 'string' && r.systemPrompt.trim() ? r.systemPrompt : DEFAULT_SYSTEM_PROMPT,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : now,
  }
}

function fallbackState(): AiChatState {
  const first = newSession()
  return { open: false, sessions: [first], activeSessionId: first.id }
}

function titleFromMessages(messages: ChatLine[]): string {
  const firstUser = messages.find(m => m.role === 'user' && m.content.trim())
  if (!firstUser) return '新对话'
  const text = firstUser.content.trim().replace(/\s+/g, ' ')
  return text.length > 16 ? `${text.slice(0, 16)}…` : text
}

function readStorage(): AiChatState {
  try {
    if (typeof localStorage === 'undefined') return fallbackState()

    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AiChatState> | null
      if (parsed && Array.isArray(parsed.sessions)) {
        const sessions = parsed.sessions
          .map(sanitizeSession)
          .filter((s): s is ChatSession => s !== null)
          .slice(-MAX_SESSIONS)
        if (sessions.length > 0) {
          const activeSessionId =
            typeof parsed.activeSessionId === 'string' && sessions.some(s => s.id === parsed.activeSessionId)
              ? parsed.activeSessionId
              : sessions[sessions.length - 1].id
          // `open` 不持久化：刷新后不该自动弹出一个面板挡住用户
          return { open: false, sessions, activeSessionId }
        }
      }
      return fallbackState()
    }

    // 迁移上一版单会话格式：把老对话装进一条会话，不丢历史。
    const legacyRaw = localStorage.getItem(LEGACY_KEY)
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw) as { messages?: unknown; systemPrompt?: unknown } | null
      const messages = sanitizeMessages(legacy?.messages)
      const systemPrompt =
        typeof legacy?.systemPrompt === 'string' && legacy.systemPrompt.trim()
          ? legacy.systemPrompt
          : DEFAULT_SYSTEM_PROMPT
      const session = newSession(systemPrompt)
      session.messages = messages
      session.title = titleFromMessages(messages)
      return { open: false, sessions: [session], activeSessionId: session.id }
    }

    return fallbackState()
  } catch {
    return fallbackState()
  }
}

let state: AiChatState = readStorage()
const listeners = new Set<() => void>()

function persist(): void {
  try {
    if (typeof localStorage === 'undefined') return
    // 只存需要跨会话的部分；`open` 是瞬时 UI 状态，存了会让刷新后莫名其妙弹面板。
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      sessions: state.sessions.map(s => ({ ...s, messages: s.messages.slice(-MAX_LINES) })),
      activeSessionId: state.activeSessionId,
    }))
  } catch {
    // 存不下（隐私模式/超额）就丢：对话还在内存里，只是下次打开接不上
  }
}

function replace(next: AiChatState): void {
  state = next
  listeners.forEach(fn => fn())
}

function update(patch: Partial<AiChatState>): void {
  replace({ ...state, ...patch })
}

export function getAiChat(): AiChatState {
  return state
}

/** 当前会话；理论上永远存在（readStorage 保证至少一条），兜底再建一条。 */
export function activeSession(s: AiChatState = state): ChatSession {
  return s.sessions.find(x => x.id === s.activeSessionId) ?? s.sessions[s.sessions.length - 1] ?? newSession()
}

export function subscribeAiChat(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * 别的标签页改了对话时同步过来。
 *
 * 不加这个的话：在 A 标签页聊了半天，B 标签页（或另一个窗口）永远停在打开时读到的旧快照，
 * 而且它下一次写盘会把 A 的内容整份盖掉。`storage` 事件只在**其它**文档写入时触发，
 * 自己写不会回环，正好用来做单向同步。
 */
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY) return
    // 保留本页的 open（那是瞬时 UI 状态，不该被别的标签页带着走）
    const incoming = readStorage()
    replace({ ...incoming, open: state.open })
  })
}

export function useAiChat(): AiChatState {
  return useSyncExternalStore(subscribeAiChat, getAiChat, getAiChat)
}

/** 展开/收起对话面板。收起不丢对话。 */
export function setAiChatOpen(open: boolean): void {
  update({ open })
}

export function toggleAiChat(): void {
  update({ open: !state.open })
}

/** 用当前会话替换后的整体状态。 */
function withActiveSession(next: ChatSession): AiChatState {
  return {
    ...state,
    sessions: state.sessions.map(s => (s.id === next.id ? next : s)),
  }
}

/** 追加一条消息（用户提问或助手回答）到当前会话。 */
export function appendAiLine(line: Omit<ChatLine, 'at'> & { at?: number }): void {
  const session = activeSession()
  const nextMessages = [...session.messages, { ...line, at: line.at ?? Date.now() }].slice(-MAX_LINES)
  const next: ChatSession = {
    ...session,
    messages: nextMessages,
    // 第一条用户消息自动给会话命名，省得一堆「新对话」分不清
    title: session.title === '新对话' && line.role === 'user' ? titleFromMessages(nextMessages) : session.title,
    updatedAt: Date.now(),
  }
  replace(withActiveSession(next))
  persist()
}

/**
 * 把"正在思考"的占位气泡换成真正的回答。
 * 用 `pendingIndex` 定位而不是"找最后一条 assistant"—— 并发/重试时后者会换错气泡。
 */
export function resolvePendingAiLine(
  pendingIndex: number,
  line: Omit<ChatLine, 'at'> & { at?: number },
): void {
  const session = activeSession()
  const nextMessages = [...session.messages]
  if (pendingIndex < 0 || pendingIndex >= nextMessages.length) return
  nextMessages[pendingIndex] = { ...line, at: line.at ?? Date.now() }
  replace(withActiveSession({ ...session, messages: nextMessages, updatedAt: Date.now() }))
  persist()
}

export function setAiSystemPrompt(systemPrompt: string): void {
  const session = activeSession()
  replace(withActiveSession({ ...session, systemPrompt, updatedAt: Date.now() }))
  persist()
}

export function clearAiChat(): void {
  const session = activeSession()
  replace(withActiveSession({ ...session, messages: [], title: '新对话', updatedAt: Date.now() }))
  persist()
}

/** 新建一个空会话并切过去（超过上限就丢掉最旧且非当前的）。 */
export function newAiSession(): void {
  const session = newSession()
  let sessions = [...state.sessions, session]
  if (sessions.length > MAX_SESSIONS) {
    sessions = sessions
      .filter(s => s.id !== state.activeSessionId)
      .slice(-(MAX_SESSIONS - 1))
      .concat(session)
  }
  replace({ ...state, sessions, activeSessionId: session.id })
  persist()
}

export function switchAiSession(id: string): void {
  if (!state.sessions.some(s => s.id === id)) return
  replace({ ...state, activeSessionId: id })
  persist()
}

/** 删除会话；删掉当前会话就切到剩下的最后一条，删光了自动补一条空会话。 */
export function deleteAiSession(id: string): void {
  const remaining = state.sessions.filter(s => s.id !== id)
  if (remaining.length === 0) {
    const fresh = newSession()
    replace({ ...state, sessions: [fresh], activeSessionId: fresh.id })
  } else {
    const activeSessionId =
      state.activeSessionId === id ? remaining[remaining.length - 1].id : state.activeSessionId
    replace({ ...state, sessions: remaining, activeSessionId })
  }
  persist()
}

export function renameAiSession(id: string, title: string): void {
  const clean = title.trim().slice(0, 24)
  if (!clean) return
  replace({
    ...state,
    sessions: state.sessions.map(s => (s.id === id ? { ...s, title: clean, updatedAt: Date.now() } : s)),
  })
  persist()
}
