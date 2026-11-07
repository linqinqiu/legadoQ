/**
 * 书源页左栏宽度的取值与持久化。
 *
 * 左栏原来是写死的 280px。5,574 个书源里长名字一大片，280 只放得下「四字书名 + 两个徽标」，
 * 剩下的被截成「这个反派有点良…」，选源全靠猜。改成可拖，并把宽度记在 localStorage：
 * 拖过之后每次进来都是自己那档，不用再拖第二次。
 *
 * 上下限取 240 / 560：再窄装不下书名，再宽右栏编辑器就只剩一条缝（1280 屏上 560 已经是极限）。
 */

/** 默认宽度。比原来的 280 宽一档，长书名不必再靠悬停看全名。 */
export const SIDEBAR_WIDTH_DEFAULT = 320
export const SIDEBAR_WIDTH_MIN = 240
export const SIDEBAR_WIDTH_MAX = 560

export const SIDEBAR_WIDTH_KEY = 'legado.sourceSidebarWidth'

/** 夹到 [MIN, MAX] 并取整；非法值（NaN / Infinity）回落到默认值，不把 NaN 写进 style。 */
export function clampSidebarWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDEBAR_WIDTH_DEFAULT
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(value)))
}

/** 读上次拖到的宽度。读不到、存了脏值、localStorage 被禁（隐私模式）都回落到默认值。 */
export function readStoredSidebarWidth(): number {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY)
    if (!raw) return SIDEBAR_WIDTH_DEFAULT
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : SIDEBAR_WIDTH_DEFAULT
  } catch {
    return SIDEBAR_WIDTH_DEFAULT
  }
}

/** 记下宽度。写不进去不影响这一次的拖拽结果 —— 只是下次进来回到默认值。 */
export function storeSidebarWidth(width: number): void {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(width)))
  } catch {
    /* 隐私模式 / 配额满：静默放弃持久化，宽度这一趟照样生效 */
  }
}
