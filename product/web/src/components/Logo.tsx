import type { ImgHTMLAttributes } from 'react'

export interface LogoProps extends ImgHTMLAttributes<HTMLImageElement> {
  size?: number | string
}

/**
 * 应用品牌位。图形与 `web/public/brand-icon.png`（图标源图）、以及由它光栅化出来的
 * 桌面/PWA 图标**是同一张图**。
 *
 * 这里不再内联矢量：用户 2026-10-27 把品牌图形换成了自己给的这张图，位图没法在 JSX 里
 * 复制几何，所以直接引用随包资源 —— 标签页 / 桌面 / 应用内三处只剩一个真源。
 *
 * 但界面上最大只显示到 28px（顶栏 22、更新提示 28），不该为它下载 512×512 的源图：
 * `brand-logo-96.png` 由 `tools/verify/render-icons.mjs` 从同一张源图降采样而来，
 * 96px 在 3x 屏上仍有余量，体积从 478KB 降到 17KB。
 */
export function Logo({ className = '', size = 26, ...props }: LogoProps) {
  return (
    <img
      src="/brand-logo-96.png"
      width={size}
      height={size}
      className={`app-brand-logo ${className}`}
      alt=""
      aria-hidden="true"
      draggable={false}
      {...props}
    />
  )
}
