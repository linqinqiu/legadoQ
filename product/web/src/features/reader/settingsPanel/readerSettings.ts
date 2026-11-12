import { pushUiPref } from '../../../lib/uiPrefs'
import { DEFAULT_MAPS, looksLikeGrid, migrateGrid, sanitizeMap, type TapMap } from '../interaction/tapZones'
import { DEFAULT_READER_MENU, parseReaderMenu, type ReaderMenuAction } from '../interaction/readerMenu'
import { parseScriptMode, type ScriptMode } from '../content/scriptConvert'
import type { MangaDirection } from '../content/mangaPages'
import type { PageTurnAnim } from '../interaction/pageTurn'
import { READER_FONT_SIZE_MAX, READER_FONT_SIZE_MIN } from '../content/fontSizeControl'
import { clampNumber, clampScrollPosition, scrollPosition } from '../../../lib/scrollProgress'

/**
 * 这三个纯函数已下沉到 `lib/scrollProgress.ts`（它们不引用任何 `ReaderSettings`，
 * 而 shared 侧的 `BookDetailModal` 也要用 `scrollPosition`，放在这里就是一条
 * shared → feature 反向依赖）。此处**原样再导出**，既有同域调用点不受影响。
 */
export { clampNumber, clampScrollPosition, scrollPosition }

/** 内置七套皮肤；同时允许任意自定义 id —— 配合注入 `.theme-<id>` 的 CSS 变量即可加皮肤，不必改这个类型。 */
export type ReaderTheme = 'light' | 'paper' | 'dark' | (string & {})
/** 内置那七档的 id（内置列表要按类型逐个列出来，所以单独收一个联合类型）。 */
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

/**
 * 一套自定义皮肤（用户可存许多套，见 `customSkins`）。
 *
 * 只有三个字段：id（拼成 `.theme-<id>` 类名）、显示名、完整 CSS。
 * **没有"叠在哪一档内置皮肤之上"这种半套语义**：自定义就是全权自定义，
 * 没写到的变量落到 `styles.css` 最前面的 `:root` 中性基线，不跟随任何预设皮肤。
 * 老数据里的 `base` / `mode` 字段读的时候直接忽略（`parseCustomSkin` 不接收它们）。
 */
export type CustomSkin = {
  id: string
  name: string
  css: string
}

/**
 * 对一套内置皮肤的改动：只存用户改写的那两栏，空字段表示"用出厂值"。
 *
 * 用户 2026-11-02：「固定的也能编辑或删除」。内置皮肤不再是一块动不得的底板：
 * 可以改名、换 CSS，也可以从皮肤列表里删掉（只是隐藏，随时能恢复）。
 * 改动与自定义皮肤分开存，内置 id 仍是自定义皮肤的保留字 —— 否则一条同名自定义
 * 就能悄悄覆盖内置皮肤，界面上却看不到"这是自定义"。
 */
export type BuiltinSkinOverride = {
  name: string
  css: string
}

export type BuiltinSkinOverrides = Partial<Record<BuiltinSkinId, BuiltinSkinOverride>>

/**
 * 一套阅读背景预设（用户可存许多套）。
 *
 * 背景与皮肤是两件事：皮肤管整套界面的配色令牌，背景只铺在阅读区上。
 * 预设保存"颜色 + 图片地址 + 压暗比例"三件套，点一下整体套用、可编辑可删除。
 * 只存 localStorage，不进备份包。
 */
export type ReaderBackground = {
  id: string
  name: string
  color: string
  image: string
  dim: number
}

