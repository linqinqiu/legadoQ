// 书源候选列表与它的右键启停菜单（换源候选三处共用）
// 从 main.tsx 拆出（0.8.2 结构重排）：组件体逐字未动，import 由脚本按导出面索引补全。

import { useMemo } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { Icon } from '../icons'
import { SourceChoice } from '../lib/searchStore'
import { SourceHealthInspection } from '../sources/sourceInspector'
import { SourceSummary, api } from '../lib/api'
import { showContextMenu } from './ContextMenu'
import { toast } from './Toast'
import { setPendingSourceFocus } from '../lib/sourceFocus'

export const flipSource = async (source: SourceSummary, onSourcesChanged?: () => void) => {
  try {
    await api.batchSources(source.enabled ? 'disable' : 'enable', [source.id])
    toast.success(source.enabled ? `已停用「${source.name}」` : `已启用「${source.name}」`)
    onSourcesChanged?.()
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '启停失败')
  }
}

/** 换源行的右键：能就地做的就地做，做不了的跳去书源页并带着定位目标。 */
export function openSourceMenu(event: ReactMouseEvent, choice: SourceChoice, source: SourceSummary | undefined, onSourcesChanged?: () => void) {
  showContextMenu(event, [
    ...(source
      ? [
          { label: source.enabled ? '停用此书源' : '启用此书源', icon: source.enabled ? ('close' as const) : ('check' as const), onSelect: () => void flipSource(source, onSourcesChanged) },
          { label: '在书源页中定位', icon: 'edit' as const, onSelect: () => { setPendingSourceFocus(source.name); location.hash = '#sources' } },
        ]
      : []),
    { label: '复制书源地址', icon: 'copy' as const, onSelect: () => void navigator.clipboard?.writeText(choice.result.sourceId) },
  ])
}

/**
 * 详情弹窗里的「可用书源」列表：一行 = 一个源在这本书上的实际表现。
 *
 * 以前行内只写 `choice.result.sourceId`（一串 `https://xxx.com/`），十几个源摊开时
 * 用户根本分不清哪个是哪个 —— 那正是「书籍详情信息不完善、不明了」的直接来源。
 * 现在按 `sources` 反查书源名与分组，把体检拿到的细节摊开，并且右键一行就能直接管理该书源。
 */
