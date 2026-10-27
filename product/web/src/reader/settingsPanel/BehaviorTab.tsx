import { type ReaderSettings } from '../readerSettings'
import { SettingGroup } from './SettingRow'

/**
 * 「行为」标签页：翻页方式与翻页动画。
 *
 * PROPOSAL-020 P4 把「工具/其它」那批（简繁、点击区域、工具栏、本地书目录、净化）
 * 拆去了「设置」弹层（见 `reader/OtherSettingsPanel.tsx`）—— 本页只留**翻页**这一件，
 * 它属于"外观"（怎么翻），与排版/颜色同处「界面」。
 */
export function BehaviorTab({ settings, onChange }: { settings: ReaderSettings; onChange: (next: ReaderSettings) => void }) {
  const update = (value: Partial<ReaderSettings>) => onChange({ ...settings, ...value })
  return <>
    <SettingGroup title="翻页方式">
      <div className="page-modes">
        <button className={settings.pageMode === 'scroll' ? 'selected' : ''} onClick={() => update({ pageMode: 'scroll' })}>连续滚动</button>
        <button className={settings.pageMode === 'paginate' ? 'selected' : ''} onClick={() => update({ pageMode: 'paginate' })}>平移分页</button>
      </div>
    </SettingGroup>
    {settings.pageMode === 'paginate' && (
      <SettingGroup title="翻页动画">
        <div className="page-modes">
          <button className={settings.pageAnim === 'slide' ? 'selected' : ''} onClick={() => update({ pageAnim: 'slide' })}>平移过渡</button>
          <button className={settings.pageAnim === 'cover' ? 'selected' : ''} onClick={() => update({ pageAnim: 'cover' })}>覆盖</button>
          <button className={settings.pageAnim === 'fade' ? 'selected' : ''} onClick={() => update({ pageAnim: 'fade' })}>淡化</button>
          <button className={settings.pageAnim === 'none' ? 'selected' : ''} onClick={() => update({ pageAnim: 'none' })}>无动画</button>
        </div>
      </SettingGroup>
    )}
  </>
}
