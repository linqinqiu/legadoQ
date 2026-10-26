import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../icons'
import { OVERLAY_EDGE, clampOverlay } from '../lib/overlayGeometry'

export type SelectOption = { value: string; label: string; hint?: string; disabled?: boolean }

/**
 * 站内下拉控件。
 *
 * 换掉原生 `<select>` 的原因不是好看：原生弹层的字号、选中态、系统滚动条都跟系统走，
 * 和全站控件不同形；而且选项一多（书源几千条）原生只有首字母跳转，没法按名字过滤。
 * 所以这里选项超过 `SEARCH_THRESHOLD` 条时浮层自带一个过滤框。
 *
 * 下面这几个几何数是**唯一的一份**：样式表里不再重复声明（原来 `.ui-select-menu` 写 340、
 * `.ui-select-options` 写 288、`.ui-select-option` 写 32，而这里是 340/288/34 —— 34 与 32
 * 互相矛盾，改一处另一处照样生效，没人发现）。夹进视口那条算式与右键菜单共用一份。
 */
const SEARCH_THRESHOLD = 12
/** 打开时最多露出几行（再多就滚）。 */
const VISIBLE_ROWS = 8
/** 浮层总高上限，决定"往下开还是往上开"。 */
const MENU_MAX_HEIGHT = 340
/** 单行高度（虚拟滚动按它切窗口，行本身靠内联高度）。 */
const ROW_H = 34
/** 选项列表可视高度上限。 */
const LIST_MAX_H = 288
/** 浮层内边距（上下各 6）与过滤框那一档，只为算开向，不参与布局。 */
const MENU_PADDING = 12
const SEARCH_BOX_H = 44
/** 浮层与触发器之间那一条缝。 */
const TRIGGER_GAP = 4
/** 触发器再窄也不小于这一档，否则两个字的选择器没法读。 */
const TRIGGER_MIN_WIDTH = 180
const OVERSCAN = 6

type SelectProps = {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  ariaLabel: string
  placeholder?: string
  className?: string
  /** 强制显示过滤框（哪怕选项不多）。 */
  searchable?: boolean
  /** 整只控件不可用（比如批量操作还没选中任何书时，不该让人以为能点）。 */
  disabled?: boolean
  /** 挂到触发器那颗 button 上，给外部 `<label htmlFor>` 用（button 也是可标注元素）。 */
  id?: string
}

