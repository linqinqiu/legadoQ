import { useEffect, useState } from 'react'
import { Icon } from '../../icons'
import { stepFontSize } from '../fontSizeControl'
import { defaultReaderSettings, type ReaderSettings } from '../readerSettings'
import {
  fontNameFromFile,
  fontNameFromUrl,
  listFonts,
  removeFont,
  saveFont,
  uniqueFontName,
  type FontInfo,
} from '../../lib/fontLibrary'
import { SettingChoices, SettingGroup, SettingRange } from './SettingRow'

/** 列表里的字节数：超过 1MB 按 MB 显示，否则按 KB。 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes > 0) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return '未知大小'
}

/**
 * 「排版」标签页：字体 / 字号 / 间距 / 缩进 / 边距 / 版心 / 分栏 / 对齐。
 * 从原 ReaderSettingsControls 单列拆来（P1 三标签页），值口径不变 —— 只换摆放。
 */
export function TypographyTab({ settings, onChange }: { settings: ReaderSettings; onChange: (next: ReaderSettings) => void }) {
  const update = (value: Partial<ReaderSettings>) => onChange({ ...settings, ...value })
  /** 已导入的字体列表（来自 IndexedDB，见 lib/fontLibrary）。 */
  const [fonts, setFonts] = useState<FontInfo[]>([])
  /** 「从地址导入」输入框里的字。 */
  const [fontUrl, setFontUrl] = useState('')
  /** 导入/删除进行中：按钮置灰，避免连点导进两份。 */
  const [fontBusy, setFontBusy] = useState(false)
  /** 导入结果或失败原因：导入是异步的，不能只在控制台里说。 */
  const [fontMessage, setFontMessage] = useState('')

  const refreshFonts = async () => setFonts(await listFonts())
  useEffect(() => { void refreshFonts() }, [])

  /** 选中列表里的一条字体：族名写进 customFont，font 固定为 custom。 */
  const applyFont = (name: string) => {
    update({ font: 'custom', customFont: name })
    setFontMessage('')
  }

  /** 本地字体文件：读二进制 → 存库并注册 → 自动启用。族名默认取文件名，重名加序号。 */
  const importFile = async (file: File) => {
    setFontBusy(true)
    setFontMessage('')
    try {
      const data = await file.arrayBuffer()
      const name = uniqueFontName(fontNameFromFile(file.name), fonts.map(font => font.name))
      await saveFont(name, data)
      await refreshFonts()
      update({ font: 'custom', customFont: name })
      setFontMessage(`已导入「${name}」`)
    } catch (error) {
      setFontMessage(`导入失败：${error instanceof Error ? error.message : '未知原因'}`)
    } finally {
      setFontBusy(false)
    }
  }

  /** 字体直链：经同源代理取回字节后注册，同样存库并自动启用。 */
  const importUrl = async () => {
    const url = fontUrl.trim()
    if (!url) {
      setFontMessage('先填字体地址（.ttf / .otf / .woff / .woff2 直链）')
      return
    }
    setFontBusy(true)
    setFontMessage('')
    try {
      const name = uniqueFontName(fontNameFromUrl(url), fonts.map(font => font.name))
      await saveFont(name, url)
      await refreshFonts()
      update({ font: 'custom', customFont: name })
      setFontUrl('')
      setFontMessage(`已导入「${name}」`)
    } catch (error) {
      setFontMessage(`导入失败：${error instanceof Error ? error.message : '未知原因'}`)
    } finally {
      setFontBusy(false)
    }
  }

  /** 删除一条字体：库里和 document.fonts 一起摘掉；删的是当前字体就把族名清空。 */
  const dropFont = async (name: string) => {
    await removeFont(name)
    await refreshFonts()
    if (settings.customFont.trim() === name) update({ customFont: '' })
    setFontMessage(`已删除「${name}」`)
  }

  return <>
    <SettingGroup title="字体" hint="可直接填本机已装字体的名字（多个用逗号隔开，先找到的先用）；也可以选本地字体文件或填字体地址导入，导入后自动启用并保存在本机。">
      <label className="font-select"><select value={settings.font} onChange={event => update({ font: event.target.value as ReaderSettings['font'] })}><option value="song">思源宋体</option><option value="hei">黑体 / 苹方</option><option value="kai">华文楷体</option><option value="fangsong">华文仿宋</option><option value="yuan">圆体</option><option value="mono">等宽字体</option><option value="system">系统字体</option><option value="custom">自定义字体名…</option></select><Icon name="chevronDown" /></label>
      {settings.font === 'custom' && <>
        <input type="text" className="reader-text-input" value={settings.customFont} placeholder="本机已装字体，如：霞鹜文楷 / LXGW WenKai" onChange={event => update({ customFont: event.target.value })} />
        {/* 导入区：本期不改 styles.css，复用设置页已有的行 / 输入框 / 按钮档，视觉与阅读设置其余控件一致。 */}
        <div className="settings-search-row">
          <label className="subtle-button">
            选择字体文件
            <input type="file" accept=".ttf,.otf,.woff,.woff2" hidden onChange={event => {
              const file = event.target.files?.[0]
              // 同一个文件再选一次也要触发 change：不清空的话第二次不会回调。
              event.target.value = ''
              if (file) void importFile(file)
            }} />
          </label>
          <input className="settings-search" type="text" value={fontUrl} placeholder="字体地址，如 https://…/font.woff2" onChange={event => setFontUrl(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void importUrl() }} />
          <button type="button" className="subtle-button" disabled={fontBusy} onClick={() => void importUrl()}>从地址导入</button>
        </div>
        {fontMessage && <p className="setting-hint" role="status">{fontMessage}</p>}
        {fonts.length > 0 && <div className="settings-rows">
          {fonts.map(font => <div className="settings-row" key={font.name}>
            <div className="settings-row-main">
              <strong>{font.name}</strong>
              <small>{font.url ? `地址：${font.url}` : `本地文件 · ${formatBytes(font.bytes)}`}</small>
            </div>
            <button type="button" className="subtle-button" onClick={() => applyFont(font.name)}>{settings.font === 'custom' && settings.customFont.trim() === font.name ? '使用中' : '使用'}</button>
            <button type="button" className="subtle-button danger-button" onClick={() => void dropFont(font.name)}>删除</button>
          </div>)}
        </div>}
      </>}
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
