import { useEffect, useState } from 'react'
import { Icon } from '../../icons'
import { SkinModal } from '../../components/SkinModal'
import { availableSkins, parseBgImage, resolveTheme, type ReaderSettings } from '../readerSettings'
import { BackgroundLibrary } from './BackgroundLibrary'
import { SettingGroup, SettingRange } from './SettingRow'

/**
 * 「颜色与背景」标签页：主题网格 + 皮肤库入口 + 阅读背景。
 *
 * 皮肤与阅读背景的编辑都收在这里，阅读页内即可完成，不必先回到「设置 → 皮肤」。
 * 自定义皮肤复用同一个 `SkinModal`，没有第二套编辑器。
 */
export function ColorTab({ settings, onChange }: { settings: ReaderSettings; onChange: (next: ReaderSettings) => void }) {
  const update = (value: Partial<ReaderSettings>) => onChange({ ...settings, ...value })
  /** 皮肤库浮层：只在阅读页按需挂载，不占抽屉高度。 */
  const [showSkinEditor, setShowSkinEditor] = useState(false)
  /**
   * 背景图地址的草稿：边打字边写会把半截 URL 当成图片去加载，
   * 也会让 `url("…")` 在引号未闭合时拼坏样式。提交放在回车 / 失焦。
   */
  const [bgUrlDraft, setBgUrlDraft] = useState(settings.readerBgImage)
  const [bgError, setBgError] = useState('')

  useEffect(() => { setBgUrlDraft(settings.readerBgImage) }, [settings.readerBgImage])

  const commitBgUrl = () => {
    const raw = bgUrlDraft.trim()
    if (!raw) {
      update({ readerBgImage: '' })
      setBgError('')
      return
    }
    const image = parseBgImage(raw)
    if (!image) {
      setBgError('背景图地址仅支持 http(s)://、以 / 开头的站内路径或 data:image，且不能包含引号。')
      return
    }
    update({ readerBgImage: image })
    setBgUrlDraft(image)
    setBgError('')
  }

  const customCount = (settings.customSkins ?? []).length
  const activeTheme = resolveTheme(settings)

  return <>
    <SettingGroup title="主题" hint="预设皮肤与你自己建的皮肤并列在这里；点一下即应用，按 T 键在没被隐藏的预设皮肤间循环。">
      <div className="theme-grid">
        {availableSkins(settings).map(skin => {
          const selected = activeTheme === skin.id
          return (
            <button
              key={skin.id}
              type="button"
              className={`theme-choice ${skin.builtin ? `swatch-${skin.id}` : 'swatch-custom'} ${selected ? 'selected' : ''}`}
              onClick={() => update({ theme: skin.id })}
            >
              <i>{selected && <Icon name="check" />}</i>
              <small>{skin.name}</small>
            </button>
          )
        })}
      </div>
      <div className="theme-custom-actions">
        <button type="button" className="subtle-button" onClick={() => setShowSkinEditor(true)}>
          <Icon name="sliders" /> 管理皮肤{customCount > 0 ? `（${customCount} 套自定义）` : ''}
        </button>
        <small>预设皮肤可改名、换样式或隐藏；改动只存在这台电脑上，与「设置 → 皮肤」是同一份。</small>
      </div>
    </SettingGroup>

    <SettingGroup title="阅读背景" hint="颜色与背景图只铺在阅读区；压暗用于维持对比度，都不设时跟随主题。">
      <div className="bg-row">
        <input
          type="color"
          className="reader-bg-color"
          value={settings.readerBgColor || '#ffffff'}
          onChange={event => update({ readerBgColor: event.target.value })}
          aria-label="背景颜色"
        />
        <span className="bg-row-label">{settings.readerBgColor || '跟随主题'}</span>
        <button
          type="button"
          className="ghost-button"
          onClick={() => update({ readerBgColor: '', readerBgImage: '' })}
        >
          清除背景
        </button>
      </div>
      <input
        type="text"
        className="reader-text-input"
        value={bgUrlDraft}
        placeholder="背景图地址（http(s):// 或站内路径；可留空）"
        onChange={event => setBgUrlDraft(event.target.value)}
        onBlur={commitBgUrl}
        onKeyDown={event => { if (event.key === 'Enter') commitBgUrl() }}
      />
      {!!bgError && <p className="customize-error" role="alert">{bgError}</p>}
      <SettingRange
        label="背景压暗"
        value={settings.readerBgDim}
        min={0}
        max={0.6}
        step={0.05}
        display={`${Math.round(settings.readerBgDim * 100)}%`}
        onChange={dim => update({ readerBgDim: dim })}
      />
      <BackgroundLibrary settings={settings} onChange={onChange} />
    </SettingGroup>

    {showSkinEditor && (
      <SkinModal
        settings={settings}
        onChange={onChange}
        onClose={() => setShowSkinEditor(false)}
      />
    )}
  </>
}
