/**
 * 阅读器的点击分区。
 *
 * 用户 2026-10-04：「书籍阅读时，点击区域有问题，可以自定义点击区域范围并设置，自定义管理」；
 * 2026-10-09：「分组如果有很多那么影响显示，区域设置改提供横竖虚线，自定义，但是要区分翻页方式的影响」。
 *
 * 上游手机端是一整块 3×3 九宫格，每一格单独挑一个动作。我们这边先是写死的三区，后来做成
 * "rows×cols 的格子表 + 每格一个下拉" —— 格子一多就占满一屏，用户说的"影响显示"就是它。
 * 现在改成**分隔虚线**模型：竖虚线把屏分成左右列、横虚线分成上下段，位置是 0..1 的分数、
 * 可以任意拖动（"横竖虚线，自定义"）。分页看竖线、滚动看横线，两张表分开存（"区分翻页方式"）。
 *
 * 这里只放**纯算式与预设**：DOM 归 TapZoneEditor，落库归 readerSettings，判据归 TapZones.test.ts。
 * 默认值刻意保持"和现在一样"（翻页按列、滚动按段），改了才生效，不改不漂移。
 */

export type TapAction = 'previous' | 'next' | 'toggle' | 'toc' | 'settings' | 'none'

/** 一张点击分区表：竖虚线位置 + 横虚线位置 + 行优先的动作。 */
export type TapMap = {
  /** 竖虚线位置（0..1 的分数，升序，不含端点）—— 分页模式按它分左右列。 */
  x: number[]
  /** 横虚线位置（0..1 的分数，升序，不含端点）—— 滚动模式按它分上下段。 */
  y: number[]
  /** 行优先动作，长度 = (y.length + 1) × (x.length + 1)。 */
  actions: TapAction[]
}

export const TAP_ACTION_LABELS: Record<TapAction, { label: string; hint: string }> = {
  previous: { label: '上一页 / 上一章', hint: '往回翻一栏；在窗口开头则把上一章接到前面' },
  next: { label: '下一页 / 下一章', hint: '往前翻一栏，跨过章界只是"下一页"' },
  toggle: { label: '呼出 / 收起工具栏', hint: '现在中间那一格的行为' },
  toc: { label: '打开章节目录', hint: '直接进目录，不用先呼工具栏' },
  settings: { label: '打开阅读设置', hint: '字号、行距、主题、翻页方式' },
  none: { label: '不做任何事', hint: '防误触：这一格点了没反应' },
}

export const TAP_ACTION_ORDER: TapAction[] = ['previous', 'next', 'toggle', 'toc', 'settings', 'none']

/** 分区里那枚小徽标用的短名（完整名太长，摆在格子里会溢出）。 */
export const TAP_ACTION_SHORT: Record<TapAction, string> = {
  previous: '上一页', next: '下一页', toggle: '工具栏', toc: '目录', settings: '设置', none: '不响应',
}

/** 一条虚线离边界 / 离相邻那条的最小距离：太近会切出一条点不中的窄格。 */
export const MIN_CUT_GAP = 0.04
/** 一轴最多几条虚线（6 列 / 6 段已是格子表时代的上限）。 */
export const MAX_CUTS = 5

/** 出厂默认：与"格子表"时代逐字一致（翻页 1×3 按列、滚动 3×1 按段）。 */
export const DEFAULT_MAPS: Record<'paginate' | 'scroll', TapMap> = {
  paginate: { x: [1 / 3, 2 / 3], y: [], actions: ['previous', 'toggle', 'next'] },
  scroll: { x: [], y: [1 / 3, 2 / 3], actions: ['previous', 'toggle', 'next'] },
}

