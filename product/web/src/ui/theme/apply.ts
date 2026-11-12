/**
 * 把「算出来的主题」落到 DOM 上（唯一碰 `document` 的地方）。
 *
 * 设计约束（都是踩过坑才写下来的）：
 * 1. **不新增皮肤类**：内置七套的 `--canvas/--accent/…` 仍由 `styles.css` 的 `.theme-*` 定义，
 *    这里只追加一层 `html.theme-dynamic`。选择器写死成 `html.theme-dynamic`（特异性 0,1,1）
 *    而不是 `.theme-dynamic`（0,1,0）：后者与 `.theme-*` 平手，胜负取决于样式表先后，
 *    而用户自定义皮肤的 `<style>` 是运行时追加的 —— 平手就会变成"谁后加载谁赢"，
 *    于是同一份代码在"先开阅读器"和"先改皮肤"两种顺序下配色不同。加一个 `html` 就与顺序无关。
 * 2. **一个 style 元素反复改写**，不 add/remove：每本书都插一个新标签会让 head 无限增长。
 * 3. **不可用就什么都不做**：没有 document、seed 非法、算色失败 —— 一律静默回落到皮肤，
 *    绝不把界面留在"覆盖层存在但颜色是空"的状态。
 */
import { buildDynamicTheme } from '../color/scheme'
import { skinCss } from '../color/legacy'
import { springVars } from '../motion/spring'
import type { DynamicThemeState } from './types'

export const DYNAMIC_STYLE_ID = 'legado-dynamic-theme'
export const SPRING_STYLE_ID = 'legado-ui-springs'

/** 动态主题覆盖层的选择器。导出是给判据用的：改它必须同时改本文件与 `styles.css` 的回落。 */
export const DYNAMIC_SELECTOR = 'html.theme-dynamic'
export const DYNAMIC_CLASS = 'theme-dynamic'

/**
 * 纯函数：状态 → 一段 CSS 文本。判据不必造 DOM 就能核对配色真的被写进去了。
 * 非 active 或 seed 非法时返回空串（调用方据此移除覆盖层）。
 */
export function composeDynamicCss(state: DynamicThemeState, options: { dark: boolean }): string {
  if (!state.active || !/^#[0-9a-f]{6}$/i.test(state.seed)) return ''
  const theme = buildDynamicTheme(state.seed)
  return skinCss(theme, { selector: DYNAMIC_SELECTOR, dark: options.dark })
}

/** 纯函数：弹簧令牌 → `:root{ --spring-*: … }`。 */
export function composeSpringCss(): string {
  const vars = springVars()
  const body = Object.entries(vars).map(([name, value]) => `${name}: ${value};`).join('')
  return body ? `:root{${body}}` : ''
}

function upsertStyle(id: string, text: string): HTMLStyleElement | null {
  if (typeof document === 'undefined') return null
  const existing = document.getElementById(id) as HTMLStyleElement | null
  if (!text) {
    existing?.remove()
    return null
  }
  // 覆盖层必须排在所有皮肤规则之后：head 里既有的 `<style>`（含用户自定义皮肤）
  // 先留原位，本元素每次 apply 都重新 append 到末尾，序号即优先级。
  const el = existing ?? document.createElement('style')
  el.id = id
  el.dataset.uiKernel = '1'
  if (el.textContent !== text) el.textContent = text
  document.head.appendChild(el)
  return el
}

/** 首帧前调一次即可；重复调用幂等。 */
export function applySpringVars(): void {
  upsertStyle(SPRING_STYLE_ID, composeSpringCss())
}

/**
 * 应用动态主题。`options.dark` 由调用方按当前皮肤给（我们不用 `prefers-color-scheme`：
 * 皮肤是显式的七选一，跟着系统走会与用户选的那套打架）。
 */
export function applyDynamicTheme(state: DynamicThemeState, options: { dark: boolean }): void {
  if (typeof document === 'undefined') return
  const css = composeDynamicCss(state, options)
  const root = document.documentElement
  if (!css) {
    removeDynamicTheme()
    return
  }
  upsertStyle(DYNAMIC_STYLE_ID, css)
  if (!root.classList.contains(DYNAMIC_CLASS)) root.classList.add(DYNAMIC_CLASS)
  syncThemeColorMeta()
}

/** 撤掉覆盖层：先摘类再删 style，顺序反了会有一帧"类在、变量没了"的空色。 */
export function removeDynamicTheme(): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.remove(DYNAMIC_CLASS)
  document.getElementById(DYNAMIC_STYLE_ID)?.remove()
  syncThemeColorMeta()
}

/**
 * 系统标题栏颜色跟着**算出来**的 `--canvas` 走。
 * `main.tsx` 里那条 effect 只在皮肤类变化时跑，动态主题变化不会触发它 —— 所以这里补一次。
 */
function syncThemeColorMeta(): void {
  const canvas = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim()
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', canvas || '#f8f9f7')
}

/**
 * 判据用：判断"这个 seed 值不值得覆盖皮肤"。
 *
 * 全黑/全白/极低饱和的封面（大量纯色贴图与占位图）算出来的主题会像"配色坏了"，
 * 而不是"呼应封面"。低于阈值就返回 false，调用方保持皮肤原样 —— 这比给出一个灰扑扑的
 * 主题更不打扰。阈值按 sRGB 饱和度粗算，不引 HCT 依赖，保持纯函数可测。
 */
export function isSeedWorthApplying(seed: string, threshold = 0.12): boolean {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(seed)
  if (!m) return false
  const r = parseInt(m[1], 16) / 255
  const g = parseInt(m[2], 16) / 255
  const b = parseInt(m[3], 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const light = (max + min) / 2
  const delta = max - min
  const sat = delta === 0 ? 0 : delta / (1 - Math.abs(2 * light - 1))
  return sat >= threshold
}
