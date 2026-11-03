import { useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react'
import { toast } from '../components/Toast'
import {
  clearWallpaper,
  DEFAULT_WALLPAPER_SETTINGS,
  getWallpaperSnapshot,
  saveWallpaper,
  subscribeWallpaper,
  updateWallpaperSettings,
  type WallpaperFill,
} from '../lib/wallpaper'

/** 单张壁纸的体积上限：再大就不是"壁纸"而是素材库了，IndexedDB 也不该被一张图塞满。 */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

/**
 * 壁纸浮层里的全部控件：图片、观感、界面三组，外加底部的清除。
 *
 * 全部改动即时生效、自动保存 —— 这里没有"保存"按钮：拖一下滑杆壁纸就变，
 * 松手时值已经写进 localStorage（见 `lib/wallpaper.ts` 的 `updateWallpaperSettings`）。
 *
 * 控件复用设置页已有的类名（`.settings-rows` / `.settings-row` /
 * `.setting-range` / `.page-modes`），分组沿用 `.customize-section`；
 * 只有组间距与底部清除条是壁纸浮层自己的样式。
 */
export function WallpaperSection() {
  const { settings } = useSyncExternalStore(subscribeWallpaper, getWallpaperSnapshot, getWallpaperSnapshot)
  const fileRef = useRef<HTMLInputElement>(null)
  /** 地址输入框的草稿：边打字边存会把半截 URL 当成图片地址去加载，提交放在回车 / 失焦时。 */
  const [urlDraft, setUrlDraft] = useState(settings.url)
  const [saving, setSaving] = useState(false)

  // 外部清除 / 重置后把输入框同步回真实值
  useEffect(() => { setUrlDraft(settings.url) }, [settings.url])

  const pickFile = () => fileRef.current?.click()

  const onFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // 先清掉 input 的值：同一张图再选一次也要触发 change
    event.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      toast.error('仅支持图片文件（JPG / PNG / WebP / GIF）')
      return
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error('图片超过 20 MB 上限')
      return
    }
    setSaving(true)
    try {
      await saveWallpaper(file, file.type)
      updateWallpaperSettings({ source: 'upload', enabled: true })
      toast.success('壁纸已保存到本机')
    } catch {
      // 隐私模式 / 配额满 / 没有 IndexedDB：明确告诉用户没存下，而不是静默失败
      toast.error('图片保存失败：浏览器存储不可用或空间不足')
    } finally {
      setSaving(false)
    }
  }

  const commitUrl = () => {
    const url = urlDraft.trim()
    if (!url) {
      updateWallpaperSettings({ url: '', enabled: false })
      return
    }
    if (!/^https?:\/\//i.test(url)) {
      toast.error('图片地址要以 http:// 或 https:// 开头')
      return
    }
    // 先让浏览器把图真取一次再启用：地址写错、被防盗链挡住、返回的不是图片，
    // 都在这里给出结论，而不是切过去之后只剩一块空白让人猜。
    const probe = new Image()
    probe.onload = () => updateWallpaperSettings({ url, source: 'url', enabled: true })
    probe.onerror = () => toast.error('图片加载失败：地址不可用、被防盗链拦截，或响应内容不是图片')
    probe.src = url
  }

  const toggleEnabled = () => {
    updateWallpaperSettings({ enabled: !settings.enabled })
  }

  const clear = async () => {
    // 先回到默认外观，再清二进制：即使 IndexedDB 清不掉，界面也已经没有壁纸了
    updateWallpaperSettings({ ...DEFAULT_WALLPAPER_SETTINGS })
    setUrlDraft('')
    await clearWallpaper()
  }

  const opacityPercent = Math.round(settings.opacity * 100)
  const maskPercent = Math.round(settings.mask * 100)

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={event => void onFileChange(event)}
      />

      <div className="wallpaper-groups">
        <section className="customize-section">
          <h3>图片</h3>
          <p className="customize-hint">本地上传与图片地址二选一，最后选中的生效。</p>
          <div className="settings-rows">
            <div className="settings-row">
              <div className="settings-row-main">
                <strong>启用壁纸</strong>
                <small>在整站内容背后铺图片；关闭后回到主题画布。</small>
              </div>
              <button
                type="button"
                className="subtle-button"
                aria-pressed={settings.enabled}
                onClick={toggleEnabled}
              >
                {settings.enabled ? '已开启' : '已关闭'}
              </button>
            </div>

            <div className="settings-row">
              <div className="settings-row-main">
                <strong>本地图片</strong>
                <small>保存在这台电脑的浏览器里；重新选择会覆盖上一张。</small>
              </div>
              <button type="button" className="subtle-button" onClick={pickFile} disabled={saving}>
                {saving ? '正在保存…' : '选择图片'}
              </button>
            </div>

            <div className="settings-row">
              <div className="settings-row-main">
                <strong>图片地址</strong>
                <small>http(s) 地址，按回车或离开输入框后生效。</small>
                <input
                  className="settings-search"
                  type="url"
                  inputMode="url"
                  placeholder="https://example.com/wallpaper.jpg"
                  value={urlDraft}
                  onChange={event => setUrlDraft(event.target.value)}
                  onBlur={commitUrl}
                  onKeyDown={event => { if (event.key === 'Enter') commitUrl() }}
                />
              </div>
            </div>
          </div>
        </section>

        <section className="customize-section">
          <h3>观感</h3>
          <p className="customize-hint">不透明度管图片本身；遮罩压暗画面；模糊柔化图片。</p>
          <div className="settings-rows">
            <div className="settings-row">
              <div className="settings-row-main">
                <label className="setting-range">
                  <span>不透明度</span>
                  <output>{opacityPercent}%</output>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={opacityPercent}
                    onChange={event => updateWallpaperSettings({ opacity: Number(event.target.value) / 100 })}
                  />
                </label>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-main">
                <label className="setting-range">
                  <span>遮罩</span>
                  <output>{maskPercent}%</output>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={maskPercent}
                    onChange={event => updateWallpaperSettings({ mask: Number(event.target.value) / 100 })}
                  />
                </label>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-main">
                <label className="setting-range">
                  <span>模糊</span>
                  <output>{settings.blur}px</output>
                  <input
                    type="range"
                    min={0}
                    max={60}
                    step={2}
                    value={settings.blur}
                    onChange={event => updateWallpaperSettings({ blur: Number(event.target.value) })}
                  />
                </label>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-main">
                <strong>填充方式</strong>
                <small>铺满裁剪会裁掉边缘；完整留白会露出底色。</small>
                <div className="page-modes" role="group" aria-label="填充方式">
                  {(['cover', 'contain'] as const).map(fill => (
                    <button
                      key={fill}
                      type="button"
                      className={settings.fill === fill ? 'selected' : ''}
                      aria-pressed={settings.fill === fill}
                      onClick={() => updateWallpaperSettings({ fill: fill as WallpaperFill })}
                    >
                      {fill === 'cover' ? '铺满裁剪' : '完整留白'}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="customize-section">
          <h3>界面</h3>
          <p className="customize-hint">面板与阅读区如何落在壁纸上。</p>
          <div className="settings-rows">
            <div className="settings-row">
              <div className="settings-row-main">
                <label className="setting-range">
                  <span>面板不透明度</span>
                  <output>{Math.round(settings.panelOpacity * 100)}%</output>
                  <input
                    type="range"
                    min={20}
                    max={100}
                    step={5}
                    value={Math.round(settings.panelOpacity * 100)}
                    onChange={event => updateWallpaperSettings({ panelOpacity: Number(event.target.value) / 100 })}
                  />
                </label>
                <small>面板越透明，壁纸越明显。</small>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-main">
                <label className="setting-range">
                  <span>毛玻璃模糊</span>
                  <output>{settings.glassBlur}px</output>
                  <input
                    type="range"
                    min={0}
                    max={40}
                    step={2}
                    value={settings.glassBlur}
                    onChange={event => updateWallpaperSettings({ glassBlur: Number(event.target.value) })}
                  />
                </label>
                <small>面板背后的虚化半径。</small>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-main">
                <strong>阅读区跟随壁纸</strong>
                <small>阅读区透明，直接透出这张壁纸。</small>
              </div>
              <button
                type="button"
                className="subtle-button"
                aria-pressed={settings.readerFollow}
                onClick={() => updateWallpaperSettings({ readerFollow: !settings.readerFollow })}
              >
                {settings.readerFollow ? '已开启' : '已关闭'}
              </button>
            </div>
          </div>
        </section>

        <div className="wallpaper-footer">
          <span>删除本机图片与地址，关闭壁纸。</span>
          <button type="button" className="subtle-button is-danger" onClick={() => void clear()}>清除壁纸</button>
        </div>
      </div>
    </>
  )
}
