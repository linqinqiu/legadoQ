/**
 * `src/ui/` 的对外门面：features/components/app 只从这里 import。
 *
 * 为什么要门面：内部文件布局（`color/` `motion/` `material/` `theme/`）是**实现细节**，
 * 重组时不应该逼着 20 个调用点跟着改 import。判据里也直接引 `../ui/index.ts`，
 * 等于顺手把"门面导出的东西确实存在"钉住。
 */
export { COLOR_ROLES, buildDynamicTheme, normalizeSeed } from './color/scheme'
export type { ColorRole, ColorRoles, DynamicTheme, ThemeVariant } from './color/scheme'
export { LEGACY_VARS, rolesToSkinVars, skinCss } from './color/legacy'
export type { LegacyVar } from './color/legacy'
export { seedFromPixels, scoreSeeds } from './color/seed'
export type { Pixels } from './color/seed'
export { springDurationMs, springEasing, springSample, springVars, SPRINGS } from './motion/spring'
export type { SpringName, SpringSpec } from './motion/spring'
export { glassClassName, glassStyle } from './material/glass'
export type { GlassLevel, GlassStyle } from './material/glass'
export {
  applyDynamicTheme,
  applySpringVars,
  composeDynamicCss,
  composeSpringCss,
  DYNAMIC_CLASS,
  DYNAMIC_SELECTOR,
  isSeedWorthApplying,
  removeDynamicTheme,
} from './theme/apply'
export {
  clearDynamicTheme,
  EMPTY_DYNAMIC_THEME,
  getDynamicTheme,
  setDynamicTheme,
  subscribeDynamicTheme,
} from './theme/store'
export type { DynamicThemeOrigin, DynamicThemeState } from './theme/types'
