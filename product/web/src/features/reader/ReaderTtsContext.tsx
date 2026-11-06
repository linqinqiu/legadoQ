import React, { createContext, useContext } from 'react'
import type { useReaderTts } from './useReaderTts'

/**
 * TTS 上下文 = `useReaderTts` 的完整返回值 + 悬浮条自己要的倒计时。
 *
 * 类型直接由 hook 的返回推导，而不是在这里手抄一遍字段：
 * hook 加了字段（`ttsData`、`autoPlayNextChapterRef` 之类）上下文自动跟上，
 * 抄一份的下场是调用方拿到 `undefined` 却没有任何编译报错。
 */
/**
 * 上下文值就是 `useReaderTts` 的返回值本身。
 *
 * `remainingSeconds` **不**进这里：它是朗读条的展示态，由 `ReaderTtsManager` 自己按
 * `sleepTimer` 倒计时、自己传给 `TtsPlayerBar` / `TtsSettingsModal`。放进上下文就变成
 * "两处都能改"的第二份状态 —— 11-04 拆分时正是这么写的，同时它还把 Provider 放进了
 * 子组件，导致父组件 `ReaderScreen` 读不到（11-06 修）。
 */
export type TtsContextValue = ReturnType<typeof useReaderTts>

export const TtsContext = createContext<TtsContextValue | null>(null)

export const useTts = (): TtsContextValue => {
  const ctx = useContext(TtsContext)
  if (!ctx) {
    throw new Error('useTts 必须在 <ReaderTtsManager> 内部使用')
  }
  return ctx
}