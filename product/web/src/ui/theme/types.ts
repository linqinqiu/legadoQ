/**
 * `ui/theme` 的数据形状。单独一个文件，是为了让 `store`（纯状态）与 `apply`（碰 DOM）
 * 都能引它而不互相引，也让判据可以只 import 类型所在的模块。
 */

/** 动态主题从哪来：封面算出来的 / 品牌色 / 用户手填。只有前两种会随书变。 */
export type DynamicThemeOrigin = 'cover' | 'wallpaper' | 'brand' | 'manual' | 'none'

export interface DynamicThemeState {
  /** false = 没有覆盖层，界面完全由皮肤决定。 */
  active: boolean
  /** 种子色，`#rrggbb` 小写；`active=false` 时为空串。 */
  seed: string
  /** 界面上显示这颜色来自哪（书名/品牌名），只用于文案。 */
  label: string
  origin: DynamicThemeOrigin
  /** 这本书的 bookUrl：切书时要据此判断"还是同一本，不必重算"。 */
  bookId: string | null
}
