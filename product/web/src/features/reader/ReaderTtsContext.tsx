import React, { createContext, useContext } from 'react'
import type { useReaderTts } from './useReaderTts'

/**
 * TTS 上下文 = `useReaderTts` 的完整返回值 + 悬浮条自己要的倒计时。
 *
 * 类型直接由 hook 的返回推导，而不是在这里手抄一遍字段：
 * hook 加了字段（`ttsData`、`autoPlayNextChapterRef` 之类）上下文自动跟上，
 * 抄一份的下场是调用方拿到 `undefined` 却没有任何编译报错。
 */
export type TtsContextValue = ReturnType<typeof useReaderTts> & {
  /** 睡眠定时器剩余秒数（悬浮条显示用；hook 内部只管倒计时到点后的 stop） */
  remainingSeconds: number | null
}

export const TtsContext = createContext<TtsContextValue | null>(null)

export const useTts = (): TtsContextValue => {
  const ctx = useContext(TtsContext)
  if (!ctx) {
    throw new Error('useTts 必须在 <ReaderTtsManager> 内部使用')
  }
  return ctx
}