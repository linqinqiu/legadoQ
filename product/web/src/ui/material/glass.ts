/**
 * Liquid Glass 材质：把「玻璃」写成可计算的样式对象，而不是一堆散落的 CSS 类。
 *
 * 为什么要算而不是写死：三档透明度 × 明暗两套配色 × 跟随主题的 tint，
 * 手写就是 3×2 段近似重复的 CSS，加一档就得再加两段；改一处高光要改六处。
 * 这里把**档位参数**与**拼装规则**分开：参数是数据，拼装是纯函数，
 * 判据可以直接断言「三档的 backdrop-filter 各不相同」「非法 tint 不抛错」。
 *
 * 真实玻璃的三个视觉线索（缺一个就"像塑料"）：
 * 1. **折射模糊分层**：近景细节被大半径模糊吃掉，但边缘保留一点小半径模糊，
 *    单一 `blur(Npx)` 会让整块玻璃糊成一片，所以是 `blur(柔) blur(主)` 两层叠加。
 * 2. **顶缘镜面高光**（sheen）：光从上方来，上沿最亮、到中部迅速消失（48% 处归零）。
 * 3. **边缘折射亮线**：1px 半透明描边 + inset 高光，玻璃才"有厚度"。
 *
 * 契约（src/ui/README.md）：background / backdropFilter / border / boxShadow / sheen 五段字符串。
 * **注意**：`border` 只能表达一条边线，内侧高光放不进 border 属性，
 * 所以「描边 + 内侧高光」拆成 border（亮线）与 boxShadow 的 inset（厚度）—— CSS 属性能力所限，
 * 不是漏实现。
 *
 * 本文件是纯函数：不碰 document，也不 import 任何 feature。
 */

export type GlassLevel = 'thin' | 'regular' | 'thick'

export interface GlassStyle {
  /** 半透明渐变叠加（顶部光晕 + 主体填充 + tint 色）。 */
  background: string
  /** 多层模糊 + 饱和度 + 亮度：模拟折射。 */
  backdropFilter: string
  /** 1px 半透明描边（带 tint）。内侧高光见 boxShadow 的 inset。 */
  border: string
  /** 外阴影 + inset 高光。 */
  boxShadow: string
  /** 顶缘镜面高光的线性渐变，给 `.lg-sheen` 用。 */
  sheen: string
}

/**
 * 缺省 tint 指向主题令牌，但**一定带回落**：`ui/` 可能在没挂任何皮肤类的容器里被渲染
 * （Storybook 式预览、导出图片、单元判据），那时 `--accent` 是不存在的。
 * 落回 legadoQ 的浅色主色 #247a58 —— 与 styles.css 的 `.theme-light` 同值。
 */
const DEFAULT_TINT_VAR = 'var(--accent, #247a58)'
const FALLBACK_TINT = '#247a58'

interface LevelParams {
  /** 主模糊半径（px）：越厚，背后越糊。 */
  blur: number
  /** 柔化层半径（px）：保留一点近景轮廓，避免整块糊死。 */
  blurSoft: number
  saturate: number
  brightness: number
  contrast: number
  /** 顶部白色填充不透明度（0–1）。 */
  fillTop: number
  fillMid: number
  fillLow: number
  /** tint 混合比例（%）。 */
  tintAlpha: number
  /** 描边里 tint 的比例（%）。 */
  borderTint: number
  /** 描边白色亮线的 alpha（0–1）。 */
  borderAlpha: number
  shadowAlpha: number
  shadowLift: number
  shadowBlur: number
  insetTop: number
  insetBottom: number
  sheenAlpha: number
}

/**
 * 三档参数。thin→thick 是**单调**的：越厚 = 越糊（blur↑）、越不透明（fill↑、tint↑）、
 * 越重的投影（shadow↑）。判据按这个单调性断言，改参数时若破坏单调性会立刻红。
 */
const LEVELS: Record<GlassLevel, LevelParams> = {
  thin: {
    blur: 12, blurSoft: 4, saturate: 138, brightness: 1.06, contrast: 102,
    fillTop: 0.22, fillMid: 0.1, fillLow: 0.06,
    tintAlpha: 5, borderTint: 6, borderAlpha: 0.32,
    shadowAlpha: 0.22, shadowLift: 14, shadowBlur: 40,
    insetTop: 0.48, insetBottom: 0.08, sheenAlpha: 0.3,
  },
  regular: {
    blur: 20, blurSoft: 7, saturate: 162, brightness: 1.03, contrast: 104,
    fillTop: 0.3, fillMid: 0.14, fillLow: 0.08,
    tintAlpha: 9, borderTint: 9, borderAlpha: 0.44,
    shadowAlpha: 0.34, shadowLift: 18, shadowBlur: 48,
    insetTop: 0.58, insetBottom: 0.1, sheenAlpha: 0.38,
  },
  thick: {
    blur: 30, blurSoft: 10, saturate: 182, brightness: 1.0, contrast: 106,
    fillTop: 0.38, fillMid: 0.19, fillLow: 0.11,
    tintAlpha: 13, borderTint: 12, borderAlpha: 0.56,
    shadowAlpha: 0.42, shadowLift: 22, shadowBlur: 56,
    insetTop: 0.64, insetBottom: 0.12, sheenAlpha: 0.44,
  },
}

/** 深色下投影要更重才有层次（背景本身就暗）；高光反而要收一点，否则发灰。 */
const SCHEMES = {
  light: { shadowScale: 1, highlightScale: 1, tintScale: 1 },
  dark: { shadowScale: 1.25, highlightScale: 0.82, tintScale: 1.35 },
} as const

