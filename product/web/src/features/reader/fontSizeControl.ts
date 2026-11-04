/**
 * 字号的唯一口径（P1 收敛）：设置步进器、快捷键、Ctrl+滚轮三处原来各写一份
 * `Math.min(28, Math.max(15, …))`，改边界要改三处。现在只有这里一个出处 ——
 * 连"读回 localStorage 时夹一遍"（`readerSettings.ts`）与"备份包里的 dp 折算"
 * （`lib/backupPreferences.ts`）也引这里，那两处原本把 15/28 又抄了一遍。
 */
export const READER_FONT_SIZE_MIN = 15
export const READER_FONT_SIZE_MAX = 28

/** 非法值（NaN/越界）一律收回边界内 —— 与 readerSettings 的 clampNumber 同一哲学。 */
export function clampFontSize(value: number): number {
  if (!Number.isFinite(value)) return READER_FONT_SIZE_MIN
  return Math.min(READER_FONT_SIZE_MAX, Math.max(READER_FONT_SIZE_MIN, value))
}

/** 在当前值上步进 ±delta，结果仍夹在边界内。 */
export function stepFontSize(current: number, delta: number): number {
  return clampFontSize(current + delta)
}
