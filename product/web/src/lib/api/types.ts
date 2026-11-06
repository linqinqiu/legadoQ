/** 前后端契约类型：与后端 `resources/agent-api.json` / Kotlin 模型保持一致。
 *
 * 书源字段的增删在后端契约中修改，应通过构建流程自动生成此文件，消除手动同步漂移。
 * 目前先手动维护，待契约生成脚本接入后再迁出至 generated/。
 */

/* ===== 书源 ===== */
export type SourceSummary = {
  id: string
  name: string
  url: string
  group?: string
  enabled: boolean
  isJsSource: boolean
  hasLogin: boolean
  updatedAt: number
  version: number
  /** 自定义排序位；null = 没拖过，按名称排在有序段之后。 */
  sortOrder?: number | null
}

export type SourceRecord = {
  id: string
  json: string
  version: number
  updatedAt: number
}

/* ===== 服务自身 ===== */
export type AboutInfo = {
  title: string
  version: string
  repository: string
  build?: string
}

/** 服务自身：这次运行实际绑在哪（改 port.txt 不会让它变，要重启）。 */
export type ServerInfo = {
  host: string
  port: number
}

export type ServerPortResult = {
  port: number
  restartRequired: boolean
}

/* ===== 品牌 ===== */
export type BrandInfo = {
  name: string
  displayName: string
  shortName: string
  themeColor: string
  hasIcon: boolean
  iconUrl?: string
  builtinName: string
}

/* ===== 更新检查 ===== */
export type UpdateCheckResult = {
  current: string
  latest?: string | null
  url?: string | null
  publishedAt?: string | null
  repository: string
  status: 'latest' | 'available' | 'not_found' | 'unreachable' | 'not_configured' | string
  message?: string | null
  rollingTag?: string | null
  rollingUrl?: string | null
  rollingPublishedAt?: string | null
}

/* ===== 搜索 ===== */
export type SearchResult = {
  sourceId: string
  name: string
  author?: string
  bookUrl: string
  coverUrl?: string
  intro?: string
  kind?: string
  wordCount?: string
  lastChapter?: string
  /** 书源 bookSourceType：0 文本 / 1 音频 / 2 漫画 / 3 文件 / 4 视频 */
  sourceType?: number
}

export type ExploreTab = {
  title: string
  url: string
  /** 服务端按规则写法判出来的"这一栏吃不吃页码"；缺省按支持（旧数据/别的入口没带这个字段） */
  supportsPaging?: boolean
}

export type SearchStreamEvent = {
  type: 'start' | 'results' | 'progress' | 'done' | 'error'
  totalSources: number
  completedSources: number
  matchedSources: number
  emptySources: number
  failedSources: number
  resultCount: number
  results: SearchResult[]
  message?: string
}

/* ===== 阅读器 ===== */
export type BookDetails = {
  sourceId: string
  name: string
  author?: string
  intro?: string
  coverUrl?: string
  tocUrl: string
  kind?: string
  wordCount?: string
  lastChapter?: string
  alternateSources?: SearchResult[]
  /** 书源 bookSourceType：0 文本 / 1 音频 / 2 漫画 / 3 文件 / 4 视频 */
  sourceType?: number
  /** 书源 ruleContent.imageStyle：FULL 表示正文图片铺满阅读区 */
  imageStyle?: string | null
}

export type Chapter = {
  index: number
  title: string
  url: string
  isVolume?: boolean
}

