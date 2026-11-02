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
 * 章节导航（上一章 / 下一章）**不在顶栏**（用户 2026-11-02：「顶部导航栏内容有冲突的
 * 要将上下一章的功能删掉」）：翻页键 / 点按区 / 键盘 ←→ / 目录抽屉已经覆盖同一件事，
 * 顶栏再摆一排只是第四份入口。旧 `ReaderHeader` 仍保留那两颗键（回退档没有别处常驻入口）。
 *
 * 顶栏只留「返回 / 目录」与右侧动作；窄屏重复的动作由 CSS 隐藏，交给底栏那排 pill
 * （见 styles.css 的 max-width:959px）。
 */

type ActionProps = {
  isFullscreen: boolean
  mediaDisabled: boolean
  ttsActive: boolean
  ttsPlayState: TtsPlayState
  onToggleSettings: () => void
  onToggleFullscreen: () => void
  onToggleTts: () => void
  onResetTtsBar: () => void
}

/** 顶栏右侧那排可配置动作（与旧工具栏同源 `settings.menuItems`）。 */
function TopAction({ id, ...props }: { id: ReaderMenuAction } & ActionProps) {
  const { mediaDisabled, ttsActive, ttsPlayState, isFullscreen } = props
  // 每一档都带上 `md3-action-<id>`：窄屏要把底栏已有的动作（朗读/设置）从顶栏藏掉，
  // 宽屏则照常显示。不按文案判，避免以后改标签时两条通道一起失灵。
  const className = `md3-icon-btn md3-action-${id}`
  switch (id) {
    case 'settings':
      return <button className={className} aria-label="阅读设置" title="阅读设置" onClick={props.onToggleSettings}><Icon name="settings" /></button>
    case 'fullscreen':
      return <button className={className} aria-label={isFullscreen ? '退出全屏' : '全屏阅读'} title={isFullscreen ? '退出全屏' : '全屏阅读'} onClick={props.onToggleFullscreen}><Icon name="expand" /></button>
    case 'tts':
      return <button
        className={`${className}${ttsActive && ttsPlayState === 'playing' ? ' is-active' : ''}`}
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

export function Md3TopBar({ bookName, chapterTitle, menuItems, onBack, onToggleToc, onBookSearch, onToggleNotes, notesCount, ...action }: {
  bookName: string
  chapterTitle: string | null
  menuItems: ReaderMenuAction[]
  onBack: () => void
  onToggleToc: () => void
  onBookSearch: () => void
  onToggleNotes: () => void
  notesCount: number
} & ActionProps) {
  return <header className="md3-topbar" data-testid="reader-header">
    <div className="md3-topbar-side">
      <button className="md3-icon-btn" aria-label="返回书架" title="返回书架" onClick={onBack}><Icon name="arrowLeft" /></button>
      <button className="md3-icon-btn md3-topbar-toc" aria-label="目录" title="目录" onClick={onToggleToc}><Icon name="list" /></button>
    </div>
    <div className="md3-topbar-title">
      <strong data-testid="reader-chapter-title">{chapterTitle || bookName}</strong>
      <small>{bookName}</small>
    </div>
    <div className="md3-topbar-side md3-topbar-actions">
      <button
        type="button"
        className="md3-icon-btn md3-topbar-search"
        aria-label="搜索本书"
        title="在已缓存的章节正文里搜索关键词"
        onClick={onBookSearch}
      ><Icon name="search" /></button>
      <button
        type="button"
        className="md3-icon-btn md3-topbar-notes"
        aria-label={`笔记（${notesCount}）`}
        title="笔记与划线"
        onClick={onToggleNotes}
      ><Icon name="edit" /></button>
      {menuItems.map(id => <TopAction key={id} id={id} {...action} />)}
    </div>
  </header>
}

/**
 * 底栏只剩窄屏那一排动作 pill（目录 / 搜书 / 笔记 / 朗读 / 设置）。
 *
 * 原来的「上一章 · 章节进度滑杆 · 下一章」整行已删除：进度滑杆与百分比既占正文高度，
 * 又和顶栏的章节导航重复；章节导航走点按区 / 键盘 ←→ / 目录抽屉，顶栏也不再摆。
 * 宽屏连这条 pill 行也不渲染（styles.css 的 min-width:960px），所以宽屏不会留下一条空底栏。
 *
 * 笔记 pill 用 `edit` 图标：目录头的「加入书架」是 `bookmark`，同一个书签图标挨在一起
 * 看着像同一件事（用户 2026-11-02 的截图里就是在问这批重复入口）。
 */
export function Md3BottomBar({ notesCount, ttsActive, onToggleToc, onToggleNotes, onToggleTts, onToggleSettings, onBookSearch }: {
  notesCount: number
  ttsActive: boolean
  onToggleToc: () => void
  onToggleNotes: () => void
  onToggleTts: () => void
  onToggleSettings: () => void
  onBookSearch: () => void
}) {
  return <footer className="md3-bottombar" data-testid="reader-bottombar">
    <div className="md3-actions-row">
      <button className="md3-pill" aria-label="目录" onClick={onToggleToc}><Icon name="list" /><span>目录</span></button>
      <button className="md3-pill" aria-label="搜索本书" title="在已缓存的章节正文里搜索关键词" onClick={onBookSearch}><Icon name="search" /><span>搜书</span></button>
      <button className="md3-pill" aria-label={`笔记（${notesCount}）`} onClick={onToggleNotes}><Icon name="edit" /><span>笔记{notesCount > 0 ? ` ${notesCount}` : ''}</span></button>
      <button className={`md3-pill${ttsActive ? ' is-active' : ''}`} aria-label="朗读" onClick={onToggleTts}><Icon name="volume2" /><span>朗读</span></button>
      <button className="md3-pill" aria-label="阅读设置" onClick={onToggleSettings}><Icon name="settings" /><span>设置</span></button>
    </div>
  </footer>
}
