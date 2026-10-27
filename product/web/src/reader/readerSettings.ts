import { DEFAULT_MAPS, looksLikeGrid, migrateGrid, sanitizeMap, type TapMap } from './tapZones'
import { DEFAULT_READER_MENU, parseReaderMenu, type ReaderMenuAction } from './readerMenu'
import { parseScriptMode, type ScriptMode } from './scriptConvert'
import type { PageTurnAnim } from './pageTurn'
import { READER_FONT_SIZE_MAX, READER_FONT_SIZE_MIN } from './fontSizeControl'

/** 内置三套皮肤；同时允许任意自定义 id —— 配合注入 `.theme-<id>` 的 CSS 变量即可加皮肤，不必改这个类型。 */
export type ReaderTheme = 'light' | 'paper' | 'dark' | (string & {})
/** 内置那三档的 id（自定义皮肤要叠在其中一档之上，所以这个集合要能被类型化地表达）。 */
export type BuiltinSkinId = 'light' | 'paper' | 'dark' | 'qingzhu' | 'mulan' | 'meigui' | 'shimo'
/**
 * 内置字体栈（本机已装优先，逐级回落）；`custom` 表示用 `customFont` 里用户自己填的字体名。
 */
export type ReaderFont = 'song' | 'hei' | 'kai' | 'fangsong' | 'system' | 'yuan' | 'mono' | 'custom'
export type ReaderPageMode = 'scroll' | 'paginate'
/**
 * 分页模式的翻页动画（参照 legado-with-MD3 的 PageAnim）：
 * `slide` 平移过渡（默认，整条栏流滑过去）、`fade` 淡化（旧页淡出新页淡入）、
 * `cover` 覆盖（新页从右盖住旧页，旧页不动）、`none` 即时切换。
 * 仿真卷页要 canvas 逐帧重画，先不承诺 —— 值域与渲染分开，将来加一个值 + 一处渲染即可。
 * 只在 `pageMode === 'paginate'` 下生效。值域的唯一出处是 `pageTurn.ts`。
 */
export type ReaderPageAnim = PageTurnAnim
export type ReaderColumnMode = 'auto' | 'single' | 'double'
/**
 * 正文对齐：`justify` 两端对齐（中文出版惯例，默认）、`left` 左对齐（西文混排/等宽字体下更自然）。
 * CSS 侧从写死的 `text-align: justify` 改读 `--reader-text-align`（styles.css 的正文段落规则）。
 */
export type ReaderTextAlign = 'justify' | 'left'
export type TtsEngineType = 'webSpeech' | 'edge' | 'custom'

/** 一套自定义皮肤（用户可存许多套，见 `customSkins`）。 */
export type CustomSkin = {
  id: string
  name: string
  css: string
  base: BuiltinSkinId
  /**
   * 这一套怎么取"自己没写的那些变量"。
   *
   * - `'overlay'`（**老数据缺省这个**，逐字节保持历史行为）：叠在 `base` 那套内置皮肤之上，
   *   没写到的变量沿用那一套的取值。
   * - `'standalone'`：全权自定义 —— 只挂自己这一个类，没写到的变量落到 `styles.css`
   *   里 `:root` 的中性颜色基线，**不沿用任何预设皮肤**。
   *
   * 用户原话：「自定义不是叠在哪一套之上（没写到的变量沿用那一套），是全权自定义」。
   * 做成可选而不是直接改掉，是因为 `overlay` 是既有 12 套以内数据的现状语义；
   * 老记录没有这个字段 → 解析成 `overlay` → 外观一个像素都不动，想要全权的那一套手动切。
   */
  mode?: SkinMode
}

/** 自定义皮肤的两种语义。 */
export type SkinMode = 'overlay' | 'standalone'

/** 没写 mode 的老数据按历史语义走（不改变既有外观）。 */
export const DEFAULT_SKIN_MODE: SkinMode = 'overlay'

export function parseSkinMode(mode: unknown): SkinMode {
  return mode === 'standalone' ? 'standalone' : DEFAULT_SKIN_MODE
}

