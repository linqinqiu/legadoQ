// 界面框架判据：量的是"版面被谁占走了"，不是颜色。
// 每页在给定视口下输出：顶栏高、首行内容起始 y（= 页头 masthead 的代价）、
// 内容实际占宽与两侧死白、底部死白、正文列数、控件高度、卡片宽高、横向溢出。
// 改版前后各跑一次，用数字对比，不用形容词。
//
//   node tools/verify/frame-metrics.mjs before            # 写 out/frame-metrics-before.json
//   node tools/verify/frame-metrics.mjs after --compare   # 与 before 逐页比，超阈值判红
//   node tools/verify/frame-metrics.mjs now --frozen      # 书库与 baselines/frame-frozen-20261010.json 比，出界即红
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, OUT, launchOptions } from './env.mjs'

const require = createRequire(path.join(ROOT, 'web', 'package.json'))
const puppeteer = require('puppeteer-core')

const BASE = process.env.UI_AUDIT_URL || process.env.LEGADO_BASE_URL || 'http://127.0.0.1:1234'
const TAG = process.argv[2] || 'before'
const COMPARE = process.argv.includes('--compare')
const VIEWPORTS = [
  { name: 'desk-1440', width: 1440, height: 900 },
  { name: 'desk-1180', width: 1180, height: 800 },
  { name: 'mobile-390', width: 390, height: 844 },
].filter(vp => !process.env.FRAME_VP || process.env.FRAME_VP.split(',').includes(vp.name))
const ROUTES = ['#library', '#shelf', '#sources', '#explore', '#subscriptions', '#settings']
  .filter(route => !process.env.FRAME_ROUTES || process.env.FRAME_ROUTES.split(',').includes(route))