export type ReaderSettings = {
  theme: ReaderTheme
  /**
   * 自定义皮肤**库**（用户 2026-10-11：「所有的自定义是可以自己定义保存……可以自定义许多个，并有记录保存」）：
   * 每一套 = id（拼成 `.theme-<id>` 类名）+ 显示名 + 完整 CSS，可新增 / 编辑 / 删除 / 切换。
   * 全部只存 localStorage —— 这是这台机器自己的外观，不上传服务端，也不进备份包。
   * 当前启用哪一套由 `theme`（等于那一套的 id）决定；`theme` 是内置档时库里哪套都不生效。
   */
  customSkins: CustomSkin[]
  /** 内置七套的改名 / 换 CSS；键是内置 id，空字段用出厂值。只存本机，不进备份包。 */
  builtinSkinOverrides: BuiltinSkinOverrides
  /** 从皮肤列表里删掉的内置 id（只隐藏，不抹掉改动；随时可恢复）。 */
  hiddenBuiltinSkins: BuiltinSkinId[]
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
  /**
   * 漫画双页对开：宽屏（≥720px）一屏并排两张，窄屏自动退回一张。
   * 页号按屏对齐（1–2、3–4），跨屏不串页；末屏只剩一张时就是单页。
   */
  mangaSpread: boolean
  /** 双页顺序：`ltr` 前一张在左（国漫），`rtl` 前一张在右（日漫）。单页模式看不出区别。 */
  mangaDirection: MangaDirection
  /**
   * 封面取色：阅读时按当前这本文档的封面算一版 M3 配色覆盖皮肤（见 `src/ui/README.md`）。
   * 只有封面能被算出"够鲜艳"的种子色时才真的覆盖，纯白/纯黑/灰图一律保持皮肤原样。
   */
  coverTheme: boolean
  /**
   * 壁纸取色：壁纸开着且不在读书时，按壁纸主色生成一版配色。
   * 与 `coverTheme` 是**同一条链的两端**（都是 seed → M3 → 覆盖皮肤），
   * 区别只在种子从哪来：读书时用封面，平时用壁纸。两个都关 = 完全听皮肤。
   */
  wallpaperTheme: boolean
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
  /** 背景预设库：把当前背景存成一条，之后一键套用；与皮肤库同样只存本机。 */
  customBackgrounds: ReaderBackground[]
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
  builtinSkinOverrides: {},
  hiddenBuiltinSkins: [],
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
  mangaSpread: false,
  mangaDirection: 'ltr',
  coverTheme: true,
  wallpaperTheme: true,
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
  customBackgrounds: [],
  tapZones: { paginate: DEFAULT_MAPS.paginate, scroll: DEFAULT_MAPS.scroll },
  menuItems: DEFAULT_READER_MENU,
  scriptMode: 'off',
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

/** 内置七套皮肤。名字只写一处，顶栏菜单与「皮肤」浮层共用（各自定义一份迟早会漂移）。 */
export const BUILTIN_SKINS: ReadonlyArray<{ id: BuiltinSkinId; name: string }> = [
  { id: 'light', name: '晓白' },
  { id: 'paper', name: '护眼' },
  { id: 'dark', name: '夜读' },
  { id: 'qingzhu', name: '青竹' },
  { id: 'mulan', name: '暮蓝' },
  { id: 'meigui', name: '玫瑰' },
  { id: 'shimo', name: '石墨' },
]

/**
 * 内置七套的 id 是保留字。内置皮肤本身可以改（改动用 `builtinSkinOverrides` 单独存），
 * 但不允许自定义皮肤占用同名 id —— 否则一条同名自定义就能盖掉内置配色，
 * 界面与数据层也分不清"这是内置皮肤被改了"还是"多了一套自定义"。
 * 保存前由 `parseCustomSkin` 拒绝；旧数据、手改 localStorage 再在 `availableSkins`
 * 与 `activeCustomSkin` 各挡一层，内置皮肤永远优先。
 */
export function isBuiltinSkinId(id: unknown): id is BuiltinSkinId {
  const normalized = parseSkinId(id)
  return BUILTIN_SKINS.some(skin => skin.id === normalized)
}

/** 某一套内置皮肤被改动的部分（没有改动时 undefined）。 */
export function builtinSkinOverride(settings: ReaderSettings, id: BuiltinSkinId): BuiltinSkinOverride | undefined {
  return settings.builtinSkinOverrides?.[id]
}

/** 内置皮肤当前显示名：改过就用改后的名字，否则用出厂名。 */
export function builtinSkinName(settings: ReaderSettings, id: BuiltinSkinId): string {
  const name = builtinSkinOverride(settings, id)?.name.trim()
  return name || BUILTIN_SKINS.find(skin => skin.id === id)?.name || id
}

/** 用户给内置皮肤写的 CSS；空串 = 沿用 styles.css 里的出厂规则。 */
export function builtinSkinCss(settings: ReaderSettings, id: BuiltinSkinId): string {
  const css = builtinSkinOverride(settings, id)?.css ?? ''
  return css.trim() ? css : ''
}

/** 这套内置皮肤是否已从皮肤列表里删掉（删除只是隐藏，改动仍在，可恢复）。 */
export function isBuiltinSkinHidden(settings: ReaderSettings, id: BuiltinSkinId): boolean {
  return (settings.hiddenBuiltinSkins ?? []).includes(id)
}

/**
 * 清洗一套内置皮肤的改动：名字去换行并限长，CSS 限长（注入走 textContent）。
 * 两栏都空 → 这套没有改动，返回 null（不往存储里留空对象）。
 */
export function parseBuiltinSkinOverride(value: unknown): BuiltinSkinOverride | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const name = typeof raw.name === 'string' ? raw.name.replace(/[\r\n]+/g, ' ').trim().slice(0, 40) : ''
  const css = typeof raw.css === 'string' ? raw.css.slice(0, 20000) : ''
  return name || css.trim() ? { name, css } : null
}

