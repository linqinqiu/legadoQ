/**
 * 阅读设置的单一真源（维护切片 1a）。
 *
 * 背景：`readerSettings.ts` 769 行里同时放着「字段清单、默认值、清洗规则、迁移、上行同步」，
 * 加一项设置要改三处，且默认值与读回逻辑没有共同出处。这里先把**清单与默认值**收成一张表。
 *
 * 范围（1a，刻意收窄）：
 * - 标量设置（数字 / 布尔 / 枚举）由本表统一给出默认值与读回规则；
 * - 复杂结构（皮肤库、背景库、点击区、菜单、自定义 TTS 文本…）仍由 `readerSettings.ts`
 *   的专用清洗函数负责，但必须在本表登记一条 `kind: 'custom'`，否则「新增设置必须登记」
 *   的判据会红（`test/ReaderConfigRegistry.test.ts`）。
 *
 * 1b 才会用 `appliesTo` 决定哪些控件由注册表驱动渲染；本阶段它只是记录事实，
 * 供设置页与阅读器核对「这项在哪种模式下生效」，不参与运行时分支。
 *
 * 为什么不在这里写 `migrateFrom`：本仓没有发生过标量字段改名（只有 `customSkinId`
 * → `customSkins` 与 tapZones 格子表 → 虚线表这两类**结构**迁移，归专用清洗函数）。
 * 先不预留没有使用者的字段；真出现改名时再加，并同时补迁移用例。
 */

import { READER_FONT_SIZE_MAX, READER_FONT_SIZE_MIN } from '../content/fontSizeControl'

/** 一项设置在哪些形态下生效。`scroll` / `paginate` 是阅读模式，`desktop` / `web` 是外壳。 */
export type ReaderSettingSurface = 'scroll' | 'paginate' | 'desktop' | 'web'

type SpecBase = {
  readonly key: string
  readonly appliesTo: readonly ReaderSettingSurface[]
}

export type ReaderNumberSpec = SpecBase & {
  readonly kind: 'number'
  readonly default: number
  readonly min: number
  readonly max: number
  /** 存储值允许小数，但界面语义是整数（如版心宽度）。 */
  readonly integer?: boolean
}

export type ReaderBooleanSpec = SpecBase & {
  readonly kind: 'boolean'
  readonly default: boolean
}

export type ReaderEnumSpec = SpecBase & {
  readonly kind: 'enum'
  readonly default: string
  readonly values: readonly string[]
}

/** 复杂结构：默认值与清洗都在 `readerSettings.ts`，这里只登记「它存在」。 */
export type ReaderCustomSpec = SpecBase & {
  readonly kind: 'custom'
  /** 为什么不能走通用清洗（写给下一个改设置的人看）。 */
  readonly why: string
}

export type ReaderScalarSpec = ReaderNumberSpec | ReaderBooleanSpec | ReaderEnumSpec
export type ReaderSettingSpec = ReaderScalarSpec | ReaderCustomSpec

const BOTH = ['scroll', 'paginate'] as const
const SCREENS = ['desktop', 'web'] as const

/**
 * 标量设置表。
 *
 * 数值项的 min/max 与旧 `loadReaderSettings` 里的 `clampNumber` 参数逐项一致；
 * 枚举项的 values 与旧 `parse*` 函数逐项一致 —— 改这里等于改读回行为，必须同时补用例。
 */
