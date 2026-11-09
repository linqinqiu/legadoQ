import type { ComponentProps } from 'react'
import { Icon } from '../../icons'
import { useEscapeClose } from '../../lib/useEscapeClose'
import { zh } from '../../i18n/zh'
import type { BookDetails, Chapter, SearchResult } from '../../lib/api'
import { OfflineCacheModal } from '../../components/OfflineCacheModal'
import { ReplaceRulesModal } from '../../components/ReplaceRulesModal'
import { SourceSwitchModal } from '../../components/SourceSwitchModal'
import { BookSearchDialog } from './dialogs/BookSearchDialog'
import { RefreshChaptersModal } from './dialogs/RefreshChaptersModal'
import { MarkingMenu } from './interaction/MarkingMenu'
import { NoteToolbar, type NoteDraft } from './notes/NoteToolbar'
import type { ReaderSettings } from './settingsPanel/readerSettings'
import { ReaderTtsManager } from './tts/ReaderTtsManager'
import { TtsSettingsModal } from './tts/TtsSettingsModal'

export interface ReaderOverlaysProps {
  dialogs: {
    sourceSwitch: boolean
    ttsActive: boolean
    ttsSettings: boolean
    replaceRules: boolean
    offlineStats: boolean
    refreshChapters: boolean
    offlineTtsConfirm: boolean
    lightboxSrc: string | null
    bookSearch: boolean
    noteDraft: NoteDraft | null
    noteEditor: boolean
  }
  book: {
    name: string
    details: BookDetails
    bookUrl: string
    chapter: Chapter
    chapterIndex: number
    chapters: Chapter[]
  }
  reader: {
    settings: ReaderSettings
    sleepTimer: ComponentProps<typeof TtsSettingsModal>['sleepTimer']
    remainingSeconds: number | null
    cachedChapterUrls: Set<string>
  }
  actions: {
    onCloseSourceSwitch: () => void
    onSwitchSource: (chosen: { result: SearchResult; chapters: Chapter[]; targetChapterIndex: number }) => Promise<void>
    onSettingsChange: (next: ReaderSettings) => void
    onSleepTimerChange: ComponentProps<typeof TtsSettingsModal>['onSleepTimerChange']
    onCloseTtsSettings: () => void
    onRulesChanged: () => void
    onCloseReplaceRules: () => void
    onCloseOfflineStats: () => void
    onCloseRefreshChapters: () => void
    onRefreshed: (chapterUrls: string[]) => void
    onCloseOfflineTtsConfirm: () => void
    onUseWebSpeech: () => void
    onCloseLightbox: () => void
    onJumpSearchHit: ComponentProps<typeof BookSearchDialog>['onJump']
    onCloseBookSearch: () => void
    onHighlight: () => void
    onNote: () => void
    onCopy: () => void
    onAi: () => void
    onDismissMarking: () => void
    onChangeNoteText: (text: string) => void
    onSaveNote: () => void
    onRemoveNote: () => void
    onDismissNote: (clearSelection: boolean) => void
  }
}

/**
 * 阅读器的弹层集合：换源 / TTS 播放条与设置 / 净化规则 / 缓存统计 / 刷新正文 /
 * 离线语音确认 / 图片预览 / 本书搜索 / 选中浮层。
 *
 * 从 `ReaderScreen.tsx` 搬出来的纯展示层：开关状态、数据与动作都由阅读器传入。
 * 这些节点都挂在 `<section class="reader-main">` **之外**，自己的点击不该再触发
 * `onReaderMouseUp`（选中正文的浮层尤其如此）。
 */
