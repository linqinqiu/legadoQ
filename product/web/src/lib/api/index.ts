/** API 客户端统一出口。按域拆分，每个 domain 对应一组后端端点。
 *
 * 导出形状是**扁平按域**（不是嵌套对象）：
 *   sources / cookies / sourceLogin / sourceBrowser / externalLogin / explore / subscriptions
 *   search / book / bookSearch / rss
 *   bookshelf / bookshelfGroups / progress / readingLog / notes / cache / tocRules /
 *   localBooks / cover / bookImage / bookMedia / replaceRules / tts
 *   backup
 *   connections / models / agentSources / comprehend / chat / chatStream / skills / prompts / taskModels / mcp
 *   brand / system
 *
 * 文件末尾另组装旧 `api` 对象形状（兼容层）：旧调用点经 `lib/api.ts` 别名拿到它，
 * 新代码请直接用上面的按域导出。所有类型定义见 ./types.ts；基础 fetch 客户端见 ./client.ts。
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

/** 旧 `api` 对象形状（兼容层，@deprecated）：把按域导出重新组合成历史调用点熟悉的扁平键名。
 * 新代码请用上面的按域导出（sources.list / search.run / ...），不要再往这里加键。
 * `lib/api.ts` 只是本文件的别名（TypeScript 文件优先于同名目录），旧 import 路径因此不用改。
 */
