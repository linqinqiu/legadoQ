// useReaderTts：阅读器的朗读集群（0.8.2 结构重排从 ReaderScreen.tsx 抽出）。
//
// 抽的是**状态与逻辑**，不是视图：19 个状态/ref、9 个回调、2 个 effect，从 2667 行的组件体
// 搬到这里。之所以能抽，是因为依赖矩阵量出来它的输入面收敛到 11 项、输出面 16 项，
// 且所有内部成员都满足"声明在使用之前"（无环）。唯一的环是 playTtsChunk → changeChapter，
// 用 changeChapterRef 打破（与文件里既有的 playTtsChunkRef 同一手法，注释见下）。
//
// 返回值的**名字与原来逐字一致**，所以调用方组件体内那 590 行渲染代码一个字都不用改。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from '../components/Toast'
import {
  HttpAudioTtsEngine,
  ITtsEngine,
  isPlayInterruptedError,
  TtsPlayState,
  TtsSpeakMode,
  WebSpeechEngine,
} from './ttsEngine'
import { processChapterForTts, TtsChapterData } from './ttsTextProcessor'
import { findFirstFullyVisibleParagraphIndex, ViewportBounds } from './readerInteractions'
import { ttsSessionKey, TtsEngineType, type ReaderSettings } from './readerSettings'
import type { SleepTimerOption } from './TtsSettingsModal'
import type { Chapter } from '../lib/api'

export type ReaderTtsDeps = {
  /** 当前章（用于取标题做朗读分片、以及"音频章"判定）。 */
  chapter: Chapter | undefined
  chapterIndex: number
  /** 章节总数（越界判断用；只取 length 是为了依赖数组稳定）。 */
  chapterCount: number
  /** 当前章已到位的段落（切章过渡期由调用方给空数组）。 */
  paragraphs: string[]
  isCurrentChapterLoaded: boolean
  /** 简繁转换器（章名与正文都要过它）。 */
  convert: (text: string) => string
  /** 非文本章节的媒体地址：有值时朗读直接不响应。 */
  mediaSrc: string | null
  /** 正文原文（滚动位置 → 起始分片时要用）。 */
  content: string
  /** 翻页模式的视口元素（量首屏可见段落）。 */
  viewportRef: React.RefObject<HTMLDivElement | null>
  settings: ReaderSettings
  /** 上报阅读进度（切章前调用）。 */
  persist: () => void
  /** 预载下一章正文（朗读临近章尾时调用）。 */
  preloadNextChapter: (index: number) => void
  /**
   * 切章。用 ref 传入是为了打破 playTtsChunk ↔ changeChapter 的循环依赖：
   * 组件里 `changeChapter` 要调 `stopTts`，而 `playTtsChunk` 要调 `changeChapter`。
   * 与 `playTtsChunkRef` 同一手法 —— 异步回调永远读到最新那份。
   */
  changeChapterRef: React.MutableRefObject<(rawIndex: number) => void>
}

