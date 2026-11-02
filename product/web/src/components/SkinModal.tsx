import React, { useEffect, useRef, useState } from 'react'
import { Icon } from '../icons'
import { useEscapeClose } from '../lib/useEscapeClose'
import {
  activeCustomSkin,
  availableSkins,
  parseSkinId,
  skinLabel,
  type CustomSkin,
  type ReaderSettings,
} from '../reader/readerSettings'

/**
 * 「皮肤」浮层：只负责配色与自定义皮肤库，壁纸另有 `WallpaperModal`。
 *
 * 皮肤分两层：
 * ① **内置七套** —— 点一下就换；
 * ② **自定义皮肤库** —— 新增 / 编辑 / 删除 / 切换，全存这台浏览器的 localStorage。
 *
 * 注入点见 main.tsx 的 `SkinStyle`：只把**当前启用那一套**的 CSS 挂成
 * `<style id="legado-custom-skin">`，文本走 textContent（不走 innerHTML）。
 * 自定义皮肤只挂自己的 `.theme-<id>`，未定义的颜色回落到中性基线。
 */
export function SkinModal({
  settings,
  onChange,
  onClose,
}: {
  settings: ReaderSettings
  onChange: (next: ReaderSettings) => void
  onClose: () => void
}) {
  useEscapeClose(onClose)
  const skins = availableSkins(settings)
  const library = settings.customSkins ?? []
  const active = activeCustomSkin(settings)

  /** 正在编辑哪一套；`null` = 编辑器当前是"新建"。 */
  const [editingId, setEditingId] = useState<string | null>(null)
  /** 编辑器按需展开：默认只列皮肤库，点「新建皮肤」或某一条的「编辑」才把表单放出来。 */
  const [formOpen, setFormOpen] = useState(false)
  const [formId, setFormId] = useState('')
  const [formName, setFormName] = useState('')
  const [formCss, setFormCss] = useState('')
  const [error, setError] = useState('')
  const editorRef = useRef<HTMLDivElement>(null)

  const sanitized = parseSkinId(formId)
  const cssLooksLikeRules = /(^|\})\s*[.#a-zA-Z][^{}]*\{[^{}]*\}/.test(formCss)

  const resetForm = () => {
    setEditingId(null)
    setFormId(''); setFormName(''); setFormCss(''); setError('')
  }
  const startNew = () => { resetForm(); setFormOpen(true) }
  const startEdit = (skin: CustomSkin) => {
    setEditingId(skin.id)
    setFormId(skin.id); setFormName(skin.name); setFormCss(skin.css); setError('')
    setFormOpen(true)
  }
  const closeForm = () => { resetForm(); setFormOpen(false) }

  // 列表长的时候编辑区在折叠线以下：展开后把它带到视口里，别让人以为按钮没反应。
  useEffect(() => {
    if (formOpen) editorRef.current?.scrollIntoView({ block: 'nearest' })
  }, [formOpen, editingId])

  const save = () => {
    if (!sanitized) {
      setError('皮肤 id 不能为空，且只能用字母、数字、- 和 _（它会被拼成 .theme-<id> 类名）。')
      return
    }
    if (!formCss.trim()) {
      setError('CSS 是空的：这样保存只会多一个看不出效果的皮肤选项。')
      return
    }
    if (!cssLooksLikeRules) {
      setError('看起来不是完整的规则。要写成 `.theme-' + sanitized + ' { --surface: … }` 这种带选择器的形式，不是只写变量。')
      return
    }
    const collides = library.some(skin => skin.id === sanitized && skin.id !== editingId)
    if (collides) {
      setError('id `' + sanitized + '` 已经有一套了，换个 id，或去编辑那一套。')
      return
    }
    const next: CustomSkin = {
      id: sanitized,
      name: formName.trim(),
      css: formCss,
    }
    const rest = library.filter(skin => skin.id !== editingId && skin.id !== sanitized)
    const nextLibrary = [...rest, next].sort((a, b) => a.id.localeCompare(b.id))
    // 保存即套用：让用户马上看到效果（theme 指向这一套的 id）
    onChange({ ...settings, customSkins: nextLibrary, theme: sanitized })
    closeForm()
  }

  const remove = (skin: CustomSkin) => {
    const nextLibrary = library.filter(item => item.id !== skin.id)
    // 删掉的正好是当前这套时退回晓白：别让 theme 指向一套已经不存在的皮肤。
    const theme = settings.theme === skin.id ? 'light' : settings.theme
    onChange({ ...settings, customSkins: nextLibrary, theme })
    if (editingId === skin.id) closeForm()
  }

  const apply = (id: string) => onChange({ ...settings, theme: id })

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="dialog-shell size-m skin-dialog" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="皮肤">
        <header className="dialog-head customize-header">
          <h2><Icon name="sliders" /> 皮肤</h2>
          <button type="button" className="overlay-close" onClick={onClose} aria-label="关闭"><Icon name="close" /></button>
        </header>

        <div className="customize-body">
          <section className="customize-section">
            <h3>配色</h3>
            <p className="customize-hint">点击即应用；内置七套只改配色，不改布局。</p>
            <div className="customize-skin-row" role="radiogroup" aria-label="皮肤">
              {skins.map(skin => {
                const selected = settings.theme === skin.id
                return (
                  <button
                    key={skin.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={`customize-skin ${selected ? 'selected' : ''}`}
                    onClick={() => apply(skin.id)}
                  >
                    <span className={`theme-swatch theme-swatch-${skin.builtin ? skin.id : 'custom'}`} />
                    <span className="customize-skin-name">{skin.name}</span>
                  </button>
                )
              })}
            </div>
          </section>

          <section className="customize-section customize-skin-editor">
            <div className="skin-library-head">
              <h3>自定义皮肤库</h3>
              <button type="button" className="subtle-button" onClick={startNew}>＋ 新建皮肤</button>
            </div>
            <p className="customize-hint">
              可新增、编辑、删除与切换。只存在本机浏览器 localStorage，
              <strong>不上传服务端，不进备份包</strong>。CSS 需包含
              <code>.theme-&lt;id&gt;</code> 选择器；未定义的颜色回落到中性基线。
            </p>

            {library.length === 0 ? (
              <p className="customize-note">暂无自定义皮肤。点击「新建皮肤」创建。</p>
            ) : (
              <ul className="skin-library">
                {library.map(skin => {
                  const isActive = settings.theme === skin.id
                  return (
                    <li key={skin.id} className={`skin-library-row ${isActive ? 'active' : ''}`}>
                      <div className="skin-library-main">
                        <span className="skin-library-name">{skinLabel(skin)}</span>
                        <span className="skin-library-meta">
                          <code>.theme-{skin.id}</code> · {skin.css.length} 字符
                        </span>
                      </div>
                      <div className="skin-library-actions">
                        {isActive
                          ? <span className="customize-saved">正在使用</span>
                          : <button type="button" className="subtle-button" onClick={() => apply(skin.id)}>切换</button>}
                        <button type="button" className="subtle-button" onClick={() => startEdit(skin)}>编辑</button>
                        <button type="button" className="subtle-button is-danger" onClick={() => remove(skin)}>删除</button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}

            {formOpen && (
              <div className="skin-editor" ref={editorRef}>
                <h4>{editingId ? '编辑皮肤' : '新建皮肤'}</h4>
                <label className="customize-field">
                  <span>皮肤 id（拼成 .theme-&lt;id&gt;，只留字母数字与 - _）</span>
                  <input
                    type="text"
                    value={formId}
                    maxLength={32}
                    placeholder="midnight"
                    onChange={event => setFormId(event.target.value)}
                  />
                  {formId && sanitized !== formId.trim() && (
                    <small className="customize-note">清洗后是 <code>{sanitized || '（空）'}</code></small>
                  )}
                </label>
                <label className="customize-field">
                  <span>名字（不填就用 id）</span>
                  <input
                    type="text"
                    value={formName}
                    maxLength={40}
                    placeholder="午夜"
                    onChange={event => setFormName(event.target.value)}
                  />
                </label>
                <label className="customize-field">
                  <span>CSS</span>
                  <textarea
                    className="customize-css"
                    rows={6}
                    spellCheck={false}
                    value={formCss}
                    onChange={event => setFormCss(event.target.value)}
                  />
                </label>
                <p className="customize-note">保存后立即应用。</p>
                {!!error && <p className="customize-error" role="alert">{error}</p>}
                <div className="customize-actions">
                  <button type="button" className="primary-button" onClick={save}>保存并套用</button>
                  <button type="button" className="subtle-button" onClick={closeForm}>{editingId ? '取消编辑' : '取消'}</button>
                  {!!active && (
                    <span className="customize-saved">当前已套用 <code>.theme-{active.id}</code></span>
                  )}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
