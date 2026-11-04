import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { dropIndexAt, moveWithin, type Rect } from './shelfOrder'

/** 按住多久算"我要拖动"而不是"我要点开"。250ms 是各家长按的常见档位，再长就手感发木。 */
const HOLD_MS = 250
/** 按住之前先动了这么多像素，说明用户是在滚动页面，不是在拖动。 */
const MOVE_SLOP = 9
/** 拖到上下边缘这么多像素内时自动滚动，否则长列表永远拖不到末尾。 */
const EDGE_SCROLL = 56

export type DragSortState = { from: number; at: number } | null

/**
 * 长按拖动排序。只负责"手势 → 落点下标"，顺序怎么落库、乐观更新都交给调用方，
 * 因为可拖的清单是**筛选后**的那一列，服务端要的是这一列的新顺序而不是全库。
 * 书架与书源列表共用这一份：各写一遍手势，只会一个修了另一个忘修。
 */
export function useDragSort<T>(options: {
  enabled: () => boolean
  gridRef: RefObject<HTMLElement | null>
  /** 参与拖动的子元素选择器（书架是 `.shelf-card`，书源列表是 `.source-list-item`） */
  itemSelector: string
  items: T[]
  onReorder: (ordered: T[]) => void
}) {
  const { enabled, gridRef, itemSelector, items, onReorder } = options
  const [drag, setDrag] = useState<DragSortState>(null)
  const dragRef = useRef<DragSortState>(null)
  const suppressClickRef = useRef(false)

  const measure = useCallback((): Rect[] => {
    const grid = gridRef.current
    if (!grid) return []
    const offset = window.scrollY
    return [...grid.querySelectorAll<HTMLElement>(itemSelector)].map(node => {
      const box = node.getBoundingClientRect()
      return { left: box.left, top: box.top + offset, width: box.width, height: box.height }
    })
  }, [gridRef, itemSelector])

  const beginDrag = useCallback((from: number, rects: Rect[]) => {
    dragRef.current = { from, at: from }
    setDrag({ from, at: from })
    const move = (event: PointerEvent) => {
      // 自动滚动直接改 window：rects 存的是文档坐标，滚完之后命中测试仍然对得上
      if (event.clientY < EDGE_SCROLL) window.scrollBy(0, -16)
      else if (event.clientY > window.innerHeight - EDGE_SCROLL) window.scrollBy(0, 16)
      const at = dropIndexAt(rects, event.clientX, event.clientY + window.scrollY)
      if (at < 0) return
      const current = dragRef.current
      if (!current || current.at === at) return
      current.at = at
      setDrag({ from: current.from, at })
    }
    const finish = (event: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', cancel)
      const current = dragRef.current
      dragRef.current = null
      setDrag(null)
      if (!current) return
      const ordered = moveWithin(items, current.from, current.at)
      // moveWithin 原地不动时返回同一个数组，靠引用相等挡住什么都没变的写库
      if (ordered !== items) onReorder(ordered)
      // 拖完这一下不能再被当成"点开这本书"，否则一松手就跳进阅读器
      suppressClickRef.current = true
      window.setTimeout(() => { suppressClickRef.current = false }, 0)
      event.preventDefault()
    }
    const end = (event: PointerEvent) => finish(event)
    const cancel = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', cancel)
      dragRef.current = null
      setDrag(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', cancel)
  }, [items, onReorder])

  const onPointerDown = useCallback((index: number) => (event: ReactPointerEvent<HTMLElement>) => {
    if (!enabled() || event.button !== 0 || dragRef.current) return
    const originX = event.clientX
    const originY = event.clientY
    let started = false
    const timer = window.setTimeout(() => {
      started = true
      const rects = measure()
      if (rects.length < 2) { started = false; return }
      beginDrag(index, rects)
    }, HOLD_MS)
    const abort = (moveEvent: PointerEvent) => {
      if (started) return
      if (Math.hypot(moveEvent.clientX - originX, moveEvent.clientY - originY) > MOVE_SLOP) {
        window.clearTimeout(timer)
        window.removeEventListener('pointerup', release)
        window.removeEventListener('pointercancel', release)
      }
    }
    const release = () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointermove', abort)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
    window.addEventListener('pointermove', abort)
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
  }, [beginDrag, enabled, measure])

  const onClickCapture = useCallback((event: React.MouseEvent) => {
    if (!suppressClickRef.current) return
    event.stopPropagation()
    event.preventDefault()
  }, [])

  return { drag, onPointerDown, onClickCapture }
}
