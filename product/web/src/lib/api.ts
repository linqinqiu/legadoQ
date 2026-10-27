import {
  putOfflineChapter,
  getOfflineChapter,
  saveShelfSnapshot,
  getShelfSnapshot,
  enqueueOfflineProgress,
  flushOfflineProgress,
} from './offlineStorage'

export type SourceSummary = { id: string; name: string; url: string; group?: string; enabled: boolean; isJsSource: boolean; hasLogin: boolean; updatedAt: number; version: number; /** 自定义排序位；null = 没拖过，按名称排在有序段之后 */ sortOrder?: number | null }
export type SourceRecord = { id: string; json: string; version: number; updatedAt: number }
export type AboutInfo = { title: string; version: string; repository: string }
/** 服务自身：这次运行实际绑在哪（改 port.txt 不会让它变，要重启）。 */
export type ServerInfo = { host: string; port: number }
export type ServerPortResult = { port: number; restartRequired: boolean }

/**
 * 自定义品牌（用户 2026-10-23：「允许自定义图标和名称」）。
 * `displayName` 是服务端算好的实际显示名（没设过就等于内置的「legadoQ」），
 * `builtinName` 一起回，界面才能区分"这是默认"与"这是你改过的"。
 */
export type BrandInfo = {
  name: string
  displayName: string
  shortName: string
  themeColor: string
  hasIcon: boolean
  iconUrl?: string
  builtinName: string
}
export type UpdateCheckResult = {
  current: string
  /** 版本号发布里最高的一个标签（形如 `v0.6.26`），没有版本号发布时为 null。 */
  latest?: string | null
  url?: string | null
  publishedAt?: string | null
  repository: string
  status: 'latest' | 'available' | 'not_found' | 'unreachable' | 'not_configured' | string
  message?: string | null
  /** CI 的滚动构建（标签不是版本号，如 `latest`）：只报发布时间与链接，不判新旧。 */
  rollingTag?: string | null
  rollingUrl?: string | null
  rollingPublishedAt?: string | null
}
export type SearchResult = { sourceId: string; name: string; author?: string; bookUrl: string; coverUrl?: string; intro?: string; kind?: string; wordCount?: string; lastChapter?: string; /** 书源 bookSourceType：0 文本 / 1 音频 / 2 漫画 / 3 文件 / 4 视频 */ sourceType?: number }
export type ExploreTab = { title: string; url: string; /** 服务端按规则写法判出来的"这一栏吃不吃页码"；缺省按支持（旧数据/别的入口没带这个字段） */ supportsPaging?: boolean }
export type BookDetails = { sourceId: string; name: string; author?: string; intro?: string; coverUrl?: string; tocUrl: string; kind?: string; wordCount?: string; lastChapter?: string; alternateSources?: SearchResult[]; /** 书源 bookSourceType：0 文本 / 1 音频 / 2 漫画 / 3 文件 / 4 视频 */ sourceType?: number; /** 书源 ruleContent.imageStyle：FULL 表示正文图片铺满阅读区 */ imageStyle?: string | null }
export type Chapter = { index: number; title: string; url: string; isVolume?: boolean }
export type ReadingProgress = {
  sourceId: string; bookUrl: string; chapterUrl: string; chapterIndex: number; scrollPosition: number; updatedAt: number
  /** 逻辑位置模型（P1-T1）：章节内绝对字符偏移；老客户端不报时为 undefined。 */
  charOffset?: number
  /** 段落锚点：重排后辅助回退。可空。 */
  paragraphAnchor?: string | null
  /** 逻辑位置编码版本。 */
  positionVersion?: number
  /** 保存时刻章节内容校验值。 */
  positionChecksum?: string | null
}
/** 阅读记录（PROPOSAL-019 D）：粒度「一天 · 一本书」一行，秒数只累加。`day` 是本地日 YYYY-MM-DD。 */
export type ReadingLogEntry = { day: string; sourceId: string; bookUrl: string; bookName: string; chapterIndex: number; seconds: number; updatedAt: number }
/** 笔记 / 划线 / 书签（PROPOSAL-019 E）。偏移是**章节内字符偏移**，不是像素 / 列号。`bookmark` 为真表示只标位置不写想法。 */
export type BookNote = { id: number; sourceId: string; bookUrl: string; bookName: string; chapterUrl: string; chapterIndex: number; startOffset: number; endOffset: number; excerpt: string; note: string; createdAt: number; updatedAt: number; bookmark?: boolean; paragraphAnchor?: string | null; positionVersion?: number; positionChecksum?: string | null }
export type BookNoteWrite = { sourceId: string; bookUrl: string; bookName?: string; chapterUrl?: string; chapterIndex?: number; startOffset: number; endOffset: number; excerpt: string; note?: string; bookmark?: boolean; paragraphAnchor?: string | null; positionVersion?: number; positionChecksum?: string | null }
/** 本书正文检索命中（搜索本书 feature）：在已缓存章节正文里按关键词找，snippet 是命中处前后截一段。 */
export type BookSearchHit = { chapterUrl: string; chapterIndex: number; title: string; snippet: string }
export type BookshelfItem = { sourceId: string; bookUrl: string; name: string; author?: string; tocUrl: string; coverKey?: string; chapterIndex?: number; scrollPosition?: number; lastReadAt: number; tocUpdatedAt?: number; cachedChapters: number; totalChapters: number; cacheState: 'idle' | 'caching' | 'ready' | 'failed'; cacheError?: string; completed: boolean; alternateSources?: SearchResult[]; groupId?: number; /** 这本本地书实际用的目录规则（`auto`/`builtin`/规则 id）；在线书没有 */ tocRule?: string | null; /** 自定义排序位（1 起）；null/缺省 = 没参与过自定义排序 */ sortOrder?: number | null; /** 书源 bookSourceType：0 文本 / 1 音频 / 2 漫画 / 3 文件 / 4 视频 */ sourceType?: number }
export type BookshelfWrite = { sourceId: string; bookUrl: string; name: string; author?: string; tocUrl: string; coverUrl?: string; alternateSources?: SearchResult[] }
export type BookshelfSourceSwitch = { oldSourceId: string; oldBookUrl: string; book: BookshelfWrite; alternateSources?: SearchResult[] }
export type ImportResponse = { imported: number; updated: number; skipped: number; errors: string[] }
export type DebugTrace = { field: string; rule: string; value: string; failure: string }
export type DebugStep = { stage: string; label: string; detail: string; ok: boolean; elapsedMs: number; traces: DebugTrace[] }
export type LocalBookImportItem = { filename: string; success: boolean; bookUrl?: string; name?: string; author?: string; totalChapters: number; error?: string }
export type LocalBookImportResponse = { total: number; imported: number; failed: number; results: LocalBookImportItem[] }
/** 「阅读设置 → 本地书目录」下拉的一项（服务端把 auto / builtin / 规则 id 统一成同一形状）。 */
/**
 * 一条可选的分章规则。`enable` 只表示"参与自动打分"，**不表示能不能手动选** ——
 * 曾经服务端只发启用的 12 条，另外 12 条（章回体「第N回」这类）于是既看不见也选不了。
 */
