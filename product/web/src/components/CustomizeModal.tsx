import React, { useState } from 'react'
import { Icon } from '../icons'
import { useEscapeClose } from '../lib/useEscapeClose'
import { WallpaperSection } from '../settings/WallpaperSection'
import {
  activeCustomSkin,
  availableSkins,
  BUILTIN_SKINS,
  DEFAULT_SKIN_BASE,
  DEFAULT_SKIN_MODE,
  parseSkinBase,
  parseSkinId,
  parseSkinMode,
  skinLabel,
  type CustomSkin,
  type ReaderSettings,
  type SkinMode,
} from '../reader/readerSettings'

/**
 * 「自定义」这一栏（用户 2026-10-01：「咱们这个是开源允许自定义」）。
 *
 * 皮肤分两层：
 * ① **内置七套** —— 点一下就换；
 * ② **自定义皮肤库** —— 用户 2026-10-11：「所有的自定义是可以自己定义保存……可以自定义许多个，
 *    并有记录保存」。库里每一套都能**新增 / 编辑 / 删除 / 切换**，全存这台浏览器的 localStorage。
 *
 * 注入点见 main.tsx 的 `SkinStyle`：只把**当前启用那一套**的 CSS 挂成
 * `<style id="legado-custom-skin">`，文本走 textContent（不走 innerHTML —— 见那条判据）。
 *
 * 这里原来还有一档「界面布局（顶栏 / 侧栏）」，随界面框架 v2 一起撤掉了；
 * 本地书分章规则也搬走了（用户 2026-10-03：「『自定义』弹窗成了杂物间」）—— 它现在长在书架的导入动作旁边。
 */