export type ReaderSettings = {
  theme: ReaderTheme
  /**
   * 自定义皮肤**库**（用户 2026-10-11：「所有的自定义是可以自己定义保存……可以自定义许多个，并有记录保存」）：
   * 每一套 = id（拼成 `.theme-<id>` 类名）+ 显示名 + 完整 CSS + 叠在哪一档内置皮肤之上。
   * 全部只存 localStorage —— 这是这台机器自己的外观，不上传服务端，也不进备份包。
   * 当前启用哪一套由 `theme`（等于那一套的 id）决定；`theme` 是内置档时库里哪套都不生效。
   */
  customSkins: CustomSkin[]
  fontSize: number
  lineHeight: number
  letterSpacing: number
  paragraphSpacing: number
  /** 首行缩进，单位 em（0 / 1 / 2 三档；2 是中文出版惯例，也是上游 Legado 的默认）。 */
  textIndent: number
  contentPadding: number
  font: ReaderFont
  pageMode: ReaderPageMode
  pageAnim: ReaderPageAnim
  maxWidth: number
  columnMode: ReaderColumnMode
  textAlign: ReaderTextAlign
  /** 漫画单图模式：书源 `bookSourceType === 2` 时一屏一图、按图翻页；关掉则按普通图文混排。 */
  mangaSinglePage: boolean
  sidebarPinned: boolean
  /**
   * 固定目录（`sidebarPinned`）时目录栏的宽度，px。
   * 目录与正文之间那条边界可以左右拖（用户 2026-10-09：「我希望目录与正文边界能左右移动部分」）——
   * 拖出来的值存在这里；正文区与点击分区的范围都跟着它走。
   */
  sidebarWidth: number
  ttsEngine: TtsEngineType
  ttsVoice: string
  ttsSpeed: number
  ttsPitch: number
  ttsAutoNextChapter: boolean
  ttsFilterSymbols: boolean
  ttsCustomUrl?: string
  ttsCustomBody?: string
  ttsCustomMethod?: string
  /**
   * 自定义 HTTP 源的发音人标识，填进 `{{speakVoice}}`。
   * 刻意不与 `ttsVoice` 共用一个字段：ttsVoice 的取值来自 Edge 音色表 / 系统音色表，
   * 切到自定义引擎时把 `zh-CN-XiaoxiaoNeural` 原样发给用户自己的 TTS 服务是错的，
   * 反过来把用户填的标识留着又会污染 Edge / 系统那两个引擎的选择。
   */
  ttsCustomVoice?: string
  /** 附加请求头，JSON 对象文本（例如 `{"Authorization": "Bearer xxx"}`）。第三方 TTS 基本都要一个 key。 */
  ttsCustomHeader?: string
  /**
   * 导入本地 TXT 时用哪条目录规则切章：`auto` 让服务端按正文打分选，
   * `builtin` 强制用服务端原本那条逐行匹配，其余是规则 id（选项来自 `GET /api/books/toc-rules`）。
   * 这是**下一本**的默认值；已经进来的书以自己记着的那条为准（`BookshelfItem.tocRule`）。
   */
  txtTocRule: string
  /**
   * 自定义字体名（`font === 'custom'` 时生效，直接作为 `--reader-font-family`）。
   * 可以填本机已装字体的名字，也可以由设置面板导入字体文件/地址后自动填入族名
   * （文件存在浏览器 IndexedDB 里，见 `lib/fontLibrary.ts`）。原样是用户的输入，
   * 存取都要过 `parseCustomFont` 滤掉能拼坏 CSS 的字符。
   */
  customFont: string
  /**
   * 小说阅读背景（用户 2026-10-10：「小说界面背景」可以自定义）：
   * 纯色 + 可选的背景图（URL）+ 压暗比例。三者叠加在阅读区上，文字仍按主题墨色渲染；
   * 全空 = 跟随主题画布。图片只存这个浏览器（localStorage），不上传服务端。
   */
  readerBgColor: string
  readerBgImage: string
  readerBgDim: number
  /**
   * 点击分区（用户 2026-10-04：「可以自定义点击区域范围并设置，自定义管理」；
   * 2026-10-09：「区域设置改提供横竖虚线，自定义，但是要区分翻页方式的影响」）。
   * 两种翻页方式各一张虚线表 —— 默认值就是改动前那三区，不改不漂移。
   */
  tapZones: { paginate: TapMap; scroll: TapMap }
  /**
   * 右上角工具栏显示哪些按钮、按什么顺序（用户 2026-10-11：「阅读菜单可配置」）。
   * 出厂值 = 改动前那一排；配置项见 `readerMenu.ts`（唯一来源，工具栏与配置面板共用）。
   */
  menuItems: ReaderMenuAction[]
  /**
   * 简繁转换（用户 2026-10-11 的 A–F 里 C 项）：`off` 原文 / `s2t` 简→繁 / `t2s` 繁→简。
   * 正文与章名一起转（只转正文会出现"标题简体、正文繁体"）。词表在 `scriptConvert.ts`，
   * 那一份 200KB 上下的字典**开了才载**，默认不进首屏。
   */
  scriptMode: ScriptMode
}

