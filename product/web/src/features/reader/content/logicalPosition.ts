/**
 * 阅读逻辑位置：章节内字符偏移 + 段落锚点 + 内容校验值。
 *
 * 页码、滚动比例都依赖字号、栏宽、窗口里挂了几章，只能当"派生显示"。
 * 真正该落盘的是**正文里的一个字符位置**：换字号、换分栏、前后接章之后，
 * 仍能二分回同一段、同一行。
 *
 * 这里只放纯函数与 DOM 小工具；ReaderScreen 只负责"从当前视口取一个偏移"和"把偏移滚回视口"。
 */

export type LogicalPosition = {
  charOffset: number
  paragraphAnchor: string
  positionChecksum: string
}

/**
 * 段落起点：段与段之间按一个换行算，和 `splitParagraphs` 的输出一一对应。
 * 空段落不会出现在 `splitParagraphs` 里，所以下标就是渲染时的 `data-paragraph-index`。
 */
export function buildParagraphStarts(paragraphs: readonly string[]): number[] {
  const starts = new Array<number>(paragraphs.length)
  let running = 0
  for (let i = 0; i < paragraphs.length; i += 1) {
    starts[i] = running
    running += paragraphs[i].length + 1
  }
  return starts
}

/** 字符偏移 → 第几段 + 段内偏移。越界一律夹到最后一段末尾，绝不返回负数。 */
export function offsetToParagraph(
  starts: readonly number[],
  charOffset: number,
): { index: number; within: number } {
  if (starts.length === 0) return { index: 0, within: 0 }
  const offset = Number.isFinite(charOffset) ? Math.max(0, Math.floor(charOffset)) : 0
  let low = 0
  let high = starts.length - 1
  let found = 0
  while (low <= high) {
    const mid = (low + high) >> 1
    if (starts[mid] <= offset) {
      found = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return { index: found, within: Math.max(0, offset - starts[found]) }
}

/** 稳定、可读、不依赖序号的锚点；序号只是给"二分失败时做邻近兜底"用的。 */
export function paragraphAnchor(index: number): string {
  return `p${Math.max(0, Math.floor(index))}`
}

/** FNV-1a 32 位。只求"内容变没变"，不用于安全。 */
export function checksumText(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 节点位置 → 段内字符偏移（高亮里的 `<mark>` 等嵌套节点也要算进去）。 */
export function textOffsetWithin(root: HTMLElement, node: Node, offset: number): number {
  let total = 0
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const current = walker.currentNode
    if (current === node) return total + Math.max(0, offset)
    total += (current.textContent ?? '').length
  }
  return total
}

/**
 * 段内第 N 个字符的屏幕矩形。
 *
 * 取 `[offset, offset + 1)` 而不是折叠 Range：折叠 Range 在行尾/段尾经常量出 0×0，
 * 拿它算"这一页从哪开始"会稳定地差一段。段尾则退到最后一个字符。
 */
export function textOffsetRect(root: HTMLElement, offset: number): DOMRect | null {
  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let remaining = Math.max(0, Math.floor(offset))
  let lastText: Text | null = null
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    const length = node.data.length
    lastText = node
    if (remaining < length) {
      const range = doc.createRange()
      range.setStart(node, remaining)
      range.setEnd(node, Math.min(length, remaining + 1))
      const rect = range.getBoundingClientRect()
      if (rect.width > 0 || rect.height > 0) return rect
      break
    }
    remaining -= length
  }
  if (lastText && lastText.data.length > 0) {
    const range = doc.createRange()
    range.setStart(lastText, Math.max(0, lastText.data.length - 1))
    range.setEnd(lastText, lastText.data.length)
    const rect = range.getBoundingClientRect()
    if (rect.width > 0 || rect.height > 0) return rect
  }
  return null
}

/**
 * 鼠标/视口坐标 → 段落内字符偏移。
 * Chrome/Edge/Safari 走 `caretRangeFromPoint`，Firefox 走 `caretPositionFromPoint`；
 * 两个都没有（或点在了段外）就返回 null，让调用方退到段首。
 */
export function caretOffsetWithin(el: HTMLElement, clientX: number, clientY: number): number | null {
  const doc = el.ownerDocument as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }
  let node: Node | null = null
  let offset = 0
  if (typeof doc.caretRangeFromPoint === 'function') {
    const range = doc.caretRangeFromPoint(clientX, clientY)
    if (range) {
      node = range.startContainer
      offset = range.startOffset
    }
  } else if (typeof doc.caretPositionFromPoint === 'function') {
    const position = doc.caretPositionFromPoint(clientX, clientY)
    if (position) {
      node = position.offsetNode
      offset = position.offset
    }
  }
  if (!node || !el.contains(node)) return null
  return textOffsetWithin(el, node, offset)
}
