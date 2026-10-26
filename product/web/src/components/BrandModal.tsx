import React, { useEffect, useRef, useState } from 'react'
import { api, type BrandInfo } from '../lib/api'
import { reportBrand } from '../lib/brandStore'
import { Icon } from '../icons'
import { useEscapeClose } from '../lib/useEscapeClose'

/**
 * 「应用名称与图标」（用户 2026-10-23：「允许自定义图标和名称」）。
 *
 * 外壳走统一那一套（`.overlay-backdrop` + `.dialog-shell` + `useEscapeClose`），
 * 与 `ServerPortModal` 同形 —— 它改的也是本机安装根（`brand.json` + `brand/` 里的图标字节），
 * 与端口是同一族，所以不塞进「自定义」弹窗（那里有"不许当杂物间"的明文纪律），
 * 也不与皮肤混放：皮肤只存这台浏览器的 localStorage，而品牌对本机所有浏览器都生效。
 *
 * 生效范围要如实说清（这里最容易被误解）：
 * - 名称与主题色：manifest 那条路由带 no-cache，**刷新即生效**；
 * - 已装到桌面/主屏幕的 PWA：名称与图标由浏览器自己存一份清单，要等浏览器同步
 *   （通常重启浏览器；有的平台要卸载重装）才会变 —— 这不是这里能控制的；
 * - 桌面的 `legadoQ.exe` 文件名与快捷方式名：打包期（jpackage）就定死了，运行时改不动。
 */
/**
 * 服务端那份品牌写进前端的单一来源（`lib/brandStore`）。
 * 界面标题与顶栏品牌字都读那里 —— 此前「legadoQ」硬编码在三处（顶栏、阅读器的
 * `document.title` 两处、index.html），改名后那三处照旧，等于"改了个寂寞"。
 */
function publishBrand(info: BrandInfo): void {
  reportBrand({
    displayName: info.displayName,
    builtinName: info.builtinName,
    iconUrl: info.hasIcon ? info.iconUrl ?? null : null,
    themeColor: info.themeColor,
  })
}

export function BrandModal({ onClose }: { onClose: () => void }) {
  useEscapeClose(onClose)
  const [brand, setBrand] = useState<BrandInfo | null>(null)
  const [name, setName] = useState('')
  const [shortName, setShortName] = useState('')
  const [themeColor, setThemeColor] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    void api.brand()
      .then(info => {
        setBrand(info)
        setName(info.name)
        setShortName(info.shortName)
        setThemeColor(info.themeColor)
        // 打开这一屏就把当前品牌灌进单一来源：之前它还是默认的「legadoQ」，
        // 而顶栏与标签页要读的是同一个值。
        publishBrand(info)
      })
      .catch(() => setError('没取到当前的名称与图标'))
  }, [])

  const apply = (next: BrandInfo, note: string) => {
    setBrand(next)
    publishBrand(next)
    setMessage(note)
  }

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const next = await api.setBrand({ name, shortName, themeColor })
      apply(next, next.name ? `已改名为「${next.displayName}」，刷新页面即生效。` : '已回到内置名称。')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '没保存成功')
    } finally {
      setBusy(false)
    }
  }

  const reset = async () => {
    setBusy(true)
    setError('')
    try {
      const next = await api.resetBrand()
      setBrand(next); setName(''); setShortName(''); setThemeColor('')
      apply(next, '已恢复内置的名称与图标。')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '没恢复成')
    } finally {
      setBusy(false)
    }
  }

  const upload = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setError('')
    try {
      const next = await api.uploadBrandIcon(file)
      apply(next, '图标已换。已装到桌面的应用要等浏览器同步清单（或重装）才更新。')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '图标没存上')
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const dropIcon = async () => {
    setBusy(true)
    setError('')
    try {
      const next = await api.clearBrandIcon()
      apply(next, '已换回内置图标。')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '没换回去')
    } finally {
      setBusy(false)
    }
  }

  const customised = !!brand && (brand.name !== '' || brand.hasIcon)

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="dialog-shell size-s" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="应用名称与图标">
        <header className="dialog-head">
          <h2><Icon name="sliders" /> 应用名称与图标</h2>
          <button type="button" className="overlay-close" onClick={onClose} aria-label="关闭"><Icon name="close" /></button>
        </header>

        <div className="server-port-body">
          <p className="customize-hint">
            这台服务的名字与图标。改的是<b>本机安装根</b>下的 <code>brand.json</code>，
            所以对本机所有浏览器与装到桌面的应用都生效；界面标题与主题色刷新即生效，
            已经装到桌面的那个应用要等浏览器同步清单（必要时卸载重装）。
          </p>

          <label className="customize-field">
            <span>应用名称（留空 = 内置的「{brand?.builtinName ?? 'legadoQ'}」）</span>
            <input type="text" value={name} maxLength={40} placeholder={brand?.builtinName ?? 'legadoQ'}
              onChange={event => setName(event.target.value)} />
          </label>
          <label className="customize-field">
            <span>短名（桌面那一格空间不够时用；留空跟着名称走）</span>
            <input type="text" value={shortName} maxLength={20} placeholder={name}
              onChange={event => setShortName(event.target.value)} />
          </label>
          <label className="customize-field">
            <span>主题色（<code>#rrggbb</code>；留空用内置皮肤的）</span>
            <div className="brand-color-row">
              <input type="color" value={/^#[0-9a-f]{6}$/i.test(themeColor) ? themeColor : '#247a58'}
                onChange={event => setThemeColor(event.target.value)} aria-label="主题色" />
              <input type="text" value={themeColor} maxLength={7} placeholder="#247a58"
                onChange={event => setThemeColor(event.target.value.trim())} />
              {themeColor && <button type="button" className="subtle-button" onClick={() => setThemeColor('')}>清除</button>}
            </div>
          </label>

          <div className="brand-icon-row">
            <span>图标</span>
            {brand?.hasIcon
              ? <img className="brand-icon-preview" src={brand.iconUrl} alt="当前自定义图标" />
              : <span className="brand-icon-preview is-empty" aria-label="当前用内置图标"><Icon name="book" /></span>}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={event => void upload(event.target.files?.[0])}
            />
            {brand?.hasIcon && <button type="button" className="subtle-button" onClick={() => void dropIcon()}>换回内置</button>}
          </div>
          <p className="customize-note">
            只收 PNG / JPEG / WebP，单个不超过 5 MB —— <b>不收 SVG</b>：
            图标会被浏览器当本站资源取用，带脚本的 SVG 等于自己开一条同源执行面。
          </p>

          {!!error && <p className="customize-error" role="alert">{error}</p>}
          {!!message && <p className="customize-saved">{message}</p>}
          <div className="customize-actions">
            <button type="button" className="primary-button" onClick={() => void save()} disabled={busy}>保存</button>
            {customised && <button type="button" className="subtle-button" onClick={() => void reset()} disabled={busy}>恢复内置</button>}
          </div>
        </div>
      </div>
    </div>
  )
}
