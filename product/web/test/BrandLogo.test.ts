import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * 品牌图形只有一个真源：`web/public/favicon.svg`（标签页），桌面/PWA 图标都由它派生。
 * 应用内品牌位是内联 SVG（要跟着 size 缩放、被 CSS 命中），所以几何是复制过来的 ——
 * 复制就会漂。这一条逐字比对两边的路径与配色，历史上这里漂成过
 * 「桌面绿底白书、标签页同一套、应用内却是青绿书+金色结」三种样子并存。
 */
const favicon = readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8')
const logo = readFileSync(new URL('../src/components/Logo.tsx', import.meta.url), 'utf8')

// 词边界不能省：`id="bg"` 里也含 `d="`，不加边界会把渐变 id 当成路径比进来
const paths = (text: string) => [...text.matchAll(/\bd="([^"]+)"/g)].map(m => m[1])
const stops = (text: string) => [...text.matchAll(/stop-color="([^"]+)"|stopColor="([^"]+)"/g)].map(m => m[1] ?? m[2])

test('应用内品牌位与 favicon 用同一套路径', () => {
  const fromFavicon = paths(favicon)
  const fromLogo = paths(logo)
  assert.ok(fromFavicon.length >= 3, `favicon.svg 里只抓到 ${fromFavicon.length} 条路径，测试本身失效了`)
  assert.deepEqual(fromLogo, fromFavicon, 'Logo.tsx 的路径与 favicon.svg 不一致：品牌图形又漂了')
})

test('品牌配色与圆角几何一致', () => {
  assert.deepEqual(stops(logo), stops(favicon), '渐变端点色与 favicon 不一致')
  const radius = (text: string) => /rx="(\d+)"/.exec(text)?.[1]
  assert.equal(radius(logo), radius(favicon), '圆角半径与 favicon 不一致')
  const box = (text: string) => /viewBox="([^"]+)"/.exec(text)?.[1]
  assert.equal(box(logo), box(favicon), 'viewBox 与 favicon 不一致，缩放到小尺寸会错位')
})

test('四个图标 SVG 与品牌位共用同一套图形（桌面 ≠ 标签页就是从这里漂出去的）', () => {
  const read = (name: string) => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8')
  const set = ['favicon.svg', 'pwa-192x192.svg', 'pwa-512x512.svg', 'maskable-icon-512x512.svg'].map(name => ({
    name,
    paths: paths(read(name)),
  }))
  const baseline = paths(favicon)
  for (const item of set) {
    assert.deepEqual(item.paths, baseline, `${item.name} 的路径与 favicon.svg 不一致`)
  }
  // 旧 pwa-*.svg 多一条金色书签绶带（#F0B429）并且 rx=112，桌面图标因此和标签页不是一套
  const anyGold = set.some(item => read(item.name).includes('F0B429'))
  assert.equal(anyGold, false, '图标资产里不该再有金色绶带 #F0B429')
})

test('孤儿品牌资产已清掉，不再被拷进产物', () => {
  // public/logo.svg 曾经存在但没有任何地方渲染它，只被 vite 的 includeAssets 拷进 dist
  let exists = true
  try {
    readFileSync(new URL('../public/logo.svg', import.meta.url), 'utf8')
  } catch {
    exists = false
  }
  assert.equal(exists, false, 'public/logo.svg 又回来了：它没人引用，只会让人以为品牌图形有两个版本')
  const viteConfig = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8')
  assert.ok(!viteConfig.includes("'logo.svg'"), 'vite.config.ts 仍在把 logo.svg 拷进产物')
})
