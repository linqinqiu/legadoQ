import { useState } from 'react'
import { Icon } from '../icons'
import type { ReaderSettings } from './readerSettings'
import { TypographyTab } from './settingsPanel/TypographyTab'
import { ColorTab } from './settingsPanel/ColorTab'
import { BehaviorTab } from './settingsPanel/BehaviorTab'

/**
 * 阅读设置面板的内容 —— **三标签页容器**（P1，仿 legado「界面」面板的信息架构）。
 *
 * PROPOSAL-020 P3 起它渲染在 MD3 底部弹层（「界面」）里；旧界面仍挂在右侧抽屉。
 * 三页组织不变：
 *   - TypographyTab  字体、字号与间距、段落与版心、分栏、对齐
 *   - ColorTab       主题网格（内置七套 + customSkins 一处渲染）、阅读背景
 *   - BehaviorTab    翻页方式与动画
 * 「工具/其它」那批（简繁、点击区域、工具栏、本地书目录、净化）在 P4 拆去了「设置」弹层
 * （`reader/OtherSettingsPanel.tsx`）。所有改动仍走 `onChange` 即时生效；本组件只管「现在显示哪一页」。
 */
const TABS = [
  { id: 'typography', label: '排版', icon: 'columns' },
  { id: 'color', label: '颜色', icon: 'eye' },
  { id: 'behavior', label: '行为', icon: 'sliders' },
] as const

type TabId = (typeof TABS)[number]['id']

export function ReaderSettingsControls({
  settings,
  onChange,
}: {
  settings: ReaderSettings
  onChange: (next: ReaderSettings) => void
}) {
  const [tab, setTab] = useState<TabId>('typography')
  return <div className="drawer-scroll-content settings-panel">
    <nav className="settings-tabs" role="tablist" aria-label="阅读设置分组">
      {TABS.map(entry => (
        <button
          key={entry.id}
          type="button"
          role="tab"
          aria-selected={tab === entry.id}
          className={`settings-tab${tab === entry.id ? ' selected' : ''}`}
          onClick={() => setTab(entry.id)}
        >
          <Icon name={entry.icon} />{entry.label}
        </button>
      ))}
    </nav>
    <div className="settings-tab-body" role="tabpanel">
      {tab === 'typography' && <TypographyTab settings={settings} onChange={onChange} />}
      {tab === 'color' && <ColorTab settings={settings} onChange={onChange} />}
      {tab === 'behavior' && <BehaviorTab settings={settings} onChange={onChange} />}
    </div>
  </div>
}