/** 预设（"从预设开始"）：每个都是完整的表，挑一个就整套换掉。 */
export const TAP_PRESETS: { key: string; label: string; hint: string; paginate: TapMap; scroll: TapMap }[] = [
  {
    key: 'current', label: '默认（翻页分列、滚动分段）', hint: '与老版本一致，不改手感',
    paginate: DEFAULT_MAPS.paginate, scroll: DEFAULT_MAPS.scroll,
  },
  {
    key: 'nine', label: '九宫格（同手机端）', hint: '四角与左右都算翻页，正中呼出工具栏',
    paginate: {
      x: [1 / 3, 2 / 3], y: [1 / 3, 2 / 3],
      actions: ['previous', 'previous', 'next', 'previous', 'toggle', 'next', 'previous', 'next', 'next'],
    },
    scroll: {
      x: [1 / 3, 2 / 3], y: [1 / 3, 2 / 3],
      actions: ['previous', 'previous', 'next', 'previous', 'toggle', 'next', 'previous', 'next', 'next'],
    },
  },
  {
    key: 'edges', label: '只认两侧', hint: '中间与上下边全部不响应：最容易误触的一种',
    paginate: { x: [1 / 3, 2 / 3], y: [], actions: ['previous', 'none', 'next'] },
    scroll: { x: [], y: [1 / 3, 2 / 3], actions: ['none', 'toggle', 'none'] },
  },
  {
    key: 'menu', label: '整屏只呼出工具栏', hint: '翻页完全交给键盘/滚轮/滑动',
    paginate: { x: [], y: [], actions: ['toggle'] },
    scroll: { x: [], y: [], actions: ['toggle'] },
  },
]

/** 一格落在第几行第几列（行优先）。边界值归给"更靠外"的那一格，与旧的 1/3、2/3 口径同一形状。 */
export function zoneAt(map: TapMap, px: number, py: number, width: number, height: number): TapAction {
  if (width <= 0 || height <= 0) return 'none'
  const col = countBelow(map.x, px / width)
  const row = countBelow(map.y, py / height)
  return map.actions[row * (map.x.length + 1) + col] ?? 'none'
}

/** 分数 value 落在第几格（有多少条虚线在它左边/上边）。 */
function countBelow(cuts: number[], value: number): number {
  let count = 0
  for (const cut of cuts) if (value >= cut) count += 1
  return count
}

/** 第 index 格（0..cuts.length）的中心分数：拖动时把指针位置翻成格号要用它。 */
export function cellCenter(cuts: number[], index: number): number {
  const lo = index === 0 ? 0 : cuts[index - 1]
  const hi = index === cuts.length ? 1 : cuts[index]
  return (lo + hi) / 2
}

/** 这张表分了几块（界面上要报数）。 */
export const mapCells = (map: TapMap) => (map.x.length + 1) * (map.y.length + 1)

/** 拖动某条虚线时的夹取：不许出界、不许和相邻那条贴死。 */
export function clampCut(cuts: number[], index: number, value: number): number {
  const lower = index === 0 ? MIN_CUT_GAP : cuts[index - 1] + MIN_CUT_GAP
  const upper = index === cuts.length - 1 ? 1 - MIN_CUT_GAP : cuts[index + 1] - MIN_CUT_GAP
  return Math.min(upper, Math.max(lower, value))
}

/** 在某一轴上插一条线：插进当前最大的空隙中间；到上限就不再插（返回原数组）。 */
export function addCut(cuts: number[]): number[] {
  if (cuts.length >= MAX_CUTS) return cuts
  const points = [0, ...cuts, 1]
  let at = 0.5
  let best = -1
  for (let index = 0; index < points.length - 1; index += 1) {
    const gap = points[index + 1] - points[index]
    if (gap > best) {
      best = gap
      at = (points[index] + points[index + 1]) / 2
    }
  }
  return [...cuts, at].sort((a, b) => a - b)
}

/** 换分区（加/删一条虚线）时，把旧动作按"新格中心落在旧哪一格"搬过来，越界回落成 none。 */
/**
 * 删掉第 `index` 条虚线。
 *
 * 单独抽出来是因为编辑器里原先写的是 `cuts.filter((_, item) => item !== index)` ——
 * 第二个回调参数是**值**不是下标，与整数 `index` 比较几乎永远不等，
 * 于是"双击删一条线"静默无效：线还在，界面上也没有任何报错。
 */