const storageKey = 'legado-reader-settings-v2'
export const defaultReaderSettings: ReaderSettings = {
  theme: 'light',
  customSkins: [],
  fontSize: 19,
  lineHeight: 1.95,
  letterSpacing: 0,
  paragraphSpacing: 1.15,
  textIndent: 2,
  contentPadding: 80,
  font: 'song',
  pageMode: 'scroll',
  pageAnim: 'slide',
  maxWidth: 860,
  columnMode: 'auto',
  textAlign: 'justify',
  mangaSinglePage: true,
  sidebarPinned: false,
  sidebarWidth: 300,
  ttsEngine: 'edge',
  ttsVoice: 'zh-CN-XiaoxiaoNeural',
  ttsSpeed: 1.0,
  ttsPitch: 1.0,
  ttsAutoNextChapter: true,
  ttsFilterSymbols: true,
  ttsCustomUrl: '',
  ttsCustomBody: '',
  ttsCustomMethod: 'GET',
  ttsCustomVoice: '',
  ttsCustomHeader: '',
  txtTocRule: 'auto',
  customFont: '',
  readerBgColor: '',
  readerBgImage: '',
  readerBgDim: 0.25,
  tapZones: { paginate: DEFAULT_MAPS.paginate, scroll: DEFAULT_MAPS.scroll },
  menuItems: DEFAULT_READER_MENU,
  scriptMode: 'off',
}

export function clampScrollPosition(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

export function scrollPosition(scrollTop: number, scrollHeight: number, clientHeight: number): number {
  return clampScrollPosition(scrollTop / Math.max(1, scrollHeight - clientHeight))
}

/**
 * 数值项的读取一律走这里。以前各字段自己写 `typeof x === 'number' ? Math.min(...)`，
 * 而 `NaN` 也满足 `typeof === 'number'`，`Math.min/max(NaN)` 又返回 `NaN` ——
 * localStorage 里存进一个 NaN（旧版本或被改坏的 JSON）就会让 `--reader-font-size: NaNpx`
 * 这种无效值一路发到 CSS，浏览器整条声明作废，界面表现为"设置突然不生效"。
 */
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export function parseReaderFont(font: unknown): ReaderFont {
  if (font === 'hei' || font === 'kai' || font === 'fangsong' || font === 'system' || font === 'yuan' || font === 'mono' || font === 'custom') return font
  return 'song'
}

/**
 * 自定义字体名只允许"字体名该有的字符"：字母/数字/空格/逗号/引号/连字符/CJK。
 * 能拼坏 CSS 的（`{ } < > @ ; \` 反斜杠）一律剥掉——这个串会被直接放进 font-family。
 */
export function parseCustomFont(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[{}<>@;\\]/g, '').trim().slice(0, 120)
}

/** 背景色只认 #RGB/#RRGGBB/#RRGGBBAA；空串 = 跟随主题。 */
export function parseBgColor(value: unknown): string {
  if (typeof value !== 'string') return ''
  return /^#[0-9a-fA-F]{3,8}$/.test(value.trim()) ? value.trim().toLowerCase() : ''
}

/** 背景图只认 http(s) 绝对地址、站内相对路径（/ 开头）或 data:image；带引号的一律不要。 */
export function parseBgImage(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim().slice(0, 600)
  if (/^(https?:\/\/|\/|data:image\/)/.test(trimmed) && !trimmed.includes('"') && !trimmed.includes('\\')) return trimmed
  return ''
}

