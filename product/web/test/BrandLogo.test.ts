import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

/**
 * 品牌图形只有一个真源：`web/public/brand-icon.png`（用户 2026-10-27 换的那张图）。
 *
 * 换图之前这里是「favicon.svg 的路径 + Logo.tsx 内联的同一套路径」，靠测试逐字比对
 * 防漂移。位图没法在 JSX 里复制几何，所以比对对象变成"三处引用的是不是同一张图"：
 * 标签页 / 桌面 / 应用内任一处置回旧图或旧 SVG，都必须在这里变红。
 */
const publicFile = (name: string) => new URL(`../public/${name}`, import.meta.url)
const logo = readFileSync(new URL('../src/components/Logo.tsx', import.meta.url), 'utf8')
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const viteConfig = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8')

test('应用内品牌位引用随包那张图，不再留旧的绿色矢量', () => {
  assert.ok(existsSync(publicFile('brand-icon.png')), 'brand-icon.png 不见了')
  assert.ok(logo.includes('src="/brand-icon.png"'), 'Logo.tsx 没引用 brand-icon.png')
  assert.ok(!logo.includes('#2E8B63'), 'Logo.tsx 还留着旧的绿底渐变：品牌图形又分叉了')
})

test('标签页与 PWA 图标都从这张图派生，没有第二套 SVG 品牌', () => {
  for (const svg of ['favicon.svg', 'pwa-192x192.svg', 'pwa-512x512.svg', 'maskable-icon-512x512.svg']) {
    assert.equal(existsSync(publicFile(svg)), false, `${svg} 还在：两套品牌图形迟早漂成两个样子`)
  }
  assert.ok(!indexHtml.includes('favicon.svg'), 'index.html 还在引 favicon.svg')
  assert.ok(
    indexHtml.includes('/favicon-32.png?v=4') && indexHtml.includes('/apple-touch-icon.png?v=4'),
    '标签页 / iOS 图标没挂上，或指纹没跟着图标一起换',
  )
  assert.ok(viteConfig.includes("icon('/pwa-192x192.png'"), 'manifest 里缺 192 PNG')
  assert.ok(viteConfig.includes("'maskable'"), 'manifest 里缺 maskable 那一条')
  assert.ok(!viteConfig.includes('.svg'), 'manifest 仍在发 SVG 图标')
})

test('各尺寸 PNG 都随包，缺一张就是某处会退回默认图标', () => {
  const pngs = [
    'pwa-192x192.png',
    'pwa-512x512.png',
    'maskable-icon-512x512.png',
    'apple-touch-icon.png',
    'favicon-32.png',
    'favicon-48.png',
    'shortcut-96x96.png',
  ]
  for (const name of pngs) assert.ok(existsSync(publicFile(name)), `${name} 缺失`)
})

test('孤儿品牌资产已清掉，不再被拷进产物', () => {
  // public/logo.svg 曾经存在但没有任何地方渲染它，只被 vite 的 includeAssets 拷进 dist
  assert.equal(existsSync(publicFile('logo.svg')), false, 'public/logo.svg 又回来了：它没人引用')
  assert.ok(!viteConfig.includes("'logo.svg'"), 'vite.config.ts 仍在把 logo.svg 拷进产物')
})
