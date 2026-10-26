import { useSyncExternalStore } from 'react'
import { Icon } from '../icons'
import { ReaderMenuAction } from './readerMenu'
import { TtsPlayState } from './ttsEngine'
import { getProgress, overallProgress, subscribeProgress } from './readerProgress'

/**
 * MD3 阅读外壳（PROPOSAL-020 P1）：顶栏 + 底栏，参照 legado-with-MD3 的阅读界面。
 *
 * **这是默认界面**；旧 `ReaderHeader` 那套留着当回退档（`?ui=legacy` 或 localStorage
 * `reader-ui-v2=0` 才走它），开关的判据在 `ReaderScreen` 的 `uiV2`。只换摆放与观感，
 * 功能一律复用现有回调，不新增能力。底栏进度按**章 + 章内真实比例**走（`readerProgress.ts`）。
 */

type ActionProps = {
  isFullscreen: boolean
  mediaDisabled: boolean
  ttsActive: boolean
  ttsPlayState: TtsPlayState
  onOpenSourceSwitch: () => void
  onToggleSettings: () => void
  onToggleFullscreen: () => void
  onToggleTts: () => void
  onResetTtsBar: () => void
}

/** 顶栏右侧那排可配置动作（与旧工具栏同源 `settings.menuItems`）。 */
function TopAction({ id, ...props }: { id: ReaderMenuAction } & ActionProps) {
  const { mediaDisabled, ttsActive, ttsPlayState, isFullscreen } = props
  switch (id) {
    case 'switchSource':
      return <button className="md3-icon-btn" aria-label="切换书源" title="切换书源" onClick={props.onOpenSourceSwitch}><Icon name="sliders" /></button>
    case 'settings':
      return <button className="md3-icon-btn" aria-label="阅读设置" title="阅读设置" onClick={props.onToggleSettings}><Icon name="settings" /></button>
    case 'fullscreen':
      return <button className="md3-icon-btn" aria-label={isFullscreen ? '退出全屏' : '全屏阅读'} title={isFullscreen ? '退出全屏' : '全屏阅读'} onClick={props.onToggleFullscreen}><Icon name="expand" /></button>
    case 'tts':
      return <button
        className={`md3-icon-btn${ttsActive && ttsPlayState === 'playing' ? ' is-active' : ''}`}
        aria-label={mediaDisabled ? '本类型不支持朗读' : !ttsActive ? '朗读本章' : ttsPlayState === 'playing' ? '暂停朗读' : '继续朗读'}
        title={mediaDisabled ? '本类型不支持朗读' : '朗读（双击把朗读条放回默认位置）'}
        onClick={props.onToggleTts}
        onDoubleClick={props.onResetTtsBar}
        disabled={mediaDisabled}
      ><Icon name={ttsActive && ttsPlayState === 'playing' ? 'pause' : 'volume2'} /></button>
    default:
      return null
  }
}

export function Md3TopBar({ bookName, chapterTitle, menuItems, onBack, onToggleToc, onBookSearch, onToggleNotes, notesCount, onTogglePureReading, ...action }: {
  bookName: string
  chapterTitle: string | null
  menuItems: ReaderMenuAction[]
  onBack: () => void
  onToggleToc: () => void
  onBookSearch: () => void
  onToggleNotes: () => void
  notesCount: number
  onTogglePureReading: () => void
} & ActionProps) {
  return <header className="md3-topbar" data-testid="reader-header">
    <div className="md3-topbar-side">
      <button className="md3-icon-btn" aria-label="返回书架" title="返回书架" onClick={onBack}><Icon name="arrowLeft" /></button>
      <button className="md3-icon-btn" aria-label="目录" title="目录" onClick={onToggleToc}><Icon name="list" /></button>
    </div>
    <div className="md3-topbar-title">
      <strong data-testid="reader-chapter-title">{chapterTitle || bookName}</strong>
      <small>{bookName}</small>
    </div>
    <div className="md3-topbar-side md3-topbar-actions">
      <button
        type="button"
        className="md3-icon-btn"
        aria-label="搜索本书"
        title="在已缓存的章节正文里搜索关键词"
        onClick={onBookSearch}
      ><Icon name="search" /></button>
      <button
        type="button"
        className="md3-icon-btn"
        aria-label={`笔记（${notesCount}）`}
        title="笔记与划线"
        onClick={onToggleNotes}
      ><Icon name="bookmark" /></button>
      {/* 纯阅读开关放顶栏：桌面端底部那排 pill 不渲染（见 styles.css 的 min-width:961px），
          而它原本只存在于底栏 —— 不放这儿，宽屏用户就没有入口了。 */}
      <button
        type="button"
        className="md3-icon-btn"
        aria-label="纯阅读：隐藏所有控件"
        title="纯阅读（隐藏所有控件，Esc 或边缘把手退出）"
        onClick={onTogglePureReading}
      ><Icon name="eyeOff" /></button>
      {menuItems.map(id => <TopAction key={id} id={id} {...action} />)}
    </div>
  </header>
}