export function parsePageMode(mode: unknown): ReaderPageMode {
  return mode === 'paginate' ? 'paginate' : 'scroll'
}

export function parsePageAnim(anim: unknown): ReaderPageAnim {
  return anim === 'fade' || anim === 'cover' || anim === 'none' ? anim : 'slide'
}

/**
 * 皮肤 id 会被拼成类名 `.theme-<id>`，所以只允许 `[a-z0-9-_]`：
 * 带空格、引号、`>` 之类的输入会把类名拼坏（甚至拼出别的 selector），一律滤掉。
 * 滤完为空就当作"没有自定义皮肤"。
 */
export function parseSkinId(id: unknown): string {
  return typeof id === 'string' ? id.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 32) : ''
}

/** 内置四套皮肤。名字只写一处，两套外壳与「自定义」弹窗共用（各自定义一份迟早会漂移）。 */
export const BUILTIN_SKINS: ReadonlyArray<{ id: BuiltinSkinId; name: string }> = [
  { id: 'light', name: '晓白' },
  { id: 'paper', name: '护眼' },
  { id: 'dark', name: '夜读' },
  { id: 'qingzhu', name: '青竹' },
  { id: 'mulan', name: '暮蓝' },
  { id: 'meigui', name: '玫瑰' },
  { id: 'shimo', name: '石墨' },
]

/** 当前可选的皮肤：内置七套 + 库里每一套自定义皮肤（没写 CSS 的不出现，不摆点了没反应的控件）。 */
export function availableSkins(settings: ReaderSettings): Array<{ id: string; name: string; builtin: boolean }> {
  const custom = (settings.customSkins ?? [])
    .filter(skin => skin.id && skin.css.trim())
    .map(skin => ({ id: skin.id, name: skinLabel(skin), builtin: false }))
  return [...BUILTIN_SKINS.map(skin => ({ ...skin, builtin: true })), ...custom]
}

/** 自定义皮肤没写基档时的默认档。 */
export const DEFAULT_SKIN_BASE: BuiltinSkinId = 'light'

/** 自定义皮肤的**叠在哪一套之上**（只认内置档，别的值退回默认档）。 */
export function parseSkinBase(base: unknown): BuiltinSkinId {
  return BUILTIN_SKINS.some(skin => skin.id === base) ? base as BuiltinSkinId : DEFAULT_SKIN_BASE
}

/**
 * 清洗一套自定义皮肤：id 过 `parseSkinId`（拼类名用），name 去换行并限长，css 限长（注入走 textContent），
 * base 只认内置档。id 清洗后为空、或 css 为空 → 返回 null（这一套不成立，不进库）。
 */
export function parseCustomSkin(value: unknown): CustomSkin | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = parseSkinId(raw.id)
  const css = typeof raw.css === 'string' ? raw.css.slice(0, 20000) : ''
  if (!id || !css.trim()) return null
  const name = typeof raw.name === 'string' ? raw.name.replace(/[\r\n]+/g, ' ').trim().slice(0, 40) : ''
  return { id, name, css, base: parseSkinBase(raw.base), mode: parseSkinMode(raw.mode) }
}

/** 清洗皮肤库：逐套过 `parseCustomSkin`，丢掉不成立的；同 id 只留最后一套。 */
export function parseCustomSkins(value: unknown): CustomSkin[] {
  if (!Array.isArray(value)) return []
  const byId = new Map<string, CustomSkin>()
  for (const item of value) {
    const skin = parseCustomSkin(item)
    if (skin) byId.set(skin.id, skin)
  }
  return [...byId.values()]
}

/** 库里一套皮肤的显示名：用户没起名就用 id 兜底。 */
export function skinLabel(skin: CustomSkin): string {
  return skin.name.trim() || `自定义（${skin.id}）`
}

/** 当前启用的那一套自定义皮肤（`theme` 命中库里某个 id 时），否则 undefined。 */
export function activeCustomSkin(settings: ReaderSettings): CustomSkin | undefined {
  const id = parseSkinId(settings.theme)
  return (settings.customSkins ?? []).find(skin => skin.id === id)
}