export function useReaderTts({
  chapter,
  chapterIndex,
  chapterCount,
  paragraphs,
  isCurrentChapterLoaded,
  convert,
  mediaSrc,
  content,
  viewportRef,
  settings,
  persist,
  preloadNextChapter,
  changeChapterRef,
}: ReaderTtsDeps) {
  const [ttsActive, setTtsActive] = useState(false)
  const [ttsPlayState, setTtsPlayState] = useState<TtsPlayState>('idle')
  const [currentChunkIndex, setCurrentChunkIndex] = useState(0)
  const [sleepTimer, setSleepTimer] = useState<SleepTimerOption>('off')
  const [showTtsSettings, setShowTtsSettings] = useState(false)
  const [offlineTtsConfirmOpen, setOfflineTtsConfirmOpen] = useState(false)

  const autoPlayNextChapterRef = useRef(false)
  const webSpeechEngineRef = useRef<WebSpeechEngine | null>(null)
  const httpAudioEngineRef = useRef<HttpAudioTtsEngine | null>(null)
  // Ref to the latest playTtsChunk so that async onEnd callbacks always invoke the freshest version,
  // avoiding stale closure issues when cross-chapter auto-play triggers after chapter content reloads.
  const playTtsChunkRef = useRef<(idx: number, mode?: TtsSpeakMode) => void>(() => undefined)

  // 朗读管线只认"当前这一章已经到位"的正文，过渡期间给空数组，避免读进上一章剩下的段落。
  const ttsParagraphs = useMemo(() => (isCurrentChapterLoaded ? paragraphs : []), [isCurrentChapterLoaded, paragraphs])

  const ttsData: TtsChapterData = useMemo(() => {
    return processChapterForTts(convert(chapter?.title || ''), ttsParagraphs, settings.ttsFilterSymbols)
  }, [chapter?.title, ttsParagraphs, settings.ttsFilterSymbols, convert])

  const currentChunk = ttsData.chunks[currentChunkIndex] ?? null
  const activeParagraphIndex = currentChunk ? currentChunk.paragraphIndex : -1
  const activeSentenceText = currentChunk?.text || ''

  const getTtsEngine = useCallback((type: TtsEngineType): ITtsEngine => {
    if (type === 'webSpeech') {
      if (!webSpeechEngineRef.current) {
        webSpeechEngineRef.current = new WebSpeechEngine()
      }
      return webSpeechEngineRef.current
    }
    if (!httpAudioEngineRef.current) {
      httpAudioEngineRef.current = new HttpAudioTtsEngine()
    }
    return httpAudioEngineRef.current
  }, [])

  const stopAllEngines = useCallback(() => {
    webSpeechEngineRef.current?.stop()
    httpAudioEngineRef.current?.stop()
  }, [])

  const stopTts = useCallback(() => {
    stopAllEngines()
    setTtsPlayState('idle')
    setTtsActive(false)
  }, [stopAllEngines])

  // 切到音频/视频/文件章节（`mediaSrc` 非空）时把朗读停掉：那一章的"正文"是媒体地址，朗读没有意义。
  useEffect(() => {
    if (mediaSrc) stopTts()
  }, [mediaSrc, stopTts])

  const pauseTts = useCallback(() => {
    const engine = getTtsEngine(settings.ttsEngine)
    engine.pause()
    setTtsPlayState('paused')
  }, [getTtsEngine, settings.ttsEngine])

  const resumeTts = useCallback(() => {
    const engine = getTtsEngine(settings.ttsEngine)
    engine.resume()
    setTtsPlayState('playing')
  }, [getTtsEngine, settings.ttsEngine])

  const playTtsChunk = useCallback((idx: number, mode: TtsSpeakMode = 'replace') => {
    if (!ttsData.chunks || ttsData.chunks.length === 0) return
    if (idx < 0) idx = 0
    if (idx >= ttsData.chunks.length) {
      // Reached end of current chapter
      if (sleepTimer === 'chapter') {
        toast.info('已读完本章，睡眠定时已触发')
        stopTts()
        return
      }
      if (settings.ttsAutoNextChapter && chapterIndex < chapterCount - 1) {
        persist()
        autoPlayNextChapterRef.current = true
        changeChapterRef.current(chapterIndex + 1)
        return
      }
      stopTts()
      return
    }

    setCurrentChunkIndex(idx)
    setTtsPlayState('playing')

    const chunk = ttsData.chunks[idx]
    const engine = getTtsEngine(settings.ttsEngine)

    // 切换引擎或重新开始时必须先停掉所有旧引擎，避免重音
    // mode='continue' 是同一引擎连续播放，不需要停；其他情况都要先停
    if (mode !== 'continue') {
      stopAllEngines()
    }

    engine.speak(
      chunk.text,
      settings,
      () => {
        const nextIdx = idx + 1
        playTtsChunkRef.current(nextIdx, 'continue')
      },
      (err) => {
        if (isPlayInterruptedError(err)) return
        toast.warning(err.message || '朗读中断')
        setTtsPlayState('paused')
      },
      mode,
      { chunkId: `${chapterIndex}:${chunk.globalIndex}`, chapterIndex, paragraphIndex: chunk.paragraphIndex },
    )
    if (settings.ttsEngine !== 'webSpeech') {
      const httpEngine = engine as HttpAudioTtsEngine
      for (let lookahead = 1; lookahead <= 5; lookahead++) {
        const nextIdx = idx + lookahead
        if (nextIdx < ttsData.chunks.length) {
          const nextChunk = ttsData.chunks[nextIdx]
          void httpEngine.prefetch(
            nextChunk.text,
            settings,
            { chunkId: `${chapterIndex}:${nextChunk.globalIndex}`, chapterIndex, paragraphIndex: nextChunk.paragraphIndex },
          )
        }
      }
    }
    if (settings.ttsAutoNextChapter && idx >= ttsData.chunks.length - 5) {
      preloadNextChapter(chapterIndex)
    }
  }, [ttsData, sleepTimer, settings, chapterIndex, chapterCount, persist, stopTts, getTtsEngine, preloadNextChapter, changeChapterRef])

  playTtsChunkRef.current = playTtsChunk

  // 「朗读引擎在使用中切换会重音，都启动」（用户 2026-09-30）。
  // 换引擎/音色/语速时旧引擎不会自己停：WebSpeech 的 utterance.onEnd 与 HttpAudio 的分片 onEnd
  // 都还在推进 currentChunkIndex，新引擎接着出声 → 两条声音叠在一起。这里在"正在播"的当口
  // 把两套引擎一起停掉，再用新设置重读当前分片（'replace' 分支内部会 resetSession 并清掉旧音色的预取队列）。
  // 暂停态刻意不动：resume 只续播现有音频，真正出声的是下一分片的 speak()，
  // 而 HttpAudioTtsEngine.speak 检测到 settings key 变了会自己 resetSession（ttsEngine.ts speak 开头）。
  const ttsVoiceKey = ttsSessionKey(settings)
  const prevTtsVoiceKeyRef = useRef(ttsVoiceKey)
  useEffect(() => {
    const previous = prevTtsVoiceKeyRef.current
    prevTtsVoiceKeyRef.current = ttsVoiceKey
    if (previous === ttsVoiceKey) return
    if (!ttsActive || ttsPlayState !== 'playing') return
    playTtsChunkRef.current(currentChunkIndex, 'replace')
  }, [currentChunkIndex, ttsActive, ttsPlayState, ttsVoiceKey])

  const getInitialTtsChunkIndex = useCallback((): number => {
    if (!ttsData.chunks || ttsData.chunks.length === 0) return 0

    let viewportBounds: ViewportBounds
    if (settings.pageMode === 'paginate') {
      const vEl = viewportRef.current
      if (vEl) {
        const r = vEl.getBoundingClientRect()
        viewportBounds = { top: r.top, bottom: r.bottom, left: r.left, right: r.right }
      } else {
        viewportBounds = { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth }
      }
    } else {
      // In scroll mode, header bar is fixed at 56px height (top boundary)
      const topBarHeight = 56
      viewportBounds = { top: topBarHeight, bottom: window.innerHeight, left: 0, right: window.innerWidth }
    }

    // 1. Check if chapter title <h1> is fully visible on the current screen
    const h1El = document.querySelector(
      settings.pageMode === 'paginate'
        ? '.reader-paginated-column-body h1'
        : '.reading-content h1'
    ) as HTMLElement | null

    if (h1El) {
      const h1Rect = h1El.getBoundingClientRect()
      const isH1FullyVisible =
        h1Rect.top >= viewportBounds.top - 2 &&
        h1Rect.bottom <= viewportBounds.bottom + 2 &&
        h1Rect.left >= viewportBounds.left - 2 &&
        h1Rect.right <= viewportBounds.right + 2
      if (isH1FullyVisible) {
        const titleChunk = ttsData.chunks.find(c => c.paragraphIndex === -1)
        if (titleChunk) return titleChunk.globalIndex
      }
    }

    // 2. Query all paragraph elements with data-paragraph-index
    //    滚动模式要限定在**锚点那一章**里：连续流里续接进来的下一章也带 data-paragraph-index，
    //    从 0 重新编号，全局查会挑到别的章（朗读起始句与高亮跟读都会错段）。
    const paragraphEls = Array.from(
      document.querySelectorAll<HTMLElement>(
        settings.pageMode === 'paginate'
          ? '.reader-paginated-column-body .reader-page-chapter:first-of-type [data-paragraph-index]'
          : '.reading-content .reader-flow-chapter:first-of-type [data-paragraph-index]'
      )
    )

    if (paragraphEls.length === 0) return 0

    const paragraphItems = paragraphEls.map(el => {
      const pIdx = parseInt(el.getAttribute('data-paragraph-index') || '0', 10)
      const r = el.getBoundingClientRect()
      return {
        index: pIdx,
        rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
      }
    })

    const targetPIndex = findFirstFullyVisibleParagraphIndex(paragraphItems, viewportBounds)

    const targetChunk = ttsData.chunks.find(c => c.paragraphIndex === targetPIndex)
    return targetChunk ? targetChunk.globalIndex : 0
  }, [ttsData.chunks, settings.pageMode, viewportRef])

  const toggleTts = useCallback(() => {
    // 音频/视频/文件章节的"正文"是媒体地址，朗读没有意义（念一串 URL 只会干扰）—— 直接不响应。
    if (mediaSrc) return
    if (!ttsActive) {
      if (typeof navigator !== 'undefined' && !navigator.onLine && settings.ttsEngine !== 'webSpeech') {
        setOfflineTtsConfirmOpen(true)
        return
      }
      setTtsActive(true)
      const startIdx = getInitialTtsChunkIndex()
      playTtsChunk(startIdx)
    } else if (ttsPlayState === 'playing') {
      pauseTts()
    } else if (ttsPlayState === 'paused') {
      resumeTts()
    } else {
      playTtsChunk(currentChunkIndex)
    }
  }, [mediaSrc, ttsActive, ttsPlayState, playTtsChunk, currentChunkIndex, pauseTts, resumeTts, getInitialTtsChunkIndex, settings.ttsEngine])

  const handlePrevChunk = useCallback(() => {
    const prevIdx = Math.max(0, currentChunkIndex - 1)
    playTtsChunk(prevIdx)
  }, [currentChunkIndex, playTtsChunk])

  const handleNextChunk = useCallback(() => {
    const nextIdx = Math.min(ttsData.chunks.length - 1, currentChunkIndex + 1)
    playTtsChunk(nextIdx)
  }, [currentChunkIndex, ttsData.chunks.length, playTtsChunk])

  const handlePrevChapterTts = useCallback(() => {
    if (chapterIndex > 0) {
      persist()
      autoPlayNextChapterRef.current = true
      changeChapterRef.current(chapterIndex - 1)
    }
  }, [chapterIndex, persist, changeChapterRef])

  const handleNextChapterTts = useCallback(() => {
    if (chapterIndex < chapterCount - 1) {
      persist()
      autoPlayNextChapterRef.current = true
      changeChapterRef.current(chapterIndex + 1)
    }
  }, [chapterIndex, chapterCount, persist, changeChapterRef])

  return {
    // 状态（名字与原来逐字一致，调用方渲染代码不用改）
    ttsActive,
    setTtsActive,
    ttsPlayState,
    setTtsPlayState,
    currentChunkIndex,
    setCurrentChunkIndex,
    sleepTimer,
    setSleepTimer,
    showTtsSettings,
    setShowTtsSettings,
    offlineTtsConfirmOpen,
    setOfflineTtsConfirmOpen,
    // 派生值
    ttsParagraphs,
    ttsData,
    currentChunk,
    activeParagraphIndex,
    activeSentenceText,
    // 回调
    getTtsEngine,
    stopAllEngines,
    stopTts,
    pauseTts,
    resumeTts,
    playTtsChunk,
    playTtsChunkRef,
    getInitialTtsChunkIndex,
    toggleTts,
    handlePrevChunk,
    handleNextChunk,
    handlePrevChapterTts,
    handleNextChapterTts,
    // 跨章自动续播的旗标（changeChapter 要读）
    autoPlayNextChapterRef,
  }
}
