import React, { useEffect, useRef, useState } from 'react'
import { zh } from '../i18n/zh'
import { Icon } from '../icons'
import { useEscapeClose } from '../lib/useEscapeClose'
import {
  activeSkin,
  availableSkins,
  BUILTIN_SKINS,
  builtinSkinName,
  builtinSkinOverride,
  isBuiltinSkinHidden,
  isBuiltinSkinId,
  parseBuiltinSkinOverrides,
  parseCustomSkins,
  parseHiddenBuiltinSkins,
  parseSkinId,
  readBuiltinSkinCss,
  resolveTheme,
  skinLabel,
  type BuiltinSkinId,
  type CustomSkin,
  type ReaderSettings,
} from '../features/reader/readerSettings'

/**
 * 「皮肤」浮层：只管配色与皮肤，壁纸另有 `WallpaperModal`。
 *
 * 两层皮肤都可以管：
 * ① **内置七套** —— 点一下就换；可以改名、换 CSS、从列表删除，也能恢复；
 * ② **自定义皮肤库** —— 新增 / 编辑 / 删除 / 切换，全存这台浏览器的 localStorage。
 *
 * 内置皮肤的改动单独存在 `builtinSkinOverrides`，删除只是记进 `hiddenBuiltinSkins`：
 * 两者的 id 仍是自定义皮肤的保留字，否则一条同名自定义就能顶掉内置配色。
 * 注入点见 main.tsx 的 `SkinStyle`：只把**当前启用那一套**的追加 CSS 挂成
 * `<style id="legado-custom-skin">`，文本走 textContent（不走 innerHTML）。
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
  // 直接渲染 localStorage 里的原数组会把"撞内置 id / 空 CSS"的旧条目也摆出来；
  // 过一遍清洗，列表与保存时看到的才是同一套数据。
  const library = parseCustomSkins(settings.customSkins ?? [])
  const activeTheme = resolveTheme(settings)
  const active = activeSkin(settings)
  const hiddenCount = settings.hiddenBuiltinSkins?.length ?? 0
  const modifiedCount = BUILTIN_SKINS.filter(skin => {
    const override = builtinSkinOverride(settings, skin.id)
    return Boolean(override && (override.name.trim() || override.css.trim()))
  }).length

  /** 正在编辑哪一套自定义皮肤；`null` = 当前不是自定义编辑器。 */
  const [editingId, setEditingId] = useState<string | null>(null)
  /** 正在编辑哪一套内置皮肤；与 `editingId` 互斥，两个都为空才是"新建自定义"。 */
  const [editingBuiltinId, setEditingBuiltinId] = useState<BuiltinSkinId | null>(null)
  /** 编辑器按需展开：默认只列皮肤，点「新建皮肤」「编辑」才把表单放出来。 */
  const [formOpen, setFormOpen] = useState(false)
  const [formId, setFormId] = useState('')
  const [formName, setFormName] = useState('')
  const [formCss, setFormCss] = useState('')
  const [error, setError] = useState('')
  /** 管理动作（删除最后一款、恢复失败等）的错误；与编辑器错误分开放，别在编辑器收起时消失。 */
  const [libraryError, setLibraryError] = useState('')
  const editorRef = useRef<HTMLDivElement>(null)

  const sanitized = parseSkinId(formId)
  const cssLooksLikeRules = /(^|\})\s*[.#a-zA-Z][^{}]*\{[^{}]*\}/.test(formCss)
  const editingBuiltin = editingBuiltinId
    ? BUILTIN_SKINS.find(skin => skin.id === editingBuiltinId)
    : undefined
  const editingBuiltinOverride = editingBuiltinId ? builtinSkinOverride(settings, editingBuiltinId) : undefined

  const resetForm = () => {
    setEditingId(null)
    setEditingBuiltinId(null)
    setFormId(''); setFormName(''); setFormCss(''); setError('')
  }
  const startNew = () => { resetForm(); setFormOpen(true) }
  const startEdit = (skin: CustomSkin) => {
    setEditingBuiltinId(null)
    setEditingId(skin.id)
    setFormId(skin.id); setFormName(skin.name); setFormCss(skin.css); setError('')
    setFormOpen(true)
  }
  const startBuiltinEdit = (id: BuiltinSkinId) => {
    const override = builtinSkinOverride(settings, id)
    setEditingId(null)
    setEditingBuiltinId(id)
    setFormId(id)
    setFormName(builtinSkinName(settings, id))
    // 改过 CSS 就打开改后的；没改过就把样式表里的出厂规则预填进来，编辑才有起点。
    setFormCss(override?.css.trim() ? override.css : readBuiltinSkinCss(id))
    setError('')
    setLibraryError('')
    setFormOpen(true)
  }
  const closeForm = () => { resetForm(); setFormOpen(false) }

  // 列表长的时候编辑区在折叠线以下：展开后把它带到视口里，别让人以为按钮没反应。
  useEffect(() => {
    if (formOpen) editorRef.current?.scrollIntoView({ block: 'nearest' })
  }, [formOpen, editingId, editingBuiltinId])

  /** 至少要留一套看得见的皮肤：全删光后主题网格会变成空白，用户不知道该点哪。 */
  const isLastVisibleSkin = () => {
    if (availableSkins(settings).length > 1) return false
    setLibraryError('至少要保留一套皮肤。要换成别的样式，请先新建或恢复一套皮肤。')
    return true
  }

  const save = () => {
    if (editingBuiltinId) {
      const name = formName.replace(/[\r\n]+/g, ' ').trim().slice(0, 40)
      const css = formCss.slice(0, 20000)
      if (css.trim() && !cssLooksLikeRules) {
        setError('看起来不是完整的规则。要写成 `.theme-' + editingBuiltinId + ' { … }` 这种带选择器的形式，不是只写变量。')
        return
      }
      // 和样式表里的**出厂规则**比较：只把真正改过的 CSS 存成追加规则。
      // 否则点一次「编辑 → 保存」就会把整份出厂样式复制进 localStorage，
      // 之后内置配色更新就再也落不到这台机器上。
      const baseCss = readBuiltinSkinCss(editingBuiltinId)
      const storedName = name && name !== editingBuiltin?.name ? name : ''
      const storedCss = css.trim() && css.trim() !== baseCss.trim() ? css : ''
      const builtinSkinOverrides = parseBuiltinSkinOverrides({
        ...(settings.builtinSkinOverrides ?? {}),
        [editingBuiltinId]: { name: storedName, css: storedCss },
      })
      // 保存即套用：顺带把这一套从"已删除"里恢复出来，否则套用了却看不见。
      const hiddenBuiltinSkins = parseHiddenBuiltinSkins(
        (settings.hiddenBuiltinSkins ?? []).filter(item => item !== editingBuiltinId),
      )
      onChange({ ...settings, builtinSkinOverrides, hiddenBuiltinSkins, theme: editingBuiltinId })
      setLibraryError('')
      closeForm()
      return
    }

    if (!sanitized) {
      setError('皮肤 id 不能为空，且只能用字母、数字、- 和 _（它会被拼成 .theme-<id> 类名）。')
      return
    }
    if (isBuiltinSkinId(sanitized)) {
      setError(`这些名字被预设皮肤占用了（${BUILTIN_SKINS.map(item => item.id).join('、')}），新建的皮肤不能同名。要改预设皮肤，请用上面的「预设皮肤」。`)
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
    setLibraryError('')
    closeForm()
  }

  const remove = (skin: CustomSkin) => {
    // 内置 id 不进库；这一道是兜底：旧数据或手改 localStorage 也不能删掉内置皮肤。
    if (isBuiltinSkinId(skin.id)) return
    if (isLastVisibleSkin()) return
    if (!window.confirm(`删除自定义皮肤「${skinLabel(skin)}」？此操作不可恢复。`)) return
    const nextLibrary = library.filter(item => item.id !== skin.id)
    // 删掉的正好是当前这套时，按"还剩哪些"重新求一套，别让 theme 指向已经不存在的皮肤。
    const nextSettings = { ...settings, customSkins: nextLibrary }
    onChange({ ...nextSettings, theme: resolveTheme(nextSettings) })
    setLibraryError('')
    if (editingId === skin.id) closeForm()
  }

  /** 删除内置皮肤 = 从可选列表隐藏；改过的名字与 CSS 都留着，恢复时原样回来。 */
  const removeBuiltin = (id: BuiltinSkinId) => {
    if (isLastVisibleSkin()) return
    const name = builtinSkinName(settings, id)
    if (!window.confirm(`隐藏预设皮肤「${name}」？它只是从列表里收起来，你的改动还在，随时可以在「预设皮肤」里恢复。`)) return
    const hiddenBuiltinSkins = parseHiddenBuiltinSkins([...(settings.hiddenBuiltinSkins ?? []), id])
    const nextSettings = { ...settings, hiddenBuiltinSkins }
    onChange({ ...nextSettings, theme: resolveTheme(nextSettings) })
    setLibraryError('')
    if (editingBuiltinId === id) closeForm()
  }

  const restoreBuiltin = (id: BuiltinSkinId) => {
    onChange({ ...settings, hiddenBuiltinSkins: parseHiddenBuiltinSkins((settings.hiddenBuiltinSkins ?? []).filter(item => item !== id)) })
    setLibraryError('')
  }

  const resetBuiltin = (id: BuiltinSkinId) => {
    const name = builtinSkinName(settings, id)
    if (!window.confirm(`把预设皮肤「${name}」恢复成默认的名字与配色？`)) return
    const builtinSkinOverrides = { ...(settings.builtinSkinOverrides ?? {}) }
    delete builtinSkinOverrides[id]
    onChange({ ...settings, builtinSkinOverrides })
    setLibraryError('')
    if (editingBuiltinId === id) closeForm()
  }

  const restoreAllBuiltins = () => {
    if (!window.confirm('把所有预设皮肤恢复成默认的名字与配色，并让它们重新出现在列表里？你对预设皮肤做过的修改会被清除。')) return
    const nextSettings = {
      ...settings,
      builtinSkinOverrides: {},
      hiddenBuiltinSkins: [] as BuiltinSkinId[],
    }
    onChange({ ...nextSettings, theme: resolveTheme(nextSettings) })
    setLibraryError('')
    if (editingBuiltinId) closeForm()
  }

  const apply = (id: string) => {
    setLibraryError('')
    onChange({ ...settings, theme: id })
  }

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="dialog-shell size-m skin-dialog" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="皮肤">
        <header className="dialog-head customize-header">
          <h2><Icon name="sliders" /> 皮肤</h2>
          <button type="button" className="overlay-close" onClick={onClose} aria-label={zh.common.close}><Icon name="close" /></button>
        </header>

        <div className="customize-body">
          <section className="customize-section">
            <h3>配色</h3>
            <p className="customize-hint">点一下就换；要改名、换样式或隐藏，看下面。</p>
            <div className="customize-skin-row" role="radiogroup" aria-label="皮肤">
              {skins.map(skin => {
                const selected = activeTheme === skin.id
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
            {skins.length === 0 && (
              <p className="customize-note">没有可用的皮肤：预设都被隐藏了，也还没新建过。在下面恢复一套，或者新建一套。</p>
            )}
          </section>

          <section className="customize-section">
            <details className="builtin-skin-manage">
              <summary>
                <span>预设皮肤</span>
                <small>{modifiedCount > 0 || hiddenCount > 0
                  ? [modifiedCount > 0 ? `已修改 ${modifiedCount}` : '', hiddenCount > 0 ? `已隐藏 ${hiddenCount}` : ''].filter(Boolean).join(' · ')
                  : '可改名、换样式、隐藏'}</small>
              </summary>
              <p className="customize-hint">
                预设皮肤可以改名、换配色，也可以从列表里隐藏；隐藏的随时能恢复。
                这些改动只存在这台电脑的浏览器里，不会上传，也不进备份包。
              </p>
              <ul className="skin-library">
                {BUILTIN_SKINS.map(skin => {
                  const hidden = isBuiltinSkinHidden(settings, skin.id)
                  const isActive = activeTheme === skin.id
                  const override = builtinSkinOverride(settings, skin.id)
                  const modified = Boolean(override && (override.name.trim() || override.css.trim()))
                  return (
                    <li key={skin.id} className={`skin-library-row ${isActive ? 'active' : ''} ${hidden ? 'is-hidden' : ''}`}>
                      <div className="skin-library-main">
                        <span className="skin-library-name">
                          {builtinSkinName(settings, skin.id)}
                          {isActive && <span className="customize-saved">使用中</span>}
                        </span>
                        <span className="skin-library-meta">
                          <code>.theme-{skin.id}</code>
                          {' · '}{hidden ? '已隐藏' : modified ? '已修改' : '出厂'}
                          {modified && override?.name.trim() ? ` · 原名 ${skin.name}` : ''}
                        </span>
                      </div>
                      <div className="skin-library-actions">
                        {hidden && (
                          <button type="button" className="subtle-button" onClick={() => restoreBuiltin(skin.id)}>恢复</button>
                        )}
                        <button type="button" className="subtle-button" onClick={() => startBuiltinEdit(skin.id)}>编辑</button>
                        {!hidden && modified && (
                          <button type="button" className="subtle-button" onClick={() => resetBuiltin(skin.id)}>还原</button>
                        )}
                        {!hidden && (
                          <button type="button" className="subtle-button is-danger" onClick={() => removeBuiltin(skin.id)}>隐藏</button>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
              {(modifiedCount > 0 || hiddenCount > 0) && (
                <div className="skin-library-foot">
                  <button type="button" className="subtle-button" onClick={restoreAllBuiltins}>全部恢复默认</button>
                </div>
              )}
            </details>
            {!!libraryError && <p className="customize-error" role="alert">{libraryError}</p>}
          </section>

          <section className="customize-section">
            <div className="skin-library-head">
              <h3>自定义皮肤库</h3>
              <button type="button" className="subtle-button" onClick={startNew}>＋ 新建皮肤</button>
            </div>
            <p className="customize-hint">
              可以新增、编辑、删除与切换。只存在这台电脑的浏览器里，
              <strong>不会上传，也不进备份包</strong>。样式要写成
              <code>.theme-&lt;id&gt; { '{ … }' }</code> 这种带选择器的规则；没写到的颜色会用默认值补上。
            </p>

            {library.length === 0 ? (
              <p className="customize-note">暂无自定义皮肤。点击「新建皮肤」创建。</p>
            ) : (
              <ul className="skin-library">
                {library.map(skin => {
                  const isActive = activeTheme === skin.id
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
          </section>

          {formOpen && (
            <div className="skin-editor" ref={editorRef}>
                <h4>{editingBuiltinId ? `编辑预设皮肤「${editingBuiltin?.name ?? editingBuiltinId}」` : editingId ? '编辑皮肤' : '新建皮肤'}</h4>
                <label className="customize-field">
                  <span>{editingBuiltinId
                    ? '皮肤 id（预设皮肤的 id 不可改）'
                    : '皮肤 id（拼成 .theme-<id>，只留字母数字与 - _）'}</span>
                  {editingBuiltinId ? (
                    <input type="text" value={formId} readOnly aria-readonly="true" />
                  ) : (
                    <input
                      type="text"
                      value={formId}
                      maxLength={32}
                      placeholder="midnight"
                      onChange={event => setFormId(event.target.value)}
                    />
                  )}
                  {!editingBuiltinId && formId && sanitized !== formId.trim() && (
                    <small className="customize-note">清洗后是 <code>{sanitized || '（空）'}</code></small>
                  )}
                </label>
                <label className="customize-field">
                  <span>名字（不填就用{editingBuiltinId ? '出厂名字' : 'id'}）</span>
                  <input
                    type="text"
                    value={formName}
                    maxLength={40}
                    placeholder={editingBuiltin?.name ?? '午夜'}
                    onChange={event => setFormName(event.target.value)}
                  />
                </label>
                <label className="customize-field">
                  <span>CSS</span>
                  <textarea
                    className="customize-css"
                    rows={6}
                    maxLength={20000}
                    spellCheck={false}
                    value={formCss}
                    onChange={event => setFormCss(event.target.value)}
                  />
                </label>
                <p className="customize-note">{editingBuiltinId
                  ? '留空 = 用这套皮肤的默认配色；保存后立刻套用。'
                  : '保存后立即应用。'}</p>
                {!!error && <p className="customize-error" role="alert">{error}</p>}
                <div className="customize-actions">
                  <button type="button" className="primary-button" onClick={save}>保存并套用</button>
                  <button type="button" className="subtle-button" onClick={closeForm}>{editingId || editingBuiltinId ? '取消编辑' : '取消'}</button>
                  {editingBuiltinId && (
                    <button type="button" className="subtle-button" onClick={() => setFormCss(readBuiltinSkinCss(editingBuiltinId))}>
                      填入默认配色
                    </button>
                  )}
                  {editingBuiltinId && editingBuiltinOverride && (
                    <button type="button" className="subtle-button is-danger" onClick={() => resetBuiltin(editingBuiltinId)}>
                      恢复默认
                    </button>
                  )}
                  {!!active && (
                    <span className="customize-saved">当前已套用 <code>.theme-{active.id}</code></span>
                  )}
                </div>
              </div>
            )}
        </div>
      </div>
    </div>
  )
}
