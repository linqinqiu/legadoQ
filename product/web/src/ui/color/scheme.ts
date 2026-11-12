/**
 * 动态配色内核：一个种子色 → 两套（浅/深）38 个 M3 角色。
 *
 * 为什么需要它：阅读器过去只有七套写死在 styles.css 里的皮肤。要让界面"跟着这本书的封面走"，
 * 就必须有一层可计算、可测、无 DOM 的颜色层 —— 这一层只吐纯数据（6 位小写 hex），
 * 由 legacy.ts 桥接回旧皮肤令牌，再由 theme/apply.ts 写进 <style>。
 *
 * 两个容易踩的点，这里先钉住：
 * 1. **确定性**：同一 seed 任何时候都要得到同一份角色表。主题会随切书反复重算，
 *    只要中间有一处 Math.random / 时间戳，界面就会在两本书之间闪色。
 * 2. **tonalSpot 的主色就是封面色**：库的 SchemeTonalSpot 会把主色色度压到 36，
 *    #6750A4 会被洗成 #65558F —— 用户看到的"封面取色"和实际主色对不上。
 *    这里给 tonalSpot 显式换一条"保留源色度"的 primaryPalette（M3 基线 #6750A4 本身
 *    就是源色度 tone40 的产物），于是浅色 primary 恰好等于种子；其余角色仍走 tonalSpot 规则。
 */
import {
  DynamicScheme,
  Hct,
  SchemeContent,
  SchemeExpressive,
  SchemeFidelity,
  SchemeMonochrome,
  SchemeNeutral,
  SchemeVibrant,
  TonalPalette,
  Variant,
  argbFromHex,
  hexFromArgb,
} from '@material/material-color-utilities'
import type { DynamicColor } from '@material/material-color-utilities'

/**
 * 38 个角色，顺序稳定（浅/深两套都按这个顺序插键，判据也按这个顺序核）。
 * 选取口径：Material 3 的全量语义色 + 五个 surface container + primaryFixed（固定品牌强调色）。
 * 改名会同时改到 legacy.ts 的映射与 ARCHITECTURE 边界判据，别动。
 */
export const COLOR_ROLES = [
  'primary',
  'onPrimary',
  'primaryContainer',
  'onPrimaryContainer',
  'primaryFixed',
  'secondary',
  'onSecondary',
  'secondaryContainer',
  'onSecondaryContainer',
  'tertiary',
  'onTertiary',
  'tertiaryContainer',
  'onTertiaryContainer',
  'error',
  'onError',
  'errorContainer',
  'onErrorContainer',
  'background',
  'onBackground',
  'surface',
  'onSurface',
  'surfaceDim',
  'surfaceBright',
  'surfaceContainerLowest',
  'surfaceContainerLow',
  'surfaceContainer',
  'surfaceContainerHigh',
  'surfaceContainerHighest',
  'surfaceVariant',
  'onSurfaceVariant',
  'outline',
  'outlineVariant',
  'shadow',
  'scrim',
  'inverseSurface',
  'inverseOnSurface',
  'inversePrimary',
  'surfaceTint',
] as const

export type ColorRole = typeof COLOR_ROLES[number]

/** 值统一 '#rrggbb'（小写 6 位，不带 alpha）。 */
export type ColorRoles = Record<ColorRole, string>

export type ThemeVariant =
  | 'tonalSpot'
  | 'content'
  | 'fidelity'
  | 'vibrant'
  | 'expressive'
  | 'neutral'
  | 'monochrome'

export interface DynamicTheme {
  /** '#rrggbb' */
  seed: string
  variant: ThemeVariant
  /** 0 表示默认；取值夹在 -1..1（M3 的 contrastLevel）。 */
  contrast: number
  light: ColorRoles
  dark: ColorRoles
}

export interface DynamicThemeOptions {
  variant?: ThemeVariant
  contrast?: number
}

const VARIANT_NAMES: readonly ThemeVariant[] = [
  'tonalSpot', 'content', 'fidelity', 'vibrant', 'expressive', 'neutral', 'monochrome',
]

type SchemeCtor = new (sourceColorHct: Hct, isDark: boolean, contrastLevel: number) => DynamicScheme

/** tonalSpot 之外的六个变体直接复用库里的方案类（构造签名一致）。 */
const VARIANT_SCHEMES: Record<Exclude<ThemeVariant, 'tonalSpot'>, SchemeCtor> = {
  content: SchemeContent,
  fidelity: SchemeFidelity,
  vibrant: SchemeVibrant,
  expressive: SchemeExpressive,
  neutral: SchemeNeutral,
  monochrome: SchemeMonochrome,
}