export function Select({ value, options, onChange, ariaLabel, placeholder = '请选择', className = '', searchable, disabled = false, id }: SelectProps) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [active, setActive] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [placement, setPlacement] = useState<{ left: number; top: number; width: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  const selected = options.find(option => option.value === value)
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return options
    return options.filter(option => `${option.label} ${option.hint ?? ''}`.toLowerCase().includes(needle))
  }, [options, filter])

  const wantSearch = searchable || options.length > SEARCH_THRESHOLD
  // 虚拟滚动窗口：只渲染可视区 ± overscan 行，5574 条也能顺滑滚到底，不再截断成 200。
  const totalHeight = shown.length * ROW_H
  const viewportHeight = Math.min(LIST_MAX_H, Math.max(ROW_H, totalHeight))
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const end = Math.min(shown.length, Math.ceil((scrollTop + viewportHeight) / ROW_H) + OVERSCAN)
  const visible = shown.slice(start, end)

  // 浮层用 fixed + portal：书架/订阅面板都有各自的边框与滚动容器，
  // 绝对定位会被祖先裁掉，长列表在窄屏上还会顶出视口。
  useEffect(() => {
    if (!open) return
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const root = document.documentElement
    // clientWidth/clientHeight 而不是 innerWidth/innerHeight：后者把经典滚动条算进来，
    // position: fixed 的包含块本来不含滚动条，用错一个数就是"夹到 8px"实际压在滚动条上。
    const viewport = { width: root.clientWidth, height: root.clientHeight }
    const width = Math.max(rect.width, TRIGGER_MIN_WIDTH)
    const wanted = Math.min(MENU_MAX_HEIGHT,
      (wantSearch ? SEARCH_BOX_H : 0) + Math.max(1, Math.min(shown.length, VISIBLE_ROWS)) * ROW_H + MENU_PADDING)
    const below = viewport.height - rect.bottom - OVERLAY_EDGE
    const openUp = below < wanted && rect.top - OVERLAY_EDGE > below
    const top = openUp ? rect.bottom - Math.min(wanted, rect.top - OVERLAY_EDGE) - TRIGGER_GAP : rect.bottom + TRIGGER_GAP
    const at = clampOverlay({ left: rect.left, top, width, height: wanted }, viewport)
    setPlacement({ left: at.left, top: at.top, width })
    setActive(Math.max(0, shown.findIndex(option => option.value === value)))
  }, [open])

  // 打开时把当前选中项滚到可视区中部（虚拟滚动下不能靠浏览器自己定位）。
  useEffect(() => {
    if (!open) return
    const idx = Math.max(0, shown.findIndex(option => option.value === value))
    const el = listRef.current
    if (!el) return
    const target = Math.max(0, idx * ROW_H - viewportHeight / 2 + ROW_H / 2)
    el.scrollTop = target
    setScrollTop(target)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 过滤词一变，列表内容全变，滚动位置归零。
  useEffect(() => {
    setScrollTop(0)
    if (listRef.current) listRef.current.scrollTop = 0
  }, [filter])

  // 键盘上下移动高亮时，把高亮行滚进可视区。
  useEffect(() => {
    if (!open) return
    const el = listRef.current
    if (!el) return
    const top = active * ROW_H
    const bottom = top + ROW_H
    if (top < el.scrollTop) { el.scrollTop = top; setScrollTop(top) }
    else if (bottom > el.scrollTop + viewportHeight) { const next = bottom - viewportHeight; el.scrollTop = next; setScrollTop(next) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) } }
    const onResize = () => setOpen(false)
    // 关菜单的滚动监听：只关心「菜单外部」的滚动。
    // 菜单本身是 portal 到 body 的，内部 .ui-select-options 自己滚；
    // 若把它的 scroll 也算进来，就会「一滑就关」——正是用户说的"不能正常滑动点击"。
    const onScroll = (event: Event) => {
      const target = event.target
      if (menuRef.current && target instanceof Node && menuRef.current.contains(target)) return
      setOpen(false)
    }
    addEventListener('pointerdown', onPointerDown, true)
    addEventListener('keydown', onKey)
    addEventListener('resize', onResize)
    // 找最近的滚动祖先并监听它；找不到就退回 window 捕获。
    // 两条路径都靠上面的 onScroll 守卫排除菜单内部滚动，所以退回 window 也安全。
    let container: HTMLElement | null = null
    let el: HTMLElement | null = triggerRef.current
    while (el && el !== document.body) {
      const style = getComputedStyle(el)
      if (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflow === 'auto' || style.overflow === 'scroll') {
        container = el
        break
      }
      el = el.parentElement
    }
    if (container) container.addEventListener('scroll', onScroll, true)
    else addEventListener('scroll', onScroll, true)
    return () => {
      removeEventListener('pointerdown', onPointerDown, true)
      removeEventListener('keydown', onKey)
      removeEventListener('resize', onResize)
      if (container) container.removeEventListener('scroll', onScroll, true)
      else removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) { setFilter(''); return }
    if (wantSearch) searchRef.current?.focus()
    else menuRef.current?.focus()
  }, [open, wantSearch])

  const pick = (option: SelectOption) => {
    if (option.disabled) return
    onChange(option.value)
    setOpen(false)
    triggerRef.current?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!shown.length) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(current => (current + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length)
      return
    }
    if (event.key === 'Home') { event.preventDefault(); setActive(0); return }
    if (event.key === 'End') { event.preventDefault(); setActive(shown.length - 1); return }
    if (event.key === 'Enter' || event.key === ' ') {
      if (event.key === ' ' && event.target === triggerRef.current) return
      event.preventDefault()
      const option = shown[Math.min(active, shown.length - 1)]
      if (option) pick(option)
    }
  }

  return (
    <span className={`ui-select ${className}`.trim()} data-open={open || undefined}>
      <button
        type="button"
        id={id}
        ref={triggerRef}
        className="ui-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => { if (!disabled) setOpen(current => !current) }}
        onKeyDown={event => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span className="ui-select-value">{selected?.label ?? placeholder}</span>
        <Icon name="chevronDown" />
      </button>
      {open && placement && createPortal(
        <div
          id={listId}
          ref={menuRef}
          className="ui-select-menu"
          role="listbox"
          tabIndex={-1}
          aria-label={ariaLabel}
          style={{ left: placement.left, top: placement.top, width: placement.width }}
          onKeyDown={onKeyDown}
        >
          {wantSearch && (
            <input
              ref={searchRef}
              className="ui-select-search"
              value={filter}
              placeholder="输入以过滤"
              aria-label={`过滤${ariaLabel}`}
              onChange={event => { setFilter(event.target.value); setActive(0) }}
              onKeyDown={onKeyDown}
            />
          )}
          <div
            ref={listRef}
            className="ui-select-options"
            style={{ height: viewportHeight }}
            onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
          >
            {shown.length === 0 && <p className="ui-select-none">没有匹配的选项</p>}
            {shown.length > 0 && (
              <div style={{ position: 'relative', height: totalHeight }}>
                {visible.map((option, offset) => {
                  const index = start + offset
                  return (
                    <button
                      type="button"
                      key={option.value || `__empty${index}`}
                      role="option"
                      aria-selected={option.value === value}
                      className={[
                        'ui-select-option',
                        index === active ? 'active' : '',
                        option.value === value ? 'current' : '',
                        option.disabled ? 'disabled' : '',
                      ].filter(Boolean).join(' ')}
                      style={{ position: 'absolute', top: index * ROW_H, left: 0, right: 0, height: ROW_H }}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => pick(option)}
                    >
                      <span>{option.label}</span>
                      {option.hint && <small>{option.hint}</small>}
                      {option.value === value && <Icon name="check" />}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </span>
  )
}
