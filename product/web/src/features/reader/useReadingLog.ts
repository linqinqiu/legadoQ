import { useEffect } from 'react'
import { api } from '../../lib/api'

export interface ReadingLogOptions {
  sourceId: string
  bookUrl: string
  bookName: string
  chapterIndex: number
}

/**
 * 阅读记录（PROPOSAL-019 D）：在阅读页停留计时，每攒够 30 秒上报一段。
 *
 * 只在页面**可见**时计时（切到别的标签页 / 锁屏不算在读）；换章时把没满 30 秒的零头也报上去 ——
 * 否则「每章只读二十秒」的读者一条记录都不会有。上报失败只吞掉：它是统计，丢了不影响读书。
 * 依赖里带 `chapterIndex` 是故意的：换章就是一次收尾。
 *
 * 从 `ReaderScreen.tsx` 搬出来，行为与依赖未改。
 */
export function useReadingLog({ sourceId, bookUrl, bookName, chapterIndex }: ReadingLogOptions) {
  useEffect(() => {
    const index = chapterIndex
    let pending = 0
    let last = Date.now()
    let visible = document.visibilityState !== 'hidden'
    const report = (seconds: number) => {
      if (seconds <= 0) return
      void api.addReadingLog({ sourceId, bookUrl, bookName, chapterIndex: index, seconds }).catch(() => undefined)
    }
    const tick = () => {
      const now = Date.now()
      if (visible) pending += (now - last) / 1000
      last = now
      if (pending >= 30) { report(Math.round(pending)); pending = 0 }
    }
    const timer = window.setInterval(tick, 2000)
    const onVisibility = () => { tick(); visible = document.visibilityState !== 'hidden'; last = Date.now() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      tick()
      report(Math.round(pending))
    }
  }, [bookName, bookUrl, chapterIndex, sourceId])
}