const HEX3 = /^[0-9a-f]{3}$/i
const HEX4 = /^[0-9a-f]{4}$/i
const HEX6 = /^[0-9a-f]{6}$/i
const HEX8 = /^[0-9a-f]{8}$/i

/**
 * 任何能表示颜色的输入 → '#rrggbb'（小写）。
 *
 * 支持的形状：
 * - '#RGB' / '#RGBA' / '#RRGGBB' / '#RRGGBBAA'（不带 # 也认，方便从 CSS 变量里直接拿）
 * - 32 位 ARGB 数字（0xFF6750A4）或 24 位 RGB 数字（0x6750A4）；alpha 一律丢弃
 *
 * 非法输入**抛错，不静默回落**：配色错一位就是整屏读不清，宁可让调用方在开发期炸掉。
 */
export function normalizeSeed(input: string | number): string {
  if (typeof input === 'number') {
    if (!Number.isInteger(input) || input < 0 || input > 0xffffffff) {
      throw new TypeError(`normalizeSeed: 数字种子必须是 0..0xFFFFFFFF 的整数，收到 ${input}`)
    }
    return `#${(input & 0xffffff).toString(16).padStart(6, '0')}`
  }
  if (typeof input !== 'string') {
    throw new TypeError(`normalizeSeed: 种子必须是字符串或数字，收到 ${typeof input}`)
  }
  const raw = input.trim().replace(/^#/, '')
  if (HEX6.test(raw)) return `#${raw.toLowerCase()}`
  if (HEX8.test(raw)) return `#${raw.slice(0, 6).toLowerCase()}`
  if (HEX3.test(raw)) {
    return `#${[...raw].map((char) => char + char).join('').toLowerCase()}`
  }
  if (HEX4.test(raw)) {
    // CSS 的 #RGBA：只取 RGB 三位，alpha 丢弃。
    return `#${[...raw.slice(0, 3)].map((char) => char + char).join('').toLowerCase()}`
  }
  throw new TypeError(`normalizeSeed: 无法识别的种子色 ${JSON.stringify(input)}（要 #rgb/#rrggbb/ARGB 数字）`)
}

function normalizeContrast(value: number | undefined): number {
  if (value === undefined) return 0
  if (typeof value !== 'number') throw new TypeError('buildDynamicTheme: contrast 必须是数字')
  // NaN/Infinity 来自"设置没读出来"这类脏数据：按默认对比度处理，不把界面算成一片黑。
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(-1, value))
}

function buildScheme(hct: Hct, variant: ThemeVariant, isDark: boolean, contrast: number): DynamicScheme {
  if (variant === 'tonalSpot') {
    // 保留源色度（理由见文件头）。secondary/tertiary/neutral 仍按 tonalSpot 的默认色度走。
    return new DynamicScheme({
      sourceColorHct: hct,
      variant: Variant.TONAL_SPOT,
      contrastLevel: contrast,
      isDark,
      primaryPalette: TonalPalette.fromHct(hct),
    })
  }
  return new VARIANT_SCHEMES[variant](hct, isDark, contrast)
}

function rolesFromScheme(scheme: DynamicScheme): ColorRoles {
  const colors = scheme.colors as unknown as Record<ColorRole, () => DynamicColor>
  const roles = {} as ColorRoles
  for (const role of COLOR_ROLES) {
    // hexFromArgb 已经给 6 位小写；toLowerCase 只是把契约再钉一次，防止上游改格式。
    roles[role] = hexFromArgb(colors[role]().getArgb(scheme)).toLowerCase()
  }
  return roles
}

/**
 * 种子 → 完整动态主题。纯函数：不读 DOM、不读时间、不随机。
 * 非法种子/变体抛错；contrast 越界夹到 [-1, 1]。
 */
export function buildDynamicTheme(seed: string | number, options: DynamicThemeOptions = {}): DynamicTheme {
  const normalizedSeed = normalizeSeed(seed)
  const variant = options.variant ?? 'tonalSpot'
  if (!VARIANT_NAMES.includes(variant)) {
    throw new TypeError(`buildDynamicTheme: 未知变体 ${String(variant)}（可选：${VARIANT_NAMES.join(' / ')}）`)
  }
  const contrast = normalizeContrast(options.contrast)
  const hct = Hct.fromInt(argbFromHex(normalizedSeed))
  return {
    seed: normalizedSeed,
    variant,
    contrast,
    light: rolesFromScheme(buildScheme(hct, variant, false, contrast)),
    dark: rolesFromScheme(buildScheme(hct, variant, true, contrast)),
  }
}