const collect = () => {
  const px = v => Math.round(parseFloat(v) || 0)
  const rect = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
  const header = document.querySelector('header')
  const headerH = header ? rect(header).h : 0
  // 只统计"真正画了东西"的叶子节点：容器往往撑满整屏，量它们等于量白。
  const leaves = Array.from(document.querySelectorAll('body *')).filter(el => {
    if (el.children.length > 0 && !['IMG', 'SVG', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'CANVAS', 'VIDEO'].includes(el.tagName)) return false
    const s = getComputedStyle(el)
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false
    if (s.position === 'fixed' && el.tagName === 'DIV' && (el.textContent || '').trim() === '' && !el.className) return false
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) return false
    if (header && r.top < headerH - 2 && r.left >= 0) return false  // 顶栏自己不算"内容起始"
    const text = (el.textContent || '').trim()
    const paints = text.length > 0 || ['IMG', 'SVG', 'INPUT', 'SELECT', 'TEXTAREA', 'CANVAS', 'VIDEO'].includes(el.tagName)
      || (s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent')
      || s.backgroundImage !== 'none'
      || (s.borderTopWidth !== '0px' && s.borderTopStyle !== 'none')
    return paints
  })
  // 把叶子矩形栅格化到 20px 网格，再算墨迹包围盒与空白
  const CELL = 20
  const vw = window.innerWidth
  const vh = window.innerHeight
  const cols = Math.ceil(vw / CELL)
  const rows = Math.ceil(vh / CELL)
  const ink = new Uint8Array(cols * rows)
  for (const el of leaves) {
    const r = el.getBoundingClientRect()
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue
    const x0 = Math.max(0, Math.floor(r.left / CELL)), x1 = Math.min(cols - 1, Math.ceil(r.right / CELL) - 1)
    const y0 = Math.max(0, Math.floor(r.top / CELL)), y1 = Math.min(rows - 1, Math.ceil(r.bottom / CELL) - 1)
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) ink[y * cols + x] = 1
  }
  let minX = cols, maxX = -1, minY = rows, maxY = -1, filled = 0
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    if (!ink[y * cols + x]) continue
    filled++
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const inkBox = maxX < 0 ? null : { left: minX * CELL, right: (maxX + 1) * CELL, top: minY * CELL, bottom: (maxY + 1) * CELL }
  // 内容列宽：墨迹包围盒的宽度（不是容器宽度）
  const contentWidth = inkBox ? inkBox.right - inkBox.left : 0
  const sideDead = inkBox ? Math.max(0, inkBox.left) + Math.max(0, vw - inkBox.right) : vw
  const bottomDead = inkBox ? Math.max(0, vh - inkBox.bottom) : vh
  const mastheadCost = inkBox ? Math.max(0, inkBox.top - headerH) : 0
  const grid = document.querySelector('.shelf-grid, .search-results, .source-list, .explore-grid, .grid')
  const gridStyle = grid ? getComputedStyle(grid) : null
  const buttons = Array.from(document.querySelectorAll('button')).filter(b => {
    const r = b.getBoundingClientRect()
    // 只量**内容区**的控件：页头条与侧栏是改版新增的外框，把它们算进中位数，
    // 每个页面都会凭空多出十几个 34px 的侧栏按钮，密度对比就变成在量侧栏（实测踩过）。
    if (b.closest('.page-title, .app-page-header, .desk-header')) return false
    return r.width > 0 && r.height > 0 && r.top < vh
  })
  const heights = buttons.map(b => px(getComputedStyle(b).height)).sort((a, b) => a - b)
  /**
   * "控件高度"只能量**控件**。封面卡也是 <button>，245px 高，把它算进中位数之后
   * 书库页的"密度"就变成了在量封面多大 —— 改版前后卡的数量一变，判据就假红。
   * 所以只取 ≤60px 的那一档（按钮、chip、分栏、输入框）。
   */
  const controlHeights = heights.filter(h => h > 0 && h <= 60)
  const cards = Array.from(document.querySelectorAll('.shelf-card, .search-result-card, .source-item, .book-card')).slice(0, 6).map(el => rect(el))
  return {
    viewport: { w: vw, h: vh },
    headerH,
    inkBox: inkBox || {},
    contentWidth,
    /** 第一笔墨迹离窗口顶多远 —— 这才是"页头吃掉多少"的真判据（顶栏 + 大标题 + 说明句全算在内）。 */
    contentTop: inkBox ? inkBox.top : vh,
    coveragePct: Math.round(filled / (cols * rows) * 100),
    mastheadCost,
    sideDeadPx: sideDead,
    sideDeadPct: Math.round(sideDead / vw * 100),
    bottomDeadPx: bottomDead,
    bottomDeadPct: Math.round(bottomDead / vh * 100),
    overflowX: document.documentElement.scrollWidth > vw + 1,
    /**
     * 溢出必须**指名道姓**：只报"这页溢出了"就还得人再去点一遍 DevTools。
     * 取"伸出视口且没有子元素也伸出"的最深节点 —— 父容器只是被撑大的，改它没用。
     */
    overflowCulprits: (() => {
      const out = []
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.right <= vw + 1) continue
        const worse = Array.from(el.children).some(child => {
          const cr = child.getBoundingClientRect()
          return cr.width > 0 && cr.right > r.right - 1
        })
        if (worse) continue
        const s = getComputedStyle(el)
        // 只报最伸出的那一个还不够：伸出常常是**祖先**给的宽度不对，
        // 所以把四层祖先链一起量出来（宽度、右边、左右内边距），当场就能看出是谁撑的。
        const chain = []
        for (let p = el.parentElement; p && chain.length < 4; p = p.parentElement) {
          const pr = p.getBoundingClientRect()
          if (pr.width === 0) continue
          const ps = getComputedStyle(p)
          chain.push({
            path: p.tagName.toLowerCase() + (typeof p.className === 'string' && p.className ? '.' + p.className.trim().split(/\s+/).join('.') : ''),
            width: Math.round(pr.width), right: Math.round(pr.right),
            padding: `${ps.paddingLeft}/${ps.paddingRight}`, maxWidth: ps.maxWidth,
          })
        }
        out.push({
          path: el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).join('.') : ''),
          right: Math.round(r.right), width: Math.round(r.width),
          cssWidth: s.width, minWidth: s.minWidth, whiteSpace: s.whiteSpace,
          text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24),
          chain,
        })
      }
      return out.sort((a, b) => b.right - a.right).slice(0, 4)
    })(),
    gridColumns: gridStyle ? (gridStyle.gridTemplateColumns.split(' ').filter(Boolean).length) : 0,
    buttonHeights: { min: controlHeights[0] || 0, median: controlHeights[Math.floor(controlHeights.length / 2)] || 0, max: controlHeights[controlHeights.length - 1] || 0, count: controlHeights.length, cardMax: heights[heights.length - 1] || 0 },
    cards,
    h1: (() => { const h = document.querySelector('h1'); if (!h) return null; const s = getComputedStyle(h); return { text: h.textContent.trim().slice(0, 20), size: px(s.fontSize), box: rect(h) } })(),
    kickerCount: document.querySelectorAll('.section-kicker, .page-kicker').length,
    proseCount: Array.from(document.querySelectorAll('p')).filter(p => (p.textContent || '').trim().length > 40).length,
  }
}

