// 这个组件在 `web/test/tap-zone-editor.test.ts` 里被 `renderToStaticMarkup` 静态渲染，
// 那条链路走 classic JSX（`React.createElement`），只有 Vite 构建才走 automatic runtime。
// 少这一行时构建与页面都正常，只有套件红四条 —— 与 ShortcutHelp/useEscapeClose 那次同形。
import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Icon } from '../icons'
import { useEscapeClose } from '../lib/useEscapeClose'
import {
  addCut,
  removeCut,
  clampCut,
  MAX_CUTS,
  mapCells,
  remapActions,
  TAP_ACTION_LABELS,
  TAP_ACTION_ORDER,
  TAP_ACTION_SHORT,
  TAP_PRESETS,
  type TapAction,
  type TapMap,
} from './tapZones'

type Axis = 'x' | 'y'

/**
 * 「点击区域」编辑器（用户 2026-10-09：「区域设置改提供横竖虚线，自定义，但是要区分翻页方式的影响」
 * +「这个改成底下一小行，可以折叠进去，目的是显示更多书籍内容」）。
 *
 * 它是一层盖在正文上的编辑层：正文照常渲染（看得见字），上面画**虚线**分区 ——
 * 竖虚线分左右列（分页）、横虚线分上下段（滚动），拖一下就能改位置（"横竖虚线，自定义"）。
 * 控制条收在**底部一行**、默认折叠，展开才露出动作与预设 —— 调分区时正文占满屏，
 * 而不是被一整块设置挡住（"显示更多书籍内容"）。
 *
 * 两种翻页方式各一张表（"区分翻页方式的影响"）：切换方式换的是另一张表，互不干扰。
 */
