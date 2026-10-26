// 目录虚拟列表（0.8.2 结构重排从 ReaderScreen.tsx 逐字拆出）：只挂窗口内那几十行，
// 其余靠上下垫高凑出总滚动高度。实现与窗口算式同源（./virtualSlice），判据在
// web/test/VirtualChapterList.test.ts —— 那份判据现在读的就是这个文件。
// classic JSX 说明（AGENTS §5 的同形坑）：这条静态渲染链路走 React.createElement，默认导入必须在。
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Icon } from '../icons'
import type { Chapter } from '../lib/api'
import { TOC_ROW_HEIGHT } from './readerInteractions'
import { IDENTITY_CONVERTER } from './scriptConvert'
import { computeCenterScrollOffset, computeVirtualWindow } from './virtualSlice'
import { getProgress, subscribeProgress } from './readerProgress'

/** 当前阅读章内的细进度条：只挂在这一行上、自订阅进度 store，不拖累整张虚拟列表重渲染。 */
function CurrentChapterProgress({ chapterIndex }: { chapterIndex: number }) {
  const progress = useSyncExternalStore(subscribeProgress, getProgress, getProgress)
  const fraction = progress.chapterIndex === chapterIndex ? progress.fraction : 0
  return (
    <span className="reader-chapter-progress" aria-hidden="true">
      <i style={{ width: `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%` }} />
    </span>
  )
}

export interface VirtualChapterListProps {
  chapters: Chapter[]
  activeChapterIndex: number
  cachedUrlsSet?: Set<string>
  /**
   * 已取到正文的章节字数（`chapterUrl` → 字符数）。有字数的行在右侧那一格显示「N 字」，
   * 与云朵互斥占同一槽位（已缓存 → 无云 → 有地方放字数；未缓存 → 云朵）。
   * 用户原话：「当获取到内容的时候，显示章节字数放在右面合适位置」。
   */
  wordCounts?: ReadonlyMap<string, number>
  onSelect: (index: number) => void
  itemHeight?: number
  overscan?: number
  className?: string
  autoScrollKey?: string | number
  /** 章名的显示变换（简繁转换）。缺省是恒等 —— 不传就一个字都不动。 */
  convertTitle?: (title: string) => string
}

export function VirtualChapterList({
  chapters,
  activeChapterIndex,
  cachedUrlsSet,
  wordCounts,
  onSelect,
  itemHeight = TOC_ROW_HEIGHT,
  overscan = 8,
  className = '',
  autoScrollKey,
  convertTitle = IDENTITY_CONVERTER,
}: VirtualChapterListProps) {
  const containerRef = useRef<HTMLElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [containerHeight, setContainerHeight] = useState(600)

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    setContainerHeight(el.clientHeight || 600)

    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        if (entry.contentRect.height > 0) {
          setContainerHeight(entry.contentRect.height)
        }
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const scrollToActive = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = containerRef.current
    if (!el) return
    const targetIndex = chapters.findIndex(c => c.index === activeChapterIndex)
    if (targetIndex < 0) return

    const finalScroll = computeCenterScrollOffset(targetIndex, itemHeight, el.clientHeight, chapters.length)

    if (Math.abs(el.scrollTop - finalScroll) > 1) {
      el.scrollTo({ top: finalScroll, behavior })
    }
  }, [activeChapterIndex, chapters, itemHeight])

  useEffect(() => {
    const timer = window.requestAnimationFrame(() => {
      scrollToActive('auto')
    })
    return () => window.cancelAnimationFrame(timer)
  }, [scrollToActive, autoScrollKey])

  const handleScroll = useCallback((event: React.UIEvent<HTMLElement>) => {
    setScrollTop(event.currentTarget.scrollTop)
  }, [])

  const count = chapters.length
  const slice = computeVirtualWindow({
    totalCount: count,
    itemHeight,
    scrollTop,
    viewportHeight: containerHeight,
    overscan,
  })
  const { startIndex, endIndex } = slice
  const topSpacer = slice.offsetY
  const bottomSpacer = slice.bottomSpacer

  const visibleChapters = useMemo(() => {
    const items: Array<{ chapter: Chapter; index: number }> = []
    for (let i = startIndex; i < endIndex; i++) {
      if (chapters[i]) {
        items.push({ chapter: chapters[i], index: i })
      }
    }
    return items
  }, [chapters, startIndex, endIndex])

  return (
    <nav
      ref={containerRef}
      className={`reader-chapters ${className}`}
      aria-label="章节目录"
      onScroll={handleScroll}
    >
      {topSpacer > 0 && <div style={{ height: topSpacer }} aria-hidden="true" />}
      {visibleChapters.map(({ chapter }) => {
        if (chapter.isVolume) {
          return (
            <div
              key={`vol-${chapter.index}`}
              style={{ height: itemHeight }}
              className="reader-chapter-volume"
            >
              {convertTitle(chapter.title)}
            </div>
          )
        }
        const isCached = cachedUrlsSet ? cachedUrlsSet.has(chapter.url) : false
        const words = wordCounts?.get(chapter.url) ?? null
        // url 不能单独当 key：服务端 `RuleRunner.kt` 的 `chapters()`（HTTP 规则与 JS 书源两条实现）
        // 都不按地址去重，上下篇共用一页、"本章完"重复条目都会给出同 url 两行 —— 撞 key 只 warning，门禁看不见
        return (
          <button
            key={`${chapter.index}-${chapter.url}`}
            style={{ height: itemHeight }}
            className={`reader-chapter-item ${chapter.index === activeChapterIndex ? 'current' : ''} ${chapter.index < activeChapterIndex ? 'read' : ''} ${isCached ? 'cached' : ''}`}
            onClick={() => onSelect(chapter.index)}
            title={`${convertTitle(chapter.title)}${isCached ? '（已离线缓存）' : '（未缓存，需联网）'}${words !== null ? `，${words} 字` : ''}`}
          >
            <i />
            <span className="reader-chapter-title">{convertTitle(chapter.title)}</span>
            {/*
              右侧那一格是同一个槽位（.chapter-cloud-badge / .chapter-word-count 都是
              margin-left:auto + flex-shrink:0），二选一：
              - 未取到内容 → 挂一朵小云（需联网加载）；
              - 已取到内容且有字数 → 显示「N 字」（用户：「当获取到内容的时候，显示章节字数放在右面」）。
              没有字数数据（旧服务端不返回 cachedWordCounts）时那一格留空，不报 0 骗人。
            */}
            {!isCached && <span className="chapter-cloud-badge" title="未缓存，需联网加载"><Icon name="cloud" /></span>}
            {isCached && words !== null && <span className="chapter-word-count">{words} 字</span>}
            {chapter.index === activeChapterIndex && <CurrentChapterProgress chapterIndex={chapter.index} />}
          </button>
        )
      })}
      {bottomSpacer > 0 && <div style={{ height: bottomSpacer }} aria-hidden="true" />}
      {count === 0 && <p className="reader-status" style={{ padding: '24px 0' }}>无匹配章节</p>}
    </nav>
  )
}