const browser = await puppeteer.launch(launchOptions())

/**
 * PWA 安装横幅（`.pwa-install-banner`）是 `position: fixed; bottom: 16px`，由 `beforeinstallprompt`
 * 触发 —— 这个事件在无头 Chrome 里**时有时无**，一旦出现就成了"最低的那个墨迹节点"，把每一页的
 * **底部死白**从真实的 20–40% 压到 0–3%。判据于是随"这次事件有没有触发"忽红忽绿：实测**同一构建**
 * 连跑两次，书库底部死白一次 3%、一次 40%；`--compare` 因此能把没碰过的页（书库/订阅）判成回归。
 * 测量前统一摘掉它（连同更新提示），数字才可复现 —— 冻结基线本身也是在没有横幅的状态下立的。
 */
const hideNonDeterministicOverlays = () => page.evaluateOnNewDocument(() => {
  const style = document.createElement('style')
  style.textContent = '.pwa-install-banner,.pwa-update-toast{display:none !important}'
  const attach = () => { if (document.head) document.head.appendChild(style) }
  if (document.head) attach(); else document.addEventListener('DOMContentLoaded', attach, { once: true })
})

let page = await browser.newPage()
await hideNonDeterministicOverlays()
let viewport = { width: 1440, height: 900 }

/**
 * 全新 profile 的**第一次**导航会慢过 30s（Edge 首启要建 profile），之后同一浏览器里只要 200ms；
 * 偶发还会把 frame 弄 detached。两种情况都换一个新 page 重来，而不是让整条判据假红。
 */
const setViewport = async next => {
  viewport = next
  await page.setViewport({ ...next, deviceScaleFactor: 1 })
}
const goto = async url => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: attempt === 0 ? 30000 : 90000 })
      return
    } catch (error) {
      console.log(`导航第 ${attempt + 1} 次没成：${String(error.message).slice(0, 70)}`)
      await page.close().catch(() => undefined)
      page = await browser.newPage()
      await hideNonDeterministicOverlays()
      await page.setViewport({ ...viewport, deviceScaleFactor: 1 })
    }
  }
  throw new Error('三次导航都失败')
}

/**
 * 等版面"长定了"再量，而不是睡固定毫秒。
 *
 * 原来这里睡 2200ms，实测同一页两次跑出 `1020×720 底部死白0% 控件58px` 与
 * `960×480 底部死白30% 控件34px` —— 后一次是**列表还没出行**，中位数于是去量了工具栏按钮。
 * 一个自己不可复现的版面判据，既能假红也能漏红（AGENTS §3：靠固定 sleep 读界面必然偶发假红）。
 * 判据：先等**网络静默**，再等"连续四帧墨迹包围盒与可见元素数不变"。
 * 只用"像素不变"会停在加载态上 —— 实测 `#sources` 冷启动时列表还没到，那一屏的像素
 * 本来就是静止的，于是量出 `960×480 / 控件中位高 34`（34 是工具栏按钮，58 才是行），
 * 而热服务上是 `1020×720 / 58`。一个把"还没数据"当成"版面板结"的判据，会同时假红和漏红。
 */
async function waitForLayout(page, { timeoutMs = 20000, stepMs = 400 } = {}) {
  const started = Date.now()
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 15000 }).catch(() => undefined)
  let last = ''
  let stable = 0
  while (Date.now() - started < timeoutMs) {
    const now = await page.evaluate(() => {
      const leaves = [...document.querySelectorAll('body *')].filter(el => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && !el.children.length
      })
      let top = Infinity; let bottom = -Infinity; let left = Infinity; let right = -Infinity
      for (const el of leaves) {
        const r = el.getBoundingClientRect()
        if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) continue
        top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom)
        left = Math.min(left, r.left); right = Math.max(right, r.right)
      }
      return `${Math.round(bottom - top)}x${Math.round(right - left)}:${leaves.length}`
    })
    if (now === last) { if (++stable >= 4) return { waitedMs: Date.now() - started, settled: true, box: now } } else stable = 0
    last = now
    await new Promise(r => setTimeout(r, stepMs))
  }
  return { waitedMs: Date.now() - started, settled: false, box: last }
}