export function removeCut(cuts: number[], index: number): number[] {
  return cuts.filter((_, position) => position !== index)
}

export function remapActions(map: TapMap, nextX: number[], nextY: number[]): TapMap {
  const oldCols = map.x.length + 1
  const cols = nextX.length + 1
  const rows = nextY.length + 1
  const actions: TapAction[] = []
  for (let row = 0; row < rows; row += 1) {
    const cy = cellCenter(nextY, row)
    for (let col = 0; col < cols; col += 1) {
      const cx = cellCenter(nextX, col)
      const oldCol = countBelow(map.x, cx)
      const oldRow = countBelow(map.y, cy)
      actions.push(map.actions[oldRow * oldCols + oldCol] ?? 'none')
    }
  }
  return { x: nextX, y: nextY, actions }
}

/** 设置里存进来的东西可能缺项或写错，一律清洗成能用的表（不清洗就会点到 undefined 上没反应）。 */
export function sanitizeMap(value: unknown, fallback: TapMap): TapMap {
  const source = (value ?? {}) as Partial<TapMap>
  const x = sanitizeCuts(source.x, fallback.x)
  const y = sanitizeCuts(source.y, fallback.y)
  const cells = (x.length + 1) * (y.length + 1)
  const known = new Set<string>(TAP_ACTION_ORDER)
  const actions = Array.from({ length: cells }, (_, index) => {
    const item = source.actions?.[index]
    return typeof item === 'string' && known.has(item) ? item as TapAction : (fallback.actions[index % fallback.actions.length] ?? 'none')
  })
  return { x, y, actions }
}

function sanitizeCuts(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value)) return [...fallback]
  const sorted = value
    .filter(item => typeof item === 'number' && Number.isFinite(item))
    .map(item => Math.min(1 - MIN_CUT_GAP, Math.max(MIN_CUT_GAP, item)))
    .sort((a, b) => a - b)
  const out: number[] = []
  for (const item of sorted) {
    if (out.length === 0 || item - out[out.length - 1] >= MIN_CUT_GAP) out.push(item)
  }
  return out.slice(0, MAX_CUTS)
}

/**
 * 旧版 `{rows, cols, actions}`（格子表）迁到虚线模型：均匀切分。
 * 只在读设置时用一次 —— 用户已经存过的那份是旧形状，不迁就等于"设置被重置了"。
 */
export function migrateGrid(value: unknown, fallback: TapMap): TapMap {
  const source = value as { rows?: unknown; cols?: unknown; actions?: unknown } | null
  const rawActions = source?.actions
  if (!source || typeof source !== 'object' || !Array.isArray(rawActions)) return sanitizeMap(value, fallback)
  const rows = Number.isFinite(source.rows) ? Math.min(6, Math.max(1, Math.trunc(source.rows as number))) : 1
  const cols = Number.isFinite(source.cols) ? Math.min(6, Math.max(1, Math.trunc(source.cols as number))) : 1
  const known = new Set<string>(TAP_ACTION_ORDER)
  const actions = Array.from({ length: rows * cols }, (_, index) => {
    const item = rawActions[index]
    return typeof item === 'string' && known.has(item) ? item as TapAction : 'none'
  })
  return {
    x: Array.from({ length: cols - 1 }, (_, index) => (index + 1) / cols),
    y: Array.from({ length: rows - 1 }, (_, index) => (index + 1) / rows),
    actions,
  }
}

/** 读设置时判断某个字段是旧"格子表"还是新"虚线表"。 */
export function looksLikeGrid(value: unknown): boolean {
  return !!value && typeof value === 'object' && ('rows' in (value as Record<string, unknown>) || 'cols' in (value as Record<string, unknown>))
}