export function CustomizeModal({
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
  const [formId, setFormId] = useState('')
  const [formName, setFormName] = useState('')
  const [formCss, setFormCss] = useState('')
  const [formBase, setFormBase] = useState<string>(DEFAULT_SKIN_BASE)
  const [formMode, setFormMode] = useState<SkinMode>(DEFAULT_SKIN_MODE)
  const [error, setError] = useState('')

  const sanitized = parseSkinId(formId)
  const cssLooksLikeRules = /(^|\})\s*[.#a-zA-Z][^{}]*\{[^{}]*\}/.test(formCss)

  const startNew = () => {
    setEditingId(null)
    setFormId(''); setFormName(''); setFormCss(''); setFormBase(DEFAULT_SKIN_BASE); setFormMode(DEFAULT_SKIN_MODE); setError('')
  }
  const startEdit = (skin: CustomSkin) => {
    setEditingId(skin.id)
    setFormId(skin.id); setFormName(skin.name); setFormCss(skin.css); setFormBase(skin.base); setFormMode(skin.mode ?? DEFAULT_SKIN_MODE); setError('')
  }

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
      base: parseSkinBase(formBase),
      mode: parseSkinMode(formMode),
    }
    const rest = library.filter(skin => skin.id !== editingId && skin.id !== sanitized)
    const nextLibrary = [...rest, next].sort((a, b) => a.id.localeCompare(b.id))
    // 保存即套用：让用户马上看到效果（theme 指向这一套的 id）
    onChange({ ...settings, customSkins: nextLibrary, theme: sanitized })
    setError('')
    startNew()
  }

  const remove = (skin: CustomSkin) => {
    const nextLibrary = library.filter(item => item.id !== skin.id)
    // 删掉的正好是当前这套时，退回它叠着的那一档内置皮肤，别把界面留在"没有基类"的状态
    const theme = settings.theme === skin.id ? parseSkinBase(skin.base) : settings.theme
    onChange({ ...settings, customSkins: nextLibrary, theme })
    if (editingId === skin.id) startNew()
  }

  const apply = (id: string) => onChange({ ...settings, theme: id })

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="dialog-shell size-l customize-dialog" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="自定义">
        <header className="dialog-head customize-header">
          <h2><Icon name="sliders" /> 自定义</h2>
          <button type="button" className="overlay-close" onClick={onClose} aria-label="关闭"><Icon name="close" /></button>
        </header>

        <div className="customize-body">
          <div className="customize-columns">
            <div className="customize-col">
          <section className="customize-section">
            <h3>皮肤</h3>
            <p className="customize-hint">
              皮肤改的是配色与标题栏，不改布局；下面皮肤库里存过的自定义皮肤也会出现在这里，点一下就换。
            </p>
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
              存过多少套就有多少条，可**新增 / 编辑 / 删除 / 切换**。全部只存在这台浏览器的 localStorage，
              <strong>不上传服务端、也不进备份包</strong>。CSS 要自己写完整选择器，例如
              <code>.theme-midnight &#123; --canvas: #0f1213; --surface: #171c1e; &#125;</code>。
            </p>

            {library.length === 0 ? (
              <p className="customize-note">还没有自定义皮肤。点「＋ 新建皮肤」加一套。</p>
            ) : (
              <ul className="skin-library">
                {library.map(skin => {
                  const isActive = settings.theme === skin.id
                  const baseName = BUILTIN_SKINS.find(base => base.id === skin.base)?.name ?? skin.base
                  return (
                    <li key={skin.id} className={`skin-library-row ${isActive ? 'active' : ''}`}>
                      <div className="skin-library-main">
                        <span className="skin-library-name">{skinLabel(skin)}</span>
                        <span className="skin-library-meta">
                          <code>.theme-{skin.id}</code> · {skin.mode === 'standalone' ? '全权自定义' : `叠在 ${baseName} 上`} · {skin.css.length} 字符
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

            <div className="skin-editor">
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
                <span>名字（皮肤列表里显示；不填就用 id）</span>
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
                  placeholder={'.theme-midnight {\n  --canvas: #0f1213;\n  --surface: #171c1e;\n  --ink: #e8ece7;\n}'}
                  onChange={event => setFormCss(event.target.value)}
                />
              </label>
              {/*
                两种语义（用户 2026-10-23：「自定义不是叠在哪一套之上，是全权自定义」）：
                - 全权自定义：只挂自己这一个类，没写到的变量落到 styles.css 里 `:root`
                  那份与皮肤无关的中性颜色基线 —— 不会跟着换肤漂移。
                - 叠在某一档之上：历史语义，没写到的变量沿用那一档预设（老数据缺省仍是它，
                  这样既有皮肤的外观一个像素都不变）。
              */}
              <div className="customize-field">
                <span>没写到的变量怎么补</span>
                <div className="customize-base-row" role="radiogroup" aria-label="自定义皮肤的取值方式">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={formMode === 'standalone'}
                    className={`customize-base ${formMode === 'standalone' ? 'selected' : ''}`}
                    onClick={() => setFormMode('standalone')}
                  >
                    <span>全权自定义</span>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={formMode === 'overlay'}
                    className={`customize-base ${formMode === 'overlay' ? 'selected' : ''}`}
                    onClick={() => setFormMode('overlay')}
                  >
                    <span>叠在某一档之上</span>
                  </button>
                </div>
                <small className="customize-note">
                  {formMode === 'standalone'
                    ? '只用自己的 CSS；没写的变量走一份与皮肤无关的中性基线，不跟随任何预设配色。'
                    : '沿用所选那一档预设里没写到的变量；切换内置皮肤时，这一套的观感会跟着变。'}
                </small>
              </div>
              {formMode === 'overlay' && (
              <div className="customize-field">
                <span>叠在哪一套之上（没写到的变量沿用那一套）</span>
                <div className="customize-base-row" role="radiogroup" aria-label="自定义皮肤的基础皮肤">
                  {BUILTIN_SKINS.map(base => (
                    <button
                      key={base.id}
                      type="button"
                      role="radio"
                      aria-checked={formBase === base.id}
                      className={`customize-base ${formBase === base.id ? 'selected' : ''}`}
                      onClick={() => setFormBase(base.id)}
                    >
                      <span className={`theme-swatch theme-swatch-${base.id}`} />
                      <span>{base.name}</span>
                    </button>
                  ))}
                </div>
              </div>
              )}
              {!!error && <p className="customize-error" role="alert">{error}</p>}
              <div className="customize-actions">
                <button type="button" className="primary-button" onClick={save}>保存并套用</button>
                {editingId && <button type="button" className="subtle-button" onClick={startNew}>取消编辑</button>}
                {!!active && (
                  <span className="customize-saved">当前已套用 <code>.theme-{active.id}</code></span>
                )}
              </div>
            </div>
          </section>
          </div>
          <div className="customize-col">
            {/* 壁纸与皮肤同一处改，但分左右两栏：左边调外观（皮肤/皮肤库），右边调背景图。 */}
            <section className="customize-section customize-wallpaper">
              <h3>壁纸</h3>
              <p className="customize-hint">
                整站背景图：从这台电脑选一张、或填图片地址，再调不透明度与模糊。只存在这台浏览器，不进备份包。
              </p>
              <WallpaperSection />
            </section>
          </div>
        </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 这里改的东西要立刻看得见效果，不留"改了但没生效"的中间态：
 * `SkinStyle`（main.tsx）把**当前启用那一套**的 CSS 挂成 `<style id="legado-custom-skin">`，
 * `<html>` 与外壳同时带 `theme-<基档> theme-<id>` 两个类（叠加的理由见 `themeClassNames`）。
 * 本组件只负责写 settings。
 */
