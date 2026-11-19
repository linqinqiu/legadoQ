import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { api, type Chapter } from '../../lib/api'

export interface ReaderChapterProgress {
  scrollPosition?: number
  charOffset?: number
  paragraphAnchor?: string | null
  positionChecksum?: string | null
}

/** fetchContent 的统一返回：正文 + 可选媒体地址（取缓存命中时没有媒体地址）。 */
export interface ReaderFetchedContent {
  content: string
  mediaUrl: string | null
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
  /** 同一 URL 的在飞请求（R3）：让"取正文"只有一个出口，避免续接窗口/预取各发一次。 */
  const inFlightRef = useRef(new Map<string, Promise<ReaderFetchedContent | null>>())
  /** 手动重试：自增一次就让加载 effect 重跑（正文失败时界面上的"重新加载"）。 */
  const [reloadToken, setReloadToken] = useState(0)
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

  /**
   * 单一正文获取口（R3）——缓存命中直接回、同一 URL 在飞复用同一个 Promise，
   * 否则发起请求并写预载缓存。续接窗口、向前接章、预取三条路径都走这里，
   * 消除"同一章被请求两次"（hook 的 preload 已在飞时，续接窗口不再另发一次）。
   *
   * 只管"取 + 缓存"；图片预热仍由调用方决定（预取不需要、续接窗口才要），
   * 避免把渲染层的关注点塞进获取层。
   */
  const fetchContent = useCallback((url: string): Promise<ReaderFetchedContent | null> => {
    const cached = preloadedContentRef.current.get(url)
    if (cached !== undefined) return Promise.resolve({ content: cached, mediaUrl: null })
    const flying = inFlightRef.current.get(url)
    if (flying) return flying
    const req = api.content(sourceId, url, bookUrl)
      .then(result => {
        remember(url, result.content)
        return { content: result.content, mediaUrl: result.mediaUrl ?? null }
      })
      .catch(() => null)
      .finally(() => { inFlightRef.current.delete(url) })
    inFlightRef.current.set(url, req)
    return req
  }, [bookUrl, remember, sourceId])

  const preload = useCallback((index: number, step: 1 | -1) => {
    let j = index + step
    while (j >= 0 && j < chapters.length && (chapters[j].isVolume || !chapters[j].url)) j += step
    const target = chapters[j]
    if (!target || !target.url) return
    void fetchContent(target.url)
  }, [chapters, fetchContent])

  const preloadNextChapter = useCallback((index: number) => preload(index, 1), [preload])
  const preloadPrevChapter = useCallback((index: number) => preload(index, -1), [preload])
  const clearPreload = useCallback(() => preloadedContentRef.current.clear(), [])

  /**
   * 重拉当前章：先把这个 URL 的预取缓存删掉，否则重试会直接命中那份旧的
   * （失败时通常是空的，但"正文加载到一半被取消"这类也会留一条）。
   */
  const reload = useCallback(() => {
    preloadedContentRef.current.delete(chapter.url)
    setReloadToken(token => token + 1)
  }, [chapter.url])

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
  }, [chapter, sourceId, bookUrl, startIndex, progress?.scrollPosition, progress?.charOffset, progress?.paragraphAnchor, progress?.positionChecksum, reloadToken])

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
    fetchContent,
    preloadNextChapter,
    preloadPrevChapter,
    clearPreload,
    reload,
  }
}
