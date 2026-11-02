import { Icon } from '../icons'
import { useEscapeClose } from '../lib/useEscapeClose'
import { WallpaperSection } from '../settings/WallpaperSection'

/**
 * 「壁纸」浮层：只管整站背景图，不再和皮肤挤在同一张弹窗里。
 *
 * 控件仍然只有 `WallpaperSection` 一份实现；这里只提供外壳、标题与一句范围说明。
 * 图片与设置都存在本机浏览器，不进备份包。
 */
export function WallpaperModal({ onClose }: { onClose: () => void }) {
  useEscapeClose(onClose)
  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="dialog-shell size-m wallpaper-dialog" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="壁纸">
        <header className="dialog-head customize-header">
          <h2><Icon name="image" /> 壁纸</h2>
          <button type="button" className="overlay-close" onClick={onClose} aria-label="关闭"><Icon name="close" /></button>
        </header>
        <div className="customize-body">
          <p className="customize-hint">整站背景图；图片与设置只存在本机浏览器，不进备份包。</p>
          <WallpaperSection />
        </div>
      </div>
    </div>
  )
}
