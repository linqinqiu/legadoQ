import { Icon } from '../../icons'
import { stepFontSize } from '../fontSizeControl'
import { defaultReaderSettings, type ReaderSettings } from '../readerSettings'
import { SettingChoices, SettingGroup, SettingRange } from './SettingRow'

/**
 * 「排版」标签页：字体 / 字号 / 间距 / 缩进 / 边距 / 版心 / 分栏 / 对齐。
 * 从原 ReaderSettingsControls 单列拆来（P1 三标签页），值口径不变 —— 只换摆放。
 */
export function TypographyTab({ settings, onChange }: { settings: ReaderSettings; onChange: (next: ReaderSettings) => void }) {
  const update = (value: Partial<ReaderSettings>) => onChange({ ...settings, ...value })
  return <>
    <SettingGroup title="字体" hint="填本机已装字体的名字（多个用逗号隔开，先找到的先用）；字体文件需要自己装进系统。">
      <label className="font-select"><select value={settings.font} onChange={event => update({ font: event.target.value as ReaderSettings['font'] })}><option value="song">思源宋体</option><option value="hei">黑体 / 苹方</option><option value="kai">华文楷体</option><option value="fangsong">华文仿宋</option><option value="yuan">圆体</option><option value="mono">等宽字体</option><option value="system">系统字体</option><option value="custom">自定义字体名…</option></select><Icon name="chevronDown" /></label>
      {settings.font === 'custom' && <input type="text" className="reader-text-input" value={settings.customFont} placeholder="本机已装字体，如：霞鹜文楷 / LXGW WenKai" onChange={event => update({ customFont: event.target.value })} />}
    </SettingGroup>
    <SettingGroup title="字号与间距">
      {/* 字号口径走 fontSizeControl.ts：设置步进器 / 快捷键 / Ctrl+滚轮三处共用。 */}
      <div className="font-stepper"><span>字号</span><button aria-label="减小字号" onClick={() => update({ fontSize: stepFontSize(settings.fontSize, -1) })}>−</button><output>{settings.fontSize}</output><button aria-label="增大字号" onClick={() => update({ fontSize: stepFontSize(settings.fontSize, 1) })}>+</button></div>
      <SettingRange label="字间距" value={settings.letterSpacing} min={-.25} max={1.5} step={.05} display={settings.letterSpacing.toFixed(2)} onChange={letterSpacing => update({ letterSpacing })} />
      <SettingRange label="行间距" value={settings.lineHeight} min={1.45} max={2.4} step={.05} display={settings.lineHeight.toFixed(2)} onChange={lineHeight => update({ lineHeight })} />
      <SettingRange label="段间距" value={settings.paragraphSpacing} min={.7} max={2} step={.05} display={settings.paragraphSpacing.toFixed(2)} onChange={paragraphSpacing => update({ paragraphSpacing })} />
    </SettingGroup>
    <SettingGroup title="段落与版心">
      {/* 首行缩进按"字"给三档，不给滑杆：1.3em 这种中间值在中文排版里没有对应惯例，只会显得没对齐。 */}
      <SettingChoices label="首行缩进" value={settings.textIndent} options={[{ value: 0, label: '不缩进' }, { value: 1, label: '1 字' }, { value: 2, label: '2 字' }]} onChange={textIndent => update({ textIndent })} />
      <SettingRange label="左右边距" value={settings.contentPadding} min={20} max={120} step={2} display={`${settings.contentPadding}`} onChange={contentPadding => update({ contentPadding })} />
      <SettingRange label="版心宽度" value={settings.maxWidth} min={560} max={1400} step={20} display={`${settings.maxWidth}px`} onChange={maxWidth => update({ maxWidth })} />
      <SettingChoices label="正文对齐" value={settings.textAlign} options={[{ value: 'justify', label: '两端对齐' }, { value: 'left', label: '左对齐' }]} onChange={textAlign => update({ textAlign })} />
      <SettingChoices label="分栏排版" value={settings.columnMode} options={[{ value: 'auto', label: '自适应' }, { value: 'single', label: '单栏' }, { value: 'double', label: '双栏' }]} onChange={columnMode => update({ columnMode })} hint={settings.columnMode === 'auto' ? '宽屏 (≥800px) 自动开启双页分栏' : settings.columnMode === 'double' ? '固定双栏双页排版' : '固定单栏排版'} />
    </SettingGroup>
    <button className="reset-settings" onClick={() => onChange({ ...defaultReaderSettings, theme: settings.theme, customSkins: settings.customSkins })}>恢复默认设置</button>
  </>
}
