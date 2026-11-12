/**
 * 动态主题 → 旧皮肤令牌（16 个 --… 变量）的桥。
 *
 * 为什么不直接改 styles.css：6,600 行样式里到处 `var(--canvas)` / `var(--accent)`，
 * 一次性换名等于把整个界面押在一次大改上。这里只做"翻译"：M3 角色表算好后，
 * 按旧皮肤已有的 16 个令牌喂回去，旧样式一行不用动也能跟着封面换色。
 *
 * 语义对照（写错一个整块 UI 就会串色）：
 * canvas=最底层背景 · surface=卡片 · surface-muted=次级卡片 · ink=正文
 * muted=次要文字 · line=分隔线 · accent=主色 · accent-soft=主色浅底
 * accent-ink=浅底上的字 · accent-solid=实心按钮底 · accent-solid-hover=悬停
 * on-accent=实心按钮上的字 · danger 三件套=error · shadow=box-shadow 字符串（不是颜色）
 */
import type { ColorRoles, DynamicTheme } from './scheme'

export const LEGACY_VARS = [
  'canvas',
  'surface',
  'surface-muted',
  'ink',
  'muted',
  'line',
  'accent',
  'accent-soft',
  'accent-ink',
  'accent-solid',
  'accent-solid-hover',
  'on-accent',
  'danger',
  'danger-solid',
  'on-danger',
  'shadow',
] as const

export type LegacyVar = typeof LEGACY_VARS[number]

const SHADOW_LIGHT = '0 12px 30px rgba(0,0,0,.08)'
const SHADOW_DARK = '0 12px 30px rgba(0,0,0,.25)'

function channel(hex: string, offset: number): number {
  return parseInt(hex.slice(offset, offset + 2), 16)
}

function toHex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
}

/** 线性亮度（sRGB → 线性）。只用来判断"这套角色是深色还是浅色"，不做对比度计算。 */
function relativeLuminance(hex: string): number {
  const linear = (c: number): number => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(channel(hex, 1)) + 0.7152 * linear(channel(hex, 3)) + 0.0722 * linear(channel(hex, 5))
}

/** rolesToSkinVars 没有 dark 参数，靠正文色（onSurface）反推：深色皮肤的正文字是浅的。 */
function isDarkRoles(roles: ColorRoles): boolean {
  // 注意：roles 是 M3 角色表，不是旧令牌表 —— 正文色叫 onSurface，没有 ink。
  return relativeLuminance(roles.onSurface) > 0.5
}

function mix(from: string, to: string, weight: number): string {
  const blend = (offset: number): string => toHex(channel(from, offset) * (1 - weight) + channel(to, offset) * weight)
  return `#${blend(1)}${blend(3)}${blend(5)}`
}

/**
 * 38 个 M3 角色 → 16 个旧令牌。纯函数、键顺序固定（skinCss 直接按 LEGACY_VARS 输出）。
 *
 * 几个刻意选择：
 * - surface 取 surfaceContainer 而不是 surface：旧皮肤里"卡片"总是和 canvas 有一档落差，
 *   而 surfaceContainer 在浅色里比 canvas 略深、在深色里比 canvas 略浅，正好两个方向都对。
 * - accent-solid-hover 不另算一条色板，而是按 M3 的 state layer 思路把主色往 onPrimary 侧混：
 *   浅色变亮、深色变暗，和旧七套皮肤的 hover 方向一致。
 * - shadow 是唯一非颜色令牌，按正文亮度给 .08 / .25 两档（和旧主题的明暗差一致）。
 */
export function rolesToSkinVars(roles: ColorRoles): Record<LegacyVar, string> {
  const dark = isDarkRoles(roles)
  return {
    canvas: roles.surface,
    surface: roles.surfaceContainer,
    'surface-muted': roles.surfaceContainerHigh,
    ink: roles.onSurface,
    muted: roles.onSurfaceVariant,
    line: roles.outlineVariant,
    accent: roles.primary,
    'accent-soft': roles.primaryContainer,
    'accent-ink': roles.onPrimaryContainer,
    'accent-solid': roles.primary,
    'accent-solid-hover': mix(roles.primary, dark ? '#ffffff' : '#000000', dark ? 0.12 : 0.1),
    'on-accent': roles.onPrimary,
    danger: roles.error,
    'danger-solid': roles.error,
    'on-danger': roles.onError,
    shadow: dark ? SHADOW_DARK : SHADOW_LIGHT,
  }
}

const SELECTOR_DEFAULT = '.theme-dynamic'
const ID_ALLOWED = /[^A-Za-z0-9_-]/g

/**
 * 生成一条完整 CSS 规则（含选择器与花括号），调用方整段塞进 <style>.textContent 即可。
 * 默认浅色；dark=true 时输出 theme.dark。selector 缺省 '.theme-dynamic'。
 * id 只作为注释标记输出（apply.ts 用它区分多份主题），不参与选择器 —— 选择器必须显式传。
 */
export function skinCss(
  theme: DynamicTheme,
  options: { id?: string; selector?: string; dark?: boolean } = {},
): string {
  const roles = options.dark ? theme.dark : theme.light
  const vars = rolesToSkinVars(roles)
  const selector = options.selector?.trim() || SELECTOR_DEFAULT
  const marker = options.id ? `/* ${options.id.replace(ID_ALLOWED, '')} */` : ''
  const body = LEGACY_VARS.map((name) => `--${name}:${vars[name]};`).join('')
  return `${marker}${selector}{${body}}`
}
