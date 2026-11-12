# `src/ui/` —— legadoQ 设计内核（UI Kernel）

> 2026-11-12 新建。**这是跨 feature 的 UI 地基层**，不是又一个 feature。
> 目标：把「颜色 / 动效 / 材质」三件目前散落在 6,600 行 `styles.css` 里的硬编码，
> 收成**可计算、可测试、可替换**的纯数据层。

## 1. 分层规则（由 `test/ArchitectureBoundary.test.ts` 与 `tools/verify/depth-check.mjs` 守）

- `ui/**` 是 **shared 层**，与 `lib/` `components/` 同级。
- **`ui/**` 禁止 import `features/` `components/` `app/` `plugins/` `lib/api/`。**
  它只允许 import 第三方包与 `ui/` 内部文件。理由：地基一旦依赖业务，就无法单独替换/删除。
- 反向允许：`features/**` `components/**` `app/**` 可以 import `ui/**`。
- 目录深度上限 3（`ui/<组>/<文件>.ts` 或 `ui/<组>/<子组>/<文件>.ts`），不得更深。
- 浏览器 API（`document` `canvas` `localStorage`）只允许出现在 `*` 后缀为 `*.dom.ts` 的文件里；
  其余文件必须是**纯函数**，能在 node:test 里直接跑（没有 DOM 桩）。

## 2. 导出契约（跨组建模的唯一真相，改名必须先改这里）

### `ui/color/scheme.ts`

```ts
export const COLOR_ROLES = [...] as const           // 38 个 M3 角色，顺序稳定
export type ColorRole = typeof COLOR_ROLES[number]
export type ColorRoles = Record<ColorRole, string>  // 值统一 '#rrggbb'（小写 6 位，不带 alpha）
export type ThemeVariant = 'tonalSpot' | 'content' | 'fidelity' | 'vibrant' | 'expressive' | 'neutral' | 'monochrome'
export interface DynamicTheme {
  seed: string                 // '#rrggbb'
  variant: ThemeVariant
  contrast: number             // 0 表示默认
  light: ColorRoles
  dark: ColorRoles
}
export function normalizeSeed(input: string | number): string   // 非法输入抛错，不静默回落
export function buildDynamicTheme(seed: string | number, options?: { variant?: ThemeVariant; contrast?: number }): DynamicTheme
```

### `ui/color/legacy.ts` —— 桥接旧皮肤令牌（**不删旧 CSS，只喂它**）

```ts
export const LEGACY_VARS = ['canvas','surface','surface-muted','ink','muted','line','accent','accent-soft','accent-ink','accent-solid','accent-solid-hover','on-accent','danger','danger-solid','on-danger','shadow'] as const
export type LegacyVar = typeof LEGACY_VARS[number]
export function rolesToSkinVars(roles: ColorRoles): Record<LegacyVar, string>
export function skinCss(theme: DynamicTheme, options?: { id?: string; selector?: string; dark?: boolean }): string
// 返回 'html.theme-dynamic{--canvas:#…;…}'；选择器缺省 '.theme-dynamic'，dark=true 时取 theme.dark 那组角色。
```

`shadow` 不是颜色而是 `box-shadow` 值，浅色 `0 12px 30px rgba(0,0,0,.08)`，深色 `0 12px 30px rgba(0,0,0,.25)`。

### `ui/color/seed.ts`（纯）与 `ui/color/seed.dom.ts`（唯一允许 DOM 的种子文件）

```ts
export interface Pixels { width: number; height: number; data: Uint8ClampedArray }
export function seedFromPixels(pixels: Pixels, options?: { fallback?: string }): string
export function scoreSeeds(pixels: Pixels, options?: { maxColors?: number }): Array<{ hex: string; population: number }>
```
```ts
export async function seedFromImageUrl(url: string, options?: { timeoutMs?: number; maxEdge?: number; fallback?: string }): Promise<string>
export function clearSeedCache(): void
```

### `ui/motion/spring.ts`

```ts
export interface SpringSpec { stiffness: number; damping: number; mass: number }
export const SPRINGS = { responsive, gentle, snappy, bouncy, pageTurn } as const  // '软、弹、跟手'
export type SpringName = keyof typeof SPRINGS
export function springDurationMs(spec: SpringSpec, settleEpsilon?: number): number
export function springSample(spec: SpringSpec, elapsedMs: number): number          // 归一化位移，允许 >1（回弹）
export function springEasing(spec: SpringSpec, samples?: number): string            // 'linear(0, 0.21, …)'
export function springVars(): Record<string, string>                                // { '--spring-responsive': 'linear(...)' }
```

### `ui/material/glass.ts` + `ui/material/glass.css`

```ts
export type GlassLevel = 'thin' | 'regular' | 'thick'
export interface GlassStyle { background: string; backdropFilter: string; border: string; boxShadow: string; sheen: string }
export function glassStyle(options: { level?: GlassLevel; tint?: string; scheme?: 'light' | 'dark' }): GlassStyle
export function glassClassName(options?: { level?: GlassLevel }): string
```
`glass.css` 提供 `.lg-glass` `.lg-glass--thin|regular|thick` `.lg-sheen` 与
`@supports not (backdrop-filter: blur(1px))` 的不透明回落。

### `ui/theme/store.ts` + `ui/theme/apply.ts`

store 照 `lib/brandStore.ts` 形状（external store + `useSyncExternalStore`）：

```ts
export interface DynamicThemeState { active: boolean; seed: string; label: string; origin: 'cover' | 'brand' | 'manual' | 'none'; bookId: string | null }
export function getDynamicTheme(): DynamicThemeState
export function subscribeDynamicTheme(listener: () => void): () => void
export function setDynamicTheme(input: { seed: string; label?: string; origin?: 'cover' | 'brand' | 'manual'; bookId?: string | null }): void
export function clearDynamicTheme(): void
```

`apply.ts`：`applyDynamicTheme(state)` 向 `document.head` 写/更新 `<style id="legado-dynamic-theme">`，
并在 `documentElement` 上挂 `.theme-dynamic` 类；`clearDynamicTheme` 时移除这两样。**幂等**。

## 3. 验收

- `cd product/web && node node_modules/tsx/dist/cli.mjs test/<你的判据>.test.ts`
- `cd product/web && npm run check`（`tsc -b`，别人可能同时在改，红了先看你自己的文件）
- 全量 `npm test` 由 Lead 统一跑。
