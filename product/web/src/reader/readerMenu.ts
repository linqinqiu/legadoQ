/**
 * 阅读器右上角工具栏的菜单项（用户 2026-10-11：「阅读菜单可配置」，参照 legado-with-MD3 的菜单配置）。
 *
 * 这一份是**唯一来源**：工具栏按它渲染，设置抽屉里的「工具栏」配置也按它列 ——
 * 两处各写一份清单迟早漂移（顶栏导航当年就是三处三份清单，加一页必然漏一处）。
 * 默认顺序 = 改动前工具栏的顺序，用户不动就不变。
 */
export type ReaderMenuAction = 'switchSource' | 'settings' | 'fullscreen' | 'tts'

export const READER_MENU_ITEMS: ReadonlyArray<{ id: ReaderMenuAction; label: string }> = [
  { id: 'switchSource', label: '切换书源' },
  { id: 'settings', label: '阅读设置' },
  { id: 'fullscreen', label: '全屏' },
  { id: 'tts', label: '朗读' },
]

const KNOWN = new Set<string>(READER_MENU_ITEMS.map(item => item.id))

/** 出厂顺序（也是"没配过"时的取值）。 */
export const DEFAULT_READER_MENU: ReaderMenuAction[] = READER_MENU_ITEMS.map(item => item.id)

/**
 * 读回来的菜单项：只认登记过的 id、去重、保序。
 * 空数组或全不认时回默认 —— 工具栏是打开设置抽屉的唯一入口（还有键盘 `S`），
 * 一个按钮都不剩等于把用户关在门外，所以"全隐藏"不合法，直接回默认。
 */
export function parseReaderMenu(value: unknown): ReaderMenuAction[] {
  if (!Array.isArray(value)) return [...DEFAULT_READER_MENU]
  const seen = new Set<string>()
  const list: ReaderMenuAction[] = []
  for (const item of value) {
    if (typeof item === 'string' && KNOWN.has(item) && !seen.has(item)) {
      seen.add(item)
      list.push(item as ReaderMenuAction)
    }
  }
  return list.length ? list : [...DEFAULT_READER_MENU]
}

/** 显示 / 隐藏一项：不在就按登记顺序插到末尾，在就去掉；去掉最后一项不生效（至少留一个）。 */
export function toggleReaderMenu(items: ReaderMenuAction[], id: ReaderMenuAction): ReaderMenuAction[] {
  if (items.includes(id)) return items.length <= 1 ? items : items.filter(item => item !== id)
  return [...items, id]
}

/** 上移（-1）/ 下移（+1）一项；到头或找不到就原样返回。 */
export function moveReaderMenu(items: ReaderMenuAction[], id: ReaderMenuAction, delta: -1 | 1): ReaderMenuAction[] {
  const index = items.indexOf(id)
  const target = index + delta
  if (index < 0 || target < 0 || target >= items.length) return items
  const next = [...items]
  next[index] = next[target]
  next[target] = id
  return next
}