export type ReadingProgress = {
  sourceId: string
  bookUrl: string
  chapterUrl: string
  chapterIndex: number
  scrollPosition: number
  updatedAt: number
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
export type ReadingLogEntry = {
  day: string
  sourceId: string
  bookUrl: string
  bookName: string
  chapterIndex: number
  seconds: number
  updatedAt: number
}

/** 笔记 / 划线 / 书签（PROPOSAL-019 E）。偏移是**章节内字符偏移**，不是像素 / 列号。`bookmark` 为真表示只标位置不写想法。 */
export type BookNote = {
  id: number
  sourceId: string
  bookUrl: string
  bookName: string
  chapterUrl: string
  chapterIndex: number
  startOffset: number
  endOffset: number
  excerpt: string
  note: string
  createdAt: number
  updatedAt: number
  bookmark?: boolean
  paragraphAnchor?: string | null
  positionVersion?: number
  positionChecksum?: string | null
}

export type BookNoteWrite = {
  sourceId: string
  bookUrl: string
  bookName?: string
  chapterUrl?: string
  chapterIndex?: number
  startOffset: number
  endOffset: number
  excerpt: string
  note?: string
  bookmark?: boolean
  paragraphAnchor?: string | null
  positionVersion?: number
  positionChecksum?: string | null
}

/** 本书正文检索命中（搜索本书 feature）：在已缓存章节正文里按关键词找，snippet 是命中处前后截一段。
 *  `offset` 是关键词在该章正文里的字符偏移 —— 阅读器据此滚到那一段并高亮，不然跳过去还得自己找。 */
export type BookSearchHit = {
  chapterUrl: string
  chapterIndex: number
  title: string
  snippet: string
  offset: number
}

export type BookshelfItem = {
  sourceId: string
  bookUrl: string
  name: string
  author?: string
  tocUrl: string
  coverKey?: string
  chapterIndex?: number
  scrollPosition?: number
  lastReadAt: number
  tocUpdatedAt?: number
  cachedChapters: number
  totalChapters: number
  cacheState: 'idle' | 'caching' | 'ready' | 'failed'
  cacheError?: string
  completed: boolean
  alternateSources?: SearchResult[]
  groupId?: number
  /** 这本本地书实际用的目录规则（`auto`/`builtin`/规则 id）；在线书没有 */
  tocRule?: string | null
  /** 书源 bookSourceType：0 文本 / 1 音频 / 2 漫画 / 3 文件 / 4 视频 */
  sourceType?: number
}

export type BookshelfWrite = {
  sourceId: string
  bookUrl: string
  name: string
  author?: string
  tocUrl: string
  coverUrl?: string
  alternateSources?: SearchResult[]
}

export type BookshelfSourceSwitch = {
  oldSourceId: string
  oldBookUrl: string
  book: BookshelfWrite
  alternateSources?: SearchResult[]
}

export type ImportResponse = {
  imported: number
  updated: number
  skipped: number
  errors: string[]
}

export type DebugTrace = {
  field: string
  rule: string
  value: string
  failure: string
}

export type DebugStep = {
  stage: string
  label: string
  detail: string
  ok: boolean
  elapsedMs: number
  traces: DebugTrace[]
}

export type LocalBookImportItem = {
  filename: string
  success: boolean
  bookUrl?: string
  name?: string
  author?: string
  totalChapters: number
  error?: string
}

export type LocalBookImportResponse = {
  total: number
  imported: number
  failed: number
  results: LocalBookImportItem[]
}

/** 「阅读设置 → 本地书目录」下拉的一项（服务端把 auto / builtin / 规则 id 统一成同一形状）。 */
export type TocRuleOption = {
  key: string
  label: string
  example?: string
  builtIn?: boolean
  rule?: string
  enable?: boolean
  /** 规则跑不出章节（线上校验失败）时后端打的标记，界面用来提示「这条坏了」。 */
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
export type TocRuleApplyResult = {
  matched: number
  flipped: number
  added: number
  unusable: number
  total: number
}

export type LocalBookReparseResult = {
  success: boolean
  name: string
  totalChapters: number
  tocRuleUsed: string
  ruleLabel: string
  fellBack?: boolean
  error?: string
}

export type SourceSubscription = {
  id: number
  url: string
  enabled: boolean
  createdAt: number
  updatedAt: number
  lastSuccessAt?: number
  lastAttemptAt?: number
  lastError?: string
  lastImported: number
  contentHash?: string
}

export type RssSourceSummary = {
  sourceUrl: string
  name: string
  group?: string
  icon?: string
  enabled: boolean
  hasListRule: boolean
  updatedAt: number
}

export type RssArticle = {
  origin: string
  title: string
  link?: string
  pubDate?: string
  description?: string
  image?: string
}

export type RssArticleContent = {
  title?: string
  content: string
}

export type BookGroup = {
  id: number
  name: string
  bookCount: number
}

/* ===== 替换规则 ===== */
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

/* ===== 柔性子样式 ===== */
export type FlexChildStyle = {
  layout_flexGrow?: number
  layout_flexShrink?: number
  layout_alignSelf?: string
  layout_flexBasisPercent?: number
  layout_wrapBefore?: boolean
  layout_justifySelf?: string
}

/* ===== 登录 UI 项 ===== */
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

/* ===== 登录相关 ===== */
export type SourceCredentialStatus = {
  domain: string
  has: boolean
}

/** 「重取这一张」的回包：新落盘的键与类型。 */
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
  /** 我们拉起时是真实进程号；服务重启后附着到仍开着的窗口时拿不到，为 0。 */
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

export type SourceLoginUiResponse = {
  sourceId: string
  sourceName: string
  hasLogin: boolean
  loginUi: SourceLoginUiItem[]
  loginUrl?: string
  loginInfo: Record<string, string>
  loginHeader?: string
  /** loginUrl 不是网址而是整段登录 JS（聚合源普遍如此）。 */
  loginIsScript?: boolean
  /** 有没有能替你打开的登录入口（网址 / 相对路径 / 登录脚本 / jsLib 里的 startBrowserAwait）。 */
  loginCanOpenBrowser?: boolean
  /** 这本书源实际会带凭据访问的域名，登录页那个排最前。 */
  cookieDomains?: string[]
  sourceVariable?: string
  /** loginUi 的协议版本：1 = 静态 JSON 数组，2 = 脚本渲染的 `{"version":2}`。 */
  loginUiVersion?: number
  /** v2 脚本渲染失败时的原因（界面要显示出来，而不是给一张空表单）。 */
  loginUiError?: string
}

/** v2 表单渲染：rows 为脚本给的字段，loginInfo 为已保存的键值。 */
export type SourceLoginUiRenderResponse = {
  rows: SourceLoginUiItem[]
  state: string
  loginInfo: Record<string, string>
  error?: string
}

/** v2 `loginAction` 的命令回包。 */
export type SourceLoginUiActionResponse = {
  ok: boolean
  state?: string
  error: Record<string, string>
  close: boolean
  unknownKeys: string[]
  malformed: boolean
  message?: string
  toastMessages: string[]
  updatedLoginInfo?: Record<string, string>
  openUrl?: string
  /** 本地 `data:text/html` 页面（设置页等），界面用 iframe 展示后把整页 HTML 交回。 */
  inlineHtml?: string
  inlineTitle?: string
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
  /** 本地 `data:text/html` 页面（设置页等），界面用 iframe 展示后把整页 HTML 交回。 */
  inlineHtml?: string
  inlineTitle?: string
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

/* ===== 更新日志 ===== */
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

/* ===== 备份 ===== */
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
  /** 备份包里有、服务端既没导入也没收进数据目录的条目名，由服务端报，不在前端写死 */
  skippedSections?: string[]
  /** 没有原生归宿、但已原样收进服务器数据目录的个性化条目（书签/阅读样式/朗读引擎…） */
  keptSections?: KeptBackupEntry[]
}

/** 备份目录里的一次快照（`/api/backup/snapshots`）：restore 需重启，故只回包不即时生效。 */
export type BackupSnapshotInfo = {
  name: string
  bytes: number
  sha256?: string | null
  verified: boolean
  createdAt: number
}

/** 排定恢复的回包：只表示已排定、需重启，不代表已改库。 */
export type BackupRestoreScheduled = { scheduled: boolean; restartRequired: boolean; name: string }

/** 备份包里被原样收下的一条个性化内容（服务端 BackupStore）。appliable 为真时前端能套到自己设置上。 */
export type KeptBackupEntry = {
  name: string
  label: string
  bytes: number
  items: number
  appliable: boolean
  updatedAt: number
}

/* ===== 批量书源操作 ===== */
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

/* ===== 书源健康 ===== */
export type SourceHealthCheckItem = {
  id: string
  name: string
  ok: boolean
  latencyMs: number
  statusCode: number
  statusCategory: string
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

/* ===== TTS ===== */
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

/* ===== 自定义 AI 接入（/api/agent/*）===== */
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
  /** 连接自己的配置：header.* / thinking / timeoutMs / default，不含 apiKey。 */
  options?: Record<string, string>
}

export type AgentConnectionInput = {
  id?: string
  name: string
  kind: string
  baseUrl: string
  apiKey?: string
  model: string
  options?: Record<string, string>
}

export type AgentComprehendResult = {
  engine: string
  summary: string
  keywords: string[]
  answer: string
  sentencesCount: number
}

export type AgentChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type AgentChatUsage = {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

export type AgentChatResult = {
  engine: string
  content: string
  error?: string
  /** 本轮 AI 实际执行过的工具（`工具id:结果码`）。没调工具就不出现。 */
  toolRounds?: string[]
  /** 上游报告的 token 用量（多轮累加）；没报就不出现。 */
  usage?: AgentChatUsage
  /** 本轮实际注入的技能 id；没命中就不出现。 */
  skillsUsed?: string[]
  /** 本轮实际注入的提示词预设 id（按注入顺序）。一条都没启用就不出现。 */
  promptsUsed?: string[]
  /** 为塞进上下文预算丢掉的旧消息条数；0 = 没裁。 */
  trimmed: number
}

/** 流式对话的一帧，与后端 `AgentStreamEvent` 一一对应。 */
export type AgentStreamEvent = {
  type: 'start' | 'delta' | 'reasoning' | 'tool_start' | 'tool_end' | 'usage' | 'end' | 'error'
  engine?: string
  model?: string
  text?: string
  toolId?: string
  callId?: string
  args?: Record<string, string>
  status?: string
  code?: string
  message?: string
  ms?: number
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  content?: string
  toolRounds?: string[]
  skills?: string[]
  /** start/end：本轮实际注入的提示词预设 id。 */
  prompts?: string[]
  /** start/end：为塞进上下文预算丢掉的旧消息条数；没裁时不出现。 */
  trimmed?: number
}

export type AgentModelListResult = {
  models: string[]
  /** false = 这个协议不提供模型清单（如 Anthropic），界面应退回自由输入。 */
  supported: boolean
}

export type AgentSkill = {
  id: string
  name: string
  description: string
  keywords: string[]
  enabled: boolean
  /** 内置技能（不在磁盘上）；可以覆盖保存，但不能删除。 */
  builtin: boolean
  content: string
}

export type AgentSkillInput = {
  id?: string
  name: string
  description?: string
  keywords?: string[]
  content: string
  enabled?: boolean
}

/** 提示词预设 —— 管"怎么说话"（语气、字数、格式），启用的每条都注入 system，对所有对话生效。 */
export type AgentPrompt = {
  id: string
  name: string
  instruction: string
  enabled: boolean
  /** 越小越先注入；相等时按名称。 */
  order: number
}

export type AgentPromptInput = {
  id?: string
  name: string
  instruction: string
  enabled: boolean
  order?: number
}
