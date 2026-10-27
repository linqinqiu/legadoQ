import { Icon } from '../icons'
import { ReaderMenuAction } from './readerMenu'
import { TtsPlayState } from './ttsEngine'

/**
 * MD3 阅读外壳（PROPOSAL-020 P1）：顶栏 + 底栏，参照 legado-with-MD3 的阅读界面。
 *
 * **这是默认界面**；旧 `ReaderHeader` 那套留着当回退档（`?ui=legacy` 或 localStorage
 * `reader-ui-v2=0` 才走它），开关的判据在 `ReaderScreen` 的 `uiV2`。只换摆放与观感，
 * 功能一律复用现有回调，不新增能力。
 *
 * 章节导航（上一章 / 下一章）在**顶栏**：底栏不再有进度行，宽屏整条底栏也不渲染，
 * 只在窄屏留那一排动作 pill（见 styles.css 的 min-width:960px）。
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

export function Md3TopBar({ bookName, chapterTitle, chapterIndex, totalChapters, menuItems, onBack, onToggleToc, onPrevChapter, onNextChapter, onBookSearch, onToggleNotes, notesCount, onTogglePureReading, ...action }: {
  bookName: string
  chapterTitle: string | null
  chapterIndex: number
  totalChapters: number
  menuItems: ReaderMenuAction[]
  onBack: () => void
  onToggleToc: () => void
  onPrevChapter: () => void
  onNextChapter: () => void
  onBookSearch: () => void
  onToggleNotes: () => void
  notesCount: number
  onTogglePureReading: () => void
} & ActionProps) {
  // 首章没有上一章、末章没有下一章：禁用态与旧底栏同一判据（chapterIndex 口径）。
  const atStart = chapterIndex <= 0
  const atEnd = chapterIndex >= Math.max(0, totalChapters - 1)
  return <header className="md3-topbar" data-testid="reader-header">
    <div className="md3-topbar-side">
      <button className="md3-icon-btn" aria-label="返回书架" title="返回书架" onClick={onBack}><Icon name="arrowLeft" /></button>
      <button className="md3-icon-btn" aria-label="目录" title="目录" onClick={onToggleToc}><Icon name="list" /></button>
      <button className="md3-icon-btn" aria-label="上一章" title="上一章" disabled={atStart} onClick={onPrevChapter}><Icon name="skipBack" /></button>
      <button className="md3-icon-btn" aria-label="下一章" title="下一章" disabled={atEnd} onClick={onNextChapter}><Icon name="skipForward" /></button>
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

/**
 * 底栏只剩窄屏那一排动作 pill（目录 / 搜书 / 笔记 / 朗读 / 设置 / 沉浸）。
 *
 * 原来的「上一章 · 章节进度滑杆 · 下一章」整行已删除：进度滑杆与百分比既占正文高度，
 * 又和顶栏的章节导航重复；章节导航现在只在顶栏（`Md3TopBar`）。宽屏连这条 pill 行也不渲染
 * （styles.css 的 min-width:960px），所以宽屏不会留下一条空底栏。
 */
export function Md3BottomBar({ notesCount, ttsActive, onToggleToc, onToggleNotes, onToggleTts, onToggleSettings, onBookSearch, onTogglePureReading }: {
  notesCount: number
  ttsActive: boolean
  onToggleToc: () => void
  onToggleNotes: () => void
  onToggleTts: () => void
  onToggleSettings: () => void
  onBookSearch: () => void
  onTogglePureReading: () => void
}) {
  return <footer className="md3-bottombar" data-testid="reader-bottombar">
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
