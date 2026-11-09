import { useCallback, useEffect, useRef, useState, type TransitionEvent as ReactTransitionEvent } from 'react'
import { pageTurnAnim } from './interaction/pageTurn'
import type { ReaderSettings } from './settingsPanel/readerSettings'

export interface ReaderPageTurnOptions {
  pageMode: ReaderSettings['pageMode']
  pageAnim: ReaderSettings['pageAnim']
  pageIndex: number
  setPageIndex: (next: number) => void
}

/**
 * 翻页动画状态（参照 legado-with-MD3 的 PageAnim，Web 里做真的三种）。
 *
 * - `slide` 只在**逐页翻**（页码差 1）时挂过渡；接章补偿/窗口挪动是几页的跳，滑过去像又跳了一次。
 * - `fade` 在页码变化时把 track 淡出再淡回。
 * - `cover` 逐页翻**不立刻改 pageIndex**：先挂一层新页滑进来盖住旧页，动画结束才真正翻页。
 *
 * 从 `ReaderScreen.tsx` 搬出来；`finishCover` / `transitionend` / 600ms 兜底三条收尾路径原样保留。
 */
export function useReaderPageTurn({ pageMode, pageAnim: configuredAnim, pageIndex, setPageIndex }: ReaderPageTurnOptions) {
  const pageAnim = pageMode === 'paginate' ? configuredAnim : 'none'
  const prevPageIndexRef = useRef(pageIndex)
  const [fading, setFading] = useState(false)
  const turnAnim = pageTurnAnim(pageAnim, prevPageIndexRef.current, pageIndex)
  const slideAnimOn = turnAnim === 'slide'

  useEffect(() => { prevPageIndexRef.current = pageIndex }, [pageIndex])
  useEffect(() => {
    if (pageAnim !== 'fade') return
    setFading(true)
    const timer = window.setTimeout(() => setFading(false), 150)
    return () => window.clearTimeout(timer)
  }, [pageIndex, pageAnim])

  const [coverTurn, setCoverTurn] = useState<{ to: number; direction: 1 | -1 } | null>(null)
  const [coverEntered, setCoverEntered] = useState(false)
  const coverTurnRef = useRef<{ to: number; direction: 1 | -1 } | null>(null)
  coverTurnRef.current = coverTurn
  // 先挂上（此时在视口外），下一帧再置 entered —— CSS transition 才有得演。
  useEffect(() => {
    if (!coverTurn) { setCoverEntered(false); return }
    const raf = window.requestAnimationFrame(() => setCoverEntered(true))
    return () => window.cancelAnimationFrame(raf)
  }, [coverTurn])
  const finishCover = useCallback(() => {
    const current = coverTurnRef.current
    if (!current) return
    setPageIndex(current.to)
    setCoverTurn(null)
  }, [setPageIndex])
  /** `transitionend` 是主路径；`coverTurnRef` 挡住重复收尾（兜底定时器与它可能都到）。 */
  const onCoverTransitionEnd = useCallback((event: ReactTransitionEvent) => {
    if (event.propertyName === 'transform') finishCover()
  }, [finishCover])
  /**
   * 别只靠 `transitionend`：系统开了"减少动态效果"、或这条 transition 被别的规则盖掉时它可能不来，
   * 那样页码就永远翻不过去。给一个略长于动画时长的兜底，谁先到谁收尾。
   */
  useEffect(() => {
    if (!coverTurn) return
    const timer = window.setTimeout(finishCover, 600)
    return () => window.clearTimeout(timer)
  }, [coverTurn, finishCover])

  return {
    pageAnim,
    fading,
    turnAnim,
    slideAnimOn,
    coverTurn,
    setCoverTurn,
    coverEntered,
    finishCover,
    onCoverTransitionEnd,
  }
}
