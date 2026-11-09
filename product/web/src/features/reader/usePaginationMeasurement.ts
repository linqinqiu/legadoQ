import { useCallback, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { calculatePaginationLayout } from './interaction/readerInteractions'
import { pageAlignmentPads, pageAlignmentStarts, resolveMeasuredPage } from './content/readerFlow'
import { offsetToParagraph, textOffsetRect, type LogicalPosition } from './content/logicalPosition'
import { performanceMonitor } from '../../lib/performance'
import type { ReaderSettings } from './settingsPanel/readerSettings'

export interface PaginationMeasurementOptions {
  viewportRef: RefObject<HTMLDivElement | null>
  bodyRef: RefObject<HTMLDivElement | null>
  loading: boolean
  content: string
  columnMode: ReaderSettings['columnMode']
  columnGap: number
  setPageIndex: Dispatch<SetStateAction<number>>
  /** 首屏恢复：目标页（first/last）与按位置恢复的页码。 */
  targetInitialPageRef: RefObject<'first' | 'last' | null>
  initialPagePositionRef: RefObject<number | null>
  /** 语义位置恢复（比 fraction 稳）；校验不过才退回页码。 */
  initialLogicalPositionRef: RefObject<(LogicalPosition & { chapterIndex: number }) | null>
  logicalMetaRef: RefObject<{ starts: number[]; checksum: string }>
}

/**
 * 分页测量：把「DOM 实际排成几栏、每章占哪几页、页码该落在哪」算出来。
 *
 * 从 `ReaderScreen.tsx` 搬出来（第三刀）。这段逻辑最容易改坏，搬动时**一个字节都没改**，
 * 只把外部依赖改成显式参数。几条不能动的口径：
 *
 * - 先算每章占几栏（精确整数），再累加起始栏号，最后除以"一屏几栏"；直接按矩形左缘除
 *   stride 会丢掉章节起始列的奇偶，下一章落在奇数列时第一栏是上一页的右半格。
 * - 量栏数不能用 section 的 `getBoundingClientRect().width`（跨七栏的 section 只报到约两栏宽），
 *   要用 Range 量碎片；左缘还要按 stride 分桶，否则首行缩进会把一个真栏数成两个。
 * - 对齐闸门按**量出来的**起始栏判，不按算术：算术说垫了、DOM 里还没渲染出来，这一刻挪窗口照样重复一栏。
 * - 最后一章末尾的垫栏不该算成一页，只收紧不放宽。
 */
export function usePaginationMeasurement({
  viewportRef,
  bodyRef,
  loading,
  content,
  columnMode,
  columnGap,
  setPageIndex,
  targetInitialPageRef,
  initialPagePositionRef,
  initialLogicalPositionRef,
  logicalMetaRef,
}: PaginationMeasurementOptions) {
  const [pageCount, setPageCount] = useState(1)
  /** 每一章**前面**垫几栏空白（双栏时把章节边界对齐到页开头）；量出来的。 */
  const [pageFillers, setPageFillers] = useState<number[]>([])
  const [columnWidth, setColumnWidth] = useState(600)
  const [stride, setStride] = useState(640)
  const [isDoubleColumn, setIsDoubleColumn] = useState(false)
  /** 分页模式下每一章占的页区间（量自排版后的 DOM）。 */
  const pageSpansRef = useRef<{ start: number; end: number }[]>([])
  /** 量得的每章起始**栏**号（DOM 真值）；后退接章的页码补偿按它落页。 */
  const measuredStartsRef = useRef<number[]>([])
  const columnsPerPageRef = useRef(1)
  /** 屏幕上真的对齐了吗（按 DOM 量出来的，不是按算术推的）—— 挪窗口的闸门看这个。 */
  const pageAlignedRef = useRef(true)
  const pendingPageRef = useRef<number | null>(null)

  const measurePagination = useCallback(() => {
    const viewport = viewportRef.current
    const body = bodyRef.current
    if (!viewport || !body) return
    const w = viewport.clientWidth
    if (w <= 0) return
    if (loading || !content) return

    const measureStartedAt = performance.now()
    const totalScrollWidth = body.scrollWidth
    const layout = calculatePaginationLayout({
      viewportWidth: w,
      totalScrollWidth,
      columnGap,
      columnMode,
    })

    setColumnWidth(layout.columnWidth)
    setStride(layout.stride)
    setIsDoubleColumn(layout.isDoubleColumn)

    // 每一章在窗口里占哪几页。关键：**先算每一章占几栏（精确整数），再累加出起始栏号**，
    // 最后才除以"一屏几栏"。直接按矩形左缘除 stride 取整会丢掉章节起始列的奇偶。
    let effectivePageCount = layout.pageCount
    const sections = [...body.querySelectorAll<HTMLElement>('.reader-page-chapter')]
    if (sections.length > 0) {
      const columnsPerPage = layout.isDoubleColumn ? 2 : 1
      // 量栏数不能量 section 的矩形（跨七栏的 section 只报到约两栏宽）；用 Range 量碎片。
      // 左缘还要按 stride 分桶：首行缩进会让一个真栏数出两个左缘。
      const bodyLeft = body.getBoundingClientRect().left
      const measuredStride = layout.columnWidth + columnGap
      const columnCounts = sections.map(node => {
        const range = document.createRange()
        range.selectNodeContents(node)
        const lefts = new Set([...range.getClientRects()]
          .filter(rect => rect.width > 1)
          .map(rect => Math.round((rect.left - bodyLeft) / measuredStride)))
        return Math.max(1, lefts.size)
      })
      const nextFillers = pageAlignmentPads(columnCounts, columnsPerPage)
      const starts = pageAlignmentStarts(columnCounts, columnsPerPage)
      // 对齐闸门按**量出来的**起始栏判，不按算术。
      const measuredStarts = sections.map(node => {
        const range = document.createRange()
        range.selectNodeContents(node)
        const rects = [...range.getClientRects()].filter(rect => rect.width > 1)
        const left = rects.length > 0 ? Math.min(...rects.map(rect => rect.left)) : bodyLeft
        return Math.round((left - bodyLeft) / measuredStride)
      })
      pageAlignedRef.current = measuredStarts.every(col => col % columnsPerPage === 0)
      measuredStartsRef.current = measuredStarts
      columnsPerPageRef.current = columnsPerPage
      // 分页测量是阅读器最贵的一次 DOM 读：记下来，`__legadoPerf.report()` 能看到。
      performanceMonitor.record('pagination_measure', 'render', performance.now() - measureStartedAt)
      setPageFillers(current => (current.length === nextFillers.length
        && current.every((value, index) => value === nextFillers[index]) ? current : nextFillers))
      // 最后一章末尾那一栏垫白不该被算成一页；只收紧、不放宽。
      const contentEndColumn = starts[starts.length - 1] + columnCounts[columnCounts.length - 1]
      effectivePageCount = Math.max(1, Math.min(layout.pageCount, Math.ceil(contentEndColumn / columnsPerPage)))
      setPageCount(effectivePageCount)
      pageSpansRef.current = starts.map((start, index) => ({
        start: Math.round(start / columnsPerPage),
        end: index + 1 < starts.length
          ? Math.round(starts[index + 1] / columnsPerPage)
          : effectivePageCount,
      }))
      // 刚把窗口往前挪过：页码要落到"摘掉前面那几章之后"的那一页上。
      if (pendingPageRef.current !== null) {
        const next = Math.min(effectivePageCount - 1, Math.max(0, pendingPageRef.current))
        pendingPageRef.current = null
        setPageIndex(next)
        return
      }
      // 首屏恢复优先用语义位置：fraction 的分母是整个多章窗口，窗口一挂上前后章就会偏。
      const pendingLogical = initialLogicalPositionRef.current
      initialLogicalPositionRef.current = null
      if (pendingLogical && pendingLogical.positionChecksum === logicalMetaRef.current.checksum) {
        const section = sections.find(node => Number(node.dataset.chapterIndex ?? -1) === pendingLogical.chapterIndex)
        const els = section ? Array.from(section.querySelectorAll<HTMLElement>('[data-paragraph-index]')) : []
        if (els.length) {
          const { index, within } = offsetToParagraph(logicalMetaRef.current.starts, pendingLogical.charOffset)
          let target = els.find(el => Number(el.dataset.paragraphIndex ?? 0) === index)
          if (!target) {
            const before = els.filter(el => Number(el.dataset.paragraphIndex ?? 0) <= index)
            target = before[before.length - 1] ?? els[0]
          }
          const rect = textOffsetRect(target, within) ?? target.getBoundingClientRect()
          const column = Math.max(0, Math.round((rect.left - bodyLeft) / measuredStride))
          const page = Math.min(effectivePageCount - 1, Math.max(0, Math.floor(column / columnsPerPage)))
          initialPagePositionRef.current = null
          setPageIndex(page)
          return
        }
      }
    } else {
      pageSpansRef.current = []
      measuredStartsRef.current = []
      setPageCount(effectivePageCount)
    }

    const pageTarget = targetInitialPageRef.current
    const restoredPosition = initialPagePositionRef.current
    targetInitialPageRef.current = null
    initialPagePositionRef.current = null
    if (pageTarget === null && restoredPosition === null) {
      // 同一个锚点内重量一次（改字号、拖窗口、续接挂章）：原地不动，只做夹取。
      setPageIndex(curr => resolveMeasuredPage(null, null, curr, effectivePageCount))
      return
    }
    setPageIndex(resolveMeasuredPage(pageTarget, restoredPosition, 0, effectivePageCount))
  }, [columnGap, columnMode, content, loading])

  return {
    pageCount,
    pageFillers,
    columnWidth,
    stride,
    isDoubleColumn,
    measurePagination,
    pageSpansRef,
    measuredStartsRef,
    columnsPerPageRef,
    pageAlignedRef,
    pendingPageRef,
  }
}
