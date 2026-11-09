import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { getOfflineChaptersSet } from '../../lib/offlineStorage'
import { toast } from '../../components/Toast'

export interface ReaderCacheStatus {
  state: string
  cached: number
  total: number
  error?: string
}

export interface ReaderCacheStatusOptions {
  bookName: string
  sourceId: string
  bookUrl: string
  chapterCount: number
}

/**
 * 离线缓存状态：服务端书架记录 + 浏览器 IndexedDB 两份来源合成一张表。
 *
 * 从 `ReaderScreen.tsx` 里整段搬出来（0.2.37 之后的第一刀）。判据与行为不变：
 * - 只在**从 caching 变成终态**那一趟弹一次 toast；
 * - 组件关掉后在途请求回来不再 setState（`syncCacheAliveRef`）；
 * - `cacheStateRef` 不参与 `useCallback` 依赖，否则回调身份每 3 秒换一次、轮询永远重头计时。
 */
export function useReaderCacheStatus({
  bookName,
  sourceId,
  bookUrl,
  chapterCount,
}: ReaderCacheStatusOptions) {
  const [cacheStatus, setCacheStatus] = useState<ReaderCacheStatus>({
    state: 'idle',
    cached: 0,
    total: chapterCount,
  })
  const [cachedChapterUrls, setCachedChapterUrls] = useState<Set<string>>(new Set())
  /**
   * 已取到正文的章节字数（`chapterUrl` → 字符数）。只有正文真的落库的章节才进得来。
   * 两个来源：服务端 `cachedWordCounts`，以及本章刚取回正文时本地直接量 `content.length`。
   */
  const [chapterWordCounts, setChapterWordCounts] = useState<ReadonlyMap<string, number>>(new Map())
  const [inShelf, setInShelf] = useState(true)
  /** 这本本地书**实际**用的目录规则，来自书架记录（设置里那条只是下一本的默认值）。 */
  const [shelfTocRule, setShelfTocRule] = useState<string | null>(null)

  /**
   * 用户关掉阅读器时在途那一趟回来，原本照样 `setCachedChapterUrls` / `setShelfTocRule`，
   * 还会把「离线缓存完成」的 toast 弹到已经关掉的界面上（那次请求可能挂了十几秒）。
   * 这里用一个 ref 判断组件还在不在。
   */
  const syncCacheAliveRef = useRef(false)
  useEffect(() => {
    syncCacheAliveRef.current = true
    return () => { syncCacheAliveRef.current = false }
  }, [])
  /** `cacheStatus.state` 的镜像：给 `syncCacheStatus` 判"上一轮是不是 caching"用，不参与依赖。 */
  const cacheStateRef = useRef(cacheStatus.state)
  cacheStateRef.current = cacheStatus.state

  const syncCacheStatus = useCallback(async () => {
    try {
      const [shelf, cachedUrlsRes, localOfflineSet] = await Promise.all([
        api.bookshelf().catch(() => []),
        api.getCachedChapters(sourceId, bookUrl).catch(() => null),
        getOfflineChaptersSet(sourceId, bookUrl).catch(() => new Set<string>()),
      ])

      // 三个 await 都回来了才知道阅读器还在不在：期间可能已经关掉或换了书。
      if (!syncCacheAliveRef.current) return

      const mergedSet = new Set<string>(localOfflineSet)
      const mergedWords = new Map<string, number>()
      if (cachedUrlsRes?.cachedChapterUrls) {
        cachedUrlsRes.cachedChapterUrls.forEach((u, i) => {
          mergedSet.add(u)
          // 服务端把「地址 → 字数」按同序两个数组回传。对不上号（旧版服务端的响应没这个字段）
          // 就干脆不填，让界面那一格留空 —— 报 0 字是谎话，报旧书的字数也是谎话。
          const words = cachedUrlsRes.cachedWordCounts?.[i]
          if (typeof words === 'number') mergedWords.set(u, words)
        })
      }
      setCachedChapterUrls(mergedSet)
      setChapterWordCounts(mergedWords)

      const item = shelf.find(s => s.sourceId === sourceId && s.bookUrl === bookUrl)
      setShelfTocRule(item?.tocRule ?? null)
      if (item) {
        setInShelf(true)
        // 「缓存完成 / 中断」只在**从 caching 变成终态**那一趟报一次。
        // 判完立刻把 ref 推到新状态：这个函数可能重叠执行（3s 一拍，而一次要拉整份书架）。
        if (cacheStateRef.current === 'caching' && item.cacheState === 'ready') {
          toast.success(`《${bookName}》离线缓存完成（共 ${item.cachedChapters} 章）`)
        } else if (cacheStateRef.current === 'caching' && item.cacheState === 'failed') {
          toast.warning(`《${bookName}》缓存中断：${item.cacheError || '部分章节未下载'}`)
        }
        cacheStateRef.current = item.cacheState
        setCacheStatus({
          state: item.cacheState,
          cached: Math.max(item.cachedChapters, mergedSet.size),
          total: item.totalChapters || chapterCount,
          error: item.cacheError,
        })
      } else {
        setInShelf(false)
      }
    } catch {
      // ignore
    }
  }, [bookName, bookUrl, chapterCount, sourceId])

  useEffect(() => {
    void syncCacheStatus()
  }, [syncCacheStatus])

  useEffect(() => {
    if (cacheStatus.state !== 'caching') return
    // 3000ms 一拍：每拍都要 `api.bookshelf()` 拉整份书架（几千本时是 MB 级），
    // 缓存进度条不需要 1.2s 的精度。卸载时 clearInterval（本 effect 的 cleanup 已覆盖）。
    const timer = window.setInterval(syncCacheStatus, 3000)
    return () => window.clearInterval(timer)
  }, [cacheStatus.state, syncCacheStatus])

  return {
    cacheStatus,
    setCacheStatus,
    cachedChapterUrls,
    setCachedChapterUrls,
    chapterWordCounts,
    setChapterWordCounts,
    inShelf,
    setInShelf,
    shelfTocRule,
    setShelfTocRule,
    syncCacheStatus,
  }
}