export function SourceChoiceList({
  choices,
  inspections,
  sources,
  active,
  onChoose,
  onRecheck,
  onSourcesChanged,
  checking,
}: {
  choices: SourceChoice[]
  inspections: Map<string, SourceHealthInspection>
  sources: SourceSummary[]
  active?: string
  onChoose: (choice: SourceChoice) => void
  onRecheck: () => void
  /** 停用/启用之后要请上层重取一次书源，否则行上的「已停用」标记会停在旧值。 */
  onSourcesChanged?: () => void
  checking: boolean
}) {
  const sourceIndex = useMemo(() => {
    const map = new Map<string, SourceSummary>()
    for (const source of sources) map.set(source.id, source)
    return map
  }, [sources])

  const sortedChoices = useMemo(() => {
    const scoreOf = (choice: SourceChoice) => {
      const key = `${choice.result.sourceId}\u0000${choice.result.bookUrl}`
      const insp = inspections.get(key)
      return insp ? insp.score : (choice.status === 'loaded' ? 5000 : 0)
    }
    const chaptersOf = (choice: SourceChoice) => {
      const key = `${choice.result.sourceId}\u0000${choice.result.bookUrl}`
      const insp = inspections.get(key)
      return insp?.totalChapters ?? choice.book?.chapters.length ?? 0
    }
    return [...choices].sort((a, b) => scoreOf(b) - scoreOf(a) || chaptersOf(b) - chaptersOf(a))
  }, [choices, inspections])

  const completedCount = useMemo(() => {
    let count = 0
    for (const choice of choices) {
      const insp = inspections.get(`${choice.result.sourceId}\u0000${choice.result.bookUrl}`)
      if (insp && insp.status !== 'checking' && insp.status !== 'idle') count++
    }
    return count
  }, [choices, inspections])

  return (
    <section className="source-choice-list" aria-label="可用书源切换列表">
      <header>
        <div className="source-choice-header-left">
          <span>可用书源 ({choices.length})</span>
          <small>
            {checking
              ? `正在校验各源的后期章节 (${completedCount}/${choices.length})`
              : `${completedCount}/${choices.length} 个源已出校验结论`}
          </small>
        </div>
        <button
          type="button"
          className="subtle-button source-recheck-btn"
          onClick={onRecheck}
          disabled={checking}
          title="重新复检每个源的后期章节与付费拦截"
        >
          <Icon name="refresh" className={checking ? 'spin' : ''} />
          <span>{checking ? '校验中' : '重新校验'}</span>
        </button>
      </header>
      <div className="source-choice-items">
        {sortedChoices.map(choice => {
          const key = `${choice.result.sourceId}\u0000${choice.result.bookUrl}`
          const isSelected = active === choice.result.bookUrl
          const isLoading = choice.status === 'loading'
          const inspection = inspections.get(key)
          const summary = sourceIndex.get(choice.result.sourceId)
          const host = choice.result.sourceId.replace(/^[a-z]+:\/\//i, '').split('/')[0].replace(/^www\./i, '')

          let badge = null
          let statusText = '点击切换为此书源'
          if (inspection) {
            // 徽章只写结论，不再混 ✓ / ⚠ / ✕ 这类字形：颜色与文字已经表达了，符号在窄列表里只是噪声。
            if (inspection.status === 'checking') {
              badge = <span className="source-health-badge health-checking">校验中</span>
              statusText = '正在复检后期章节'
            } else if (inspection.status === 'valid') {
              badge = <span className="source-health-badge health-valid">可读</span>
              statusText = inspection.summaryText
            } else if (inspection.status === 'vip_restricted') {
              badge = <span className="source-health-badge health-vip">VIP 拦截</span>
              statusText = inspection.summaryText
            } else if (inspection.status === 'incomplete') {
              badge = <span className="source-health-badge health-incomplete">疑似残卷</span>
              statusText = inspection.summaryText
            } else if (inspection.status === 'error') {
              badge = <span className="source-health-badge health-error">读不出</span>
              statusText = inspection.summaryText
            }
          } else if (isLoading) {
            statusText = '正在读取目录…'
          } else if (choice.status === 'loaded' && choice.book) {
            statusText = `已载入 · 共 ${choice.book.chapters.length} 章`
          }

          // 体检拿到的细节：抽检了几章、最新章叫什么。以前只把 summaryText 塞进一行 small，
          // 用户看不出"可读"是全本可读还是只抽检了 3 章。
          const detail = inspection && inspection.status !== 'checking' && inspection.status !== 'idle'
            ? [
                inspection.checkedChaptersCount ? `已复检 ${inspection.checkedChaptersCount} 章` : '',
                inspection.validChaptersCount && inspection.validChaptersCount !== inspection.checkedChaptersCount
                  ? `${inspection.validChaptersCount} 章有正文` : '',
                inspection.latestChapterTitle ? `最新：${inspection.latestChapterTitle}` : '',
              ].filter(Boolean).join(' · ')
            : ''
          const tags = [
            summary?.group?.trim() || '',
            summary && summary.hasLogin ? '已配登录' : '',
            summary && !summary.enabled ? '已停用' : '',
          ].filter(Boolean)

          return (
            <button
              type="button"
              key={key}
              className={`source-choice-item ${isSelected ? 'selected' : ''} ${isLoading ? 'loading' : ''}`}
              disabled={isLoading}
              onClick={() => onChoose(choice)}
              onContextMenu={event => openSourceMenu(event, choice, summary, onSourcesChanged)}
              title="右键可直接管理这个书源"
            >
              <div className="source-choice-top">
                <strong>{summary?.name || host}</strong>
                {badge}
              </div>
              <small>{statusText}</small>
              {detail && <small className="source-choice-detail">{detail}</small>}
              {tags.length > 0 && <small className="source-choice-tags">{tags.join(' · ')} · {host}</small>}
            </button>
          )
        })}
      </div>
    </section>
  )
}

