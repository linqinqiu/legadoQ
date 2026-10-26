import type { BookshelfItem } from '../lib/api'

/**
 * 书架自定义排序（用户 2026-10-02：「批量管理功能在，长按书籍可移动能排顺序（自定义）」）。
 * 排序算术单独放一份：拖动这件事的现场（pointer 事件、rAF、滚动边缘）不适合写用例，
 * 但"落到第几格""挪完是什么顺序""谁排在谁前面"这三件事错了，用户看到的就是一片乱序，
 * 而且只在真拖起来之后才看得见。
 */

/** 排过序的在前，没排过的按最后阅读跟在有序段之后（服务端 `sort_order` 可空就是这个意思）。 */
export function compareCustomSort(a: BookshelfItem, b: BookshelfItem): number {
  const left = a.sortOrder ?? null
  const right = b.sortOrder ?? null
  if (left !== null && right !== null) return left - right
  if (left !== null) return -1
  if (right !== null) return 1
  return b.lastReadAt - a.lastReadAt
}

export type Rect = { left: number; top: number; width: number; height: number }

/**
 * 指针落在哪两格之间。返回插入位（原数组下标语义：插到第 i 格之前）。
 * 命中某格时按左右半边分"插到它前面还是后面" —— 网格里一行好几本，只看中心点会让
 * 用户分不清松手后落在哪，中线是唯一不需要读心就能预判的边界。
 */
export function dropIndexAt(rects: Rect[], x: number, y: number): number {
  const hit = rects.findIndex(rect => x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height)
  if (hit >= 0) return x > rects[hit].left + rects[hit].width / 2 ? hit + 1 : hit
  let nearest = -1
  let best = Infinity
  rects.forEach((rect, index) => {
    const distance = Math.hypot(rect.left + rect.width / 2 - x, rect.top + rect.height / 2 - y)
    if (distance < best) { best = distance; nearest = index }
  })
  return nearest < 0 ? -1 : nearest
}

/** 把下标 `from` 那一项挪到"原数组的第 insertAt 格之前"。越界与原地都**返回同一个数组** —— 调用方靠这个引用相等判断"没动过"。 */
export function moveWithin<T>(list: T[], from: number, insertAt: number): T[] {
  if (from < 0 || from >= list.length) return list
  const target = Math.max(0, Math.min(list.length - 1, insertAt > from ? insertAt - 1 : insertAt))
  if (target === from) return list
  const next = [...list]
  const [moved] = next.splice(from, 1)
  next.splice(target, 0, moved)
  return next
}