export type TocRuleOption = {
  key: string
  label: string
  example?: string
  builtIn?: boolean
  rule?: string
  enable?: boolean
  broken?: boolean
  /** 只有自建的规则能删（随包那 26 条不可删）。 */
  removable?: boolean
}
export type TocRuleList = {
  options: TocRuleOption[]
  /** 本机启用几条 / 表里共几条 / 其中几条是从手机备份收下来的。界面上要报得出，不能只给下拉。 */
  enabled?: number
  total?: number
  fromBackup?: number
  /** 本机改动还在不在（套用过备份就是"在"），界面上「恢复随包那份」按它出现。 */
  overridden?: boolean
}
/** 套用备份里那份规则表的回报：匹配上几条、其中改动了启用几条、新收下几条、坏正则几条。 */
export type TocRuleApplyResult = { matched: number; flipped: number; added: number; unusable: number; total: number }
/** 重切目录的回报。`tocRuleUsed` 是**实际生效**的那条，可能与请求里选的不同（`fellBack` 会说清）。 */
export type LocalBookReparseResult = { success: boolean; name: string; totalChapters: number; tocRuleUsed: string; ruleLabel: string; fellBack?: boolean; error?: string }
export type SourceSubscription = { id: number; url: string; enabled: boolean; createdAt: number; updatedAt: number; lastSuccessAt?: number; lastAttemptAt?: number; lastError?: string; lastImported: number; contentHash?: string }
export type RssSourceSummary = { sourceUrl: string; name: string; group?: string; icon?: string; enabled: boolean; hasListRule: boolean; updatedAt: number }
export type RssArticle = { origin: string; title: string; link?: string; pubDate?: string; description?: string; image?: string }
export type RssArticleContent = { title?: string; content: string }
export type BookGroup = { id: number; name: string; bookCount: number }
export type SearchStreamEvent = { type: 'start' | 'results' | 'progress' | 'done' | 'error'; totalSources: number; completedSources: number; matchedSources: number; emptySources: number; failedSources: number; resultCount: number; results: SearchResult[]; message?: string }

export type BatchSourceAction = 'enable' | 'disable' | 'delete' | 'set_group' | 'tag_group' | 'untag_group'
export type BatchSourceRequest = {
  action: BatchSourceAction
  ids: string[]
  group?: string
}

export type BatchSourceResponse = {
  ok: boolean
  affected: number
  action: string
  message?: string
}

export type SourceHealthCheckItem = {
  id: string
  name: string
  ok: boolean
  latencyMs: number
  statusCode: number
  /**
   * 体检档位。`explore_only` / `no_search` 是**顶层 `searchUrl` 为空**那两类：服务端一个请求都没发
   * （`SourceHealth.kt` 的定档分支），所以它们不是"连不上"，不能进「一键停用 / 删除」。
   * 同类型的 `failedCount` 在服务端等于 `count { !it.ok }`，会把这两类一起算进去 —— 界面别用它。
   */
  statusCategory: string  // valid · slow · empty · blocked · needs_login · needs_webview · explore_only · no_search · unreachable · tls · broken · invalid
  error?: string
}

export type SourceHealthCheckResponse = {
  total: number
  successCount: number
  slowCount: number
  failedCount: number
  durationMs: number
  results: SourceHealthCheckItem[]
}


export type BackupImportSummary = {
  sources: number
  sourcesUpdated: number
  rules: number
  rulesUpdated: number
  books: number
  booksUpdated: number
  progress: number
  /** 从包内 cookies.json 恢复并合并进书源的登录凭据条数 */
  cookies?: number
  /** 为什么没恢复成（缺密码 / 密码不对 / 域名匹配不到书源） */
  cookiesNote?: string | null
  /** 包内 rssSources.json（手机「订阅」页的 RSS 源）恢复条数 */
  rssSources?: number
  rssSourcesUpdated?: number
  /** 包内 bookGroup.json 落到本机分组表的数量 */
  bookGroups?: number
  /** 包内条目读出来但没落库的原因（某一条本身坏了，不是整节跳过） */
  errors?: string[]
  /** 备份包里有、服务端既没导入也没收进数据目录的条目名（`config.xml` / `videoConfig.xml` / `autoTask.json` 这类），由服务端报，不在前端写死 */
  skippedSections?: string[]
  /** 没有原生归宿、但已原样收进服务器数据目录的个性化条目（书签/阅读样式/朗读引擎…） */
  keptSections?: KeptBackupEntry[]
}

/** 备份包里被原样收下的一条个性化内容（服务端 BackupStore）。appliable 为真时前端能套到自己设置上。 */
export type KeptBackupEntry = { name: string; label: string; bytes: number; items: number; appliable: boolean; updatedAt: number }

export type ReplaceRule = {
  id: string
  name: string
  group?: string
  pattern: string
  replacement: string
  isRegex: boolean
  scope?: string
  excludeScope?: string
  scopeTitle?: boolean
  scopeContent?: boolean
  isEnabled: boolean
  order: number
  timeoutMillisecond?: number
  createdAt?: number
  updatedAt?: number
}

export type ReplaceRuleImportResponse = {
  imported: number
  updated: number
  skipped: number
  total: number
}

export type ReplaceRulePreviewRequest = {
  text: string
  rule?: Partial<ReplaceRule>
  bookName?: string
  sourceUrl?: string
}

export type ReplaceRulePreviewResponse = {
  originalText: string
  cleanedText: string
  changed: boolean
  appliedRules: string[]
}

export type FlexChildStyle = {
  layout_flexGrow?: number
  layout_flexShrink?: number
  layout_alignSelf?: string
  layout_flexBasisPercent?: number
  layout_wrapBefore?: boolean
  layout_justifySelf?: string
}