/** 数字取 3 位去尾零：alpha 写成 0.34 而不是 0.3400000000000001。 */
function num(value: number, digits = 3): string {
  let text = value.toFixed(digits)
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '')
  return text === '-0' ? '0' : text
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function normalizeLevel(level: GlassLevel | undefined): GlassLevel {
  return level === 'thin' || level === 'regular' || level === 'thick' ? level : 'regular'
}

/**
 * tint 合法性检查。为什么不是「原样拼进字符串」：参数来自主题/封面，
 * 一旦带 `;` 或 `}` 就能跳出声明、改写整页样式（CSS 注入）。
 * 所以只收三类：颜色字面量、`var(--x[, 回落])`、`color-mix(...)`，且括号必须配平。
 * 其余（含空串、`not-a-color`）一律回落默认色，**不抛错** —— 材质是装饰层，
 * 一个非法色值不该让整个面板渲染失败。
 */
function normalizeTint(tint: string | undefined): string {
  const raw = typeof tint === 'string' ? tint.trim() : ''
  if (!raw || raw.length > 120) return DEFAULT_TINT_VAR
  if (/[;{}<>\n\r]/.test(raw)) return FALLBACK_TINT // 注入形状：不是回落 var，直接给安全字面量
  let depth = 0
  for (const ch of raw) {
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth < 0) return FALLBACK_TINT
    }
  }
  if (depth !== 0) return FALLBACK_TINT
  const head = raw.toLowerCase()
  const accepted =
    /^#[0-9a-f]{3,8}$/.test(head) ||
    /^(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\(/.test(head) ||
    /^(var|color-mix)\(/.test(head)
  if (!accepted) return FALLBACK_TINT
  // var(--x) 没带回落就等于「主题没定义时整条声明作废」；这里补一个，保证一定有颜色。
  return raw.replace(/var\(\s*(--[\w-]+)\s*\)/g, `var($1, ${FALLBACK_TINT})`)
}

/**
 * 玻璃材质的五个样式字段。参数全部可选：
 * `level` 默认 regular，`scheme` 默认 light，`tint` 默认跟随 `--accent`。
 *
 * 返回的是**可直接写进 style 对象**的字符串，不含选择器、不含 !important。
 */
export function glassStyle(options: { level?: GlassLevel; tint?: string; scheme?: 'light' | 'dark' } = {}): GlassStyle {
  const level = normalizeLevel(options.level)
  const scheme = options.scheme === 'dark' ? SCHEMES.dark : SCHEMES.light
  const tint = normalizeTint(options.tint)
  const p = LEVELS[level]

  const hi = (alpha: number) => clamp01(alpha * scheme.highlightScale)
  const tintPct = num(p.tintAlpha * scheme.tintScale, 2)
  const shadow = num(p.shadowAlpha * scheme.shadowScale, 3)

  const background =
    `radial-gradient(120% 82% at 18% 0%, rgba(255, 255, 255, ${num(hi(p.sheenAlpha))}) 0%, rgba(255, 255, 255, 0) 58%), ` +
    `linear-gradient(152deg, rgba(255, 255, 255, ${num(hi(p.fillTop))}) 0%, ` +
    `rgba(255, 255, 255, ${num(hi(p.fillMid))}) 36%, ` +
    `color-mix(in srgb, ${tint} ${tintPct}%, rgba(255, 255, 255, ${num(hi(p.fillLow))})) 100%)`

  // 两层 blur：先柔化（大结构）再主模糊（细节），单层会把背后的形状糊成均匀灰块。
  const backdropFilter =
    `blur(${num(p.blurSoft)}px) blur(${num(p.blur)}px) ` +
    `saturate(${num(p.saturate, 1)}%) brightness(${num(p.brightness)}) contrast(${num(p.contrast, 1)}%)`

  const border =
    `1px solid color-mix(in srgb, ${tint} ${num(p.borderTint, 2)}%, rgba(255, 255, 255, ${num(hi(p.borderAlpha))}))`

  const boxShadow =
    `0 ${num(p.shadowLift, 1)}px ${num(p.shadowBlur, 1)}px -${num(p.shadowLift * 0.6, 1)}px rgba(0, 0, 0, ${shadow}), ` +
    `0 2px 6px rgba(0, 0, 0, ${num(Number(shadow) * 0.45, 3)}), ` +
    `inset 0 1px 0 rgba(255, 255, 255, ${num(hi(p.insetTop))}), ` +
    `inset 0 -1px 0 rgba(255, 255, 255, ${num(hi(p.insetBottom))})`

  const sheen =
    `linear-gradient(180deg, rgba(255, 255, 255, ${num(hi(p.sheenAlpha))}) 0%, ` +
    `rgba(255, 255, 255, ${num(hi(p.sheenAlpha) * 0.38)}) 14%, rgba(255, 255, 255, 0) 48%)`

  return { background, backdropFilter, border, boxShadow, sheen }
}

/**
 * 与 `glass.css` 对齐的类名。样式对象负责"这一块玻璃长什么样"，
 * 类名负责"哪块区域是玻璃 + 用哪一档"：两者都从同一个 level 枚举来，不会对不上。
 * 默认 regular；非法 level 同样回落 regular（与 glassStyle 一致）。
 */
export function glassClassName(options: { level?: GlassLevel } = {}): string {
  return `lg-glass lg-glass--${normalizeLevel(options.level)}`
}
