import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { api, type Chapter } from '../../lib/api'

export interface ReaderChapterProgress {
  scrollPosition?: number
  charOffset?: number
  paragraphAnchor?: string | null
  positionChecksum?: string | null
}

export interface ReaderChapterContentOptions {
  chapter: Chapter
  chapters: Chapter[]
  sourceId: string
  bookUrl: string
  startIndex: number
  progress?: ReaderChapterProgress | null
  /** 正文落地后的阅读器簿记（字数、缓存标记、首屏定位、图片预热）。 */
  onLoaded: (content: string, mediaUrl: string | null, chapter: Chapter) => void
}

/**
 * 章节正文加载：状态、预取、请求与取消都在这里，阅读器只做「正文到了之后」的簿记。
 *
 * 从 `ReaderScreen.tsx` 整段搬出来（第二刀）。两个容易改坏的细节原样保留：
 * - 用 `useLayoutEffect`：预载命中时正文在绘制前就换好，不会先闪一帧骨架屏；
 * - 预取缓存只留最近 12 章：只增不清的 Map 会跟着长书无界增长。
 *
 * `onLoaded` 放在 ref 里而不是依赖数组：它是阅读器每次渲染新建的回调，进依赖会让
 * 加载 effect 每帧重跑（表现为"正文反复重新请求"）。
 */
export function useReaderChapterContent({
  chapter,
  chapters,
  sourceId,
  bookUrl,
  startIndex,
  progress,
  onLoaded,
}: ReaderChapterContentOptions) {
  const [content, setContent] = useState('')
  const [mediaUrl, setMediaUrl] = useState<string | null>(null)
  const [loadedChapterUrl, setLoadedChapterUrl] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)

  const preloadedContentRef = useRef(new Map<string, string>())
  const preloadingRef = useRef(new Set<string>())
  const onLoadedRef = useRef(onLoaded)
  onLoadedRef.current = onLoaded

  const remember = useCallback((url: string, text: string) => {
    const map = preloadedContentRef.current
    map.set(url, text)
    if (map.size > 12) {
      const oldest = map.keys().next().value
      if (oldest !== undefined) map.delete(oldest)
    }
  }, [])

  const preload = useCallback((index: number, step: 1 | -1) => {
    let j = index + step
    while (j >= 0 && j < chapters.length && (chapters[j].isVolume || !chapters[j].url)) j += step
    const target = chapters[j]
    if (!target || !target.url || preloadedContentRef.current.has(target.url) || preloadingRef.current.has(target.url)) return
    preloadingRef.current.add(target.url)
    void api.content(sourceId, target.url, bookUrl)
      .then(result => remember(target.url, result.content))
      .catch(() => undefined)
      .finally(() => preloadingRef.current.delete(target.url))
  }, [bookUrl, chapters, remember, sourceId])

  const preloadNextChapter = useCallback((index: number) => preload(index, 1), [preload])
  const preloadPrevChapter = useCallback((index: number) => preload(index, -1), [preload])
  const clearPreload = useCallback(() => preloadedContentRef.current.clear(), [])

  useLayoutEffect(() => {
    let cancelled = false
    setLoading(true)
    setMessage('')
    const apply = (nextContent: string, nextMediaUrl: string | null) => {
      if (cancelled) return
      setContent(nextContent)
      setMediaUrl(nextMediaUrl)
      setLoadedChapterUrl(chapter.url)
      onLoadedRef.current(nextContent, nextMediaUrl, chapter)
      setLoading(false)
    }
    const preloaded = preloadedContentRef.current.get(chapter.url)
    if (preloaded !== undefined) {
      apply(preloaded, null)
    } else {
      void api.content(sourceId, chapter.url, bookUrl)
        .then(result => apply(result.content, result.mediaUrl ?? null))
        .catch(error => {
          if (!cancelled) setMessage(error instanceof Error ? error.message : '无法读取正文')
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }
    return () => {
      cancelled = true
    }
  }, [chapter, sourceId, bookUrl, startIndex, progress?.scrollPosition, progress?.charOffset, progress?.paragraphAnchor, progress?.positionChecksum])

  return {
    content,
    setContent,
    mediaUrl,
    setMediaUrl,
    loadedChapterUrl,
    setLoadedChapterUrl,
    message,
    setMessage,
    loading,
    setLoading,
    preloadedContentRef,
    preloadingRef,
    preloadNextChapter,
    preloadPrevChapter,
    clearPreload,
  }
}