export type SourceLoginUiItem = {
  name: string
  type: string
  action?: string
  chars?: (string | null)[]
  default?: string
  viewName?: string
  style?: FlexChildStyle
  key?: string
  hint?: string
  value?: string
  options?: string[]
  countdown?: number
}

/** 某地址所属注册域上有没有存凭据。只答有/无 —— 没人能凭这个判定"登录态有效"。 */
export type SourceCredentialStatus = {
  domain: string
  has: boolean
}

/** 「重取这一张」的回包：新落盘的键与类型。界面不显示它，但拿到才算真重取成功。 */
export type RefreshedImage = {
  key: string
  contentType: string
}

/** 真浏览器登录的状态回包。 */
export type ExternalLoginStatus = {
  /** 我们拉起来的那个浏览器还在不在。 */
  opened: boolean
  browser: string
  port: number
  pid: number
  /** 这本书源会带凭据去访问的域（登录页排最前）。 */
  hosts: string[]
  /** 浏览器里已经出现 Cookie 的域 —— 「登录已经发生过」的事实依据。 */
  seen: string[]
  /** 本轮真正写进凭据表的域。 */
  stored: string[]
  /** 该书源当前能带出去的凭据桶数量。 */
  count: number
}

export type SourceLoginUiResponse = {  sourceId: string
  sourceName: string
  hasLogin: boolean
  loginUi: SourceLoginUiItem[]
  loginUrl?: string
  loginInfo: Record<string, string>
  loginHeader?: string
  /** loginUrl 不是网址而是整段登录 JS（聚合源普遍如此）。 */
  loginIsScript?: boolean
  /** 这本书源实际会带凭据访问的域名，登录页那个排最前。 */
  cookieDomains?: string[]
  sourceVariable?: string
}

export type SourceLoginActionResult = {
  success: boolean
  toastMessages: string[]
  openUrl?: string
  copyText?: string
  updatedLoginInfo?: Record<string, string>
  updatedLoginHeader?: string
  updatedVariable?: string
  reRenderUi: boolean
  error?: string
}

export type SourceLoginCheckResult = {
  loggedIn: boolean
  message?: string
  /** 已捕获任意凭据（Cookie/登录头/登录信息），不等于已验证登录。 */
  hasCredential?: boolean
  /** 经书源 loginCheckJs 主动验证通过。 */
  verified?: boolean
}

export type SourceBrowserSession = {
  token: string
  startUrl: string
  expiresInSeconds: number
  inlineOnly?: boolean
}

export type SourceBrowserCookies = {
  count: number
  domains: string[]
  cookies: Record<string, string>
}


async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  // FormData 必须留给浏览器自己带 boundary，写死 application/json 会让服务端收不到文件
  if (init.body && !(typeof FormData !== 'undefined' && init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  // 不设身份：写操作由服务端的同源闸门把关，浏览器自己带 Origin，这里没有令牌要注入
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' })
  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: response.statusText })) as { message?: string }
    throw new Error(body.message ?? '请求失败')
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>
}

export type TtsVoice = {
  id: string
  name: string
  lang: string
  gender: string
  localeName: string
  engine: string
  description?: string
}

export type TtsSpeakRequest = {
  text: string
  voice?: string
  rate?: number
  pitch?: number
  engine?: string
  customUrl?: string
  customHeader?: string
  customMethod?: string
  customBody?: string
}

export type TtsSessionInfo = {
  sessionId: string
  audioUrl: string
  eventsUrl: string
}

export type TtsSessionChunkRequest = {
  chunkId: string
  text: string
  chapterIndex: number
  paragraphIndex: number
  engine: string
  voice: string
  rate: number
  pitch: number
  customUrl?: string
  customHeader?: string
  customMethod?: string
  customBody?: string
}

/** 更新日志的一节（一个版本）。前端 `parseChangelog` 从 `CHANGELOG.md` 文本解析出来。 */
export type ChangelogRelease = {
  version: string
  date: string
  preamble: string[]
  groups: Array<{ title: string; items: string[] }>
}

export type LogEntry = {
  id: number
  timestamp: string
  category: string
  level: string
  message: string
  context?: Record<string, string>
  stackTrace?: string | null
  /** 同类日志在合并窗口里的条数；1 表示就这一条。界面念成「×N」。 */
  count?: number
}