export const api = {
  // sources
  sources: sources.list,
  source: sources.get,
  save: sources.save,
  remove: sources.remove,
  batchSources: sources.batch,
  healthCheckSources: sources.healthCheck,
  reorderSources: sources.reorder,
  clearSourceOrder: sources.clearOrder,
  exportSources: sources.export,
  import: sources.import,
  validate: sources.validate,
  debugStreamUrl: sources.debugStreamUrl,
  // cookies
  cookies: cookies.list,
  detail: cookies.detail,
  removeCookie: cookies.remove,
  writeCookie: cookies.write,
  // sourceLogin
  getSourceLoginUi: sourceLogin.getUi,
  saveSourceLoginInfo: sourceLogin.saveInfo,
  clearSourceLoginInfo: sourceLogin.removeInfo,
  saveSourceLoginHeader: sourceLogin.saveHeader,
  clearSourceLoginHeader: sourceLogin.removeHeader,
  saveSourceCookie: sourceLogin.saveCookie,
  renderSourceLoginUi: sourceLogin.renderUi,
  executeSourceLoginUiAction: sourceLogin.executeUiAction,
  executeSourceLoginAction: sourceLogin.executeAction,
  checkSourceLogin: sourceLogin.check,
  sourceCredential: sourceLogin.credential,
  // sourceBrowser
  createSourceBrowserSession: sourceBrowser.createSession,
  closeSourceBrowserSession: sourceBrowser.closeSession,
  sourceBrowserCookies: sourceBrowser.cookies,
  removeSourceCookie: sourceBrowser.removeCookie,
  sourceBrowserPageUrl: sourceBrowser.pageUrl,
  registerSourceBrowserInline: sourceBrowser.registerInline,
  sourceBrowserInlineUrl: sourceBrowser.inlineUrl,
  // externalLogin
  externalLoginStart: externalLogin.start,
  externalLoginStatus: externalLogin.status,
  externalLoginCapture: externalLogin.capture,
  externalLoginStop: externalLogin.stop,
  // explore (from sources)
  exploreSources: sourcesExplore.listSources,
  exploreTabs: sourcesExplore.tabs,
  explore: sourcesExplore.run,
  // search
  search: search.run,
  streamSearch,
  // book
  details: book.details,
  chapters: book.chapters,
  content: book.content,
  refreshChapters: book.refreshChapters,
  bookSearch: bookSearch.run,
  // rss
  rssSources: rss.list,
  addRssSources: rss.add,
  setRssSourceEnabled: rss.setEnabled,
  removeRssSource: rss.remove,
  rssTabs: rss.tabs,
  rssArticles: rss.articles,
  rssContent: rss.content,
  // bookshelf
  bookshelf: bookshelf.list,
  addToBookshelf: bookshelf.add,
  removeFromBookshelf: bookshelf.remove,
  batchDeleteBooks: bookshelf.batchDelete,
  batchMoveToGroup: bookshelf.batchMoveToGroup,
  batchMarkAsRead: bookshelf.batchMarkAsRead,
  cacheBookshelfBook: cache.book,
  cacheBookshelfRange: cache.range,
  getCachedChapters: cache.getCachedChapters,
  clearBookCacheData: cache.clearData,
  cancelBookCache: cache.cancel,
  setBookshelfCompleted: bookshelf.setCompleted,
  updateBookshelfInfo: bookshelf.updateInfo,
  switchBookshelfSource: bookshelf.switchSource,
  // bookshelf groups
  createShelfGroup: bookshelfGroups.create,
  removeShelfGroup: bookshelfGroups.remove,
  setBookGroup: bookshelfGroups.setBookGroup,
  // local books
  importLocalBooks: localBooks.import,
  // toc rules
  tocRules: tocRules.list,
  applyTocRulesFromBackup: tocRules.applyBackup,
  resetTocRules: tocRules.reset,
  toggleTocRule: tocRules.toggle,
  saveTocRule: tocRules.save,
  deleteTocRule: tocRules.delete,
  reparseLocalBook: tocRules.reparse,
  // cover
  cover: cover.key,
  coverProxy: cover.proxy,
  refreshBookImage: cover.refresh,
  // book image / media
  bookImage: bookImage.url,
  refreshBookImageAlias: cover.refresh,
  bookMedia: bookMedia.url,
  // backup
  importBackupFile: backup.importFile,
  keptBackupEntries: backup.listKeptEntries,
  keptBackupEntryUrl: backup.keptEntryUrl,
  keptBackupEntry: backup.keptEntry,
  backupSnapshots: backup.listSnapshots,
  restoreBackupSnapshot: backup.restoreSnapshot,
  // replace rules
  getReplaceRules: replaceRules.list,
  getReplaceRule: replaceRules.get,
  createReplaceRule: replaceRules.create,
  updateReplaceRule: replaceRules.update,
  deleteReplaceRule: replaceRules.remove,
  deleteReplaceRulesBatch: replaceRules.removeBatch,
  toggleReplaceRules: replaceRules.toggle,
  importReplaceRulesText: replaceRules.importText,
  importReplaceRulesUrl: replaceRules.importUrl,
  previewReplaceRule: replaceRules.preview,
  // tts
  getTtsVoices: tts.voices,
  createTtsSession: tts.createSession,
  appendTtsSessionChunk: tts.appendChunk,
  controlTtsSession: tts.control,
  deleteTtsSession: tts.delete,
  fetchTtsAudioBlob: tts.speak,
  // agent
  agentManifest: connections.manifest,
  listAgentConnections: connections.list,
  registerAgentConnection: connections.register,
  deleteAgentConnection: connections.delete,
  validateAgentSource: agentSources.validate,
  createAgentSource: agentSources.create,
  agentComprehend: comprehend,
  agentChat: chat,
  agentChatStream: chatStream,
  listAgentModels: models.list,
  listAgentSkills: skills.list,
  saveAgentSkill: skills.save,
  deleteAgentSkill: skills.delete,
  listAgentPrompts: prompts.list,
  saveAgentPrompt: prompts.save,
  deleteAgentPrompt: prompts.delete,
  listAgentTaskModels: taskModels.list,
  saveAgentTaskModel: taskModels.save,
  listAgentMcp: mcp.list,
  saveAgentMcp: mcp.save,
  refreshAgentMcp: mcp.refresh,
  deleteAgentMcp: mcp.delete,
  // system
  logs: system.logs,
  clearLogs: system.clearLogs,
  diagnostics: system.diagnostics,
  about: system.about,
  checkUpdate: system.checkUpdate,
  changelog: system.changelog,
  serverInfo: system.info,
  setServerPort: system.setPort,
  // 书源订阅
  subscriptions: subscriptions.list,
  saveSubscription: subscriptions.save,
  removeSubscription: subscriptions.remove,
  updateSubscription: subscriptions.update,
  updateSubscriptions: subscriptions.updateAll,
  // 书架分组 / 阅读进度 / 阅读记录 / 笔记
  shelfGroups: bookshelfGroups.list,
  progress: progress.get,
  saveProgress: progress.save,
  readingLog: readingLog.list,
  addReadingLog: readingLog.add,
  notes: notes.list,
  addNote: notes.add,
  updateNote: notes.update,
  deleteNote: notes.remove,
  // 品牌（站点名 / 图标 / 主题色）
  brand: brand.get,
  setBrand: brand.set,
  resetBrand: brand.reset,
  uploadBrandIcon: brand.uploadIcon,
  clearBrandIcon: brand.clearIcon,
}
