import { Icon } from '../../icons'
import { availableSkins, type ReaderSettings } from '../readerSettings'
import { SettingGroup, SettingRange } from './SettingRow'

/**
 * 「颜色与背景」标签页：主题网格 + 阅读背景。
 *
 * 主题网格一处渲染**内置七套 + customSkins 库**（P1 统一：原来内置在抽屉、自定义在
 * CustomizeModal 两处分裂，这里把它们放进同一张网格，启用哪套 = 点哪块）。
 * 自定义皮肤本体的创建/编辑仍在「我的 → 自定义皮肤」（CustomizeModal），这里只管选用。
 */
export function ColorTab({ settings, onChange }: { settings: ReaderSettings; onChange: (next: ReaderSettings) => void }) {
  const update = (value: Partial<ReaderSettings>) => onChange({ ...settings, ...value })
  return <>
    <SettingGroup title="主题" hint="自定义皮肤在「我的 → 自定义皮肤」里创建/编辑；这里点哪块用哪套。内置七套按 T 键循环。">
      <div className="theme-grid">
        {availableSkins(settings).map(skin => (
          <button
            key={skin.id}
            type="button"
            className={`theme-choice ${skin.builtin ? `swatch-${skin.id}` : 'swatch-custom'} ${settings.theme === skin.id ? 'selected' : ''}`}
            onClick={() => update({ theme: skin.id })}
          >
            <i>{settings.theme === skin.id && <Icon name="check" />}</i>
            <small>{skin.name}</small>
          </button>
        ))}
      </div>
    </SettingGroup>
    <SettingGroup title="阅读背景" hint="颜色与背景图铺在阅读区上，压暗让文字保持可读；全部清空则跟随主题。背景图只存在这台浏览器里。">
      <div className="bg-row">
        <input type="color" className="reader-bg-color" value={settings.readerBgColor || '#ffffff'} onChange={event => update({ readerBgColor: event.target.value })} aria-label="背景颜色" />
        <button type="button" className="ghost-button" onClick={() => update({ readerBgColor: '', readerBgImage: '' })}>清除背景</button>
      </div>
      <input type="text" className="reader-text-input" value={settings.readerBgImage} placeholder="背景图 URL（http(s):// 或站内路径，可留空）" onChange={event => update({ readerBgImage: event.target.value })} />
      <SettingRange label="背景压暗" value={settings.readerBgDim} min={0} max={0.6} step={0.05} display={`${Math.round(settings.readerBgDim * 100)}%`} onChange={dim => update({ readerBgDim: dim })} />
    </SettingGroup>
  </>
}
