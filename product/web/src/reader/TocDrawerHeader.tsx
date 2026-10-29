import { Icon } from '../icons'
import { IconButton } from './IconButton'

/**
 * 目录抽屉的标题栏（章名 + 倒序 / 固定 / 笔记 / 关闭四颗键）。
 *
 * 从 `ReaderScreen` 抽出来（PROPOSAL-019 F）：只有标题与四个开关回调，
 * 跟目录内容、翻页、进度都不相干。
 */
export function TocDrawerHeader({ chapterTitle, chapterCount, tocReverse, onToggleReverse, sidebarPinned, onTogglePin, notesPanel, notesCount, onToggleNotes, onOpenSourceSwitch, onOpenRefresh, inShelf, onToggleShelf, onClose }: {
  /** 当前正在读那一章的标题（已过简繁转换）；空表示还没定位到章。 */
  chapterTitle: string | null
  chapterCount: number
  tocReverse: boolean
  onToggleReverse: () => void
  sidebarPinned: boolean
  onTogglePin: () => void
  notesPanel: boolean
  notesCount: number
  onToggleNotes: () => void
  /** 换源：用户要求把入口从目录底部挪到目录顶端（「换源保留在目录侧放到顶端」）。 */
  onOpenSourceSwitch: () => void
  /** 刷新正文（单章/批量回源重取）。本地书没有书源可回，调用方不传就不出这颗键。 */
  onOpenRefresh?: () => void
  /** 这本书在不在书架里；决定「加书架」按钮是加还是移出。 */
  inShelf: boolean
  onToggleShelf: () => void
  onClose: () => void
}) {
  return (
    <header className="drawer-header">
      {/*
        标题栏原来只写「共 N 章」，不告诉你在读哪一章（用户 2026-10-09：「目录你怎么不标注章节名」）。
        现在把当前章名放进来；章名可能很长，CSS 截断 + title 里给全名。
      */}
      <div className="drawer-title">
        <Icon name="list" /><strong>目录</strong>
        <small className="drawer-title-current" title={chapterTitle ?? undefined}>
          {chapterTitle ? `正在读：${chapterTitle}` : `共 ${chapterCount} 章`}
        </small>
      </div>
      <div className="drawer-header-actions">
        <IconButton
          className={inShelf ? 'active' : ''}
          label={inShelf ? '移出书架' : '加入书架'}
          icon="bookmark"
          onClick={onToggleShelf}
        />
        <IconButton
          label="换源"
          icon="sliders"
          onClick={onOpenSourceSwitch}
        />
        {onOpenRefresh && (
          <IconButton
            label="刷新正文（单章或批量回源重取）"
            icon="refresh"
            onClick={onOpenRefresh}
          />
        )}
        <IconButton
          className={`desktop-reverse-btn ${tocReverse ? 'reversed' : ''}`}
          label={tocReverse ? '切换为正序目录' : '切换为倒序目录'}
          icon="list"
          onClick={onToggleReverse}
        />
        <IconButton
          className={`desktop-pin-btn ${sidebarPinned ? 'pinned' : ''}`}
          label={sidebarPinned ? '取消固定目录' : '固定目录到侧边栏'}
          icon={sidebarPinned ? 'pinOff' : 'pin'}
          onClick={onTogglePin}
        />
        <IconButton
          className={notesPanel ? 'active' : ''}
          label={notesPanel ? '回到目录' : `笔记（${notesCount}）`}
          icon="edit"
          onClick={onToggleNotes}
        />
        <IconButton
          // 固定态下抽屉由 `pinned` 类撑着，光 setActiveDrawer(null) 关不掉 —— 这颗必须顺带解除固定。
          // 审计把它报成"一个控件兼两个职务"，核了 ReaderScreen 里 `reader-drawer-left` 那条
          // className（`sidebarPinned` 拼在它上面）才确认是必需的；该修的是标签：它得说自己按下去会发生什么。
          label={sidebarPinned ? '取消固定并关闭目录' : '关闭目录'}
          icon="close"
          onClick={onClose}
        />
      </div>
    </header>
  )
}