export const READER_SCALAR_SPECS = [
  { key: 'fontSize', kind: 'number', default: 19, min: READER_FONT_SIZE_MIN, max: READER_FONT_SIZE_MAX, appliesTo: BOTH },
  { key: 'lineHeight', kind: 'number', default: 1.95, min: 1.45, max: 2.4, appliesTo: BOTH },
  { key: 'letterSpacing', kind: 'number', default: 0, min: -0.25, max: 1.5, appliesTo: BOTH },
  { key: 'paragraphSpacing', kind: 'number', default: 1.15, min: 0.7, max: 2, appliesTo: BOTH },
  { key: 'contentPadding', kind: 'number', default: 80, min: 20, max: 120, appliesTo: BOTH },
  { key: 'maxWidth', kind: 'number', default: 860, min: 560, max: 1400, integer: true, appliesTo: BOTH },
  { key: 'ttsSpeed', kind: 'number', default: 1, min: 0.5, max: 3, appliesTo: SCREENS },
  { key: 'ttsPitch', kind: 'number', default: 1, min: 0.5, max: 1.5, appliesTo: SCREENS },
  { key: 'readerBgDim', kind: 'number', default: 0.25, min: 0, max: 0.6, appliesTo: BOTH },

  { key: 'mangaSinglePage', kind: 'boolean', default: true, appliesTo: ['paginate'] },
  { key: 'mangaSpread', kind: 'boolean', default: false, appliesTo: ['paginate'] },
  { key: 'coverTheme', kind: 'boolean', default: true, appliesTo: BOTH },
  { key: 'wallpaperTheme', kind: 'boolean', default: true, appliesTo: SCREENS },
  { key: 'ttsAutoNextChapter', kind: 'boolean', default: true, appliesTo: SCREENS },
  { key: 'ttsFilterSymbols', kind: 'boolean', default: true, appliesTo: SCREENS },

  {
    key: 'font',
    kind: 'enum',
    default: 'song',
    values: ['song', 'hei', 'kai', 'fangsong', 'system', 'yuan', 'mono', 'custom'],
    appliesTo: BOTH,
  },
  { key: 'pageMode', kind: 'enum', default: 'scroll', values: ['scroll', 'paginate'], appliesTo: BOTH },
  { key: 'pageAnim', kind: 'enum', default: 'slide', values: ['slide', 'fade', 'cover', 'none'], appliesTo: ['paginate'] },
  { key: 'columnMode', kind: 'enum', default: 'auto', values: ['auto', 'single', 'double'], appliesTo: ['paginate'] },
  { key: 'textAlign', kind: 'enum', default: 'justify', values: ['justify', 'left'], appliesTo: BOTH },
  { key: 'mangaDirection', kind: 'enum', default: 'ltr', values: ['ltr', 'rtl'], appliesTo: ['paginate'] },
  { key: 'ttsEngine', kind: 'enum', default: 'edge', values: ['webSpeech', 'edge', 'custom'], appliesTo: SCREENS },
  { key: 'ttsCustomMethod', kind: 'enum', default: 'GET', values: ['GET', 'POST'], appliesTo: SCREENS },
] as const satisfies readonly ReaderScalarSpec[]

/**
 * 复杂设置的登记表。默认值与清洗仍在 `readerSettings.ts`：
 * 它们不是「一个值」，而是一套带迁移的结构（皮肤库、背景库、点击区…）。
 */
