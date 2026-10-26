// 浮层必须吃当前主题（用户 2026-10-01：「指定源搜索还没做好，夜读模式下你看看」）。
//
// 为什么单独一条门禁：`Select` 的下拉是 `createPortal(…, document.body)` —— 必须 portal，
// 因为书架/订阅/发现各有各的滚动容器与边框，绝对定位会被祖先裁掉。而主题变量原本只定义在
// `.theme-*` 上、`.theme-*` 只挂在 `.app-shell` 那一层，于是 portal 出来的浮层
// **一个变量都拿不到**：实测（去掉 html 上的主题类，模拟修复前）
//   --surface → 未定义 · 菜单底色 rgba(0,0,0,0)（全透明） · 选项文字 rgb(0,0,0)（纯黑）
// 浅色模式下页面底色本来就浅，只是描边发虚；夜读模式下就是"黑字压在深色页上"，
// 也就是用户看到的"没做好"。修法是主题同时挂到 `<html>`（见 main.tsx 的那个 effect），
// 这条门禁盯的是**这个不变量本身**：任何 portal 出来的东西都必须能解析到主题变量。
//
// 只读界面，不写任何数据。跑法：node tools/verify/portal-theme-check.mjs
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, OUT, SHOTS, BASE, launchOptions } from './env.mjs'

const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')

const STAMP = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)
const SETTINGS_KEY = 'legado-reader-settings-v2'
// 三套内置皮肤都要过：只测 dark 的话，下一次有人把变量挪回 .app-shell，
// 浅色"看起来还行"就会把问题再藏一轮。判据一律按**页面上解析到的主题变量**比，不写死色值。
const THEMES = ['light', 'paper', 'dark']
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const rgb = value => (String(value).match(/\d+/g) ?? []).map(Number)
/** `#202522` → `32,37,34`，好跟 computed style 的 `rgb(...)` 比。 */
const hexToRgb = hex => {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(String(hex).trim())
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)].join(',') : ''
}
/** 选项文字必须是**当前主题**的墨色或强调色之一（选中项走 --accent-ink），不能是没解析下来的纯黑。 */
const themedInk = shot => {
  const actual = rgb(shot.optionColor).join(',')
  return actual === hexToRgb(shot.inkVar) || actual === hexToRgb(shot.accentInkVar)
}

/** 打开一个下拉，量它 portal 出来的那层板子。菜单可能被外层滚动/失焦关掉，重试三次。 */
async function openAndMeasure(page, { click, menuSelector = '.ui-select-menu' }) {
  const empty = { htmlClass: '', parentIsBody: false, surfaceVar: '', inkVar: '', accentInkVar: '', menuBg: '', menuBorder: '', menuShadow: '', optionColor: '', optionIsCurrent: false }
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.keyboard.press('Escape').catch(() => null)
    await sleep(120)
    await page.evaluate(click)
    const opened = await page.waitForSelector(menuSelector, { timeout: 6000 }).then(() => true).catch(() => false)
    if (!opened) { await sleep(400); continue }
    await sleep(300)
    const measured = await page.evaluate(() => {
      const menu = document.querySelector('.ui-select-menu')
      const option = document.querySelector('.ui-select-option')
      if (!menu || !option) return null
      const html = getComputedStyle(document.documentElement)
      return {
        htmlClass: document.documentElement.className,
        parentIsBody: menu.parentElement === document.body,
        surfaceVar: (html.getPropertyValue('--surface') || '').trim(),
        inkVar: (html.getPropertyValue('--ink') || '').trim(),
        accentInkVar: (html.getPropertyValue('--accent-ink') || '').trim(),
        menuBg: getComputedStyle(menu).backgroundColor,
        menuBorder: getComputedStyle(menu).borderTopColor,
        menuShadow: getComputedStyle(menu).boxShadow,
        optionColor: getComputedStyle(option).color,
        // 首项常常就是"当前选中项"（.current 用 --accent-ink 上色），所以判据按主题变量比，
        // 不能写死一个墨色值 —— 写死的那版在书架上假红了一次。
        optionIsCurrent: option.classList.contains('current'),
      }
    })
    if (!measured) continue
    await page.screenshot({ path: path.join(SHOTS, `portal-theme-${STAMP}.png`) }).catch(() => null)
    return measured
  }
  return { ...empty }
}

