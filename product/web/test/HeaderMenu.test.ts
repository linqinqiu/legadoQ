import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import { AppHeader, APP_THEMES } from '../src/components/AppHeader'
import type { Page } from '../src/lib/nav'
import { Logo } from '../src/components/Logo'
import { defaultReaderSettings, ReaderSettings } from '../src/reader/readerSettings'

test('HeaderMenu - APP_THEMES configuration', () => {
  // 皮肤单一来源是 BUILTIN_SKINS（readerSettings.ts）；这里钉清单与名单一致。
  const themeIds = APP_THEMES.map(t => t.id)
  assert.deepEqual(themeIds, ['light', 'paper', 'dark', 'qingzhu', 'mulan', 'meigui', 'shimo'])
  
  const themeNames = APP_THEMES.map(t => t.name)
  assert.deepEqual(themeNames, ['晓白', '护眼', '夜读', '青竹', '暮蓝', '玫瑰', '石墨'])
})

test('HeaderMenu - AppHeader static rendering', () => {
  const settings: ReaderSettings = { ...defaultReaderSettings, theme: 'paper' }
  let navigatedTo: Page | null = null
  let nextSettings: ReaderSettings | null = null

  const element = React.createElement(AppHeader, {
    page: 'library',
    settings,
    onSettingsChange: (next) => { nextSettings = next },
    onNavigate: (p) => { navigatedTo = p },
  })

  const html = renderToStaticMarkup(element)

  // Verify brand title and icon
  assert.ok(html.includes('legadoQ'), 'Header should contain brand title')
  assert.ok(html.includes('app-brand'), 'Header should have app-brand class')
  
  // 一级导航（用户 2026-10-08 定框架，2026-10-09 把「书源」放回顶栏）：书库·书架·书源·发现·订阅·设置。
  // 替换净化规则 / 备份 收进「设置」页，不再占顶栏。
  assert.ok(html.includes('书库'), 'Header should contain 书库 tab')
  assert.ok(html.includes('书架'), 'Header should contain 书架 tab')
  assert.ok(html.includes('书源'), 'Header should contain 书源 tab')
  assert.ok(html.includes('发现'), 'Header should contain 发现 tab')
  assert.ok(html.includes('订阅'), 'Header should contain 订阅 tab')
  assert.ok(html.includes('设置'), 'Header should contain 设置 tab')
  assert.ok(html.includes('我的'), 'Header should contain 我的 menu label')

  // Verify hamburger menu button
  assert.ok(html.includes('header-menu-btn'), 'Header should contain hamburger menu button')
})

// 原先这里挂着两条"看起来在测组件、其实只在自己手里绕圈"的用例：
//   'Theme change handling' 自己定义一个回调、自己调用、再断言"我刚赋的值等于我赋的那个"；
//   'Logout confirmation safety' 自己写一个 confirmLogout 再断言它调了 onLogout。
// 两条都不碰 AppHeader，也因此都不可能失败；后者测的还是**已经删掉的鉴权**。
// 主题那条的真覆盖在 CustomizeSkin.test.ts（themeClassNames 叠加、皮肤库清洗）与
// tools/verify/portal-theme-check.mjs（三套皮肤 × portal 面，带摘掉 <html> 主题类的反向对照）；
// "鉴权已删"这条由下面那个静态渲染用例钉（不许再出现「已登录」）。

test('Logo - 品牌位与桌面/标签页图标是同一张图', () => {
  const element = React.createElement(Logo, { size: 28 })
  const html = renderToStaticMarkup(element)
  assert.ok(html.includes('app-brand-logo'), 'Logo should have app-brand-logo class')
  // 用户 2026-10-27 把品牌图形换成了自己给的图：品牌位直接引用随包位图，
  // 不再内联「绿底白书」。品牌位最大只显示 28px，所以引用 96px 派生图而不是 512px 源图
  // （源图仍是图标唯一真源，见 BrandLogo.test.ts）。这里钉住"引用的就是那张图 + size 照传"。
  assert.ok(html.includes('src="/brand-logo-96.png"'), 'Logo 应引用随包的 96px 派生图')
  assert.ok(!html.includes('#2E8B63'), '旧的绿底矢量不该再出现在品牌位里')
  assert.ok(html.includes('width="28"'), 'Logo should respect size prop')
})



/**
 * #65 版本号：界面显示的版本只有一个来源 —— 服务端 /healthz 报上来的 Implementation-Version。
 * 前端**不许**自己写死一个 semver，否则改了 gradle 版本还会显示旧的（这类假一致最难查）。
 */
test('HeaderMenu - 版本号来自 /healthz，前端不写死', () => {
  const settings: ReaderSettings = { ...defaultReaderSettings }
  const html = renderToStaticMarkup(React.createElement(AppHeader, {
    page: 'library', settings, onSettingsChange: () => undefined, onNavigate: () => undefined, version: '0.2.0',
  }))
  // 浮层是点开才挂载的，静态渲染只能验到闭合态；这里验的是"没有登录那套谎话残留"。
  assert.ok(!html.includes('已登录'), '认证删掉之后不许再出现"已登录"这种谎话')

  // 版本号的显示契约落在源码里：唯一的值是 /healthz 报上来的那个，取不到时如实说"未取到"。
  const header = fs.readFileSync(path.resolve(import.meta.dirname, '../src/components/AppHeader.tsx'), 'utf8')
  assert.match(header, /version\?:\s*string/, 'AppHeader 必须把版本号做成 prop（值由外层从 /healthz 取）')
  assert.match(header, /\{version \|\| '未取到'\}/, '没取到版本号时要显示"未取到"，不能空着让人以为版本未知是正常')
  assert.match(header, /className="menu-version"/, '版本号要有自己的位置，跟状态位一起摆在菜单头部')

  const app = fs.readFileSync(path.resolve(import.meta.dirname, '../src/main.tsx'), 'utf8')
  // 探活那条带 signal（超时用），所以不要求紧跟右括号。
  assert.match(app, /fetch\('\/healthz'/, "版本号必须从 /healthz 取")
  assert.match(app, /version=\{serverVersion\}/, '取到的版本号要真的传给 AppHeader，不能只 fetch 不用')
})

test('前端源码里没有任何写死的版本号', () => {
  const dir = path.resolve(import.meta.dirname, '../src')
  const offenders = fs.readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter(name => /\.(ts|tsx)$/.test(name))
    .map(name => [name, fs.readFileSync(path.join(dir, name), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')] as const)
    .filter(([, code]) => /['"`]\d+\.\d+\.\d+['"`]/.test(code))
    .map(([name]) => name)
  assert.deepEqual(offenders, [], `这些前端文件里出现了字面量版本号，版本只能来自 /healthz：${offenders.join('、')}`)
})