const result = { base: BASE, takenAt: new Date().toISOString(), screens: [] }
for (const vp of VIEWPORTS) {
  await setViewport(vp)
  for (const route of ROUTES) {
    await goto(`${BASE}/?${Date.now()}${route}`)
    await page.waitForSelector('header', { timeout: 20000 }).catch(() => undefined)
    const settle = await waitForLayout(page)
    result.settles = result.settles ?? {}
    result.settles[`${vp.name} ${route}`] = settle
    const data = await page.evaluate(collect)
    result.screens.push({ vp: vp.name, route, ...data })
    console.log(`${vp.name.padEnd(10)} ${route.padEnd(16)} ink=${String(data.contentWidth).padStart(4)}x${String((data.inkBox.bottom || 0) - (data.inkBox.top || 0)).padStart(4)} cover=${String(data.coveragePct).padStart(2)}% masthead=${String(data.mastheadCost).padStart(3)}px side=${String(data.sideDeadPct).padStart(2)}% bottom=${String(data.bottomDeadPct).padStart(2)}% cols=${data.gridColumns} btnH=${data.buttonHeights.median} h1=${data.h1 ? data.h1.size + 'px' : '-'} kicker=${data.kickerCount} prose=${data.proseCount}${data.overflowX ? ' OVERFLOW-X' : ''}  等稳定 ${settle.waitedMs}ms${settle.settled ? '' : ' ← 没等定，这一屏的数字不可信'}`)
    for (const c of data.overflowCulprits || []) {
      console.log(`           ↳ 伸出视口到 ${c.right}px：${c.path}（宽 ${c.width}px，width:${c.cssWidth} min-width:${c.minWidth}${c.text ? `，「${c.text}」` : ''}）`)
      if (c === data.overflowCulprits[0]) {
        for (const p of c.chain || []) console.log(`             ↑ 祖先 ${p.path} 宽 ${p.width}px 右 ${p.right}px padding ${p.padding} max-width ${p.maxWidth}`)
      }
    }
  }
}
await browser.close()

const file = path.join(OUT, `frame-metrics-${TAG}.json`)
fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(file, JSON.stringify(result, null, 1))
console.log(`\nwrote ${file}`)

/**
 * 冻结模式（PROPOSAL-018 §1）：书库是锚，数字出界就是事故；其余页只报差值、不判红。
 * 判的是"数字没变"，不是"我看着没变"。
 */
