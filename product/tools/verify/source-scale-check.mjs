// 5,574 个书源这一规模下，各界面不许被撑坏（用户 2026-09-30：「书源过多影响界面不能正常展示」）。
//
// 判据全部是量出来的，不是肉眼看的：
// ① 页面级：任何一档屏宽都不许出现横向滚动（documentElement 溢出 = 有东西没收缩）；
// ② 元素级：找出"内容比自己的盒子宽、又没被 ellipsis 放过"的节点 —— 那就是文字被裁掉或撑破列；
// ③ 容器级：子元素溢出父容器右边界的，按容器归类报出来；
// ④ 规模级：一次挂载的节点数上限（书源侧栏分页、下拉封顶 200、分组 chip 折叠都要生效）；
// ⑤ 具体控件：分组筛选条、书源行、换源列表各自的宽度/换行行为。
//
// 只读：不改启用位、不写书架。
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, SHOTS, BASE, launchOptions } from './env.mjs'

const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')

const results = []
const check = (name, condition, detail = '') => results.push({ name, ok: !!condition, detail })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const VIEWS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 834, height: 1000 },
  { name: 'phone', width: 390, height: 844 },
]
const PAGES = [
  { hash: '#library', label: '书库' },
  { hash: '#shelf', label: '书架' },
  { hash: '#explore', label: '发现' },
  { hash: '#sources', label: '书源' },
  { hash: '#subscriptions', label: '订阅' },
  { hash: '#rules', label: '规则' },
  { hash: '#backup', label: '备份' },
]

/** 页面内量测：横向溢出 + 被裁文字 + 子元素溢出父容器。 */
const SCAN = () => {
  const styleOf = node => getComputedStyle(node)
  const ellipsised = node => {
    const s = styleOf(node)
    return s.textOverflow === 'ellipsis' && (s.overflow !== 'visible' || s.display.includes('flex'))
  }
  const clipped = node => {
    const s = styleOf(node)
    return s.overflow === 'hidden' || s.overflowX === 'hidden' || s.overflow === 'clip' || s.overflowX === 'clip'
  }
  const offenders = []
  const all = [...document.querySelectorAll('body *')]
  for (const node of all) {
    if (!node.offsetParent && styleOf(node).position !== 'fixed') continue
    const rect = node.getBoundingClientRect()
    if (rect.width < 8 || rect.height < 4) continue
    // 只关心"有直接文字"的节点，容器溢出由子节点自己报
    const hasOwnText = [...node.childNodes].some(child => child.nodeType === 3 && child.textContent.trim().length > 0)
    if (!hasOwnText) continue
    if (node.scrollWidth > node.clientWidth + 2 && !ellipsised(node) && !clipped(node) && !node.isContentEditable) {
      offenders.push({ kind: '文字被裁', selector: node.tagName.toLowerCase() + (node.className ? '.' + String(node.className).split(/\s+/)[0] : ''), text: node.textContent.trim().slice(0, 28), scrollW: node.scrollWidth, clientW: node.clientWidth })
    }
  }
  const spillover = []
  for (const node of all) {
    if (!node.offsetParent && styleOf(node).position !== 'fixed') continue
    const parent = node.parentElement
    if (!parent || parent === document.body) continue
    const childRect = node.getBoundingClientRect()
    const parentRect = parent.getBoundingClientRect()
    if (childRect.width < 4) continue
    if (childRect.right > parentRect.right + 2 && !clipped(parent) && styleOf(parent).display !== 'flex') {
      spillover.push({ kind: '撑破父容器', selector: `${parent.tagName.toLowerCase()}.${String(parent.className).split(/\s+/)[0] || ''} > ${node.tagName.toLowerCase()}`, over: Math.round(childRect.right - parentRect.right) })
    }
  }
  return {
    docOverflowX: document.documentElement.scrollWidth - window.innerWidth,
    bodyOverflowX: document.body.scrollWidth - window.innerWidth,
    nodes: all.length,
    offenders: offenders.slice(0, 12),
    offenderCount: offenders.length,
    spillover: spillover.slice(0, 12),
    spilloverCount: spillover.length,
  }
}