/** 清洗内置改动表：只认内置七套的 id，丢掉空条目与手改出来的未知键。 */
export function parseBuiltinSkinOverrides(value: unknown): BuiltinSkinOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: BuiltinSkinOverrides = {}
  for (const skin of BUILTIN_SKINS) {
    const override = parseBuiltinSkinOverride((value as Record<string, unknown>)[skin.id])
    if (override) result[skin.id] = override
  }
  return result
}

/** 清洗"已删除的内置皮肤"：只留内置 id，去重，并按内置顺序返回。 */
export function parseHiddenBuiltinSkins(value: unknown): BuiltinSkinId[] {
  if (!Array.isArray(value)) return []
  const hidden = new Set<BuiltinSkinId>()
  for (const item of value) {
    const id = parseSkinId(item)
    if (isBuiltinSkinId(id)) hidden.add(id)
  }
  return BUILTIN_SKINS.map(skin => skin.id).filter(id => hidden.has(id))
}

/** 当前可选的皮肤：没被删掉的内置七套（用改后的名字）+ 库里每一套自定义皮肤（没写 CSS 的不出现）。 */
export function availableSkins(settings: ReaderSettings): Array<{ id: string; name: string; builtin: boolean }> {
  const custom = (settings.customSkins ?? [])
    // 同名旧数据不并排展示：同一个 id 出现两张卡时，点哪张都只能落到内置皮肤上。
    .filter(skin => skin.id && skin.css.trim() && !isBuiltinSkinId(skin.id))
    .map(skin => ({ id: skin.id, name: skinLabel(skin), builtin: false }))
  const builtin = BUILTIN_SKINS
    .filter(skin => !isBuiltinSkinHidden(settings, skin.id))
    .map(skin => ({ id: skin.id, name: builtinSkinName(settings, skin.id), builtin: true }))
  return [...builtin, ...custom]
}

/**
 * 清洗一套自定义皮肤：id 过 `parseSkinId`（拼类名用），name 去换行并限长，css 限长（注入走 textContent）。
 * 老数据里的 `base` / `mode` 字段直接忽略 —— 自定义皮肤不再有"叠一档"的语义。
 * id 清洗后为空、css 为空、或撞上内置七套的保留 id → 返回 null（这一套不成立，不进库）。
 */
export function parseCustomSkin(value: unknown): CustomSkin | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = parseSkinId(raw.id)
  const css = typeof raw.css === 'string' ? raw.css.slice(0, 20000) : ''
  if (!id || !css.trim() || isBuiltinSkinId(id)) return null
  const name = typeof raw.name === 'string' ? raw.name.replace(/[\r\n]+/g, ' ').trim().slice(0, 40) : ''
  return { id, name, css }
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
  // 内置 id 永远按内置皮肤解释：旧数据里即使留着同名自定义，也不能顶掉内置配色。
  if (!id || isBuiltinSkinId(id)) return undefined
  return (settings.customSkins ?? []).find(skin => skin.id === id)
}

/**
 * `theme` 实际会落到哪一套：大小写/脏字符先归一，被删掉的内置皮肤与库里没有的 id
 * 都不算数，按内置顺序找第一套还看得见的皮肤。全删光且没有自定义时返回空串，
 * 由调用方按"没有主题"处理（宁可露出中性基线，也不假装一套已删除的皮肤还在）。
 *
 * 界面上的选中态、注入哪份 CSS、T 键轮换都以这里为准：只比 `settings.theme`
 * 会在"删掉当前皮肤"或"导入一份小写不同的 id"时显示错一套。
 */
export function resolveTheme(settings: ReaderSettings): string {
  const theme = parseSkinId(settings.theme)
  if (theme && isBuiltinSkinId(theme) && !isBuiltinSkinHidden(settings, theme)) return theme
  if (theme && !isBuiltinSkinId(theme)) {
    const custom = (settings.customSkins ?? []).find(skin => skin.id === theme && skin.css.trim())
    if (custom) return custom.id
  }
  const builtin = BUILTIN_SKINS.find(skin => !isBuiltinSkinHidden(settings, skin.id))
  if (builtin) return builtin.id
  const custom = (settings.customSkins ?? []).find(skin => skin.id && skin.css.trim() && !isBuiltinSkinId(skin.id))
  return custom?.id ?? ''
}

