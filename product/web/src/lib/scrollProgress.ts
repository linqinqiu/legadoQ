/**
 * 滚动进度的纯数学：**与阅读域无关**，所以住在 shared。
 *
 * 这三个函数原先在 `features/reader/readerSettings.ts` 里，但它们的签名与实现
 * 完全不引用 `ReaderSettings` —— `scrollPosition` 原来的两个真实消费者里，
 * 一个是阅读器（同域，没问题），另一个是 `components/BookDetailModal.tsx`（shared）。
 * 后者据此成为一条 shared → feature 反向依赖，而它要的只是这道除法。
 *
 * 判据要求 shared 不得 import features，所以「搬用的人」和「被搬的东西」必须二选一。
 * 这三个函数没有任何 feature 语义，搬它们比搬调用方便宜得多。
 */

/** 非法值（NaN / 越界）一律收回 [0,1] —— 与 `clampNumber` 同一哲学。 */
export function clampScrollPosition(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

/** 把「滚了多高」折成 0~1 的逻辑位置，供恢复进度、进度条与离线补发共用。 */
export function scrollPosition(scrollTop: number, scrollHeight: number, clientHeight: number): number {
  return clampScrollPosition(scrollTop / Math.max(1, scrollHeight - clientHeight))
}

/**
 * 数值项的读取一律走这里。以前各字段自己写 `typeof x === 'number' ? Math.min(...)`，
 * 而 `NaN` 也满足 `typeof === 'number'`，`Math.min/max(NaN)` 又返回 `NaN` ——
 * localStorage 里存进一个 NaN（旧版本或被改坏的 JSON）就会让 `--reader-font-size: NaNpx`
 * 这种无效值一路发到 CSS，浏览器整条声明作废，界面表现为"设置突然不生效"。
 */
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}
