import { useEffect, type RefObject } from 'react'

/**
 * 弹层里可聚焦的元素。
 *
 * `[tabindex="-1"]` 故意排除：那是给"容器本身"用的，不参与 Tab 循环。
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * 当前打开的弹层（后进先出）。
 *
 * 父弹层里再开一层（书籍详情 → 封面预览、替换规则 → 导入框）时，两层都会监听 Tab：
 * 只有**最上面那层**能处理，否则父层会把焦点从子弹层里拽回去，两个循环互相打架。
 */
const activeTraps: symbol[] = []

/**
 * 把 Tab 关在弹层里。
 *
 * `role="dialog"` + `aria-modal="true"` 只是**说明**，键盘不会自己遵守：没有这道锁，
 * Tab 会从浮层一路跑到背后的阅读器 / 书架上，读屏用户也会读到背景内容。
 *
 * 打开时把焦点移进第一个可聚焦元素（没有就落到容器），关闭时还给打开它的那个元素。
 * 监听挂在 `document` 上并走捕获阶段 —— 即使焦点已经跑到浮层外，也能被拽回来。
 */
export function useFocusTrap(container: RefObject<HTMLElement | null>, active = true) {
  useEffect(() => {
    if (!active) return
    const root = container.current
    if (!root) return

    const token = Symbol('focus-trap')
    activeTraps.push(token)
    const isTopmost = () => activeTraps[activeTraps.length - 1] === token
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusables = () =>
      Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
        // 隐藏的元素（`display:none` / 折叠区里的按钮）不参与 Tab 循环。
        .filter(el => el.offsetParent !== null || el === document.activeElement)

    // 容器自己要能接住焦点：没有任何可聚焦子元素时，焦点落在这里，而不是背景页。
    if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1')
    ;(focusables()[0] ?? root).focus({ preventScroll: true })

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      // 嵌套弹层：只让最上面那层接管，父层不能把焦点从子弹层里拽回去。
      if (!isTopmost()) return
      const items = focusables()
      if (items.length === 0) {
        event.preventDefault()
        root.focus({ preventScroll: true })
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const activeEl = document.activeElement
      const inside = activeEl instanceof Node && root.contains(activeEl)
      if (event.shiftKey && (!inside || activeEl === first)) {
        event.preventDefault()
        last.focus({ preventScroll: true })
      } else if (!event.shiftKey && (!inside || activeEl === last)) {
        event.preventDefault()
        first.focus({ preventScroll: true })
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      const index = activeTraps.lastIndexOf(token)
      if (index >= 0) activeTraps.splice(index, 1)
      document.removeEventListener('keydown', onKeyDown, true)
      previous?.focus?.({ preventScroll: true })
    }
  }, [container, active])
}