export const READER_CUSTOM_SPECS = [
  { key: 'theme', kind: 'custom', appliesTo: BOTH, why: '皮肤 id 要过 parseSkinId 并回落到第一套可见皮肤' },
  { key: 'customSkins', kind: 'custom', appliesTo: BOTH, why: '皮肤库带 id 保留字与 CSS 长度上限，且有单套→库的迁移' },
  { key: 'builtinSkinOverrides', kind: 'custom', appliesTo: BOTH, why: '只认内置七套的键，逐套清洗' },
  { key: 'hiddenBuiltinSkins', kind: 'custom', appliesTo: BOTH, why: '只留内置 id 并按内置顺序返回' },
  { key: 'textIndent', kind: 'custom', appliesTo: BOTH, why: '只认 0/1/2 三档，中间值取最近档' },
  { key: 'ttsVoice', kind: 'custom', appliesTo: SCREENS, why: '空串要回落到默认音色，不能落成空发音人' },
  { key: 'ttsCustomUrl', kind: 'custom', appliesTo: SCREENS, why: '用户输入的自由文本，允许空' },
  { key: 'ttsCustomBody', kind: 'custom', appliesTo: SCREENS, why: '用户输入的自由文本，允许空' },
  { key: 'ttsCustomVoice', kind: 'custom', appliesTo: SCREENS, why: '与 ttsVoice 分开存，避免污染 Edge/系统音色' },
  { key: 'ttsCustomHeader', kind: 'custom', appliesTo: SCREENS, why: 'JSON 文本，原样存' },
  { key: 'txtTocRule', kind: 'custom', appliesTo: BOTH, why: '合法取值来自服务端，前端只挡形状' },
  { key: 'customFont', kind: 'custom', appliesTo: BOTH, why: '会拼进 font-family，必须滤掉能破坏 CSS 的字符' },
  { key: 'readerBgColor', kind: 'custom', appliesTo: BOTH, why: '只认 #RGB/#RRGGBB/#RRGGBBAA' },
  { key: 'readerBgImage', kind: 'custom', appliesTo: BOTH, why: '只认 http(s)/站内相对路径/data:image' },
  { key: 'customBackgrounds', kind: 'custom', appliesTo: BOTH, why: '背景预设库，逐条清洗' },
  { key: 'tapZones', kind: 'custom', appliesTo: BOTH, why: '旧版格子表要迁成虚线表' },
  { key: 'menuItems', kind: 'custom', appliesTo: BOTH, why: '只认 readerMenu 里登记的动作' },
  { key: 'scriptMode', kind: 'custom', appliesTo: BOTH, why: '取值口径在 scriptConvert.parseScriptMode，不在本表复制一份' },
] as const satisfies readonly ReaderCustomSpec[]

/** 全量清单（标量 + 复杂）。判据用它核对「每个 ReaderSettings 键都登记了，且只登记一次」。 */
export const READER_SETTING_SPECS: readonly ReaderSettingSpec[] = [...READER_SCALAR_SPECS, ...READER_CUSTOM_SPECS]

export type ReaderScalarKey = (typeof READER_SCALAR_SPECS)[number]['key']

/** 设置存档的读取顺序：先读新版，读不到再读 v1（键表只在这里写一次）。 */
export const READER_SETTINGS_STORAGE_KEYS = ['legado-reader-settings-v2', 'legado-reader-settings-v1'] as const

/** 取一条标量规格；键来自本文件，取不到说明表被改坏了，直接抛而不是静默回落。 */
export function getScalarSpec(key: ReaderScalarKey): ReaderScalarSpec {
  const spec = READER_SCALAR_SPECS.find(item => item.key === key)
  if (!spec) throw new Error(`阅读设置未登记的标量键：${key}`)
  return spec
}

/**
 * 按规格读回一个标量值。
 *
 * 三条与旧 `parse*` 函数必须保持一致的口径：
 * 1. 数字：非 number / NaN / Infinity 一律回落默认值，再做 min/max 夹取；`integer` 再四舍五入。
 * 2. 布尔：只认真正的 boolean（字符串 `"true"` 不算）。
 * 3. 枚举：只认 values 里的字符串，其余回落默认值。
 */
export function readScalarSetting(spec: ReaderScalarSpec, value: unknown): number | boolean | string {
  if (spec.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return spec.default
    const clamped = Math.min(spec.max, Math.max(spec.min, value))
    return spec.integer ? Math.round(clamped) : clamped
  }
  if (spec.kind === 'boolean') {
    return typeof value === 'boolean' ? value : spec.default
  }
  return typeof value === 'string' && spec.values.includes(value) ? value : spec.default
}

/** 读回全部标量设置（只包含标量键）。调用方按 ReaderSettings 的对应字段收窄。 */
export function readScalarSettings(saved: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const spec of READER_SCALAR_SPECS) result[spec.key] = readScalarSetting(spec, saved[spec.key])
  return result
}

/** 全部标量的出厂值（`defaultReaderSettings` 的标量部分由它铺开）。 */
export function readerScalarDefaults(): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const spec of READER_SCALAR_SPECS) result[spec.key] = spec.default
  return result
}