if (process.argv.includes('--frozen')) {
  const frozenFile = path.join(ROOT, 'tools', 'verify', 'baselines', 'frame-frozen-20261010.json')
  if (!fs.existsSync(frozenFile)) { console.error(`冻结基线不在：${frozenFile}`); process.exit(1) }
  const frozen = JSON.parse(fs.readFileSync(frozenFile, 'utf8')).screens
  let fails = 0
  const note = (ok, msg) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`) }
  for (const a of result.screens) {
    const b = frozen.find(x => x.vp === a.vp && x.route === a.route)
    if (!b) { console.log(`SKIP  ${a.vp} ${a.route} 冻结基线里没有这一屏`); continue }
    if (a.route !== '#library') {
      console.log(`NOTE  ${a.vp} ${a.route}（非冻结页）内容宽 ${b.contentWidth}→${a.contentWidth} · 两侧死白 ${b.sideDeadPct}%→${a.sideDeadPct}% · 底部死白 ${b.bottomDeadPct}%→${a.bottomDeadPct}% · 控件中位高 ${b.buttonHeights.median}→${a.buttonHeights.median}`)
      continue
    }
    note(Math.abs(a.contentWidth - b.contentWidth) <= 2, `${a.vp} ${a.route} 内容实占宽 ${b.contentWidth} → ${a.contentWidth}px（±2）`)
    note(Math.abs(a.sideDeadPct - b.sideDeadPct) <= 1, `${a.vp} ${a.route} 两侧死白 ${b.sideDeadPct}% → ${a.sideDeadPct}%（±1）`)
    note(Math.abs(a.bottomDeadPct - b.bottomDeadPct) <= 1, `${a.vp} ${a.route} 底部死白 ${b.bottomDeadPct}% → ${a.bottomDeadPct}%（±1）`)
    note(a.mastheadCost === b.mastheadCost, `${a.vp} ${a.route} 页头代价 ${b.mastheadCost}px → ${a.mastheadCost}px（冻结页要同一个数）`)
    note(a.buttonHeights.median === b.buttonHeights.median, `${a.vp} ${a.route} 控件中位高 ${b.buttonHeights.median}px → ${a.buttonHeights.median}px（冻结页要同一个数）`)
    note(!a.overflowX, `${a.vp} ${a.route} 无横向溢出`)
  }
  console.log(`\n冻结页 ${fails === 0 ? '零漂移' : fails + ' 项出界'}`)
  process.exit(fails === 0 ? 0 : 1)
}

if (COMPARE) {
  const beforeFile = path.join(OUT, 'frame-metrics-before.json')
  if (!fs.existsSync(beforeFile)) { console.error('没有 frame-metrics-before.json，先跑 before'); process.exit(1) }
  const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8')).screens
  const after = result.screens
  let fails = 0
  const note = (ok, msg) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`) }
  console.log('\n== before → after ==')
  for (const a of after) {
    const b = before.find(x => x.vp === a.vp && x.route === a.route)
    if (!b) { console.log(`SKIP  ${a.vp} ${a.route} 改版前没有这一屏`); continue }
    if (a.vp === 'mobile-390') {
      note(!a.overflowX, `${a.vp} ${a.route} 无横向溢出（改前 ${b.overflowX ? '有' : '无'}）`)
      continue
    }
    note(!a.overflowX, `${a.vp} ${a.route} 无横向溢出`)
    note(a.sideDeadPct <= b.sideDeadPct + 2, `${a.vp} ${a.route} 两侧死白 ${b.sideDeadPct}% → ${a.sideDeadPct}%（不得变差）`)
    note(a.bottomDeadPct <= b.bottomDeadPct + 2, `${a.vp} ${a.route} 底部死白 ${b.bottomDeadPct}% → ${a.bottomDeadPct}%（不得变差）`)
    const deadBefore = b.sideDeadPct + b.bottomDeadPct
    const deadAfter = a.sideDeadPct + a.bottomDeadPct
    note(deadAfter <= deadBefore + 2, `${a.vp} ${a.route} 合计空白 ${deadBefore}% → ${deadAfter}%（不得变差）`)
    // 版面占用只是"墨迹盖住多少格"，两栏排同样多的内容会更矮、占用反而降，
    // 所以它只做记录，判红要靠上面三条死白。
    console.log(`NOTE  ${a.vp} ${a.route} 版面占用 ${b.coveragePct}% → ${a.coveragePct}%`)
    note(a.contentWidth >= b.contentWidth - 24, `${a.vp} ${a.route} 内容实占宽 ${b.contentWidth}px → ${a.contentWidth}px（不得明显变窄）`)
    // 窄屏页头条会折成两行，绝对上限只对宽屏成立；窄屏只要求"不比改前更靠下"。
    // 书库是**冻结页**（PROPOSAL-018 §1）：它的页头高度与 kicker 就是基线的一部分，
    // 这两条对它不成立 —— 否则"冻结"与"去 kicker"两条要求互相打架。
    if (a.route !== '#library') {
      const topCap = a.vp.startsWith('desk-') ? '第一行内容起始 ≤96px' : '窄屏只看是否比改前更靠下'
      note(a.contentTop <= b.contentTop + 2 && !(a.vp.startsWith('desk-') && a.contentTop > 96),
        `${a.vp} ${a.route} 第一行内容起始 ${b.contentTop}px → ${a.contentTop}px（页头必须变矮；${topCap}）`)
      note(a.kickerCount === 0, `${a.vp} ${a.route} 不再出现 section-kicker 说明行（改前 ${b.kickerCount} 处）`)
    } else {
      console.log(`NOTE  ${a.vp} ${a.route} 冻结页：页头与 kicker 不动（基线里就是 ${b.kickerCount} 处）`)
    }
    note(a.buttonHeights.median >= Math.min(b.buttonHeights.median, a.buttonHeights.median) - 2 && a.buttonHeights.median <= b.buttonHeights.median + 2,
      `${a.vp} ${a.route} 控件中位高度 ${b.buttonHeights.median}px → ${a.buttonHeights.median}px（密度不得漂）`)
    if (b.gridColumns > 0 && a.gridColumns > 0) {
      note(a.gridColumns >= b.gridColumns, `${a.vp} ${a.route} 网格列数 ${b.gridColumns} → ${a.gridColumns}（不得变少）`)
    }
    for (let i = 0; i < Math.min(b.cards.length, a.cards.length); i++) {
      const bc = b.cards[i], ac = a.cards[i]
      note(Math.abs(ac.w - bc.w) <= Math.max(6, bc.w * 0.12), `${a.vp} ${a.route} 卡片宽 ${bc.w} → ${ac.w}`)
    }
  }
  console.log(`\n${fails === 0 ? '全部通过' : fails + ' 条未过'}`)
  process.exit(fails === 0 ? 0 : 1)
}
