import type { BookNote, Chapter, TocRuleOption } from '../../lib/api'
import { ExtensionSlot } from '../../plugins/ExtensionSlot'
import { Md3BottomBar, Md3TopBar } from './Md3Chrome'
import { ReaderCatalog } from './ReaderCatalog'
import { ReaderHeader } from './ReaderHeader'
import { TapZoneEditor } from './interaction/TapZoneEditor'
import type { TapMap } from './interaction/tapZones'
import { resetTtsBarPosition } from './tts/ttsBarPosition'
import type { TtsPlayState } from './tts/ttsEngine'
import { ReaderSettingsSheet } from './settingsPanel/ReaderSettingsSheet'
import type { ReaderSettings } from './settingsPanel/readerSettings'

export interface ReaderChromeProps {
  uiV2: boolean
  activeDrawer: 'toc' | 'settings' | 'other' | null
  bookName: string
  bookAuthor: string
  sourceId: string
  chapter: Chapter
  chapterIndex: number
  totalChapters: number
  isFullscreen: boolean
  mediaDisabled: boolean
  ttsActive: boolean
  ttsPlayState: TtsPlayState
  notesCount: number
  notesPanel: boolean
  inShelf: boolean
  tapZoneEditing: boolean
  readingLeft: number
  settings: ReaderSettings
  chapters: Chapter[]
  cachedChapterUrls: Set<string>
  chapterWordCounts: ReadonlyMap<string, number>
  convert: (text: string) => string
  notes: BookNote[]
  chapterTitles: Record<number, string>
  localBook: { name: string; tocRule: string | null } | null
  tocRuleOptions: TocRuleOption[]
  actions: {
    onBack: () => void
    onToggleToc: () => void
    onToggleSettings: () => void
    onToggleFullscreen: () => void
    onToggleTts: () => void
    onBookSearch: () => void
    onToggleNotes: () => void
    onToggleBookmark: () => void
    onPrevChapter: () => void
    onNextChapter: () => void
    onSelectChapter: (index: number) => void
    onCloseDrawer: () => void
    onBackToToc: () => void
    onOpenSourceSwitch: () => void
    onOpenRefresh?: () => void
    onToggleShelf: () => void
    onJumpNote: (note: BookNote) => void
    onOpenReplaceRules: () => void
    onEditTapZones: () => void
    onCloseTapZone: () => void
    onTapZoneMap: (map: TapMap) => void
    onTapZoneMode: (mode: ReaderSettings['pageMode']) => void
    onTapZonePreset: (paginate: TapMap, scroll: TapMap) => void
    onSettingsChange: (next: ReaderSettings) => void
    onReparseLocal?: (ruleKey: string) => Promise<string | null>
  }
}

/**
 * 阅读器外壳：顶栏（MD3 / legacy）、底栏、目录抽屉、设置抽屉/弹层、抽屉遮罩、点击区域编辑器。
 *
 * 从 `ReaderScreen.tsx` 搬出来的展示层。两条外壳并存是刻意的：
 * `uiV2` 开时用 MD3 顶栏 + 底栏，关时回旧浮动工具栏；章节导航在 MD3 下走点按区/键盘/目录，
 * 所以底栏只留窄屏动作 pill。抽屉遮罩只有目录抽屉两种界面都要，设置抽屉在 MD3 下由弹层自带遮罩。
 */
