import { useEffect, useState } from 'react'
import { Icon } from '../icons'
import { Select } from '../components/Select'
import type { TocRuleOption } from '../lib/api'
import { type ReaderSettings } from './readerSettings'
import { SCRIPT_MODE_OPTIONS } from './scriptConvert'
import { moveReaderMenu, READER_MENU_ITEMS, toggleReaderMenu } from './readerMenu'
import { mapCells } from './tapZones'
import { SettingGroup } from './settingsPanel/SettingRow'

/**
 * 「设置」底部弹层的内容（PROPOSAL-020 P4）：从原「行为」标签页拆出的**工具/其它**项 ——
 * 简繁转换 / 点击区域 / 工具栏 / 本地书目录 / 内容净化。
 * 「界面」弹层只管排版与颜色；翻页方式与动画留在「界面 · 行为」页（那是外观的一部分）。
 * 各节的值口径与文案**原样搬来**，那些口径背后都踩过坑（注释也是），动之前先读。
 */
export function OtherSettingsPanel({
  settings,
  onChange,
  onOpenReplaceRules,
  onEditTapZones,
  localBook,
  tocRuleOptions,
  onReparseLocal,
}: {
  settings: ReaderSettings
  onChange: (next: ReaderSettings) => void
  onOpenReplaceRules?: () => void
  onEditTapZones?: () => void
  localBook?: { name: string; tocRule?: string | null } | null
  tocRuleOptions?: TocRuleOption[]
  onReparseLocal?: (ruleKey: string) => Promise<string | null>
}) {
  const update = (value: Partial<ReaderSettings>) => onChange({ ...settings, ...value })
  const [reparseBusy, setReparseBusy] = useState(false)
  const [reparseMessage, setReparseMessage] = useState('')
  /** 「这本换成哪条重切」的暂选，只影响这一本（见 BehaviorTab 原注释）。 */
  const [repick, setRepick] = useState<string | null>(null)
  const repickRule = repick ?? (localBook?.tocRule || 'auto')
  useEffect(() => { setRepick(null) }, [localBook?.name])
  const ruleLabelOf = (key?: string | null) =>
    tocRuleOptions?.find(option => option.key === (key || 'auto'))?.label ?? (key || '自动选择（按正文打分）')
  const runReparse = async () => {
    if (!onReparseLocal || reparseBusy) return
    setReparseBusy(true)
    setReparseMessage('')
    const failure = await onReparseLocal(repickRule).catch((error: unknown) => error instanceof Error ? error.message : '重切失败')
    setReparseMessage(failure ?? '')
    setReparseBusy(false)
  }
  return <>
    {/* 简繁转换：只换字形不换词（A–F 的 C 项）。 */}
    <SettingGroup title="简繁转换">
      <div className="page-modes">
        {SCRIPT_MODE_OPTIONS.map(option => (
          <button key={option.id} type="button" className={settings.scriptMode === option.id ? 'selected' : ''} onClick={() => update({ scriptMode: option.id })}>{option.label}</button>
        ))}
      </div>
      <small className="setting-hint">{settings.scriptMode === 'off' ? '按原样显示书里的字。' : `正文、章名、目录一起转${settings.scriptMode === 's2t' ? '，繁体按台港排版习惯（因为 → 因為）' : ''}；第一次打开要取一次词表，稍等一下。`}</small>
    </SettingGroup>
    {/* 点击区域改到正文上编辑：这里只留一颗入口。 */}
    <SettingGroup
      title="点击区域"
      hint={`当前「${settings.pageMode === 'paginate' ? '平移分页' : '连续滚动'}」分 ${mapCells(settings.pageMode === 'paginate' ? settings.tapZones.paginate : settings.tapZones.scroll)} 区；进去在正文上拖横竖虚线改分区，改完立刻生效，不用重开这本书。`}
    >
      <button type="button" className="rules-setting-btn is-wide" onClick={onEditTapZones}>
        <span className="rules-setting-btn-label"><Icon name="sliders" />在正文上编辑点击区域</span>
        <Icon name="arrowRight" />
      </button>
    </SettingGroup>
    {/* 工具栏可配置：清单来自 readerMenu.ts，与顶栏渲染同源。 */}
    <SettingGroup title="工具栏">
      <div className="reader-menu-config">
        {READER_MENU_ITEMS.map(item => {
          const shown = settings.menuItems.includes(item.id)
          const index = settings.menuItems.indexOf(item.id)
          return (
            <div key={item.id} className={`reader-menu-row${shown ? '' : ' is-hidden'}`}>
              <button
                type="button"
                className="reader-menu-toggle"
                aria-pressed={shown}
                onClick={() => update({ menuItems: toggleReaderMenu(settings.menuItems, item.id) })}
              >
                <Icon name={shown ? 'check' : 'close'} />{item.label}
              </button>
              {shown && (
                <span className="reader-menu-move">
                  <button type="button" aria-label={`上移${item.label}`} disabled={index <= 0} onClick={() => update({ menuItems: moveReaderMenu(settings.menuItems, item.id, -1) })}>↑</button>
                  <button type="button" aria-label={`下移${item.label}`} disabled={index >= settings.menuItems.length - 1} onClick={() => update({ menuItems: moveReaderMenu(settings.menuItems, item.id, 1) })}>↓</button>
                </span>
              )}
            </div>
          )
        })}
      </div>
      <small className="setting-hint">右上角显示哪些按钮、按什么顺序。至少留一个。</small>
    </SettingGroup>
    {/* 这一档只管手上这一本（用户 2026-10-03）。 */}
    {!!localBook && (tocRuleOptions?.length ?? 0) > 0 && (
      <SettingGroup title="本地书目录">
        <small className="setting-hint">
          这本《{localBook.name}》现在用的是「{ruleLabelOf(localBook.tocRule)}」。
          换规则会重切目录并清掉正文缓存，读到的位置会回到第 1 章（章号整个变了，没法照原样挪过去）。
        </small>
        {!!onReparseLocal && (
          <div className="toc-repick">
            <Select
              ariaLabel="换一条规则重切这本"
              value={repickRule}
              options={tocRuleOptions!
                .filter(option => !option.broken)
                .map(option => ({
                  value: option.key,
                  label: option.enable || option.builtIn || option.key === 'auto' ? option.label : `${option.label}（不参与自动）`,
                  hint: option.example || undefined,
                }))}
              onChange={setRepick}
            />
            <button type="button" className="rules-setting-btn" disabled={reparseBusy} onClick={() => void runReparse()}>
              {reparseBusy ? '正在重切目录…' : '按这条规则重新识别目录'}
            </button>
          </div>
        )}
        {!!reparseMessage && <small className="setting-hint">{reparseMessage}</small>}
      </SettingGroup>
    )}
    {onOpenReplaceRules && (
      <SettingGroup title="内容净化">
        <button type="button" className="rules-setting-btn is-wide" onClick={onOpenReplaceRules}>
          <span className="rules-setting-btn-label"><Icon name="edit" />替换净化规则管理</span>
          <Icon name="arrowRight" />
        </button>
        <small className="setting-hint">针对当前书籍/书源过滤广告与特定字符</small>
      </SettingGroup>
    )}
  </>
}
