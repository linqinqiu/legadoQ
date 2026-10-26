import { IconButton } from './IconButton'
import { ReaderMenuAction } from './readerMenu'
import { TtsPlayState } from './ttsEngine'

/**
 * 阅读器顶部那条浮动工具栏：返回 / 目录 / 书名 / 可配置的按钮排（PROPOSAL-019 B）。
 *
 * 从 `ReaderScreen` 抽出来（PROPOSAL-019 F）：只有书名与一串动作回调 ——
 * 按钮排来自 `settings.menuItems`，跟翻页 / 进度 / 缓存不相干。
 */
export function ReaderHeader({ bookName, menuItems, isFullscreen, mediaDisabled, ttsActive, ttsPlayState, onBack, onToggleToc, onOpenSourceSwitch, onToggleSettings, onToggleFullscreen, onToggleTts, onResetTtsBar }: {
  bookName: string
  menuItems: ReaderMenuAction[]
  isFullscreen: boolean
  /** 当前是音视频这类不能朗读的章节（朗读键置灰）。 */
  mediaDisabled: boolean
  ttsActive: boolean
  ttsPlayState: TtsPlayState
  onBack: () => void
  onToggleToc: () => void
  onOpenSourceSwitch: () => void
  onToggleSettings: () => void
  onToggleFullscreen: () => void
  onToggleTts: () => void
  onResetTtsBar: () => void
}) {
  const menuButton = (id: ReaderMenuAction) => {
    switch (id) {
      case 'switchSource':
        return <IconButton key={id} label="切换书源" icon="sliders" onClick={onOpenSourceSwitch} />
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
      </div>
      <strong className="reader-header-title" title={bookName}>{bookName}</strong>
      <div className="reader-header-actions">
        {menuItems.map(id => menuButton(id))}
      </div>
    </header>
  )
}