let browser = null
try {
  browser = await puppeteer.launch(launchOptions())
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', error => errors.push(String(error.message)))

  for (const theme of THEMES.map(id => ({ id }))) {
    await page.goto(`${BASE}/#library`, { waitUntil: 'domcontentloaded' })
    await sleep(1500)
    await page.evaluate(({ key, id }) => {
      const base = JSON.parse(localStorage.getItem(key) || '{}')
      localStorage.setItem(key, JSON.stringify({ ...base, theme: id }))
    }, { key: SETTINGS_KEY, id: theme.id })
    await page.reload({ waitUntil: 'domcontentloaded' })
    // 刻意**不**去注销 Service Worker：注销之后应用重新注册，新 SW 接管会让页面自己重刷一次，
    // 正在跑的 evaluate 就报 "Execution context was destroyed"（第一版在这儿死了一次）。
    // 全新 profile 的第一次加载本来就没有控制中的 SW，量界面不需要动它。
    await page.waitForFunction(() => !!document.querySelector('.library-scope-modes button'), { timeout: 30000 })

    const htmlClass = await page.evaluate(() => document.documentElement.className)
    check(`主题「${theme.id}」：<html> 上确实有 theme-${theme.id}`,
      htmlClass.includes(`theme-${theme.id}`), htmlClass || '(空)')

    // ① 书库「指定书源」——用户点名的那一个
    await page.evaluate(() => {
      [...document.querySelectorAll('.library-scope-modes button')].find(n => n.textContent?.includes('指定书源'))?.click()
    })
    await page.waitForFunction(() => !!document.querySelector('.library-scope .ui-select-trigger'), { timeout: 15000 })
    const library = await openAndMeasure(page, {
      click: () => document.querySelector('.library-scope .ui-select-trigger')?.click(),
    })
    check(`主题「${theme.id}」：书库「指定书源」浮层是**不透明**的当前面板色`,
      library.parentIsBody && library.surfaceVar !== '' && rgb(library.menuBg).length === 3 && library.menuBg !== 'rgba(0, 0, 0, 0)',
      `底色 ${library.menuBg} · --surface ${library.surfaceVar || '(未定义)'} · 挂在 body=${library.parentIsBody}`)
    check(`主题「${theme.id}」：浮层里的选项文字是当前主题的墨色或强调色（不是没解析下来的纯黑）`,
      themedInk(library),
      `选项色 ${library.optionColor} · --ink ${library.inkVar} · --accent-ink ${library.accentInkVar}${library.optionIsCurrent ? ' · 首项即选中项' : ''}`)
    check(`主题「${theme.id}」：浮层有描边与投影（"板子浮在页上"这件事看得见）`,
      library.menuBorder !== 'rgb(0, 0, 0)' && library.menuShadow !== 'none',
      `描边 ${library.menuBorder} · 投影 ${library.menuShadow.slice(0, 28)}`)

    if (theme.id === 'dark') {
      // 反向对照：把 <html> 上的主题类摘掉，浮层必须**立刻失去配色**。
      // 没有这一条，上面几条可能只是恒真——变量到底是不是从 html 解析下来的，没人证明过。
      // （这正是修复前的真实形态：面板透明、文字纯黑压在深色页上，也就是用户看到的"没做好"。）
      await page.evaluate(() => document.documentElement.classList.remove('theme-dark'))
      await sleep(250)
      const unthemed = await page.evaluate(() => {
        const menu = document.querySelector('.ui-select-menu')
        return {
          bg: getComputedStyle(menu).backgroundColor,
          color: getComputedStyle(document.querySelector('.ui-select-option')).color,
        }
      })
      check('反向对照：摘掉 <html> 的主题类，浮层立刻变回"透明板 + 纯黑字"（证明上面几条是活判据）',
        unthemed.bg === 'rgba(0, 0, 0, 0)' && rgb(unthemed.color).join(',') === '0,0,0',
        `底色 ${unthemed.bg} · 选项色 ${unthemed.color}`)
      await page.evaluate(() => document.documentElement.classList.add('theme-dark'))
      await sleep(250)
    }

    // ② 书架排序 + 分组下拉（同一个 portal 机制，换个页面确认不是巧合）
    await page.goto(`${BASE}/#shelf`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!document.querySelector('.shelf-sort .ui-select-trigger'), { timeout: 30000 })
    const shelf = await openAndMeasure(page, {
      click: () => document.querySelector('.shelf-sort .ui-select-trigger')?.click(),
    })
    check(`主题「${theme.id}」：书架排序浮层同样吃到主题`,
      shelf.menuBg !== 'rgba(0, 0, 0, 0)' && themedInk(shelf),
      `底色 ${shelf.menuBg} · 选项色 ${shelf.optionColor} · --ink ${shelf.inkVar}`)

    await page.keyboard.press('Escape')
    await sleep(150)
  }

  check('全程没有页面异常', errors.length === 0, errors.slice(0, 2).join(' | '))
} catch (error) {
  check('探针自身异常', false, error.message)
} finally {
  if (browser) await browser.close().catch(() => null)
  fs.mkdirSync(OUT, { recursive: true })
  const judged = results
  const failed = judged.filter(r => !r.ok)
  fs.writeFileSync(path.join(OUT, `portal-theme-${STAMP}.json`), JSON.stringify({ stamp: STAMP, results: judged }, null, 2))
  for (const r of judged) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`)
  console.log(`\n${judged.length - failed.length}/${judged.length} 通过`)
  if (failed.length) process.exitCode = 1
  process.exit(process.exitCode || 0)
}
