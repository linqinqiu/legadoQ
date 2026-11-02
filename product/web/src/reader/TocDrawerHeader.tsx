import { Icon } from '../icons'
import { IconButton } from './IconButton'

/**
 * 目录抽屉的标题栏（章名 + 书架 / 换源 / 刷新 / 倒序 / 关闭五颗键）。
 *
 * 从 `ReaderScreen` 抽出来（PROPOSAL-019 F）：只有标题与五个开关回调，
 * 跟目录内容、翻页、进度都不相干。
 *
 * 桌面与移动统一为覆盖式抽屉（用户 2026-11-02「桌面端目录改成普通覆盖式抽屉」）：
 * 打开由顶栏「目录」键切换，关闭由本排关闭键 / 遮罩承担，没有固定侧栏形态。
 *
 * 笔记入口只在顶栏（宽屏）/ 底栏（窄屏）留一份；这里原来那颗「笔记」与它们重复，
 * 已删除（用户 2026-11-02「部分重复的功能也改掉」）。笔记面板打开时额外出现
 * 一颗「回到目录」——那是返回动作，不是第二个笔记入口。
 */
export function TocDrawerHeader({ chapterTitle, chapterCount, tocReverse, onToggleReverse, notesPanel, onBackToToc, onOpenSourceSwitch, onOpenRefresh, inShelf, onToggleShelf, onClose }: {
  /** 当前正在读那一章的标题（已过简繁转换）；空表示还没定位到章。 */
  chapterTitle: string | null
  chapterCount: number
  tocReverse: boolean
  onToggleReverse: () => void
  /** 笔记面板正开着：只决定要不要出「回到目录」返回键。 */
  notesPanel: boolean
  onBackToToc: () => void
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
        {notesPanel && (
          <IconButton
            label="回到目录"
            icon="arrowLeft"
            onClick={onBackToToc}
          />
        )}
        <IconButton
          label="关闭目录"
          icon="close"
          onClick={onClose}
        />
      </div>
    </header>
  )
}