export function ReaderOverlays({ dialogs, book, reader, actions }: ReaderOverlaysProps) {
  const { name: bookName, details, bookUrl, chapter, chapterIndex, chapters } = book
  const { settings, sleepTimer, remainingSeconds, cachedChapterUrls } = reader

  // 图片预览只认点击、不认 Esc —— 统一补上 Esc 关闭（PROPOSAL-018 W6 的"遮罩与关闭键必须走统一那一套"）。
  useEscapeClose(actions.onCloseLightbox)

  return (
    <>
      {dialogs.sourceSwitch && (
        <SourceSwitchModal
          bookName={bookName}
          author={details.author}
          currentSourceId={details.sourceId}
          currentBookUrl={bookUrl}
          currentChapterTitle={chapter?.title}
          currentChapterIndex={chapterIndex}
          knownAlternateSources={details.alternateSources}
          onSwitch={actions.onSwitchSource}
          onClose={actions.onCloseSourceSwitch}
        />
      )}

      {dialogs.ttsActive && (
        <ReaderTtsManager
          chapter={chapter}
          bookName={bookName}
          bookAuthor={details.author}
          coverUrl={details.coverUrl}
          settings={settings}
          onSettingsChange={actions.onSettingsChange}
        />
      )}

      {dialogs.ttsSettings && (
        <TtsSettingsModal
          settings={settings}
          onChange={actions.onSettingsChange}
          sleepTimer={sleepTimer}
          onSleepTimerChange={actions.onSleepTimerChange}
          remainingSeconds={remainingSeconds}
          onClose={actions.onCloseTtsSettings}
        />
      )}

      {dialogs.replaceRules && (
        <ReplaceRulesModal
          isOpen={dialogs.replaceRules}
          onClose={actions.onCloseReplaceRules}
          currentBookName={bookName}
          currentSourceUrl={details.sourceId}
          onRulesChanged={actions.onRulesChanged}
        />
      )}

      {dialogs.offlineStats && <OfflineCacheModal onClose={actions.onCloseOfflineStats} />}

      {dialogs.refreshChapters && (
        <RefreshChaptersModal
          sourceId={details.sourceId}
          bookUrl={bookUrl}
          chapters={chapters}
          currentIndex={chapterIndex}
          cachedUrls={cachedChapterUrls}
          onClose={actions.onCloseRefreshChapters}
          onRefreshed={actions.onRefreshed}
        />
      )}

      {dialogs.offlineTtsConfirm && (
        <div className="overlay-backdrop" onClick={actions.onCloseOfflineTtsConfirm}>
          <div
            className="dialog-shell size-s"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="离线语音提示"
          >
            <header className="dialog-head">
              <div className="source-login-title">
                <span><Icon name="volume2" /></span>
                <div>
                  <h2>离线朗读提示</h2>
                  <small>当前设备处于离线状态</small>
                </div>
              </div>
              <button type="button" className="overlay-close" onClick={actions.onCloseOfflineTtsConfirm} aria-label={zh.common.close}>
                <Icon name="close" />
              </button>
            </header>
            <div className="source-login-body">
              <p style={{ margin: '8px 0', fontSize: '14px', lineHeight: '1.6', color: 'var(--ink)' }}>
                当前未连接到互联网，云端 Edge-TTS 朗读不可用。是否切换使用设备本地自带的<strong>系统语音 (Web Speech)</strong> 进行脱机朗读？
              </p>
            </div>
            <footer className="source-login-footer">
              <button type="button" className="subtle-button" onClick={actions.onCloseOfflineTtsConfirm}>
                取消
              </button>
              <button type="button" className="primary-button" onClick={actions.onUseWebSpeech}>
                使用系统离线语音
              </button>
            </footer>
          </div>
        </div>
      )}

      {dialogs.lightboxSrc && (
        <div className="overlay-backdrop is-viewer" onClick={actions.onCloseLightbox} role="dialog" aria-label="图片预览">
          <button type="button" className="reader-image-lightbox-close" aria-label="关闭预览" onClick={actions.onCloseLightbox}><Icon name="close" /></button>
          <img src={dialogs.lightboxSrc} alt="" onClick={event => event.stopPropagation()} />
        </div>
      )}

      {dialogs.bookSearch && (
        <BookSearchDialog
          sourceId={details.sourceId}
          bookUrl={bookUrl}
          onJump={actions.onJumpSearchHit}
          onClose={actions.onCloseBookSearch}
        />
      )}

      {dialogs.noteDraft && !dialogs.noteEditor && (
        <MarkingMenu
          x={dialogs.noteDraft.x}
          y={dialogs.noteDraft.y}
          onHighlight={actions.onHighlight}
          onNote={actions.onNote}
          onCopy={actions.onCopy}
          onAi={actions.onAi}
          onDismiss={actions.onDismissMarking}
        />
      )}
      {dialogs.noteDraft && dialogs.noteEditor && (
        <NoteToolbar
          draft={dialogs.noteDraft}
          onChangeText={actions.onChangeNoteText}
          onSave={actions.onSaveNote}
          onRemove={actions.onRemoveNote}
          onDismiss={actions.onDismissNote}
        />
      )}
    </>
  )
}