export function Md3BottomBar({ chapterIndex, totalChapters, chapterTitle, notesCount, ttsActive, onSeekChapter, onPrev, onNext, onToggleToc, onToggleNotes, onToggleTts, onToggleSettings, onBookSearch, onTogglePureReading }: {
  chapterIndex: number
  totalChapters: number
  chapterTitle: string | null
  notesCount: number
  ttsActive: boolean
  onSeekChapter: (index: number) => void
  onPrev: () => void
  onNext: () => void
  onToggleToc: () => void
  onToggleNotes: () => void
  onToggleTts: () => void
  onToggleSettings: () => void
  onBookSearch: () => void
  onTogglePureReading: () => void
}) {
  const max = Math.max(0, totalChapters - 1)
  const atStart = chapterIndex <= 0
  const atEnd = chapterIndex >= max
  // 真实进度（PROPOSAL-020 P2）：章 + 章内比例。订阅独立 store，只让这条进度条重渲染，不拖累整屏。
  const progress = useSyncExternalStore(subscribeProgress, getProgress)
  const fraction = progress.chapterIndex === chapterIndex ? progress.fraction : 0
  const percent = Math.round(overallProgress({ chapterIndex, total: totalChapters, fraction }) * 100)
  return <footer className="md3-bottombar" data-testid="reader-bottombar">
    <div className="md3-progress-row">
      <button className="md3-icon-btn" aria-label="上一章" title="上一章" disabled={atStart} onClick={onPrev}><Icon name="skipBack" /></button>
      <div className="md3-progress">
        <div className="md3-progress-meta">
          <span className="md3-progress-chapter">{chapterTitle || '—'}</span>
          <span className="md3-progress-count">{chapterIndex + 1} / {totalChapters} · {percent}%</span>
        </div>
        <input
          type="range"
          aria-label="阅读进度"
          min={0}
          max={100}
          value={percent}
          onChange={event => {
            const pct = Number(event.target.value) / 100
            onSeekChapter(Math.min(max, Math.max(0, Math.round(pct * max))))
          }}
        />
      </div>
      <button className="md3-icon-btn" aria-label="下一章" title="下一章" disabled={atEnd} onClick={onNext}><Icon name="skipForward" /></button>
    </div>
    <div className="md3-actions-row">
      <button className="md3-pill" aria-label="目录" onClick={onToggleToc}><Icon name="list" /><span>目录</span></button>
      <button className="md3-pill" aria-label="搜索本书" title="在已缓存的章节正文里搜索关键词" onClick={onBookSearch}><Icon name="search" /><span>搜书</span></button>
      <button className="md3-pill" aria-label={`笔记（${notesCount}）`} onClick={onToggleNotes}><Icon name="bookmark" /><span>笔记{notesCount > 0 ? ` ${notesCount}` : ''}</span></button>
      <button className={`md3-pill${ttsActive ? ' is-active' : ''}`} aria-label="朗读" onClick={onToggleTts}><Icon name="volume2" /><span>朗读</span></button>
      <button className="md3-pill" aria-label="阅读设置" onClick={onToggleSettings}><Icon name="settings" /><span>设置</span></button>
      <button className="md3-pill" aria-label="纯阅读：隐藏所有控件" title="纯阅读（隐藏所有控件，Esc 或边缘把手退出）" onClick={onTogglePureReading}><Icon name="eyeOff" /><span>沉浸</span></button>
    </div>
  </footer>
}