const browser = await puppeteer.launch(launchOptions())
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error.message)))
  // 相对地址要在真的页面里发：about:blank 上 fetch('/api/sources') 直接 TypeError。
  await page.goto(`${BASE}/#library`, { waitUntil: 'domcontentloaded' })
  await sleep(1500)

  const scale = await page.evaluate(async () => {
    const list = await (await fetch('/api/sources')).json()
    const groups = new Set()
    for (const source of list) {
      for (const tag of String(source.group ?? '').split(/[,，、\s]+/)) if (tag.trim()) groups.add(tag.trim())
    }
    return { total: list.length, enabled: list.filter(item => item.enabled).length, distinctGroups: groups.size, longestName: list.reduce((best, item) => (item.name.length > (best?.name.length ?? 0) ? item : best), null)?.name ?? '' }
  })
  check('本机书源规模足以构成压力测试（<1000 时这一条门禁没有意义）', scale.total >= 1000, `共 ${scale.total}，启用 ${scale.enabled}，标签去重后 ${scale.distinctGroups} 组，最长名「${scale.longestName}」`)

  for (const view of VIEWS) {
    for (const target of PAGES) {
      await page.setViewport({ width: view.width, height: view.height, deviceScaleFactor: 1 })
      await page.goto(`${BASE}/${target.hash}`, { waitUntil: 'domcontentloaded' })
      await sleep(view.name === 'phone' ? 3000 : 2500)
      const scan = await page.evaluate(SCAN)
      const label = `${target.label} @ ${view.name}(${view.width})`
      check(`${label} 页面无横向滚动`, scan.docOverflowX <= 1 && scan.bodyOverflowX <= 1, `溢出 ${scan.docOverflowX}px，挂载 ${scan.nodes} 节点`)
      check(`${label} 没有被裁掉又没省略号提示的文字`, scan.offenderCount === 0, scan.offenders.map(item => `${item.selector}「${item.text}」${item.scrollW}>${item.clientW}`).join(' ; ').slice(0, 220))
      check(`${label} 没有子元素撑破父容器`, scan.spilloverCount === 0, scan.spillover.map(item => `${item.selector} 超出 ${item.over}px`).join(' ; ').slice(0, 220))
      if (view.name === 'desktop' && target.hash === '#sources') {
        // 整库 5,574 条要过一次 `api.sources('')` 才拿得到，固定 sleep 会量到"还没渲染"的 0 行
        let rowsMounted = 0
        for (let tick = 0; tick < 20 && rowsMounted === 0; tick++) {
          await sleep(1000)
          rowsMounted = await page.evaluate(() => document.querySelectorAll('.source-list-item').length)
        }
        await page.evaluate(() => document.querySelector('.source-group-select .ui-select-trigger')?.click())
        await sleep(700)
        const groupMenu = await page.evaluate(() => ({
          chips: document.querySelectorAll('.ui-select-option').length,
          cap: document.querySelector('.ui-select-more')?.textContent?.trim() ?? '',
        }))
        await page.keyboard.press('Escape')
        await sleep(200)
        check('书源侧栏按页挂载（不是整库 5,574 行全渲染）',
          rowsMounted > 0 && rowsMounted <= 260, `${rowsMounted} 行`)
        check('分组下拉是站内控件且有渲染封顶', groupMenu.chips > 0 && groupMenu.chips <= 200,
          `${groupMenu.chips} 项${groupMenu.cap ? ` · ${groupMenu.cap}` : ''}`)
      }
    }
  }

  // 详情弹窗换源列表的量测放在 `book-detail-check.mjs`：那里能稳定拿到多源结果
  // （发现页首屏出不出卡片取决于第一个源有没有 bookList 规则，用它做判据会假红）。

  check('全程没有页面 JS 异常', errors.length === 0, errors.slice(0, 2).join(' / '))
} finally {
  await browser.close()
}

let pass = 0
let fail = 0
let skips = 0
for (const item of results) {
  if (item.ok === true) pass++
  else if (item.ok === false) { fail++; console.log(`  FAIL ${item.name}  — ${item.detail}`) }
  else { skips++; console.log(`  NOTE ${item.name}  — ${item.detail}`) }
}
console.log(`\nsource-scale-check: PASS ${pass} / FAIL ${fail} / NOTE ${skips}`)
process.exit(fail > 0 ? 1 : 0)
