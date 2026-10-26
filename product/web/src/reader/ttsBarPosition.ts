import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'

/**
 * 朗读悬浮条的位置（用户 2026-10-03：「朗读功能启动产生的，长按可以调节位置，防止遮挡文本内容，
 * 记忆下次启动还是上次的位置，双击『朗读本章』恢复默认位置」）。
 *
 * 三件事各自都有反面做法，这里逐条说明为什么这样做：
 * ① **长按才进入拖动**（250ms + 9px 容差），不是按下去就拖 —— 这条 bar 上全是按钮，
 *    点一下就跟着走会让人以为按钮失灵。容差之内松手 = 一次普通点击，不写位置。
 * ② 位置存 localStorage 且**只存左上角**（不是 bottom/right 那套），下次启动原样恢复；
 *    窗口变小时按当前视口夹回来，不会出现"拖出去就再也找不回来"。
 * ③ 复位是**双击「朗读本章」**，不在这条 bar 上再摆一颗"重置"按钮：
 *    用户找不到位置时最需要的是"什么都不用想"的手势，而不是又一个控件。
 *
 * `null` 表示"从没拖过"，此时不写任何内联样式，位置完全由 CSS 的 `.tts-floating-bar` 决定 ——
 * 默认位置只有一个事实来源，恢复默认 = 把这份覆盖清掉。
 */
const STORAGE_KEY = 'legado-tts-bar-pos'
const HOLD_MS = 250
const SLOP = 9
/** 夹住视口时留出的边距：不让 bar 贴死边缘，留出可抓的余地。 */
const EDGE = 8

export type BarPosition = { x: number; y: number }

/**
 * 窄屏底部那条导航（`.mobile-reader-nav`）是固定高度、盖在正文上的，
 * 朗读条停在它上面就等于把「目录 / 书签 / 换源 / 朗读 / 设置 / 夜读」六颗键糊住。
 * 所以夹下边界时要按导航**实测高度**留位（`@media (max-width:640px)` 里那条
 * `bottom: 74px` 只在没拖过时生效 —— 拖过之后内联 `bottom:auto` 把它覆盖了）。
 */
function bottomReserve(): number {
  const nav = document.querySelector<HTMLElement>('.mobile-reader-nav')
  if (!nav) return EDGE
  if (getComputedStyle(nav).display === 'none') return EDGE
  return nav.getBoundingClientRect().height + EDGE
}

type Drag = {
  pointerId: number
  startX: number
  startY: number
  originX: number
  originY: number
  held: boolean
  moved: boolean
}

function readStored(): BarPosition | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<BarPosition> | null
    const x = Number(parsed?.x)
    const y = Number(parsed?.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    return { x, y }
  } catch {
    return null
  }
}

/** 把左上角夹进视口：bar 尺寸用实测的，不猜常量。 */
export function clampPosition(pos: BarPosition, size: { width: number; height: number }): BarPosition {
  const maxX = Math.max(EDGE, window.innerWidth - size.width - EDGE)
  const maxY = Math.max(EDGE, window.innerHeight - size.height - bottomReserve())
  return {
    x: Math.min(maxX, Math.max(EDGE, Math.round(pos.x))),
    y: Math.min(maxY, Math.max(EDGE, Math.round(pos.y))),
  }
}

export function resetTtsBarPosition(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // 隐私模式下 localStorage 会抛：清不掉也不该影响"回到 CSS 默认位置"这件事
  }
  window.dispatchEvent(new CustomEvent('legado-tts-bar-reset'))
}

/**
 * 挂到那条 bar 上：返回内联 style 与 pointer 处理。
 * `onDragged` 在拖完（真的移动过）之后回调，供调用方抑制随之而来的 click。
 */
export function useTtsBarPosition(getElement: () => HTMLElement | null) {
  const [position, setPosition] = useState<BarPosition | null>(readStored)
  const drag = useRef<Drag | null>(null)
  const holdTimer = useRef<number | null>(null)
  const suppressClick = useRef(false)

  /**
   * 视口变化（含手机转屏）后重新夹一次，**挂载时也要夹**：
   * 存进去的坐标是在另一块屏上量的 —— 宽屏拖到右下角、再用 390px 的手机打开，
   * 只夹 resize 的话这一次没人触发，bar 连同抓手一起留在视口外，用户"再也拖不回来"
   * （2026-10-03 审计查出来的，正是这个文件开头注释里承诺要避免的事）。
   */
  useEffect(() => {
    const clampNow = () => {
      setPosition(current => {
        if (!current) return current
        const element = getElement()
        if (!element) return current
        const rect = element.getBoundingClientRect()
        const next = clampPosition(current, { width: rect.width, height: rect.height })
        return next.x === current.x && next.y === current.y ? current : next
      })
    }
    clampNow()
    window.addEventListener('resize', clampNow)
    return () => window.removeEventListener('resize', clampNow)
  }, [getElement])

  useEffect(() => {
    const onReset = () => setPosition(null)
    window.addEventListener('legado-tts-bar-reset', onReset)
    return () => window.removeEventListener('legado-tts-bar-reset', onReset)
  }, [])

  useEffect(() => () => {
    if (holdTimer.current !== null) clearTimeout(holdTimer.current)
  }, [])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    // 按在按钮/输入框上不该抓走整条 bar：那条 bar 上六个键都是控件，
    // "长按暂停 = 把播放器拖走"会让人以为按钮坏了。可拖的是空白处与左边那块信息区。
    if ((event.target as HTMLElement).closest('button, a, input, select, textarea')) return
    const element = getElement()
    if (!element) return
    const rect = element.getBoundingClientRect()
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: rect.left,
      originY: rect.top,
      held: false,
      moved: false,
    }
    // 长按到点才"抓起来"：在此之前移动鼠标只是普通移动，不跟手
    holdTimer.current = window.setTimeout(() => {
      if (!drag.current) return
      drag.current.held = true
      element.setPointerCapture?.(event.pointerId)
      element.classList.add('is-dragging')
    }, HOLD_MS)
  }, [getElement])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const active = drag.current
    if (!active || !active.held) return
    const dx = event.clientX - active.startX
    const dy = event.clientY - active.startY
    if (!active.moved && Math.hypot(dx, dy) < SLOP) return
    active.moved = true
    suppressClick.current = true
    const element = getElement()
    if (!element) return
    setPosition(clampPosition({ x: active.originX + dx, y: active.originY + dy }, element.getBoundingClientRect()))
  }, [getElement])

  const finish = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const active = drag.current
    if (!active || active.pointerId !== event.pointerId) return
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
    drag.current = null
    getElement()?.classList.remove('is-dragging')
    // 只认"真的拖动过"的落点：长按但没移动也算一次点击，不该顺手写盘
    if (active.moved) {
      setPosition(current => {
        if (current) {
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
          } catch {
            // 存不进去只是下次回到默认位置，不该打断正在读的书
          }
        }
        return current
      })
    }
  }, [getElement])

  /** 拖过之后浏览器还会补一次 click（按在按钮上会真的触发那个按钮）—— 只吞这一次。 */
  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!suppressClick.current) return
    suppressClick.current = false
    event.stopPropagation()
    event.preventDefault()
  }, [])

  return {
    position,
    style: position ? { left: position.x, top: position.y, right: 'auto', bottom: 'auto', transform: 'none' } as const : undefined,
    handlers: { onPointerDown, onPointerMove, onPointerUp: finish, onPointerCancel: finish, onClickCapture },
  }
}
