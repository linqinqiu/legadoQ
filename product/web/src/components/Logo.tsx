import type { ImgHTMLAttributes } from 'react'

export interface LogoProps extends ImgHTMLAttributes<HTMLImageElement> {
  size?: number | string
}

/**
 * 应用品牌位。图形与 `web/public/brand-icon.png`（标签页）、以及由它光栅化出来的
 * 桌面/PWA 图标**是同一张图**。
 *
 * 这里不再内联矢量：用户 2026-10-27 把品牌图形换成了自己给的这张图，位图没法在 JSX 里
 * 复制几何，所以直接引用随包资源 —— 标签页 / 桌面 / 应用内三处只剩一个真源。
 */
export function Logo({ className = '', size = 26, ...props }: LogoProps) {
  return (
    <img
      src="/brand-icon.png"
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