/**
 * 当前真正生效的皮肤（含内置皮肤的改动）。`css` 是**额外注入**的那份：
 * 内置皮肤没改 CSS 时为空串（出厂规则仍在 styles.css 里），自定义皮肤就是它自己的 CSS。
 */
export function activeSkin(settings: ReaderSettings): { id: string; name: string; css: string; builtin: boolean } | undefined {
  const id = resolveTheme(settings)
  if (!id) return undefined
  if (isBuiltinSkinId(id)) {
    return { id, name: builtinSkinName(settings, id), css: builtinSkinCss(settings, id), builtin: true }
  }
  const custom = (settings.customSkins ?? []).find(skin => skin.id === id && skin.css.trim())
  return custom ? { id, name: skinLabel(custom), css: custom.css, builtin: false } : undefined
}

/** 背景预设 id 只用于列表 key 与内部标识，不拼选择器；仍收紧字符集，避免存进怪东西。 */
export function parseBackgroundId(id: unknown): string {
  return typeof id === 'string' ? id.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 40) : ''
}

/** 清洗一套背景预设：颜色 / 图片 / 压暗各过各自的清洗函数，空颜色 + 空图片是合法的"跟随主题"。 */
export function parseReaderBackground(value: unknown): ReaderBackground | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = parseBackgroundId(raw.id)
  if (!id) return null
  const name = typeof raw.name === 'string' ? raw.name.replace(/[\r\n]+/g, ' ').trim().slice(0, 40) : ''
  return {
    id,
    name,
    color: parseBgColor(raw.color),
    image: parseBgImage(raw.image),
    dim: clampNumber(raw.dim, 0, .6, defaultReaderSettings.readerBgDim),
  }
}

/** 清洗背景库：逐条过 `parseReaderBackground`，同 id 只留最后一条。 */
export function parseReaderBackgrounds(value: unknown): ReaderBackground[] {
  if (!Array.isArray(value)) return []
  const byId = new Map<string, ReaderBackground>()
  for (const item of value) {
    const background = parseReaderBackground(item)
    if (background) byId.set(background.id, background)
  }
  return [...byId.values()]
}

/**
 * 阅读区背景的 CSS 变量。压暗层同时作用于颜色与图片 —— 只压图片的话，滑杆在纯色背景上
 * 是一个怎么拖都没反应的控件，而「背景压暗」这个名字承诺的是背景整体。
 * 颜色与图片都没设时不铺任何东西，让阅读区回到主题画布。
 */
export function readerBackgroundVars(
  settings: Pick<ReaderSettings, 'readerBgColor' | 'readerBgImage' | 'readerBgDim'>,
): { '--reader-bg-color': string; '--reader-bg-image': string } {
  const dimValue = clampNumber(settings.readerBgDim, 0, .6, 0)
  const dim = (settings.readerBgColor || settings.readerBgImage) && dimValue > 0
    ? `linear-gradient(rgb(0 0 0 / ${dimValue}), rgb(0 0 0 / ${dimValue}))`
    : ''
  return {
    '--reader-bg-color': settings.readerBgColor || 'transparent',
    '--reader-bg-image': settings.readerBgImage
      ? (dim ? `${dim}, url("${settings.readerBgImage}")` : `url("${settings.readerBgImage}")`)
      : (dim || 'none'),
  }
}

/** 背景库里的显示名：用户没起名就用 id 兜底。 */
export function backgroundLabel(background: ReaderBackground): string {
  return background.name.trim() || `背景（${background.id}）`
}