export const api = {
  sources: (query = '') => request<SourceSummary[]>(`/api/sources?q=${encodeURIComponent(query)}`),
  source: (id: string) => request<SourceRecord>(`/api/sources/${encodeURIComponent(id)}`),
  save: (id: string, json: string, version?: number) => request<SourceRecord>(`/api/sources/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ json, version }) }),
  remove: (id: string) => request<void>(`/api/sources/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  batchSources: (action: BatchSourceAction, ids: string[], group?: string) =>
    request<BatchSourceResponse>('/api/sources/batch', { method: 'POST', body: JSON.stringify({ action, ids, group }) }),
  healthCheckSources: (ids?: string[], timeoutMs = 5000) =>
    request<SourceHealthCheckResponse>('/api/sources/health-check', { method: 'POST', body: JSON.stringify({ ids, timeoutMs }) }),
  /** 书源自定义排序：屏幕上这一列按新顺序整段回传。 */
  reorderSources: (ids: string[]) => request<{ updated: number }>('/api/sources/order', { method: 'PUT', body: JSON.stringify({ ids }) }),
  clearSourceOrder: () => request<{ updated: number }>('/api/sources/order', { method: 'DELETE' }),
  exportSources: (ids?: string[]) =>
    request<string[]>(`/api/sources/export${ids && ids.length > 0 ? `?${ids.map(id => `id=${encodeURIComponent(id)}`).join('&')}` : ''}`),
  validate: (id: string, draftJson?: string) => request<{ valid: boolean; errors: string[]; warnings: string[] }>(`/api/sources/${encodeURIComponent(id)}/validate`, { method: 'POST', body: JSON.stringify(draftJson ? { json: draftJson } : {}) }),
  /** 分阶段调试是 SSE 流，交给 EventSource 自己开，这里只负责拼地址。 */
  debugStreamUrl: (id: string, keyword: string, bookUrl?: string, chapterIndex?: number) =>
    `/api/sources/${encodeURIComponent(id)}/debug?keyword=${encodeURIComponent(keyword)}`
      + (bookUrl ? `&bookUrl=${encodeURIComponent(bookUrl)}` : '')
      + (chapterIndex ? `&chapterIndex=${chapterIndex}` : ''),
  import: (sources: string[]) => request<ImportResponse>('/api/sources/import', { method: 'POST', body: JSON.stringify({ sources }) }),
  subscriptions: () => request<SourceSubscription[]>('/api/subscriptions'),
  saveSubscription: (url: string, enabled = true) => request<SourceSubscription>('/api/subscriptions', { method: 'POST', body: JSON.stringify({ url, enabled }) }),
  removeSubscription: (id: number) => request<void>(`/api/subscriptions/${id}`, { method: 'DELETE' }),
  updateSubscription: (id: number) => request<ImportResponse>(`/api/subscriptions/${id}/update`, { method: 'POST' }),
  updateSubscriptions: () => request<{ updated: number; failed: number }>('/api/subscriptions/update', { method: 'POST' }),
  logs: (opts: { category?: string; level?: string; limit?: number } = {}) => {
    const q = new URLSearchParams()
    if (opts.category) q.set('category', opts.category)
    if (opts.level) q.set('level', opts.level)
    q.set('limit', String(opts.limit ?? 200))
    return request<LogEntry[]>(`/api/logs?${q.toString()}`)
  },
  clearLogs: () => request<void>('/api/logs', { method: 'DELETE' }),
  /** 随包发出的 CHANGELOG.md 原文（不是仓库文件路径，是打进 jar 的那一份）。 */
  changelog: async (): Promise<string> => {
    const res = await fetch('/api/changelog')
    if (!res.ok) throw new Error(`更新日志读取失败（HTTP ${res.status}）`)
    return res.text()
  },
  shelfGroups: () => request<BookGroup[]>('/api/bookshelf/groups'),
  /** 「关于」页顶部的名字/版本/仓库：版本只有一个来源（jar 清单），界面不许写死。 */
  about: () => request<AboutInfo>('/api/about'),
  /** 服务自身：当前绑的地址与端口。 */
  serverInfo: () => request<ServerInfo>('/api/server'),
  /** 改端口：只写安装根的 `port.txt`，重启 legadoQ 后生效。 */
  setServerPort: (port: number) => request<ServerPortResult>('/api/server/port', { method: 'PUT', body: JSON.stringify({ port }) }),
  checkUpdate: () => request<UpdateCheckResult>('/api/about/update-check', { method: 'POST' }),
  /**
   * 自定义品牌：名称/短名/主题色 + 图标。走 `/brand` 这一组**非 /api 表面**的路由
   * （与 `/sw.js`、`/manifest.webmanifest` 同一档，见 StaticWeb.kt 的注释），
   * 所以它不进 `/api/catalog` 的端点计数；但写操作照过服务端的同源闸门。
   * 名称与主题色改完**立刻生效**（manifest 那条路由带 no-cache）；
   * 已经装到桌面/主屏幕的 PWA 要等浏览器同步清单，界面上得把这句说清楚。
   */
  brand: () => request<BrandInfo>('/brand'),
  setBrand: (brand: { name: string; shortName: string; themeColor: string }) =>
    request<BrandInfo>('/brand', { method: 'PUT', body: JSON.stringify(brand) }),
  resetBrand: () => request<BrandInfo>('/brand', { method: 'DELETE' }),
  /** 图标只收 PNG / JPEG / WebP（服务端按魔数判、拒 SVG），上限 5 MB。 */
  uploadBrandIcon: (file: File) => {
    const form = new FormData()
    form.append('file', file, file.name)
    return request<BrandInfo>('/brand/icon', { method: 'POST', body: form })
  },
  clearBrandIcon: () => request<BrandInfo>('/brand/icon', { method: 'DELETE' }),
  createShelfGroup: (name: string) => request<BookGroup>('/api/bookshelf/groups', { method: 'POST', body: JSON.stringify({ name }) }),
  removeShelfGroup: (id: number) => request<void>(`/api/bookshelf/groups/${id}`, { method: 'DELETE' }),
  setBookGroup: (sourceId: string, bookUrl: string, groupId: number) => request<BookshelfItem>('/api/bookshelf/group', { method: 'PUT', body: JSON.stringify({ sourceId, bookUrl, groupId }) }),
  /** 自定义排序：把屏幕上这一列（筛选后的可见清单）按新顺序整段回传。 */
  reorderShelf: (books: Array<{ sourceId: string; bookUrl: string }>) =>
    request<{ updated: number }>('/api/bookshelf/order', { method: 'PUT', body: JSON.stringify({ books }) }),
  /** 回到"从没拖过"的状态：把全架的自定义位置清空（不是切排序档）。 */
  clearShelfOrder: () => request<{ updated: number }>('/api/bookshelf/order', { method: 'DELETE' }),
  // RSS 订阅（手机「订阅」页那一栏）；上面 subscriptions 是「书源订阅地址」，两者不是一回事
  rssSources: (query?: string) => request<RssSourceSummary[]>(`/api/rss/sources${query?.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''}`),
  addRssSources: (sources: string[]) => request<ImportResponse>('/api/rss/sources', { method: 'POST', body: JSON.stringify({ sources }) }),
  setRssSourceEnabled: (sourceUrl: string, enabled: boolean) => request<void>('/api/rss/sources/enabled', { method: 'POST', body: JSON.stringify({ sourceUrl, enabled }) }),
  removeRssSource: (sourceUrl: string) => request<void>(`/api/rss/sources?sourceUrl=${encodeURIComponent(sourceUrl)}`, { method: 'DELETE' }),
  rssTabs: (sourceUrl: string, signal?: AbortSignal) => request<ExploreTab[]>(`/api/rss/tabs?sourceUrl=${encodeURIComponent(sourceUrl)}`, { signal }),
  rssArticles: (sourceUrl: string, url: string, page = 1, signal?: AbortSignal) => request<RssArticle[]>('/api/rss/articles', { method: 'POST', body: JSON.stringify({ sourceUrl, url, page }), signal }),
  rssContent: (sourceUrl: string, link: string, signal?: AbortSignal) => request<RssArticleContent>('/api/rss/content', { method: 'POST', body: JSON.stringify({ sourceUrl, link }), signal }),
  getSourceLoginUi: (sourceId: string) => request<SourceLoginUiResponse>(`/api/sources/${encodeURIComponent(sourceId)}/login-ui`),
  saveSourceLoginInfo: (sourceId: string, loginInfo: Record<string, string>) => request<{ ok: boolean }>(`/api/sources/${encodeURIComponent(sourceId)}/login-info`, { method: 'POST', body: JSON.stringify({ loginInfo }) }),
  saveSourceLoginHeader: (sourceId: string, loginHeader: string) => request<{ ok: boolean }>(`/api/sources/${encodeURIComponent(sourceId)}/login-header`, { method: 'POST', body: JSON.stringify({ loginHeader }) }),
  saveSourceCookie: (sourceId: string, cookie: string, url?: string) => request<{ ok: boolean; message?: string }>(`/api/sources/${encodeURIComponent(sourceId)}/login-cookie`, { method: 'POST', body: JSON.stringify({ cookie, url }) }),
  clearSourceLoginInfo: (sourceId: string) => request<{ ok: boolean }>(`/api/sources/${encodeURIComponent(sourceId)}/login-info`, { method: 'DELETE' }),
  clearSourceLoginHeader: (sourceId: string) => request<{ ok: boolean }>(`/api/sources/${encodeURIComponent(sourceId)}/login-header`, { method: 'DELETE' }),
  executeSourceLoginAction: (sourceId: string, action: string, loginData: Record<string, string>, isLongClick = false, browserCompleted = false) => request<SourceLoginActionResult>(`/api/sources/${encodeURIComponent(sourceId)}/login-action`, { method: 'POST', body: JSON.stringify({ action, loginData, isLongClick, browserCompleted }) }),
  checkSourceLogin: (sourceId: string) => request<SourceLoginCheckResult>(`/api/sources/${encodeURIComponent(sourceId)}/login-check`),
  createSourceBrowserSession: (sourceId: string, url?: string) => request<SourceBrowserSession>(`/api/sources/${encodeURIComponent(sourceId)}/browser/session`, { method: 'POST', body: JSON.stringify({ url }) }),
  closeSourceBrowserSession: (sourceId: string, token: string) => request<void>(`/api/sources/${encodeURIComponent(sourceId)}/browser/session?t=${encodeURIComponent(token)}`, { method: 'DELETE' }),
  sourceBrowserCookies: (sourceId: string) => request<SourceBrowserCookies>(`/api/sources/${encodeURIComponent(sourceId)}/browser/cookies`),
  /** 某地址所在注册域上有没有凭据（只答有/无），发现页用它区分「要登录」与「真的空」。 */
  sourceCredential: (sourceId: string, url: string) =>
    request<SourceCredentialStatus>(`/api/sources/${encodeURIComponent(sourceId)}/credential?u=${encodeURIComponent(url)}`),
  /** 真浏览器登录：服务端拉起本机 Chromium（独立持久 profile），登录完按域自动回读凭据。 */
  externalLoginStart: (sourceId: string, url?: string) =>
    request<ExternalLoginStatus>(`/api/sources/${encodeURIComponent(sourceId)}/browser/external-login`, { method: 'POST', body: JSON.stringify(url ? { url } : {}) }),
  externalLoginStatus: (sourceId: string) =>
    request<ExternalLoginStatus>(`/api/sources/${encodeURIComponent(sourceId)}/browser/external-login`),
  externalLoginCapture: (sourceId: string) =>
    request<ExternalLoginStatus>(`/api/sources/${encodeURIComponent(sourceId)}/browser/external-login/capture`, { method: 'POST', body: '{}' }),
  externalLoginStop: (sourceId: string) =>
    request<void>(`/api/sources/${encodeURIComponent(sourceId)}/browser/external-login`, { method: 'DELETE' }),
  removeSourceCookie: (sourceId: string, url: string) => request<{ ok: boolean; removed: boolean; count: number; domains: string[] }>(`/api/sources/${encodeURIComponent(sourceId)}/browser/cookies?u=${encodeURIComponent(url)}`, { method: 'DELETE' }),
  sourceBrowserPageUrl: (sourceId: string, token: string, target: string) =>
    `/api/sources/${encodeURIComponent(sourceId)}/browser/page?t=${encodeURIComponent(token)}&u=${encodeURIComponent(target)}`,
  /** 书源 JS 生成的数据地址页面：交给服务端解码托管，避免超长 URL 触发请求行 8192 上限 */
  registerSourceBrowserInline: (sourceId: string, token: string, url: string) =>
    request<{ key: string }>(`/api/sources/${encodeURIComponent(sourceId)}/browser/inline`, { method: 'POST', body: JSON.stringify({ token, url }) }),
  sourceBrowserInlineUrl: (sourceId: string, token: string, key: string) =>
    `/api/sources/${encodeURIComponent(sourceId)}/browser/page?t=${encodeURIComponent(token)}&i=${encodeURIComponent(key)}`,
  exploreSources: () => request<SourceSummary[]>('/api/explore/sources'),
  exploreTabs: (sourceId: string, signal?: AbortSignal) => request<ExploreTab[]>(`/api/sources/${encodeURIComponent(sourceId)}/explore`, { signal }),
  explore: (sourceId: string, url: string, page = 1, signal?: AbortSignal) => request<SearchResult[]>('/api/explore', { method: 'POST', body: JSON.stringify({ sourceId, url, page }), signal }),
  details: (sourceId: string, bookUrl: string, signal?: AbortSignal) => request<BookDetails>('/api/books/details', { method: 'POST', body: JSON.stringify({ sourceId, bookUrl }), signal }),
  chapters: (sourceId: string, bookUrl: string, signal?: AbortSignal) => request<Chapter[]>('/api/books/chapters', { method: 'POST', body: JSON.stringify({ sourceId, bookUrl }), signal }),
  content: async (sourceId: string, chapterUrl: string, bookUrl?: string, signal?: AbortSignal) => {
    try {
      const res = await request<{ title?: string; content: string; mediaUrl?: string }>('/api/books/content', { method: 'POST', body: JSON.stringify({ sourceId, chapterUrl, bookUrl }), signal })
      if (res?.content && bookUrl) {
        void putOfflineChapter(sourceId, bookUrl, chapterUrl, res.title || null, res.content)
      }
      return res
    } catch (err) {
      if (bookUrl) {
        const offline = await getOfflineChapter(sourceId, bookUrl, chapterUrl)
        if (offline && offline.content) {
          return { title: offline.title ?? undefined, content: offline.content }
        }
      }
      throw err
    }
  },
  progress: (sourceId: string, bookUrl: string, signal?: AbortSignal) => request<ReadingProgress | undefined>(`/api/reading-progress?sourceId=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}`, { signal }),
  saveProgress: async (
    sourceId: string,
    bookUrl: string,
    chapterUrl: string,
    chapterIndex: number,
    scrollPosition: number,
    /** 逻辑位置模型（P1-T1）：章节内字符偏移 + 段落锚点 + 内容校验值；老调用方不传。 */
    position?: { charOffset?: number; paragraphAnchor?: string | null; positionChecksum?: string | null },
  ) => {
    const charOffset = position?.charOffset
    const progressItem = {
      sourceId, bookUrl, chapterUrl, chapterIndex, scrollPosition,
      ...(charOffset != null ? { charOffset } : {}),
      paragraphAnchor: position?.paragraphAnchor ?? null,
      positionVersion: 1,
      positionChecksum: position?.positionChecksum ?? null,
      updatedAt: Date.now(),
    }
    // 先冲掉此前积压的（flush 自带"成功即出队"），本次直写成功就不再入队 ——
    // 原来"入队 → 直写 → flush"会把刚入队的这条再发一遍（每次存进度都双写）；
    // 且 flush 排在直写前并 await，旧位置不会晚于新位置到达服务端。
    await flushOfflineProgress(async (item) => {
      await request<ReadingProgress>('/api/reading-progress', { method: 'PUT', body: JSON.stringify(item) })
    }).catch(() => {})
    try {
      const res = await request<ReadingProgress>('/api/reading-progress', { method: 'PUT', body: JSON.stringify(progressItem) })
      return res
    } catch {
      // 直写失败才进离线队列，等服务恢复由下次 saveProgress 的 flush 补发
      enqueueOfflineProgress(progressItem)
      return progressItem as ReadingProgress
    }
  },
  /**
   * 阅读记录（PROPOSAL-019 D）。上报一段停留就 `addReadingLog`（只增不改），
   * 「阅读记录」页读 `readingLog`。上报失败不重试、也不弹错 —— 它是统计，丢了不影响读书。
   */
  readingLog: (days = 30, signal?: AbortSignal) => request<ReadingLogEntry[]>(`/api/reading-log?days=${days}`, { signal }),
  addReadingLog: (entry: { sourceId: string; bookUrl: string; bookName?: string; chapterIndex?: number; seconds: number }) =>
    request<ReadingLogEntry>('/api/reading-log', { method: 'POST', body: JSON.stringify(entry) }),
  /**
   * 笔记 / 划线（PROPOSAL-019 E）。按书读、增、改备注、删。
   * 偏移是**章节内字符偏移**（不是像素 / 列号）——字号、字体、分栏一改位置就跳，这是阅读器那条老教训。
   */
  notes: (sourceId: string, bookUrl: string, signal?: AbortSignal) =>
    request<BookNote[]>(`/api/notes?sourceId=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}`, { signal }),
  /** 本书正文检索：在已离线缓存的章节正文里按关键词找命中（没缓存的章节搜不到）。 */
  bookSearch: (sourceId: string, bookUrl: string, query: string, signal?: AbortSignal) =>
    request<BookSearchHit[]>(`/api/book-search?sourceId=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}&q=${encodeURIComponent(query)}`, { signal }),
  addNote: (write: BookNoteWrite) => request<BookNote>('/api/notes', { method: 'POST', body: JSON.stringify(write) }),
  updateNote: (id: number, note: string) => request<void>(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify({ note }) }),
  deleteNote: (id: number) => request<void>(`/api/notes/${id}`, { method: 'DELETE' }),
  bookshelf: async () => {
    try {
      const list = await request<BookshelfItem[]>('/api/bookshelf')
      saveShelfSnapshot(list)
      return list
    } catch (err) {
      const snapshot = getShelfSnapshot()
      if (snapshot && snapshot.length > 0) {
        return snapshot as BookshelfItem[]
      }
      throw err
    }
  },
  addToBookshelf: (book: BookshelfWrite) => request<BookshelfItem>('/api/bookshelf', { method: 'POST', body: JSON.stringify(book) }),
  removeFromBookshelf: (sourceId: string, bookUrl: string) => request<void>(`/api/bookshelf?sourceId=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}`, { method: 'DELETE' }),
  
  // 批量操作 API
  batchDeleteBooks: (books: Array<{ sourceId: string; bookUrl: string }>) => 
    request<{ deleted: number; total: number }>('/api/bookshelf/batch-delete', { 
      method: 'POST', 
      body: JSON.stringify({ books }) 
    }),
  batchMoveToGroup: (books: Array<{ sourceId: string; bookUrl: string }>, groupId: number | null) => 
    request<{ moved: number; total: number }>('/api/bookshelf/batch-move-group', { 
      method: 'POST', 
      body: JSON.stringify({ books, groupId }) 
    }),
  batchMarkAsRead: (books: Array<{ sourceId: string; bookUrl: string }>, isRead: boolean) => 
    request<{ marked: number; total: number }>('/api/bookshelf/batch-mark-read', { 
      method: 'POST', 
      body: JSON.stringify({ books, isRead }) 
    }),
  
  cacheBookshelfBook: (sourceId: string, bookUrl: string) => request<{ status: string }>('/api/bookshelf/cache', { method: 'POST', body: JSON.stringify({ sourceId, bookUrl }) }),
  cacheBookshelfRange: (data: { sourceId: string; bookUrl: string; startIndex?: number; endIndex?: number; count?: number }) =>
    request<{ status: string }>('/api/bookshelf/cache', { method: 'POST', body: JSON.stringify(data) }),
  getCachedChapters: (sourceId: string, bookUrl: string) =>
    request<{ sourceId: string; bookUrl: string; cachedChapterUrls: string[]; cachedCount: number; totalChapters: number; cachedWordCounts?: number[] }>(
      `/api/bookshelf/cached-chapters?sourceId=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}`
    ),
  clearBookCacheData: (sourceId: string, bookUrl: string) =>
    request<void>(`/api/bookshelf/cache?sourceId=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}&clearData=true`, { method: 'DELETE' }),
  cancelBookCache: (sourceId: string, bookUrl: string) => request<void>(`/api/bookshelf/cache?sourceId=${encodeURIComponent(sourceId)}&bookUrl=${encodeURIComponent(bookUrl)}`, { method: 'DELETE' }),
  setBookshelfCompleted: (sourceId: string, bookUrl: string, completed: boolean) => request<BookshelfItem>('/api/bookshelf/status', { method: 'PUT', body: JSON.stringify({ sourceId, bookUrl, completed }) }),
  updateBookshelfInfo: (data: { sourceId: string; bookUrl: string; name: string; author?: string; coverUrl?: string }) => request<BookshelfItem>('/api/bookshelf/info', { method: 'PUT', body: JSON.stringify(data) }),
  switchBookshelfSource: (value: BookshelfSourceSwitch) => request<BookshelfItem>('/api/bookshelf/switch-source', { method: 'POST', body: JSON.stringify(value) }),
  importLocalBooks: async (files: File[], tocRule?: string): Promise<LocalBookImportResponse> => {
    const formData = new FormData()
    for (const file of files) {
      formData.append('file', file, file.name)
    }
    const headers = new Headers()
    // 规则走查询参数：multipart 字段的到达顺序靠不住（服务端是边读边解析的）
    const response = await fetch(`/api/bookshelf/import-local${tocRule && tocRule !== 'auto' ? `?tocRule=${encodeURIComponent(tocRule)}` : ''}`, {
      method: 'POST',
      headers,
      credentials: 'same-origin',
      body: formData,
    })
    if (!response.ok) {
      const err = await response.json().catch(() => ({ message: response.statusText })) as { message?: string }
      throw new Error(err.message ?? '本地书籍上传失败')
    }
    return response.json() as Promise<LocalBookImportResponse>
  },
  /** 本地书可选的目录规则（auto / builtin / 上游那 26 条里编译得出来的）。 */
  tocRules: () => request<TocRuleList>('/api/books/toc-rules'),
  /** 套用「手机备份里那份 txtTocRule.json」：按规则字面匹配采纳启用与顺序，匹配不上的收下为新规则。 */
  applyTocRulesFromBackup: () => request<TocRuleApplyResult>('/api/books/toc-rules/apply-backup', { method: 'POST' }),
  /** 撤掉本机改动（套用过备份之后想反悔，或门禁跑完要还原用户的规则表）。 */
  resetTocRules: () => request<{ cleared: boolean; total: number }>('/api/books/toc-rules/reset', { method: 'POST' }),
  /** 开关一条规则是否参与「自动」打分（手动选不受它限制）。 */
  toggleTocRule: (key: string, enable: boolean) =>
    request<{ id: number; name: string; enable: boolean }>('/api/books/toc-rules/toggle', { method: 'POST', body: JSON.stringify({ key, enable }) }),
  /** 新建（key 省略）或改一条分章规则；正则编不出来服务端会 400 并说清原因。 */
  saveTocRule: (rule: { key?: string; name: string; rule: string; example?: string; enable: boolean }) =>
    request<{ id: number; name: string; rule: string; enable: boolean; total: number }>('/api/books/toc-rules/save', { method: 'POST', body: JSON.stringify(rule) }),
  /** 删掉一条自建的规则（随包那条不可删）。 */
  deleteTocRule: (key: string) =>
    request<{ removed: boolean; total: number }>('/api/books/toc-rules/delete', { method: 'POST', body: JSON.stringify({ key, enable: true }) }),
  /** 换规则重切一本本地书的目录。失败时服务端会说清是"这条切不出第二章"还是"原文件不在了"。 */
  reparseLocalBook: (sourceId: string, bookUrl: string, ruleKey: string) =>
    request<LocalBookReparseResult>('/api/books/reparse-local', {
      method: 'POST',
      body: JSON.stringify({ sourceId, bookUrl, ruleKey }),
    }),
  cover: (key: string) => `/api/covers/${encodeURIComponent(key)}`,
  /**
   * 封面代理（0.6.22）：外域封面直连经常取不到（本机系统代理、防盗链、http 混掺），
   * 让服务端代取并落盘缓存，浏览器只加载同源地址。非 http(s) 的（data:、已是本站的）原样返回。
   */
  coverProxy: (url: string, referer?: string) => {
    if (!/^https?:\/\//i.test(url)) return url
    const params = new URLSearchParams({ url })
    if (referer) params.set('referer', referer)
    return `/api/covers/proxy?${params.toString()}`
  },
  /**
   * 正文配图/条目配图的代取地址。`version` 是"这张被重取过几次"的代次：只改浏览器侧的缓存键，
   * 服务端那份仍按原图地址落盘（见 `web/src/reader/readerImage.ts`）。
   */
  bookImage: (url: string, page?: string, version?: string, sourceId?: string) => `/api/book/image?url=${encodeURIComponent(url)}${page ? `&page=${encodeURIComponent(page)}` : ''}${version ? `&v=${encodeURIComponent(version)}` : ''}${sourceId ? `&sourceId=${encodeURIComponent(sourceId)}` : ''}`,
  /** 让服务端绕开盘上那份、重新向上游走一次并原子覆盖。取不到会 502 + 原因，界面把那句话显示给用户。 */
  refreshBookImage: (url: string, page?: string) => request<RefreshedImage>(`/api/book/image/refresh?url=${encodeURIComponent(url)}${page ? `&page=${encodeURIComponent(page)}` : ''}`, { method: 'POST' }),
  /**
   * 媒体流式代理（音频/视频/文件直链）：浏览器 `<audio>/<video>` 带不上 Referer，防盗链源直接 403 播不了；
   * 服务端代取并流式回传、注入本章地址当 Referer、原样转发 Range。非 http(s)（已同源的）原样返回。
   */
  bookMedia: (url: string, referer?: string) => {
    if (!/^https?:\/\//i.test(url)) return url
    const params = new URLSearchParams({ url })
    if (referer) params.set('referer', referer)
    return `/api/book/media?${params.toString()}`
  },
  /** 浏览器直传手机备份包：选文件即导入，服务端读完临时文件就删。 */
  importBackupFile: (file: File, password?: string) => {
    const form = new FormData()
    form.append('file', file)
    if (password) form.append('password', password)
    return request<BackupImportSummary>('/api/backup/import', { method: 'POST', body: form })
  },
  keptBackupEntries: () => request<KeptBackupEntry[]>('/api/backup/kept'),
  keptBackupEntryUrl: (name: string) => `/api/backup/kept/${encodeURIComponent(name)}`,
  keptBackupEntry: (name: string) => fetch(`/api/backup/kept/${encodeURIComponent(name)}`).then(response =>
    response.ok ? response.text() : Promise.reject(new Error('服务器上没有这个条目'))),
  getReplaceRules: (params?: { q?: string; group?: string; scope?: string }) => {
    const sp = new URLSearchParams()
    if (params?.q) sp.set('q', params.q)
    if (params?.group) sp.set('group', params.group)
    if (params?.scope) sp.set('scope', params.scope)
    const qs = sp.toString()
    return request<ReplaceRule[]>(`/api/replace-rules${qs ? `?${qs}` : ''}`)
  },
  getReplaceRule: (id: string) => request<ReplaceRule>(`/api/replace-rules/${encodeURIComponent(id)}`),
  createReplaceRule: (rule: Partial<ReplaceRule>) => request<ReplaceRule>('/api/replace-rules', { method: 'POST', body: JSON.stringify(rule) }),
  updateReplaceRule: (id: string, rule: Partial<ReplaceRule>) => request<ReplaceRule>(`/api/replace-rules/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(rule) }),
  deleteReplaceRule: (id: string) => request<void>(`/api/replace-rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  deleteReplaceRulesBatch: (ids: string[]) => request<{ deleted: number }>('/api/replace-rules/delete-batch', { method: 'POST', body: JSON.stringify(ids) }),
  toggleReplaceRules: (ids: string[], enabled: boolean) => request<{ updated: number }>('/api/replace-rules/toggle', { method: 'POST', body: JSON.stringify({ ids, enabled }) }),
  importReplaceRulesText: (text: string) => request<ReplaceRuleImportResponse>('/api/replace-rules/import', { method: 'POST', body: text }),
  importReplaceRulesUrl: (url: string) => request<ReplaceRuleImportResponse>('/api/replace-rules/import', { method: 'POST', body: JSON.stringify({ url }) }),
  previewReplaceRule: (req: ReplaceRulePreviewRequest) => request<ReplaceRulePreviewResponse>('/api/replace-rules/preview', { method: 'POST', body: JSON.stringify(req) }),
  getTtsVoices: () => request<TtsVoice[]>('/api/tts/voices'),
  createTtsSession: (signal?: AbortSignal) => request<TtsSessionInfo>('/api/tts/session', { method: 'POST', body: '{}', signal }),
  appendTtsSessionChunk: (sessionId: string, chunk: TtsSessionChunkRequest) => request<{ accepted: boolean }>(`/api/tts/session/${encodeURIComponent(sessionId)}/chunks`, { method: 'POST', body: JSON.stringify(chunk) }),
  controlTtsSession: (sessionId: string, action: 'pause' | 'resume' | 'stop') => request<{ accepted: boolean }>(`/api/tts/session/${encodeURIComponent(sessionId)}/control`, { method: 'POST', body: JSON.stringify({ action }) }),
  deleteTtsSession: (sessionId: string) => request<void>(`/api/tts/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),
  fetchTtsAudioBlob: async (req: TtsSpeakRequest): Promise<Blob> => {
    const headers = new Headers({ 'Content-Type': 'application/json' })
    const response = await fetch('/api/tts/speak', {
      method: 'POST',
      headers,
      credentials: 'same-origin',
      body: JSON.stringify(req),
    })
    if (!response.ok) {
      const err = await response.json().catch(() => ({ message: response.statusText })) as { message?: string }
      throw new Error(err.message ?? '语音合成失败')
    }
    return response.blob()
  },
  // ===== 自定义 AI 接入（/api/agent/*）=====
  // 同源写门由服务端把关，浏览器自动带 Origin，这里不注入任何令牌。
  agentManifest: () => request<AgentManifest>('/api/agent/manifest'),
  listAgentConnections: () => request<AgentConnection[]>('/api/agent/connections'),
  registerAgentConnection: (req: AgentConnectionInput) =>
    request<AgentConnection>('/api/agent/connections', { method: 'POST', body: JSON.stringify(req) }),
  deleteAgentConnection: (id: string) =>
    request<{ ok: boolean; removed: string }>(`/api/agent/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  validateAgentSource: (json: string) =>
    request<{ valid: boolean; errors: string[]; warnings: string[] }>('/api/agent/sources/validate', { method: 'POST', body: JSON.stringify({ json }) }),
  createAgentSource: (json: string, version?: number) =>
    request<{ id: string; version: number; updatedAt: string }>('/api/agent/sources', { method: 'POST', body: JSON.stringify({ json, version }) }),
  agentComprehend: (req: { text: string; question?: string; summarySentences?: number; topKeywords?: number }) =>
    request<AgentComprehendResult>('/api/agent/comprehend', { method: 'POST', body: JSON.stringify(req) }),
  agentChat: (messages: AgentChatMessage[], toolGroups?: string[] | null) =>
    request<AgentChatResult>('/api/agent/chat', { method: 'POST', body: JSON.stringify({ messages, ...(toolGroups ? { toolGroups } : {}) }) }),
  /** 拉取某个 OpenAI 兼容网关的模型清单（服务端代发，避免 CORS 与把 key 交给浏览器直连）。 */
  listAgentModels: (baseUrl: string, apiKey?: string) =>
    request<{ models: string[] }>('/api/agent/models', { method: 'POST', body: JSON.stringify({ baseUrl, apiKey }) }),
}

export function streamSearch(keyword: string, sourceIds: string[] | undefined, onEvent: (event: SearchStreamEvent) => void, onError: (message: string) => void, onClose: () => void): WebSocket {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(`${protocol}//${location.host}/api/search/stream`)
  let reported = false
  socket.addEventListener('open', () => queueMicrotask(() => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ keyword, sourceIds }))
  }))
  socket.addEventListener('message', event => {
    try { onEvent(JSON.parse(event.data) as SearchStreamEvent) }
    catch { reported = true; onError('搜索响应格式无效') }
  })
  socket.addEventListener('error', () => { if (!reported) { reported = true; onError('搜索连接中断，请重试') } })
  socket.addEventListener('close', () => { if (!reported) onClose() })
  return socket
}

// ===== 自定义 AI 接入的类型 =====
export type AgentManifestTool = {
  id: string
  group: string
  description: string
  writes: boolean
  /** 工具来源：全部为程序内置（`"builtin"` 或 null）。插件架构已移除。 */
  origin?: string | null
}

export type AgentManifest = {
  enabled: boolean
  builtinConnections: string[]
  tools: AgentManifestTool[]
}

export type AgentConnection = {
  id: string
  name: string
  kind: string
  model: string | null
  baseUrl: string | null
}

export type AgentConnectionInput = {
  id?: string
  name: string
  kind: string
  baseUrl: string
  apiKey?: string
  model: string
}

export type AgentComprehendResult = {
  engine: string
  summary: string
  keywords: string[]
  answer: string
  sentencesCount: number
}

export type AgentChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export type AgentChatResult = {
  engine: string
  content: string
  error?: string
  /** 本轮 AI 实际执行过的工具（`工具id:结果码`）。没调工具就不出现。 */
  toolRounds?: string[]
}