/**
 * 皮肤类名列表 —— 一套自定义皮肤到底挂几个类，由那一套的 `mode` 决定。
 *
 * - `overlay`（老数据缺省）：**叠在内置皮肤上，不是替换它**。
 *   为什么当年必须叠：用户只写两三条变量（例如只改 `--canvas`）是常见用法，
 *   若页面上只有 `.theme-midnight` 一个类，而那时 `:root` 又没定义任何颜色令牌，
 *   其余 `--surface / --ink / --line` 全部落空，界面直接变成"字和底一个颜色"。
 * - `standalone`：**全权自定义**，只挂自己这一个类。没写到的变量落到 `styles.css`
 *   最前面那个 `:root` 里的中性颜色基线（本次一并补上的），**不沿用任何预设皮肤**。
 *   用户要的正是这个语义：「自定义不是叠在哪一套之上，是全权自定义」。
 *   这条能成立的前提就是那份 `:root` 基线 —— 没有它就会复现上面那个花屏事故。
 */
export function themeClassNames(settings: ReaderSettings): string[] {
  const active = activeCustomSkin(settings)
  if (active) {
    return active.mode === 'standalone'
      ? [`theme-${active.id}`]
      : [`theme-${parseSkinBase(active.base)}`, `theme-${active.id}`]
  }
  return [`theme-${settings.theme}`]
}

export function parseColumnMode(mode: unknown): ReaderColumnMode {
  if (mode === 'single' || mode === 'double' || mode === 'auto') return mode
  return 'auto'
}

export function parseTextAlign(value: unknown): ReaderTextAlign {
  return value === 'left' ? 'left' : 'justify'
}

/** 首行缩进只认 0 / 1 / 2 三档：滑杆给中间值（比如 1.3em）在中文里没有对应排版惯例，只会显得没对齐。 */
export const READER_TEXT_INDENTS = [0, 1, 2] as const
export function parseTextIndent(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : null
  if (numeric === null) return defaultReaderSettings.textIndent
  return READER_TEXT_INDENTS.reduce((best, option) => (Math.abs(option - numeric) < Math.abs(best - numeric) ? option : best), 0)
}

export function parseMaxWidth(width: unknown): number {
  return Math.round(clampNumber(width, 560, 1400, defaultReaderSettings.maxWidth))
}

export function parseTtsEngine(engine: unknown): TtsEngineType {
  if (engine === 'webSpeech' || engine === 'edge' || engine === 'custom') return engine
  return defaultReaderSettings.ttsEngine
}

/**
 * 本地书目录规则的键：`auto` / `builtin` / 一个规则 id（上游那份表里全是负数）。
 *
 * 有意**不做白名单校验**：合法取值来自服务端 `GET /api/books/toc-rules`，前端硬编码一份迟早漂移。
 * 但形状要挡：这个串会被拼进查询参数与请求体，空串、超长、带符号的都当没填。
 */
export function parseTocRuleKey(value: unknown): string {
  if (typeof value !== 'string') return defaultReaderSettings.txtTocRule
  const trimmed = value.trim()
  return /^(auto|builtin|-?[0-9]{1,6})$/.test(trimmed) ? trimmed : defaultReaderSettings.txtTocRule
}

/**
 * 真正发给 TTS 的发音人。自定义引擎用它自己那一栏（`{{speakVoice}}` 的取值），
 * 其余引擎用音色表选出来的 ttsVoice。Edge 的音色 id 不该出现在用户自建服务的请求里，
 * 反过来也一样 —— 所以两边各存各的，这里只在发出去的一刻汇合。
 */
export function effectiveTtsVoice(settings: ReaderSettings): string {
  if (settings.ttsEngine === 'custom') return (settings.ttsCustomVoice ?? '').trim()
  return settings.ttsVoice?.trim() || defaultReaderSettings.ttsVoice
}

/**
 * "会话身份"：这串里任何一项变了，正在播的音频流就得推倒重来（换引擎、换音色、改语速、
 * 改自定义地址…），否则会出现两条声音叠在一起（用户 2026-09-30「朗读引擎在使用中切换会重音，都启动」）。
 * 语速/语调也在里面：当前这句继续用旧速率播完、下一句才变，读起来是"改了没生效"。
 *
 * `ttsEngine.ts` 的 sessionSettingsKey 与本函数是同一件事的两个名字，所以下面直接引用来一处定义，
 * 避免界面判定与会话判定漂移成两套（漂移过的后果见 AGENTS.md 的跨章竞态那条）。
 */
