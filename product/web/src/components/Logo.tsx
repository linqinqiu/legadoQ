import React, { type SVGProps } from 'react'

export interface LogoProps extends SVGProps<SVGSVGElement> {
  size?: number | string
}

/**
 * 应用品牌位。图形与 `web/public/favicon.svg`（标签页）以及由它派生的
 * 桌面/PWA 图标**完全同一套几何**：绿底圆角方 + 白色翻开书。
 *
 * 之前这里是另一套（青绿书 + 金色无穷结），于是"桌面一个样、标签页一个样、
 * 应用内又一个样"。路径重复是有意的：内联 SVG 才能跟着 `size` 缩放并被 CSS 命中，
 * 漂移由 `web/test/BrandLogo.test.ts` 逐条比对 `favicon.svg` 的 `d=` 拦下。
 */
export function Logo({ className = '', size = 26, ...props }: LogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      width={size}
      height={size}
      className={`app-brand-logo ${className}`}
      aria-hidden="true"
      {...props}
    >
      <defs>
        <linearGradient id="appBrandLogoBg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2E8B63" />
          <stop offset="1" stopColor="#17573F" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="104" fill="url(#appBrandLogoBg)" />
      <g transform="translate(26 26) scale(0.9)">
        <path d="M256 156C220 130 160 124 120 132 112 134 108 138 108 146L108 356C108 366 114 372 124 370 162 362 220 366 256 390Z" fill="#FFFFFF" />
        <path d="M256 156C292 130 352 124 392 132 400 134 404 138 404 146L404 356C404 366 398 372 388 370 350 362 292 366 256 390Z" fill="#FFFFFF" />
        <path d="M256 156L256 390" stroke="#1B6A4B" strokeWidth="18" strokeLinecap="round" />
      </g>
    </svg>
  )
}
