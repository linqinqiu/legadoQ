/**
 * 品牌（应用名称与图标）的前端单一来源。
 *
 * 为什么要一个 store 而不是各自的组件去 fetch：「legadoQ」这个名字此前**硬编码在三处**
 * —— 顶栏的品牌字、阅读器的 `document.title`（两处：设置与卸载重置）、index.html 的 `<title>`。
 * 用户改了名，这三处还是「legadoQ」，那就是"改了个寂寞"。收成一个来源后它们都读这里。
 *
 * 形状照 `readerProgress.ts`（external store + `useSyncExternalStore`）：
 * 品牌只在弹窗里改，改一次要顶栏、标签页、后续所有渲染都跟着变，
 * 但它不是每帧变的东西，所以不必备份一份 ref 稳定化。
 */
export type BrandSnapshot = {
  /** 实际显示名：没自定义时就是内置的「legadoQ」。 */
  displayName: string
  /** 内置名：界面要能区分"这是默认"与"这是你改过的"。 */
  builtinName: string
  /** 自定义图标的 URL；没有就是 null（各处回落到随包图标）。 */
  iconUrl: string | null
  /** 主题色（manifest 那条口径）；空 = 用皮肤的。 */
  themeColor: string
}

const BUILTIN_NAME = 'legadoQ'

let snapshot: BrandSnapshot = { displayName: BUILTIN_NAME, builtinName: BUILTIN_NAME, iconUrl: null, themeColor: '' }
const listeners = new Set<() => void>()

export function subscribeBrand(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getBrand(): BrandSnapshot {
  return snapshot
}

/**
 * 写入品牌并同步标签页标题。
 * 标题只在这里改：`ReaderScreen` 那个 title effect 也必须读 `getBrand()` 而不是写死「legadoQ」，
 * 否则它一跑就把用户改的名字冲掉（那是最难查的一种"改了又变回去"）。
 */
export function reportBrand(next: Partial<BrandSnapshot>): void {
  const merged: BrandSnapshot = { ...snapshot, ...next }
  if (merged.displayName === snapshot.displayName
    && merged.iconUrl === snapshot.iconUrl
    && merged.themeColor === snapshot.themeColor) return
  snapshot = merged
  document.title = snapshot.displayName
  listeners.forEach(listener => listener())
}

/** 服务端没答 / 还没取到时不许把界面弄成空名字 —— 回落内置。 */
export const BRAND_BUILTIN_NAME = BUILTIN_NAME
