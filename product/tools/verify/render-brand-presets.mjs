/**
 * 从 vendored 的上游 MD3 矢量（docs/research/md3-icons/upstream/）渲染 9 套预设图标 PNG。
 *
 * 前置：Chrome/Edge 已装（env.mjs 的 chromePath 能找到，或设 LEGADO_CHROME 环境变量）。
 * 不在仓库里加任何 npm 依赖：解析用浏览器自带的 DOMParser，渲染用已装的 puppeteer-core。
 *
 * 为什么不用 docs/research/md3-icons/*.svg 那份旧转换产物：
 * 它把 `#00000000`（全透明填充）误读成实心黑（黑盘盖住书+笔）、丢了 `<group>` 安全区缩放、
 * 丢了 `<aapt:attr>` 渐变。本脚本直接从上游原始 XML 重新转，正确处理这三点。
 *
 * 用法：node product/tools/verify/render-brand-presets.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, launchOptions } from './env.mjs'

const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')

const UP = path.resolve(ROOT, '../docs/research/md3-icons/upstream')
const DRAW = path.join(UP, 'drawable')
const ADAP = path.join(UP, 'mipmap-anydpi-v26')
const OUT = path.resolve(ROOT, 'web/public/brand-presets')

fs.mkdirSync(OUT, { recursive: true })

// 9 套：与上游 AndroidManifest 的 9 个 activity-alias 一一对应。
// background 是 `@color/X`（解析 colors.xml）或 `@drawable/X`（矢量底图）；foreground 是矢量。
const ICONS = [
  ['ic_launcher', '@color/ic_launcher_background', 'ic_launcher_foreground'],
  ['launcherw', '@color/ic_launcher_background_w', 'ic_launcher_foreground'],
  ['launcher0', '@drawable/ic_launcher1_b', 'ic_launcher1'],
  ['launcher1', '@color/md_yellow_600', 'ic_launcher2'],
  ['launcher2', '@drawable/ic_launcher5_b', 'ic_launcher5'],
  ['launcher3', '@color/md_grey_50', 'ic_launcher3'],
  ['launcher4', '@drawable/ic_launcher4_b', 'ic_launcher4'],
  ['launcher5', '@color/md_grey_50', 'ic_launcher6'],
  ['launcher6', '@drawable/ic_launcher7_b', 'ic_launcher7'],
]

// ---- 颜色解析（@color/X → 十六进制，递归解析引用）----
const colorCache = {}
function loadColors() {
  for (const f of ['colors.xml', 'colors_material_design.xml']) {
    const txt = fs.readFileSync(path.join(UP, 'values', f), 'utf8')
    for (const m of txt.matchAll(/<color\s+name="([^"]+)"[^>]*>([^<]+)<\/color>/g)) {
      colorCache[m[1]] = m[2].trim()
    }
  }
}
function resolveColor(ref) {
  let v = colorCache[ref]
  let guard = 0
  while (v && v.startsWith('@color/') && guard++ < 8) v = colorCache[v.slice(7)]
  return v || '#000000'
}

const readXml = (p) => fs.readFileSync(p, 'utf8')

// 在浏览器里把 VectorDrawable XML 转成一个嵌套 <svg>（铺满 108×108）。
// 处理：8 位 ARGB（#00000000=透明）、<group> 变换、<aapt:attr> 内的 linear 渐变、stroke。
const convFn = (xmlText) => {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml')
  const vd = doc.documentElement
  const vw = parseFloat(vd.getAttribute('android:viewportWidth')) || 108
  const vh = parseFloat(vd.getAttribute('android:viewportHeight')) || 108
  let gid = 0
  const cssColor = (hex) => {
    const h = (hex || '').replace('#', '')
    if (h.length === 8) {
      const a = parseInt(h.slice(0, 2), 16) / 255
      const rgb = h.slice(2)
      return a === 0 ? 'none'
        : a === 1 ? `#${rgb}`
        : `rgba(${parseInt(rgb.slice(0, 2), 16)},${parseInt(rgb.slice(2, 4), 16)},${parseInt(rgb.slice(4, 6), 16)},${a.toFixed(3)})`
    }
    if (h.length === 6) return `#${h}`
    if (h.length === 4) return `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`
    return hex || 'none'
  }
  const convNode = (node) => {
    let out = ''
    for (const child of node.children) {
      const tag = child.tagName
      if (tag === 'group') {
        const sx = child.getAttribute('android:scaleX'), sy = child.getAttribute('android:scaleY')
        const tx = child.getAttribute('android:translateX'), ty = child.getAttribute('android:translateY')
        const r = child.getAttribute('android:rotate'), px = child.getAttribute('android:pivotX'), py = child.getAttribute('android:pivotY')
        const t = []
        if (tx || ty) t.push(`translate(${tx || 0} ${ty || 0})`)
        if (r) t.push(`rotate(${r} ${px || 0} ${py || 0})`)
        if (sx || sy) t.push(`scale(${sx || 1} ${sy || 1})`)
        out += `<g transform="${t.join(' ')}">${convNode(child)}</g>`
      } else if (tag === 'path') {
        const d = child.getAttribute('android:pathData')
        const fillA = child.getAttribute('android:fillColor')
        const aapt = child.getElementsByTagName('aapt:attr')[0]
        let fill = fillA ? cssColor(fillA) : 'none'
        let defs = ''
        if (aapt) {
          const grad = aapt.getElementsByTagName('gradient')[0]
          const id = 'g' + (gid++)
          const sx = grad.getAttribute('android:startX'), sy = grad.getAttribute('android:startY')
          const ex = grad.getAttribute('android:endX'), ey = grad.getAttribute('android:endY')
          let stops = ''
          for (const it of grad.getElementsByTagName('item')) {
            stops += `<stop offset="${it.getAttribute('android:offset')}" stop-color="${cssColor(it.getAttribute('android:color'))}"/>`
          }
          defs = `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}">${stops}</linearGradient>`
          fill = `url(#${id})`
        }
        const stroke = child.getAttribute('android:strokeColor')
        const sw = child.getAttribute('android:strokeWidth')
        out += `<path d="${d}" fill="${fill}"${defs ? `<defs>${defs}</defs>` : ''}${stroke ? ` stroke="${cssColor(stroke)}"` : ''}${sw ? ` stroke-width="${sw}"` : ''}/>`
      }
    }
    return out
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" x="0" y="0" width="108" height="108" viewBox="0 0 ${vw} ${vh}">${convNode(vd)}</svg>`
}

const renderSvg = async (page, svg) => {
  await page.setContent(
    `<!doctype html><html><head><style>html,body{margin:0;width:512px;height:512px;background:#fff}</style></head><body>${svg}</body></html>`,
    { waitUntil: 'load' },
  )
  return page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 512, height: 512 }, omitBackground: false })
}

const main = async () => {
  loadColors()
  const browser = await puppeteer.launch(launchOptions())
  const page = await browser.newPage()
  await page.setViewport({ width: 512, height: 512, deviceScaleFactor: 1 })

  const cache = new Map()
  const toLayer = async (ref, isDrawable) => {
    if (!isDrawable) return `<rect x="0" y="0" width="108" height="108" fill="${resolveColor(ref.slice(7))}"/>`
    const name = (ref.startsWith('@drawable/') ? ref.slice(10) : ref).replace('.xml', '')
    if (!cache.has(name)) cache.set(name, await page.evaluate(convFn, readXml(path.join(DRAW, `${name}.xml`))))
    return cache.get(name)
  }

  for (const [id, bgRef, fgRef] of ICONS) {
    const bg = await toLayer(bgRef, bgRef.startsWith('@drawable/'))
    const fg = await toLayer(fgRef, true)
    // 前景放大 1.5 倍：Android 显示 adaptive icon 时把 108dp 画布 zoom 1.5× 只取中心 72dp，
    // 等效前景占最终画布的 54/72=75%。不放大的话只有 50%，在桌面/主屏上明显偏小
    // （实测上游 legacy 位图占 65%，也印证放大是对的）。背景保持满幅不动。
    const fgZoomed = `<g transform="translate(54 54) scale(1.5) translate(-54 -54)">${fg}</g>`
    const composite = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="512" height="512">${bg}${fgZoomed}</svg>`
    const png = await renderSvg(page, composite)
    fs.writeFileSync(path.join(OUT, `${id}.png`), png)
    console.log(`  ${id}.png  ${png.length} B`)
  }

  await browser.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
