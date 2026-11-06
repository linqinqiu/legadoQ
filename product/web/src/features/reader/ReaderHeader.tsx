import { IconButton } from './IconButton'
import { ReaderMenuAction } from './interaction/readerMenu'
import { TtsPlayState } from './tts/ttsEngine'

/**
 * 阅读器顶部那条浮动工具栏：返回 / 目录 / 上一章 / 下一章 / 书名 / 可配置的按钮排（PROPOSAL-019 B）。
 *
 * 从 `ReaderScreen` 抽出来（PROPOSAL-019 F）：只有书名与一串动作回调 ——
 * 按钮排来自 `settings.menuItems`，跟翻页 / 进度 / 缓存不相干。
 * 章节导航（上一章 / 下一章）只留在这一套回退外壳里：默认 MD3 界面已按用户 2026-11-02
 * 的要求删掉顶栏那两颗，改由点按区 / 键盘 ←→ / 目录承担。
 */
export function ReaderHeader({ bookName, chapterIndex, totalChapters, menuItems, isFullscreen, mediaDisabled, ttsActive, ttsPlayState, onBack, onToggleToc, onPrevChapter, onNextChapter, onToggleSettings, onToggleFullscreen, onToggleTts, onResetTtsBar }: {
  bookName: string
  chapterIndex: number
  totalChapters: number
  menuItems: ReaderMenuAction[]
  isFullscreen: boolean
  /** 当前是音视频这类不能朗读的章节（朗读键置灰）。 */
  mediaDisabled: boolean
  ttsActive: boolean
  ttsPlayState: TtsPlayState
  onBack: () => void
  onToggleToc: () => void
  onPrevChapter: () => void
  onNextChapter: () => void
  onToggleSettings: () => void
  onToggleFullscreen: () => void
  onToggleTts: () => void
  onResetTtsBar: () => void
}) {
  // 首章禁用上一章、末章禁用下一章。
  const atStart = chapterIndex <= 0
  const atEnd = chapterIndex >= Math.max(0, totalChapters - 1)
  const menuButton = (id: ReaderMenuAction) => {
    switch (id) {
      case 'settings':
        return <IconButton key={id} label="阅读设置" icon="settings" onClick={onToggleSettings} />
      case 'fullscreen':
        return <IconButton key={id} label={isFullscreen ? '退出全屏' : '全屏阅读'} icon="expand" onClick={onToggleFullscreen} />
      case 'tts':
        return <IconButton
          key={id}
          label={mediaDisabled ? '本类型不支持朗读' : !ttsActive ? '朗读本章' : ttsPlayState === 'playing' ? '暂停朗读' : '继续朗读'}
          icon={ttsActive && ttsPlayState === 'playing' ? 'pause' : 'volume2'}
          onClick={onToggleTts}
          onDoubleClick={onResetTtsBar}
          hint="双击可把朗读悬浮条放回默认位置"
          disabled={mediaDisabled}
        />
      default:
        return null
    }
  }
  return (
    <header className="reader-header" data-testid="reader-header">
      <div className="reader-header-left">
        <IconButton label="返回书架" icon="arrowLeft" onClick={onBack} />
        <IconButton label="目录" icon="list" onClick={onToggleToc} />
        <IconButton label="上一章" icon="skipBack" onClick={onPrevChapter} disabled={atStart} />
        <IconButton label="下一章" icon="skipForward" onClick={onNextChapter} disabled={atEnd} />
      </div>
      <strong className="reader-header-title" title={bookName}>{bookName}</strong>
      <div className="reader-header-actions">
        {menuItems.map(id => menuButton(id))}
      </div>
    </header>
  )
}
