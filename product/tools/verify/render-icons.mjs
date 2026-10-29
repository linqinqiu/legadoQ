/**
 * 从 `web/public/brand-icon.png` 生成 PWA/站点图标需要的各尺寸 PNG —— 不引入 sharp/resvg。
 *
 * 单一真源是 brand-icon.png（用户 2026-10-27 换的那张图）。maskable 与 apple-touch 必须
 * 不透明满幅，所以四周留 10% 安全区、用图片底色铺满，避免被系统裁掉一圈。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, launchOptions } from './env.mjs'

const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')

const PUBLIC = path.join(ROOT, 'web/public')
const SOURCE = path.join(PUBLIC, 'brand-icon.png')
const TARGETS = [
  { out: 'pwa-192x192.png', size: 192 },
  { out: 'pwa-512x512.png', size: 512 },
  { out: 'maskable-icon-512x512.png', size: 512, inset: 0.1, opaque: true },
  // 32/48 的标签页图标放大到脸部：整张缩到 32px 时气泡与发丝糊成一团，
  // 只保留脸和眼睛反而认得出是谁（源图不变，只改取景）。
  { out: 'favicon-32.png', size: 32, zoom: 1.9 },
  { out: 'favicon-48.png', size: 48, zoom: 1.75 },
  // 下面几档是给 Windows 的 .ico 用的（make-ico.mjs）。尺寸越小越往脸上收，
  // 16px 只留眼睛与脸型，否则整个画面塌成一团深色。
  { out: 'favicon-16.png', size: 16, zoom: 2.2 },
  { out: 'favicon-24.png', size: 24, zoom: 2.05 },
  { out: 'favicon-64.png', size: 64, zoom: 1.6 },
  { out: 'favicon-128.png', size: 128, zoom: 1.25 },
  // 256 是 .ico 的上限尺寸，也是资源管理器「大图标」实际取的那一帧，
  // 必须是从源图直接渲染的 256×256 —— 以前拿 512 顶替、目录里写 0，见 make-ico.mjs。
  { out: 'favicon-256.png', size: 256 },
  // iOS 主屏图标必须是不透明满幅图，与 maskable 同一套安全区
  { out: 'apple-touch-icon.png', size: 180, inset: 0.1, opaque: true },
  { out: 'shortcut-96x96.png', size: 96 },
  // 顶栏/更新提示里的应用图标最多显示 28px。此前直接引用 512×512 的源图，
  // 每次冷启动都要为这 22px 下载 478KB —— 96px 在 3x 屏上仍然够清晰，体积只有 ~17KB。
  { out: 'brand-logo-96.png', size: 96 },
]

// 用 data URL 而不是 file://：setContent 里的 file:// 子资源不会触发 networkidle，
// 会一路等到 30s 超时（2026-10-27 实测）。
const src = `data:image/png;base64,${fs.readFileSync(SOURCE).toString('base64')}`
const browser = await puppeteer.launch(launchOptions())
const page = await browser.newPage()
for (const target of TARGETS) {
  const inset = target.inset ?? 0
  const inner = Math.round(target.size * (1 - inset * 2))
  const offset = Math.round((target.size - inner) / 2)
  const background = target.opaque ? '#d9eefb' : 'transparent'
  const zoom = target.zoom ?? 1
  const art = zoom === 1
    ? `<img src="${src}">`
    : `<div style="width:${target.size}px;height:${target.size}px;background-image:url('${src}');`
      + `background-size:${Math.round(target.size * zoom)}px ${Math.round(target.size * zoom)}px;`
      + `background-position:50% 49%;background-repeat:no-repeat"></div>`
  await page.setViewport({ width: target.size, height: target.size, deviceScaleFactor: 1 })
  await page.setContent(
    `<style>html,body{margin:0;width:${target.size}px;height:${target.size}px;background:${background}}`
      + `img{display:block;width:${inner}px;height:${inner}px;margin:${offset}px;object-fit:cover}</style>`
      + art,
    { waitUntil: 'load' },
  )
  const png = await page.screenshot({
    type: 'png',
    clip: { x: 0, y: 0, width: target.size, height: target.size },
    omitBackground: !target.opaque,
  })
  fs.writeFileSync(path.join(PUBLIC, target.out), png)
  console.log(`  ${target.out}  ${target.size}x${target.size}  ${png.length} B  ← brand-icon.png`)
}
await browser.close()
