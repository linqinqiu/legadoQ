/** API 客户端统一出口。按域拆分，每个 domain 对应一组后端端点。
 *
 * 结构：
 *   api.sources.*        书源、Cookie、登录、内置浏览器、发现页
 *   api.search.*         搜索、书籍详情、目录、正文、RSS
 *   api.reader.*         阅读器、书架、笔记、缓存、分章规则、封面、替换规则、TTS
 *   api.backup.*         备份包导入与 kept 条目
 *   api.agent.*          AI 自定义接入：连接、模型、书源、对话、技能、提示词
 *   api.system.*         目录、服务自身、日志、诊断、关于、更新日志
 *
 * 所有类型定义见 ./types.ts；基础 fetch 客户端见 ./client.ts。
 */

import { request } from './client'
import { sources } from './domains/sources'
import { cookies } from './domains/sources'
import { sourceLogin } from './domains/sources'
import { sourceBrowser } from './domains/sources'
import { externalLogin } from './domains/sources'
import { explore as sourcesExplore } from './domains/sources'
import { subscriptions } from './domains/sources'

import { search } from './domains/search'
import { book } from './domains/search'
import { bookSearch } from './domains/search'
import { rss } from './domains/search'

import { bookshelf } from './domains/reader'
import { bookshelfGroups } from './domains/reader'
import { progress } from './domains/reader'
import { readingLog } from './domains/reader'
import { notes } from './domains/reader'
import { cache } from './domains/reader'
import { tocRules } from './domains/reader'
import { localBooks } from './domains/reader'
import { cover } from './domains/reader'
import { bookImage } from './domains/reader'
import { bookMedia } from './domains/reader'
import { replaceRules } from './domains/reader'
import { tts } from './domains/reader'

import { backup } from './domains/backup'

import { connections } from './domains/agent'
import { models } from './domains/agent'
import { agentSources } from './domains/agent'
import { comprehend } from './domains/agent'
import { chat } from './domains/agent'
import { chatStream } from './domains/agent'
import { skills } from './domains/agent'
import { prompts } from './domains/agent'
import { taskModels } from './domains/agent'
import { mcp } from './domains/agent'

import { brand } from './domains/brand'
import { system } from './domains/system'

import type { SearchStreamEvent } from './types'

export { request }
export * from './types'

export {
  sources,
  cookies,
  sourceLogin,
  sourceBrowser,
  externalLogin,
  sourcesExplore as explore,
  subscriptions,
  search,
  book,
  bookSearch,
  rss,
  bookshelf,
  bookshelfGroups,
  progress,
  readingLog,
  notes,
  cache,
  tocRules,
  localBooks,
  cover,
  bookImage,
  bookMedia,
  replaceRules,
  tts,
  backup,
  connections,
  models,
  agentSources,
  comprehend,
  chat,
  chatStream,
  skills,
  prompts,
  taskModels,
  mcp,
  brand,
  system,
}

/** 流式搜索：WebSocket 推事件。保持旧签名（keyword, sourceIds, onEvent, onError, onClose）。
 *
 * 放在 API 层而不是页面里：搜索页、书源详情、AI 检索三个入口用的是同一条流，
 * 各写一份 socket 生命周期迟早会有一处忘记 close。
 */
export function streamSearch(
  keyword: string,
  sourceIds: string[] | undefined,
  onEvent: (event: SearchStreamEvent) => void,
  onError: (message: string) => void,
  onClose: () => void,
): WebSocket {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(`${protocol}//${location.host}/api/search/stream`)
  let reported = false
  socket.addEventListener('open', () =>
    queueMicrotask(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ keyword, sourceIds }))
    }),
  )
  socket.addEventListener('message', (event) => {
    try {
      onEvent(JSON.parse(event.data) as SearchStreamEvent)
    } catch {
      reported = true
      onError('搜索响应格式无效')
    }
  })
  socket.addEventListener('error', () => {
    if (!reported) {
      reported = true
      onError('搜索连接中断，请重试')
    }
  })
  socket.addEventListener('close', () => {
    if (!reported) onClose()
  })
  return socket
}
