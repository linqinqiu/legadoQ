// 书架布局实测取证：把 0..7 每一种布局在桌面/窄屏下的真实排布量出来（几列、封面多宽、
// 标题有没有被截断、工具栏有几个按钮），并各自截图。目的是先确认「哪些档位确实没用」再删。
// 用法：node tools/verify/shelf-layout-measure.mjs [--base http://127.0.0.1:4399]
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, OUT, SHOTS, launchOptions } from './env.mjs'

// puppeteer-core 装在 web/ 下，脚本从仓库根跑，所以要按 web/package.json 的位置解析。
const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')

const BASE = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : (process.env.LEGADO_PREVIEW_URL || 'http://127.0.0.1:4399')
const STAMP = process.env.STAMP || new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)
const CODES = [0, 1, 2, 3, 4, 5, 6, 7]
const VIEWS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1100, height: 800 },
  { name: 'phone', width: 390, height: 844 },
]

const browser = await puppeteer.launch(launchOptions())
const page = await browser.newPage()
const failures = []
page.on('pageerror', error => failures.push(error.message))

async function measure(code, view) {
  await page.setViewport({ width: view.width, height: view.height, deviceScaleFactor: 1 })
  await page.goto(`${BASE}/#shelf`, { waitUntil: 'networkidle2' })
  await page.evaluate(value => localStorage.setItem('legado-shelf-layout-v1', String(value)), code)
  await page.reload({ waitUntil: 'networkidle2' })
  try {
    await page.waitForSelector('.shelf-grid .shelf-card', { timeout: 15000 })
  } catch (error) {
    console.log(JSON.stringify({ code, view: view.name, base: BASE, state: await page.evaluate(() => ({ hash: location.hash, text: document.body.innerText.slice(0, 120), cards: document.querySelectorAll('.shelf-card').length })) }))
    throw error
  }
  const data = await page.evaluate(() => {
    const grid = document.querySelector('.shelf-grid')
    const cards = [...document.querySelectorAll('.shelf-grid .shelf-card')]
    const cover = document.querySelector('.shelf-grid .shelf-card-cover')
    const name = document.querySelector('.shelf-grid .shelf-card-name')
    const style = getComputedStyle(grid)
    const tracks = style.gridTemplateColumns.split(' ').filter(Boolean).length
    const rects = cards.slice(0, 12).map(card => card.getBoundingClientRect())
    // 同一行 = top 相同；行数 = 不同 top 的个数
    const tops = [...new Set(rects.map(rect => Math.round(rect.top)))]
    return {
      tracks,
      gap: style.columnGap,
      coverWidth: cover ? Math.round(cover.getBoundingClientRect().width) : 0,
      coverHeight: cover ? Math.round(cover.getBoundingClientRect().height) : 0,
      cards: cards.length,
      rows: tops.length,
      nameClipped: name ? name.scrollWidth > name.clientWidth + 1 : false,
      nameLines: name ? Math.round(name.getBoundingClientRect().height / parseFloat(getComputedStyle(name).lineHeight || '18')) : 0,
      authorVisible: !!document.querySelector('.shelf-grid .shelf-card-author')?.getBoundingClientRect().width,
      footerButtons: [...document.querySelectorAll('.shelf-grid .shelf-card-footer button')].filter(button => button.offsetWidth > 0).length,
      pickerButtons: [...document.querySelectorAll('.shelf-layout-picker button')].map(button => (button.textContent || '').trim() || button.querySelector('svg')?.getAttribute('data-icon') || '?'),
      toolbarWidth: Math.round(document.querySelector('.shelf-layout-picker')?.getBoundingClientRect().width || 0),
      gridOverflow: grid.scrollWidth > grid.clientWidth + 1,
    }
  })
  const shot = path.join(SHOTS, `shelf-layout-${STAMP}-${code}-${view.name}.png`)
  await page.screenshot({ path: shot, clip: { x: 0, y: 0, width: view.width, height: Math.min(view.height, 900) } })
  return data
}

const rows = []
for (const view of VIEWS) {
  for (const code of CODES) {
    const data = await measure(code, view)
    rows.push({ view: view.name, code, ...data })
  }
}
await browser.close()

const width = (value, size) => String(value).padEnd(size)
console.log(width('code', 5) + width('view', 9) + width('cols', 6) + width('cover', 9) + width('cards', 7) + width('rows', 6) + width('clip', 6) + width('footBtn', 8) + width('pickerW', 9) + 'picker buttons')
for (const row of rows) {
  if (row.view !== VIEWS[0].name && row.code === CODES[0]) console.log('')
  console.log(
    width(`#${row.code}`, 5) + width(row.view, 9) + width(row.tracks, 6)
    + width(`${row.coverWidth}x${row.coverHeight}`, 9) + width(row.cards, 7) + width(row.rows, 6)
    + width(row.nameClipped ? 'yes' : 'no', 6) + width(row.footerButtons, 8) + width(`${row.toolbarWidth}px`, 9)
    + row.pickerButtons.join('|'),
  )
}
const json = path.join(OUT, `shelf-layout-${STAMP}.json`)
fs.writeFileSync(json, JSON.stringify({ base: BASE, stamp: STAMP, rows }, null, 2))
if (failures.length) console.log('\npage errors: ' + [...new Set(failures)].slice(0, 3).join(' / '))
console.log(`\n数据 ${json}\n截图 ${path.join(SHOTS, `shelf-layout-${STAMP}-*.png`)}`)