export function ttsSessionKey(settings: ReaderSettings): string {
  return [
    settings.ttsEngine,
    effectiveTtsVoice(settings),
    settings.ttsSpeed,
    settings.ttsPitch,
    settings.ttsCustomUrl ?? '',
    settings.ttsCustomMethod ?? 'GET',
    settings.ttsCustomBody ?? '',
    settings.ttsCustomHeader ?? '',
  ].join('|')
}

/** 旧版存的是"格子表"（`{rows, cols, actions}`），新版是"虚线表"（`{x, y, actions}`）：读时迁一次。 */
function loadTapMap(value: unknown, fallback: TapMap): TapMap {
  return looksLikeGrid(value) ? migrateGrid(value, fallback) : sanitizeMap(value, fallback)
}

/**
 * 皮肤库的读取 + 一次性迁移：新版读 `customSkins` 数组；旧版只有单套
 * （`customSkinId` / `customSkinCss` / `customSkinBase`），把它迁成库里的第一套，别丢用户已存的皮肤。
 */
function loadCustomSkins(saved: Record<string, unknown>): CustomSkin[] {
  const list = parseCustomSkins(saved.customSkins)
  if (list.length) return list
  const migrated = parseCustomSkin({ id: saved.customSkinId, css: saved.customSkinCss, base: saved.customSkinBase })
  return migrated ? [migrated] : []
}

export function loadReaderSettings(): ReaderSettings {
  try {
    const raw = window.localStorage.getItem(storageKey) || window.localStorage.getItem('legado-reader-settings-v1')
    const saved = JSON.parse(raw ?? '{}') as Partial<ReaderSettings> & { font?: string }
    return {
      theme: typeof saved.theme === 'string' && saved.theme.trim() ? saved.theme.trim() : defaultReaderSettings.theme,
      customSkins: loadCustomSkins(saved as unknown as Record<string, unknown>),
      fontSize: clampNumber(saved.fontSize, READER_FONT_SIZE_MIN, READER_FONT_SIZE_MAX, defaultReaderSettings.fontSize),
      lineHeight: clampNumber(saved.lineHeight, 1.45, 2.4, defaultReaderSettings.lineHeight),
      letterSpacing: clampNumber(saved.letterSpacing, -.25, 1.5, defaultReaderSettings.letterSpacing),
      paragraphSpacing: clampNumber(saved.paragraphSpacing, .7, 2, defaultReaderSettings.paragraphSpacing),
      textIndent: parseTextIndent(saved.textIndent),
      contentPadding: clampNumber(saved.contentPadding, 20, 120, defaultReaderSettings.contentPadding),
      font: parseReaderFont(saved.font),
      pageMode: parsePageMode(saved.pageMode),
      pageAnim: parsePageAnim(saved.pageAnim),
  maxWidth: parseMaxWidth(saved.maxWidth),
  columnMode: parseColumnMode(saved.columnMode),
  textAlign: parseTextAlign(saved.textAlign),
      mangaSinglePage: typeof saved.mangaSinglePage === 'boolean' ? saved.mangaSinglePage : defaultReaderSettings.mangaSinglePage,
      sidebarPinned: typeof saved.sidebarPinned === 'boolean' ? saved.sidebarPinned : defaultReaderSettings.sidebarPinned,
      sidebarWidth: Math.round(clampNumber(saved.sidebarWidth, 220, 560, defaultReaderSettings.sidebarWidth)),
      ttsEngine: parseTtsEngine(saved.ttsEngine),
      ttsVoice: typeof saved.ttsVoice === 'string' && saved.ttsVoice.trim() ? saved.ttsVoice : defaultReaderSettings.ttsVoice,
      ttsSpeed: clampNumber(saved.ttsSpeed, 0.5, 3.0, defaultReaderSettings.ttsSpeed),
      ttsPitch: clampNumber(saved.ttsPitch, 0.5, 1.5, defaultReaderSettings.ttsPitch),
      ttsAutoNextChapter: typeof saved.ttsAutoNextChapter === 'boolean' ? saved.ttsAutoNextChapter : defaultReaderSettings.ttsAutoNextChapter,
      ttsFilterSymbols: typeof saved.ttsFilterSymbols === 'boolean' ? saved.ttsFilterSymbols : defaultReaderSettings.ttsFilterSymbols,
      ttsCustomUrl: typeof saved.ttsCustomUrl === 'string' ? saved.ttsCustomUrl : '',
      ttsCustomBody: typeof saved.ttsCustomBody === 'string' ? saved.ttsCustomBody : '',
      ttsCustomMethod: saved.ttsCustomMethod === 'POST' ? 'POST' : 'GET',
      ttsCustomVoice: typeof saved.ttsCustomVoice === 'string' ? saved.ttsCustomVoice : '',
      ttsCustomHeader: typeof saved.ttsCustomHeader === 'string' ? saved.ttsCustomHeader : '',
      txtTocRule: parseTocRuleKey(saved.txtTocRule),
      customFont: parseCustomFont(saved.customFont),
      readerBgColor: parseBgColor(saved.readerBgColor),
      readerBgImage: parseBgImage(saved.readerBgImage),
      readerBgDim: clampNumber(saved.readerBgDim, 0, .6, defaultReaderSettings.readerBgDim),
      // 缺项/写错都回落到出厂那张表（不清洗就会点到 undefined 上，表现为"这一格没反应"）；
      // 旧版存的是"格子表"，新版是"虚线表"，读的时候迁一次。
      tapZones: {
        paginate: loadTapMap((saved.tapZones as Record<string, unknown> | undefined)?.paginate, DEFAULT_MAPS.paginate),
        scroll: loadTapMap((saved.tapZones as Record<string, unknown> | undefined)?.scroll, DEFAULT_MAPS.scroll),
      },
      menuItems: parseReaderMenu(saved.menuItems),
      scriptMode: parseScriptMode(saved.scriptMode),
    }
  } catch {
    return defaultReaderSettings
  }
}

