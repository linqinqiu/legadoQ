import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { getWallpaperSnapshot, loadWallpaper, subscribeWallpaper } from '../lib/wallpaper'

/**
 * 壁纸层挂载时写在自己身上的 CSS 变量。
 *
 * 动态值（不透明度 / 模糊 / 填充 / 放大）走变量、静态几何（铺满、层级、不拦截点击）
 * 走 styles.css 的 `.wallpaper-layer` / `.wallpaper-image` / `.wallpaper-mask` 规则 ——
 * 这样拖动滑杆只改几个变量，不必让 React 重算整层样式表。
 */
type WallpaperLayerStyle = CSSProperties & {
  '--wallpaper-opacity': string
  '--wallpaper-blur': string
  '--wallpaper-scale': string
  '--wallpaper-fill': string
}

/**
 * 当前皮肤是不是暗色档。
 *
 * 不能只看 `theme-dark`：石墨（`theme-shimo`）也是暗底；自定义皮肤则可能只在自己的 CSS 里
 * 写了 `color-scheme: dark`。所以先认内置暗色类，再读根节点算出来的 `color-scheme` 兜底。
 *
 * @returns 暗色主题返回 true
 */
export function isDarkWallpaperTheme(): boolean {
  if (typeof document === 'undefined') return false
  const root = document.documentElement
  if (root.classList.contains('theme-dark') || root.classList.contains('theme-shimo')) return true
  return getComputedStyle(root).getPropertyValue('color-scheme').includes('dark')
}

/**
 * 全局壁纸层：固定铺满视口、位于所有内容之下的图片 + 可读性纱帘。
 *
 * 只做三件事：
 * ① `enabled` 且有图时渲染（本地图从 IndexedDB 读成 objectURL，地址图直接用 URL）；
 * ② 遮罩随主题明暗切换（浅色白纱、深色黑纱），浓度来自设置；
 * ③ 把 `data-wallpaper="on"` 挂到 `<html>`，让 styles.css 把画布底色让出来（否则壁纸被 `--canvas` 盖住）。
 *
 * 整层 `pointer-events: none`，不拦截任何点击；它只画，不参与交互。
 */
export function WallpaperLayer() {
  const { settings, imageVersion } = useSyncExternalStore(
    subscribeWallpaper,
    getWallpaperSnapshot,
    getWallpaperSnapshot,
  )
  /** 本地上传图的 objectURL；地址图不用它。 */
  const [uploadUrl, setUploadUrl] = useState<string | null>(null)
  const [dark, setDark] = useState(isDarkWallpaperTheme)

  // 主题类挂在 <html> 上（见 main.tsx）：切皮肤时只换类名，这里跟着重算纱帘颜色。
  useEffect(() => {
    const root = document.documentElement
    const update = () => setDark(isDarkWallpaperTheme())
    update()
    const observer = new MutationObserver(update)
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  // 本地上传图：设置变化或换图（imageVersion）时重读 IndexedDB，并回收上一次的 objectURL。
  useEffect(() => {
    if (!settings.enabled || settings.source !== 'upload') {
      setUploadUrl(null)
      return
    }
    let cancelled = false
    let created: string | null = null
    setUploadUrl(null)
    void loadWallpaper().then(record => {
      if (cancelled || !record) return
      const url = URL.createObjectURL(record.blob)
      created = url
      setUploadUrl(url)
    }).catch(() => {
      // IndexedDB 不可用 / 记录损坏：当作没有图，背景回落画布色
      if (!cancelled) setUploadUrl(null)
    })
    return () => {
      cancelled = true
      if (created) URL.revokeObjectURL(created)
    }
  }, [settings.enabled, settings.source, imageVersion])

  const imageUrl = settings.source === 'url' ? settings.url.trim() : uploadUrl
  const visible = settings.enabled && Boolean(imageUrl)

  // 壁纸真的画出来时才把画布底色让出来，并把「面板不透明度 / 毛玻璃模糊」写成全局变量：
  // 顶栏、卡片、设置分区这些浮在壁纸上的表面统一读这两个值，拖动滑杆即时生效。
  useEffect(() => {
    const root = document.documentElement
    if (visible) {
      root.setAttribute('data-wallpaper', 'on')
      root.style.setProperty('--wallpaper-panel-opacity', String(settings.panelOpacity))
      root.style.setProperty('--wallpaper-glass-blur', `${settings.glassBlur}px`)
    } else {
      root.removeAttribute('data-wallpaper')
    }
    return () => root.removeAttribute('data-wallpaper')
  }, [visible, settings.panelOpacity, settings.glassBlur])

  if (!visible || !imageUrl) return null

  const layerStyle: WallpaperLayerStyle = {
    // 只画不点：不拦截任何交互（样式表里也有同一条，这里内联是硬约束的兜底）
    pointerEvents: 'none',
    // 模糊会把图片边缘削薄，按半径放大一点点盖住白边（与参考实现同一系数）
    '--wallpaper-opacity': String(settings.opacity),
    '--wallpaper-blur': `${settings.blur}px`,
    '--wallpaper-scale': (1 + settings.blur * 0.006).toFixed(4),
    '--wallpaper-fill': settings.fill,
  }
  const maskColor = dark
    ? `rgba(0, 0, 0, ${settings.mask})`
    : `rgba(255, 255, 255, ${settings.mask})`

  return (
    <>
      <div className="wallpaper-layer" aria-hidden="true" style={layerStyle}>
        <img className="wallpaper-image" src={imageUrl} alt="" draggable={false} />
      </div>
      <div
        className="wallpaper-mask"
        aria-hidden="true"
        style={{ pointerEvents: 'none', background: maskColor }}
      />
    </>
  )
}