export function TapZoneEditor({
  map, mode, left = 0, onMap, onMode, onPreset, onClose,
}: {
  map: TapMap
  mode: 'paginate' | 'scroll'
  /** 正文区左缘（px）：固定目录时把编辑层让开目录栏，别压住它。 */
  left?: number
  onMap: (next: TapMap) => void
  onMode: (next: 'paginate' | 'scroll') => void
  onPreset: (paginate: TapMap, scroll: TapMap) => void
  onClose: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [selected, setSelected] = useState(0)
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ axis: Axis; index: number } | null>(null)

  useEscapeClose(onClose)

  const cols = map.x.length + 1
  const rows = map.y.length + 1
  const cells = mapCells(map)
  // 换预设 / 删线之后选区可能越界，拉回第一格（否则动作按钮全都不高亮，像是坏了）
  useEffect(() => { if (selected >= cells) setSelected(0) }, [cells, selected])

  const cellsList = useMemo(() => {
    const bounds = (cuts: number[], index: number): [number, number] =>
      [index === 0 ? 0 : cuts[index - 1], index === cuts.length ? 1 : cuts[index]]
    const list: { index: number; left: number; top: number; width: number; height: number; action: TapAction }[] = []
    for (let row = 0; row < rows; row += 1) {
      const [top, bottom] = bounds(map.y, row)
      for (let col = 0; col < cols; col += 1) {
        const [left, right] = bounds(map.x, col)
        const index = row * cols + col
        list.push({ index, left, top, width: right - left, height: bottom - top, action: map.actions[index] ?? 'none' })
      }
    }
    return list
  }, [map, cols, rows])

  const setAction = (action: TapAction) => {
    const actions = [...map.actions]
    actions[selected] = action
    onMap({ ...map, actions })
  }

  /** 换某一轴的虚线：动作按"新格中心落在旧哪一格"搬过来（见 remapActions）。 */
  const withCuts = (axis: Axis, next: number[]) => {
    onMap(axis === 'x' ? remapActions(map, next, map.y) : remapActions(map, map.x, next))
  }

  const onHandleDown = (axis: Axis, index: number) => (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    drag.current = { axis, index }
    // 抓住指针，拖出这条线本身也还能收到 move（否则手一快线就"掉了"）
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onHandleMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current
    const surface = surfaceRef.current
    if (!current || !surface) return
    const rect = surface.getBoundingClientRect()
    const value = current.axis === 'x'
      ? (event.clientX - rect.left) / rect.width
      : (event.clientY - rect.top) / rect.height
    const cuts = current.axis === 'x' ? map.x : map.y
    const next = [...cuts]
    next[current.index] = clampCut(cuts, current.index, value)
    withCuts(current.axis, next)
  }
  const onHandleUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const modeLabel = mode === 'paginate' ? '平移分页' : '连续滚动'

  return (
    <div className="tap-zone-editor" style={{ left: `${left}px` }} role="dialog" aria-label="编辑点击区域">
      <div ref={surfaceRef} className="tap-zone-surface">
        {cellsList.map(cell => (
          <button
            key={cell.index}
            type="button"
            className={`tap-zone-cell ${selected === cell.index ? 'is-selected' : ''}`}
            style={{ left: `${cell.left * 100}%`, top: `${cell.top * 100}%`, width: `${cell.width * 100}%`, height: `${cell.height * 100}%` }}
            aria-label={`第 ${cell.index + 1} 区：${TAP_ACTION_LABELS[cell.action].label}`}
            onClick={() => setSelected(cell.index)}
          >
            <span>{TAP_ACTION_SHORT[cell.action]}</span>
          </button>
        ))}
        {map.x.map((cut, index) => (
          <div
            key={`x-${index}`}
            className="tap-zone-line is-v"
            style={{ left: `${cut * 100}%` }}
            role="separator"
            aria-label={`第 ${index + 1} 条竖虚线`}
            onPointerDown={onHandleDown('x', index)}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            onDoubleClick={() => withCuts('x', removeCut(map.x, index))}
          />
        ))}
        {map.y.map((cut, index) => (
          <div
            key={`y-${index}`}
            className="tap-zone-line is-h"
            style={{ top: `${cut * 100}%` }}
            role="separator"
            aria-label={`第 ${index + 1} 条横虚线`}
            onPointerDown={onHandleDown('y', index)}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            onDoubleClick={() => withCuts('y', removeCut(map.y, index))}
          />
        ))}
      </div>

      <div className="tap-zone-strip">
        <div className="tap-zone-strip-head">
          <button type="button" className="tap-zone-strip-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
            <Icon name={expanded ? 'chevronDown' : 'chevronRight'} />
            <span>点击区域 · {modeLabel} · {cells} 区</span>
          </button>
          <button type="button" className="tap-zone-strip-done" onClick={onClose}>完成</button>
        </div>
        {expanded && (
          <div className="tap-zone-strip-body">
            <div className="tap-zone-row">
              <span className="tap-zone-row-label">翻页方式</span>
              <div className="page-modes">
                <button type="button" className={mode === 'scroll' ? 'selected' : ''} onClick={() => onMode('scroll')}>连续滚动</button>
                <button type="button" className={mode === 'paginate' ? 'selected' : ''} onClick={() => onMode('paginate')}>平移分页</button>
              </div>
            </div>
            <div className="tap-zone-row">
              <span className="tap-zone-row-label">加虚线</span>
              <button type="button" className="tap-zone-mini" disabled={map.x.length >= MAX_CUTS} onClick={() => withCuts('x', addCut(map.x))}>＋竖线</button>
              <button type="button" className="tap-zone-mini" disabled={map.y.length >= MAX_CUTS} onClick={() => withCuts('y', addCut(map.y))}>＋横线</button>
            </div>
            <div className="tap-zone-row is-actions">
              <span className="tap-zone-row-label">第 {selected + 1} 区</span>
              <div className="tap-zone-actions">
                {TAP_ACTION_ORDER.map(action => (
                  <button
                    key={action}
                    type="button"
                    className={map.actions[selected] === action ? 'selected' : ''}
                    title={TAP_ACTION_LABELS[action].hint}
                    onClick={() => setAction(action)}
                  >
                    {TAP_ACTION_LABELS[action].label}
                  </button>
                ))}
              </div>
            </div>
            <div className="tap-zone-row">
              <span className="tap-zone-row-label">预设</span>
              <div className="tap-zone-presets">
                {TAP_PRESETS.map(preset => (
                  <button key={preset.key} type="button" title={preset.hint} onClick={() => onPreset(preset.paginate, preset.scroll)}>{preset.label}</button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