export const readerFontFamilies: Record<ReaderFont, string> = {
  song: '"Songti SC", "STSong", "SimSun", "Noto Serif CJK SC", "Noto Serif SC", "Source Han Serif SC", "Songti", STSongti, serif',
  hei: '"PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "WenQuanYi Micro Hei", "Noto Sans CJK SC", "Source Han Sans SC", "Heiti SC", sans-serif',
  kai: '"Kaiti SC", "STKaiti", "KaiTi", "SimKai", "KaiTi_GB2312", "STKaiti-SC-Regular", "BiauKai", "DFKai-SB", 楷体，楷体_GB2312, serif',
  fangsong: '"FangSong", "STFangsong", "FangSong_GB2312", "STFangsong-SC-Regular", "SimFang", 仿宋，仿宋_GB2312, serif',
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif',
  yuan: '"Yuanti SC", "YouYuan", "幼圆", "Hiragino Maru Gothic ProN", "Source Han Sans SC Rounded", ui-rounded, "PingFang SC", sans-serif',
  mono: '"Sarasa Mono SC", "更纱黑体", "Cascadia Code", "JetBrains Mono", "Consolas", "Source Han Mono SC", "Noto Sans Mono CJK SC", monospace',
  custom: 'inherit',
}

export function getReaderFontFamily(font: ReaderFont): string {
  return readerFontFamilies[font] || readerFontFamilies.song
}

/**
 * 真正发进 `--reader-font-family` 的字体栈：`font === 'custom'` 且填了自定义名时用用户那份，
 * 其余走内置表。自定义名是用户输入，出 `parseCustomFont` 时已经是干净的了。
 */
export function effectiveReaderFontFamily(settings: ReaderSettings): string {
  if (settings.font === 'custom') {
    const custom = settings.customFont.trim()
    if (custom) return custom
  }
  return getReaderFontFamily(settings.font)
}

export function saveReaderSettings(settings: ReaderSettings): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(settings))
  } catch {
    // 隐私模式/配额满：保存失败不该在 App 的 effect 里把整棵树炸掉（load 路径有守卫，save 原来没有）
  }
}



