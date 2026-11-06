import React, { useCallback, useEffect, useRef, useState } from 'react'
import { zh } from '../../../i18n/zh'
import { Chapter } from '../../../lib/api'
import { TtsPlayerBar } from './TtsPlayerBar'
import { TtsSettingsModal } from './TtsSettingsModal'
import { Icon } from '../../../icons'
import { toast } from '../../../components/Toast'
import { useEscapeClose } from '../../../lib/useEscapeClose'
import { useTts } from './ReaderTtsContext'

/**
 * 朗读浮层：只画界面，不持有朗读状态。
 *
 * 状态在 `ReaderScreen`（`useReaderTts` 调一次、`TtsContext.Provider` 往下发）。
 * 这里曾经自己调 `useReaderTts` 并**向下**提供 Context，而父组件 `ReaderScreen` 又去
 * `useTts()` 读它 —— 父读不到子提供的 Context，每开一本书都崩在 ErrorBoundary（11-06 修）。
 */
export interface ReaderTtsManagerProps {
  chapter: Chapter | undefined
  bookName: string
  bookAuthor?: string | null
  coverUrl?: string | null
  settings: any
  onSettingsChange: (next: any) => void
}

export function ReaderTtsManager({
  chapter,
  bookName,
  bookAuthor,
  coverUrl,
  settings,
  onSettingsChange,
}: ReaderTtsManagerProps) {
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null)

  const tts = useTts()

  const {
    ttsActive,
    setTtsActive,
    ttsPlayState,
    currentChunkIndex,
    sleepTimer,
    setSleepTimer,
    showTtsSettings,
    setShowTtsSettings,
    offlineTtsConfirmOpen,
    setOfflineTtsConfirmOpen,
    toggleTts,
    handlePrevChunk,
    handleNextChunk,
    handlePrevChapterTts,
    handleNextChapterTts,
    playTtsChunkRef,
    getInitialTtsChunkIndex,
    stopTts,
    pauseTts,
    resumeTts,
    activeParagraphIndex,
    ttsParagraphs,
    ttsData,
    activeSentenceText,
  } = tts

  const wakeLockRef = useRef<WakeLockSentinel | null>(null)

  // Sleep Timer countdown effect
  useEffect(() => {
    if (sleepTimer === 'off' || sleepTimer === 'chapter') {
      setRemainingSeconds(null)
      return
    }
    const totalSecs = parseInt(sleepTimer, 10) * 60
    setRemainingSeconds(totalSecs)
    const timer = window.setInterval(() => {
      setRemainingSeconds((prev) => {
        if (prev === null || prev <= 1) {
          window.setTimeout(() => {
            stopTts()
            toast.info('睡眠定时时间到，已停止朗读')
          }, 0)
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [sleepTimer, stopTts])

  // MediaSession API integration
  useEffect(() => {
    if (!('mediaSession' in navigator) || !ttsActive) return
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: chapter?.title || '正文朗读',
        artist: bookAuthor || bookName,
        album: bookName,
        artwork: coverUrl ? [{ src: coverUrl }] : undefined,
      })
      navigator.mediaSession.playbackState = ttsPlayState === 'playing' ? 'playing' : 'paused'

      navigator.mediaSession.setActionHandler('play', () => resumeTts())
      navigator.mediaSession.setActionHandler('pause', () => pauseTts())
      navigator.mediaSession.setActionHandler('previoustrack', () => handlePrevChunk())
      navigator.mediaSession.setActionHandler('nexttrack', () => handleNextChunk())
    } catch {
      // Ignore mediaSession errors
    }
  }, [
    ttsActive,
    ttsPlayState,
    chapter?.title,
    bookAuthor,
    bookName,
    coverUrl,
    resumeTts,
    pauseTts,
    handlePrevChunk,
    handleNextChunk,
  ])

  // Wake Lock API integration
  useEffect(() => {
    if (!('wakeLock' in navigator)) return
    if (ttsActive && ttsPlayState === 'playing') {
      navigator.wakeLock.request('screen').then((lock) => {
        wakeLockRef.current = lock
      }).catch(() => undefined)
    } else {
      wakeLockRef.current?.release().catch(() => undefined)
      wakeLockRef.current = null
    }
    return () => {
      wakeLockRef.current?.release().catch(() => undefined)
      wakeLockRef.current = null
    }
  }, [ttsActive, ttsPlayState])

  // 离线确认框是这一层唯一的挡片：Esc 必须能关，别只靠点背景。
  useEscapeClose(() => setOfflineTtsConfirmOpen(false))

  return (
    <>
      {/* TTS Floating Player Bar */}
      {ttsActive && (
        <TtsPlayerBar
          playState={ttsPlayState}
          currentParagraphIndex={activeParagraphIndex}
          totalParagraphs={ttsParagraphs.length}
          currentChunkIndex={currentChunkIndex}
          totalChunks={ttsData.chunks.length}
          activeSentenceText={activeSentenceText}
          sleepTimer={sleepTimer}
          remainingSeconds={remainingSeconds}
          onTogglePlay={toggleTts}
          onPrevChunk={handlePrevChunk}
          onNextChunk={handleNextChunk}
          onPrevChapter={handlePrevChapterTts}
          onNextChapter={handleNextChapterTts}
          onOpenSettings={() => setShowTtsSettings(true)}
          onClose={stopTts}
        />
      )}

      {/* TTS Settings Modal */}
      {showTtsSettings && (
        <TtsSettingsModal
          settings={settings}
          onChange={onSettingsChange}
          sleepTimer={sleepTimer}
          onSleepTimerChange={setSleepTimer}
          remainingSeconds={remainingSeconds}
          onClose={() => setShowTtsSettings(false)}
        />
      )}

      {/* Offline TTS Fallback Confirmation Dialog */}
      {offlineTtsConfirmOpen && (
        <div className="overlay-backdrop" onClick={() => setOfflineTtsConfirmOpen(false)}>
          <div
            className="dialog-shell size-s"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="离线语音提示"
          >
            <header className="dialog-head">
              <div className="source-login-title">
                <span><Icon name="volume2" /></span>
                <div>
                  <h2>离线语音提示</h2>
                  <small>当前设备处于离线状态</small>
                </div>
              </div>
              <button
                type="button"
                className="overlay-close"
                onClick={() => setOfflineTtsConfirmOpen(false)}
                aria-label={zh.common.close}
              >
                <Icon name="close" />
              </button>
            </header>
            <div className="source-login-body">
              <p style={{ margin: '8px 0', fontSize: '14px', lineHeight: '1.6', color: 'var(--ink)' }}>
                当前未连接到互联网，云端 Edge-TTS 朗读不可用。是否切换使用设备本地自带的<strong>系统语音 (Web Speech)</strong> 进行脱机朗读？
              </p>
            </div>
            <footer className="source-login-footer">
              <button type="button" className="subtle-button" onClick={() => setOfflineTtsConfirmOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  setOfflineTtsConfirmOpen(false)
                  onSettingsChange({ ...settings, ttsEngine: 'webSpeech' })
                  setTtsActive(true)
                  const startIdx = getInitialTtsChunkIndex()
                  playTtsChunkRef.current(startIdx)
                }}
              >
                使用系统离线语音
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  )
}
