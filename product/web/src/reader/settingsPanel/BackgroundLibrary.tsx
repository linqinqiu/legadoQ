import { useState, useSyncExternalStore } from 'react'
import {
  getWallpaperSnapshot,
  subscribeWallpaper,
  updateWallpaperSettings,
} from '../../lib/wallpaper'
import {
  backgroundLabel,
  newBackgroundId,
  parseBgColor,
  parseBgImage,
  type ReaderBackground,
  type ReaderSettings,
} from '../readerSettings'

/**
 * 阅读背景预设库：把「颜色 + 图片地址 + 压暗」存成一条，之后一键套用。
 *
 * 和皮肤库一样，增删改全部即时写回 ReaderSettings（App 的 effect 负责落 localStorage），
 * 没有单独的"保存设置"按钮 —— 外观调整必须是所见即所得。
 *
 * 同时提供「跟随整站壁纸」开关：壁纸层在 `html[data-wallpaper-reader]` 下会让阅读区透明，
 * 这个开关就是那个属性的唯一用户入口（值存在壁纸设置里，不在 ReaderSettings 里）。
 */
export function BackgroundLibrary({
  settings,
  onChange,
}: {
  settings: ReaderSettings
  onChange: (next: ReaderSettings) => void
}) {
  const { settings: wallpaper } = useSyncExternalStore(
    subscribeWallpaper,
    getWallpaperSnapshot,
    getWallpaperSnapshot,
  )
  const library = settings.customBackgrounds ?? []
  const [name, setName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  /** 进入编辑前的外观快照：取消编辑要真的退回原样，而不只是收起输入框。 */
  const [editOrigin, setEditOrigin] = useState<Pick<ReaderSettings, 'readerBgColor' | 'readerBgImage' | 'readerBgDim'> | null>(null)
  const [message, setMessage] = useState('')

  const patch = (value: Partial<ReaderSettings>) => onChange({ ...settings, ...value })

  /** 颜色、图片、压暗共同决定观感，三者都相等才算「使用中」。 */
  const isApplied = (background: ReaderBackground) => background.color === settings.readerBgColor
    && background.image === settings.readerBgImage
    && background.dim === settings.readerBgDim

  const apply = (background: ReaderBackground) => {
    if (editingId && editingId !== background.id) {
      setEditingId(null)
      setEditOrigin(null)
      setName('')
    }
    patch({
      readerBgColor: background.color,
      readerBgImage: background.image,
      readerBgDim: background.dim,
    })
    setMessage(`已套用「${backgroundLabel(background)}」`)
  }

  const edit = (background: ReaderBackground) => {
    if (!editingId) {
      setEditOrigin({
        readerBgColor: settings.readerBgColor,
        readerBgImage: settings.readerBgImage,
        readerBgDim: settings.readerBgDim,
      })
    }
    apply(background)
    setEditingId(background.id)
    setName(background.name)
    setMessage('调整上方颜色、图片与压暗后，点击「更新这套」。')
  }

  const save = () => {
    const color = parseBgColor(settings.readerBgColor)
    const image = parseBgImage(settings.readerBgImage)
    if (!color && !image) {
      setMessage('请先设置背景颜色，或填写有效的图片地址。')
      return
    }
    const trimmedName = name.trim().slice(0, 40)
    if (editingId) {
      const existing = library.find(item => item.id === editingId)
      if (!existing) {
        setEditingId(null)
        setMessage('该预设已不在库中，请重新保存为背景。')
        return
      }
      const next = library.map(item => item.id === editingId
        ? { ...item, name: trimmedName || item.name, color, image, dim: settings.readerBgDim }
        : item)
      patch({ customBackgrounds: next })
      setMessage(`已更新「${trimmedName || backgroundLabel(existing)}」`)
      setEditingId(null)
      setEditOrigin(null)
      setName('')
      return
    }
    const background: ReaderBackground = {
      id: newBackgroundId(library),
      name: trimmedName,
      color,
      image,
      dim: settings.readerBgDim,
    }
    patch({ customBackgrounds: [...library, background] })
    setMessage(`已存为「${backgroundLabel(background)}」`)
    setName('')
  }

  const remove = (background: ReaderBackground) => {
    const next = library.filter(item => item.id !== background.id)
    patch({ customBackgrounds: next })
    if (editingId === background.id) {
      setEditingId(null)
      setEditOrigin(null)
      setName('')
    }
    setMessage(`已删除「${backgroundLabel(background)}」`)
  }

  const cancelEdit = () => {
    // 编辑期间是「边调边看」的，取消就该退回进入编辑前的样子；只收起输入框会留下半套改动。
    if (editOrigin) patch(editOrigin)
    setEditingId(null)
    setEditOrigin(null)
    setName('')
    setMessage('')
  }

  const toggleWallpaper = () => {
    updateWallpaperSettings({ readerFollow: !wallpaper.readerFollow })
  }

  return (
    <>
      <div className="bg-library-head">
        <span className="bg-library-title">我的背景</span>
        <span className="bg-library-count">{library.length} 套</span>
      </div>

      {library.length === 0 ? (
        <p className="bg-library-empty">暂无背景预设。设置颜色或图片后，命名并保存。</p>
      ) : (
        <ul className="bg-library">
          {library.map(background => {
            const applied = isApplied(background)
            return (
              <li key={background.id} className={`bg-library-row ${applied ? 'active' : ''}`}>
                <span
                  className="bg-library-swatch"
                  style={background.image
                    ? {
                        backgroundImage: `url("${background.image}")`,
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                        backgroundColor: background.color || 'transparent',
                      }
                    : { background: background.color || 'transparent' }}
                  aria-hidden="true"
                />
                <div className="bg-library-main">
                  <span className="bg-library-name">{backgroundLabel(background)}</span>
                  <span className="bg-library-meta">
                    {background.image ? '图片' : `纯色${background.color ? ` ${background.color}` : ''}`}
                    {' · '}压暗 {Math.round(background.dim * 100)}%
                  </span>
                </div>
                <div className="bg-library-actions">
                  {applied
                    ? <span className="customize-saved">使用中</span>
                    : <button type="button" className="subtle-button" onClick={() => apply(background)}>套用</button>}
                  <button type="button" className="subtle-button" onClick={() => edit(background)}>编辑</button>
                  <button type="button" className="subtle-button is-danger" onClick={() => remove(background)}>删除</button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <div className="bg-library-save">
        <input
          type="text"
          className="reader-text-input"
          value={name}
          maxLength={40}
          placeholder={editingId ? '背景名称' : '背景名称（可选）'}
          onChange={event => setName(event.target.value)}
          aria-label="背景预设名称"
        />
        <button type="button" className="primary-button" onClick={save}>
          {editingId ? '更新这套' : '存为背景'}
        </button>
        {editingId && <button type="button" className="subtle-button" onClick={cancelEdit}>取消编辑</button>}
      </div>
      {!!message && <p className="bg-library-note" role="status">{message}</p>}

      <div className="bg-wallpaper-row">
        <div className="bg-wallpaper-main">
          <strong>跟随整站壁纸</strong>
          <small>
            {wallpaper.enabled
              ? '开启后阅读区透明，上方颜色与背景图不再显示。'
              : '整站壁纸未启用；开启后可在这里跟随。'}
          </small>
        </div>
        <button
          type="button"
          className="subtle-button"
          aria-pressed={wallpaper.readerFollow}
          onClick={toggleWallpaper}
        >
          {wallpaper.readerFollow ? '已跟随' : '不跟随'}
        </button>
      </div>
    </>
  )
}