/** 生成一个库里没占用的背景 id（时间戳 + 序号；只用于本机存储，不要求可读）。 */
export function newBackgroundId(existing: ReaderBackground[]): string {
  const base = `bg-${Date.now().toString(36)}`
  const used = new Set(existing.map(item => item.id))
  if (!used.has(base)) return base
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`
    if (!used.has(candidate)) return candidate
  }
  return `${base}-${used.size + 1}`
}

/**
 * 皮肤类名列表。每一套（内置或自定义）**只挂自己这一个类**，不叠加别的皮肤。
 *
 * 内置皮肤的出厂配色在 styles.css 的 `.theme-*` 里；用户改过的 CSS 由 `activeSkin`
 * 取出、main.tsx 的 SkinStyle 追加到文档后部，后写的规则覆盖出厂值。
 * 没写到的变量落到 styles.css 最前面那个 `:root` 里的中性颜色基线 ——
 * 那份基线与任何预设配色无关，所以切皮肤不会让自定义皮肤的外观跟着漂移。
 * 这是用户 2026-10-23 定下的语义：「自定义不是叠在哪一套之上，是全权自定义」。
 */
export function themeClassNames(settings: ReaderSettings): string[] {
  const id = resolveTheme(settings)
  return id ? [`theme-${id}`] : []
}

/**
 * 深色系内置皮肤。动态主题要按这个取深色角色表 —— 不能问 `prefers-color-scheme`：
 * 皮肤是用户显式选的七选一，跟着系统走会出现"系统深浅色与所选皮肤打架"。
 */
export const DARK_SKIN_IDS: readonly BuiltinSkinId[] = ['dark', 'shimo']

/**
 * 当前这套皮肤是不是深色。
 *
 * 内置的两套直接查表；**自定义皮肤**没有 metadata，所以从它自己写的 `--canvas` 算亮度
 * （没写 `--canvas` 就落回 styles.css 最前面那份中性浅色基线 → 判为浅色）。
 * 之所以不读 `getComputedStyle`：动态主题覆盖层挂上去之后，算出来的 `--canvas` 已经是
 * 被覆盖后的值，再用它判断会自我强化（深色皮肤一旦被判过一次就再也回不到浅色）。
 */
export function isDarkSkin(settings: ReaderSettings): boolean {
  const id = resolveTheme(settings)
  if (DARK_SKIN_IDS.some(dark => dark === id)) return true
  const css = activeSkin(settings)?.css ?? ''
  const match = /--canvass*:s*#([0-9a-f]{6})/i.exec(css)
  if (!match) return false
  const r = parseInt(match[1].slice(0, 2), 16) / 255
  const g = parseInt(match[1].slice(2, 4), 16) / 255
  const b = parseInt(match[1].slice(4, 6), 16) / 255
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 0.45
}

/**
 * 读一套内置皮肤在样式表里**当前**的出厂规则（皮肤编辑器用它预填）。
 * 遍历所有可访问的 styleSheet：跨域表读 `cssRules` 会抛，按没有处理。
 * 返回的是 CSSOM 序列化后的文本（颜色可能变成 rgb()），保存后效果不变。
 */
export function readBuiltinSkinCss(id: BuiltinSkinId): string {
  if (typeof document === 'undefined') return ''
  const selector = `.theme-${id}`
  for (const sheet of Array.from(document.styleSheets)) {
    // 跳过 SkinStyle 注入的那条：它装的是用户改后的 CSS，同一选择器会排在出厂规则后面。
    // 编辑器要预填的是出厂样式，拿错这一份会让"没改过也会显示成改过"。
    const owner = sheet.ownerNode as HTMLElement | null
    if (owner?.id === 'legado-custom-skin') continue
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    for (const rule of Array.from(rules)) {
      const styleRule = rule as CSSStyleRule
      if (typeof styleRule.selectorText === 'string'
        && styleRule.selectorText.split(',').some(part => part.trim() === selector)) {
        return styleRule.cssText
      }
    }
  }
  return ''
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
    const customSkins = loadCustomSkins(saved as unknown as Record<string, unknown>)
    const builtinSkinOverrides = parseBuiltinSkinOverrides(saved.builtinSkinOverrides)
    const hiddenBuiltinSkins = parseHiddenBuiltinSkins(saved.hiddenBuiltinSkins)
    return {
      theme: parseSkinId(saved.theme) || defaultReaderSettings.theme,
      customSkins,
      builtinSkinOverrides,
      hiddenBuiltinSkins,
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
      mangaSpread: typeof saved.mangaSpread === 'boolean' ? saved.mangaSpread : defaultReaderSettings.mangaSpread,
      mangaDirection: saved.mangaDirection === 'rtl' ? 'rtl' : 'ltr',
      coverTheme: typeof saved.coverTheme === 'boolean' ? saved.coverTheme : defaultReaderSettings.coverTheme,
      wallpaperTheme: typeof saved.wallpaperTheme === 'boolean' ? saved.wallpaperTheme : defaultReaderSettings.wallpaperTheme,
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
      customBackgrounds: parseReaderBackgrounds(saved.customBackgrounds),
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
    // 存一份到服务端：localStorage 按 origin 隔离，换端口后整份设置会"回到出厂"。
    pushUiPref('reader-settings')
  } catch {
    // 隐私模式/配额满：保存失败不该在 App 的 effect 里把整棵树炸掉（load 路径有守卫，save 原来没有）
  }
}