export function ReaderChrome({
  uiV2,
  activeDrawer,
  bookName,
  bookAuthor,
  sourceId,
  chapter,
  chapterIndex,
  totalChapters,
  isFullscreen,
  mediaDisabled,
  ttsActive,
  ttsPlayState,
  notesCount,
  notesPanel,
  inShelf,
  tapZoneEditing,
  readingLeft,
  settings,
  chapters,
  cachedChapterUrls,
  chapterWordCounts,
  convert,
  notes,
  chapterTitles,
  localBook,
  tocRuleOptions,
  actions,
}: ReaderChromeProps) {
  return (
    <>
      {/* 顶栏：MD3 外壳（PROPOSAL-020）或旧浮动工具栏，由 uiV2 开关切换 */}
      {uiV2 ? <Md3TopBar
        bookName={bookName}
        chapterTitle={chapter?.title ? convert(chapter.title) : null}
        menuItems={settings.menuItems}
        isFullscreen={isFullscreen}
        mediaDisabled={mediaDisabled}
        ttsActive={ttsActive}
        ttsPlayState={ttsPlayState}
        onBack={actions.onBack}
        onToggleToc={actions.onToggleToc}
        onToggleSettings={actions.onToggleSettings}
        onToggleFullscreen={actions.onToggleFullscreen}
        onToggleTts={actions.onToggleTts}
        onResetTtsBar={resetTtsBarPosition}
        onBookSearch={actions.onBookSearch}
        onToggleNotes={actions.onToggleNotes}
        notesCount={notesCount}
        onToggleBookmark={actions.onToggleBookmark}
      /> : <ReaderHeader
        bookName={bookName}
        chapterIndex={chapterIndex}
        totalChapters={totalChapters}
        menuItems={settings.menuItems}
        isFullscreen={isFullscreen}
        mediaDisabled={mediaDisabled}
        ttsActive={ttsActive}
        ttsPlayState={ttsPlayState}
        onBack={actions.onBack}
        onToggleToc={actions.onToggleToc}
        onPrevChapter={actions.onPrevChapter}
        onNextChapter={actions.onNextChapter}
        onToggleSettings={actions.onToggleSettings}
        onToggleFullscreen={actions.onToggleFullscreen}
        onToggleTts={actions.onToggleTts}
        onResetTtsBar={resetTtsBarPosition}
        onToggleBookmark={actions.onToggleBookmark}
      />}

      {/* 扩展槽位：第三方/用户可在此注入自定义组件（如统计卡片、快捷工具等）。 */}
      <ExtensionSlot name="reader.toolbar.right" />

      {/* MD3 底栏：只剩窄屏那一排动作 pill（宽屏整条不渲染）。 */}
      {uiV2 && <Md3BottomBar
        notesCount={notesCount}
        ttsActive={ttsActive}
        onToggleToc={actions.onToggleToc}
        onToggleNotes={actions.onToggleNotes}
        onToggleTts={actions.onToggleTts}
        onToggleSettings={actions.onToggleSettings}
        onBookSearch={actions.onBookSearch}
      />}

      {/* TOC Drawer (Left)：桌面与移动统一为覆盖式抽屉，不挤压正文；内容在 ReaderCatalog 里 */}
      <ReaderCatalog
        open={activeDrawer === 'toc'}
        chapterTitle={chapter?.title ? convert(chapter.title) : null}
        chapters={chapters}
        chapterIndex={chapterIndex}
        cachedUrlsSet={cachedChapterUrls}
        wordCounts={chapterWordCounts}
        convertTitle={convert}
        onSelectChapter={actions.onSelectChapter}
        onCloseDrawer={actions.onCloseDrawer}
        notesPanel={notesPanel}
        onBackToToc={actions.onBackToToc}
        onOpenSourceSwitch={actions.onOpenSourceSwitch}
        onOpenRefresh={actions.onOpenRefresh}
        inShelf={inShelf}
        onToggleShelf={actions.onToggleShelf}
        notes={notes}
        onJumpNote={actions.onJumpNote}
        onBookmarkHere={actions.onToggleBookmark}
        bookMeta={{ bookName, author: bookAuthor, sourceId }}
        chapterTitles={chapterTitles}
        autoScrollKey={activeDrawer === 'toc' ? 1 : 0}
      />

      {/* 阅读设置：弹层（MD3）或右侧抽屉（旧界面），内容与标签页在 ReaderSettingsSheet 里 */}
      <ReaderSettingsSheet
        uiV2={uiV2}
        open={activeDrawer === 'settings'}
        settings={settings}
        onSettingsChange={actions.onSettingsChange}
        onClose={actions.onCloseDrawer}
        onOpenReplaceRules={actions.onOpenReplaceRules}
        onEditTapZones={actions.onEditTapZones}
        localBook={localBook}
        tocRuleOptions={tocRuleOptions}
        onReparseLocal={actions.onReparseLocal}
      />

      {/* Backdrop for Drawers：目录抽屉两种界面都用；设置抽屉在 MD3 下改由弹层自带遮罩 */}
      {activeDrawer && (activeDrawer === 'toc' || !uiV2) && (
        <div className="reader-drawer-backdrop" onClick={actions.onCloseDrawer} aria-hidden="true" />
      )}

      {/* 点击区域编辑层：盖在正文之上（正文仍渲染，看得见字），只编当前翻页方式那张表。 */}
      {tapZoneEditing && (
        <TapZoneEditor
          map={settings.pageMode === 'paginate' ? settings.tapZones.paginate : settings.tapZones.scroll}
          mode={settings.pageMode}
          left={readingLeft}
          onMap={actions.onTapZoneMap}
          onMode={actions.onTapZoneMode}
          onPreset={actions.onTapZonePreset}
          onClose={actions.onCloseTapZone}
        />
      )}
    </>
  )
}
