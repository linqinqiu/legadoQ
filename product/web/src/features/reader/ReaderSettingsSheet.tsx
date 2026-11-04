import React, { useState } from 'react'
import { Icon } from '../../icons'
import { IconButton } from './IconButton'
import { OtherSettingsPanel } from './OtherSettingsPanel'
import { ReaderSettingsControls } from './ReaderSettingsControls'
import { ReaderSheet } from './ReaderSheet'
import type { ReaderSettings } from './readerSettings'
import type { TocRuleOption } from '../../lib/api'

/**
 * 阅读设置的两套外形，共用同一份内容。
 *
 * - `uiV2`（MD3 外壳）：单个弹层，层内「阅读 / 其它」两标签切换（用户 2026-10「现在有两个设置处理一下」）。
 * - 旧界面：右侧抽屉，两批设置上下排列（功能不缺，只是没有标签页）。
 *
 * 从 `ReaderScreen` 抽出（0.2.15 第二步）：这一块只关心「设置值的渲染与回写」，
 * 与翻页/正文/朗读无关；唯一的自有状态是当前选中的标签页。
 */
export interface ReaderSettingsSheetProps {
  /** 是否 MD3 外壳（决定弹层还是抽屉）。 */
  uiV2: boolean
  /** 设置是否展开。 */
  open: boolean
  settings: ReaderSettings
  onSettingsChange: (next: ReaderSettings) => void
  onClose: () => void
  onOpenReplaceRules: () => void
  onEditTapZones: () => void
  /** 本地书才有：{ 书名, 目录规则 }。 */
  localBook: { name: string; tocRule: string | null } | null
  tocRuleOptions: TocRuleOption[]
  /** 本地书重解析：返回新用到的目录规则键，失败传 null。 */
  onReparseLocal?: (ruleKey: string) => Promise<string | null>
}

export function ReaderSettingsSheet({
  uiV2,
  open,
  settings,
  onSettingsChange,
  onClose,
  onOpenReplaceRules,
  onEditTapZones,
  localBook,
  tocRuleOptions,
  onReparseLocal,
}: ReaderSettingsSheetProps) {
  const [settingsTab, setSettingsTab] = useState<'reader' | 'other'>('reader')

  const panels = (
    <>
      <ReaderSettingsControls settings={settings} onChange={onSettingsChange} />
      <OtherSettingsPanel
        settings={settings}
        onChange={onSettingsChange}
        onOpenReplaceRules={onOpenReplaceRules}
        onEditTapZones={onEditTapZones}
        localBook={localBook}
        tocRuleOptions={tocRuleOptions}
        onReparseLocal={onReparseLocal}
      />
    </>
  )

  if (uiV2) {
    return (
      <ReaderSheet open={open} title="阅读设置" onClose={onClose}>
        <nav className="settings-tabs is-two" role="tablist" aria-label="设置分组">
          <button
            type="button"
            role="tab"
            aria-selected={settingsTab === 'reader'}
            className={`settings-tab${settingsTab === 'reader' ? ' selected' : ''}`}
            onClick={() => setSettingsTab('reader')}
          >
            <Icon name="columns" />
            阅读
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={settingsTab === 'other'}
            className={`settings-tab${settingsTab === 'other' ? ' selected' : ''}`}
            onClick={() => setSettingsTab('other')}
          >
            <Icon name="sliders" />
            其它
          </button>
        </nav>
        {settingsTab === 'reader' ? (
          <ReaderSettingsControls settings={settings} onChange={onSettingsChange} />
        ) : (
          <OtherSettingsPanel
            settings={settings}
            onChange={onSettingsChange}
            onOpenReplaceRules={onOpenReplaceRules}
            onEditTapZones={onEditTapZones}
            localBook={localBook}
            tocRuleOptions={tocRuleOptions}
            onReparseLocal={onReparseLocal}
          />
        )}
      </ReaderSheet>
    )
  }

  return (
    <aside
      className={`reader-drawer reader-drawer-right ${open ? 'open' : ''}`}
      aria-label="阅读设置"
    >
      <header className="drawer-header">
        <div className="drawer-title">
          <Icon name="settings" />
          <strong>阅读设置</strong>
        </div>
        <IconButton label="关闭设置" icon="close" onClick={onClose} />
      </header>
      {/* 旧界面把「界面」三标签与「设置」那批都挂在这条抽屉里，功能不缺。 */}
      {panels}
    </aside>
  )
}