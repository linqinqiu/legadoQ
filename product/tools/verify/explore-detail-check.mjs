// 发现页点击语义验证：点卡片只弹详情窗、不静默加架；点「开始阅读」才进阅读器。
// 用法：node tools/verify/explore-detail-check.mjs
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { BASE, OUT, SHOTS, ROOT, launchOptions } from './env.mjs'

const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')
const wait = ms => new Promise(r => setTimeout(r, ms))

const lines = []
const check = (label, ok, detail = '') => {
  const line = `${ok ? '✔' : '✘'} ${label}${detail ? ' — ' + detail : ''}`
  lines.push(line)
  console.log(line)
}

const b = await puppeteer.launch(launchOptions())
const p = await b.newPage()
await p.setViewport({ width: 1440, height: 900 })
const errors = []
p.on('pageerror', e => errors.push(String(e.message || e)))

/** 书架指纹：sourceId|bookUrl 集合，用来精确算出这次测试新增/残留了哪几本。 */
const shelfKeys = () => p.evaluate(async () => {
  const list = await (await fetch('/api/bookshelf')).json()
  return list.map(item => `${item.sourceId}|${item.bookUrl}`)
})

await p.goto(`${BASE}/#explore`, { waitUntil: 'domcontentloaded', timeout: 40000 })
await p.waitForSelector('.explore-page', { timeout: 40000 })
await wait(2500)

/**
 * 先把发现页选到一个"确实能出书"的源上。
 *
 * 这一条以前直接吃默认选中的第一个源。全库 5,574 个源都启用后，按名字排第一的是
 * 「00小说网」，它的发现页分栏根本没有 `bookList` 规则（界面如实写着「缺少 bookList 规则」），
 * 于是无论点哪一栏都是 0 张卡片 —— 门禁红的是夹具，不是"点卡片弹详情窗"这个行为。
 * 现在显式挑番茄那个源；它不在（没启用/没配 exploreUrl）就退化成逐个试下拉里的源。
 */
const FANQIE_HOST = 'fq-book.netsite.cc'
const pickSource = async name => {
  await p.evaluate(() => document.querySelector('.explore-source-picker .ui-select-trigger')?.click())
  await p.waitForSelector('.ui-select-menu', { timeout: 20000 }).catch(() => null)
  await wait(400)
  await p.evaluate(target => {
    const input = document.querySelector('.ui-select-search')
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, target)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    return true
  }, name)
  await wait(600)
  return p.evaluate(() => {
    const node = [...document.querySelectorAll('.ui-select-option')][0]
    if (!node) return false
    node.click()
    return true
  })
}
const fanqie = await p.evaluate(async host => {
  const list = await (await fetch('/api/explore/sources')).json()
  const hit = list.find(item => String(item.id ?? '').includes(host))
  return hit ? { id: hit.id, name: hit.name } : null
}, FANQIE_HOST)
if (fanqie) {
  await pickSource(fanqie.name)
  console.log(`ℹ 发现页选到「${fanqie.name}」（00小说网那类没配 bookList 的源会让本条门禁假红）`)
} else {
  console.log(`ℹ 可发现的书源里没有 ${FANQIE_HOST}，沿用默认选中的源`)
}
// 等分栏出来
for (let i = 0; i < 100; i++) {
  await wait(1000)
  if ((await p.$$('.explore-tabs button, .explore-tab')).length > 0) break
}
const tabNames = await p.$$eval('.explore-tabs button, .explore-tab', els => els.slice(0, 6).map(e => e.innerText.trim()))
console.log(`ℹ 分栏：${tabNames.join(' / ')}`)

// 默认那一栏可能本来就是空的（番茄「番茄书架」这一栏实测返回 0 本），逐栏试到出书为止
let cards = 0
let usedTab = ''
for (const name of tabNames.slice(0, 4)) {
  await p.evaluate(label => {
    const btn = [...document.querySelectorAll('.explore-tabs button, .explore-tab')].find(e => e.innerText.trim() === label)
    btn?.click()
  }, name)
  for (let i = 0; i < 40 && cards === 0; i++) {
    await wait(1000)
    cards = await p.$$eval('.explore-card', els => els.length)
  }
  if (cards > 0) { usedTab = name; break }
}
check('发现页列出书籍', cards > 0, `分栏「${usedTab}」出 ${cards} 张卡片`)
if (cards === 0) {
  const why = await p.evaluate(() => {
    const status = document.querySelector('.explore-status, .explore-message, .explore-empty')
    return (status?.innerText ?? document.querySelector('main')?.innerText ?? '').replace(/\s+/g, ' ').slice(-160)
  })
  console.log('ℹ 页尾状态文案：' + why)
}

const csrf = '' // 不设身份
const before = await shelfKeys()

const pickedName = await p.evaluate(() => {
  const card = document.querySelector('.explore-card')
  const name = card?.innerText.split('\n')[0]?.trim() ?? ''
  card?.click()
  return name
})

let modalShown = false
for (let i = 0; i < 25 && !modalShown; i++) {
  await wait(1000)
  modalShown = !!(await p.$('.book-detail-modal'))
}
check('点卡片弹出详情窗（不再直接进阅读器）', modalShown, `书名 ${pickedName}`)
check('点卡片不改路由', (await p.evaluate(() => location.hash)) === '#explore')
check('点卡片不静默加架', (await shelfKeys()).length === before.length, `${before.length} 本`)

if (modalShown) {
  console.log('ℹ 详情窗：' + await p.$eval('.book-detail-modal', el => el.innerText.replace(/\s+/g, ' ').slice(0, 110)))
  // 封面：详情页给的地址常打不开，要能自动降级到别的源；全落空时换成带书名作者的文字书封，
  // 不许留一个破图框。图片是异步的，必须先等它 settle（load 或 error）再判定。
  await p.evaluate(async () => {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const img = document.querySelector('.book-detail-modal img.book-detail-cover')
      if (!img || img.complete) return
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  })
  const cover = await p.evaluate(() => {
    const img = document.querySelector('.book-detail-modal img.book-detail-cover')
    const textCover = document.querySelector('.book-detail-modal .book-detail-cover-text .cover-fallback-title')
    return {
      hasImg: !!img,
      loaded: img ? img.naturalWidth > 0 : null,
      src: img?.currentSrc?.slice(0, 60) ?? null,
      textCover: textCover?.textContent?.trim() ?? '',
    }
  })
  check('详情窗封面要么真出图、要么降级成文字书封（不留破图框）',
    (cover.hasImg && cover.loaded === true) || (!cover.hasImg && cover.textCover.length > 0),
    JSON.stringify(cover))
  await p.screenshot({ path: path.join(SHOTS, 'explore-detail-modal.png') })

  const readBtn = await p.evaluate(() => {
    const btn = [...document.querySelectorAll('.book-detail-modal button')].find(e => /开始阅读|继续阅读/.test(e.innerText))
    if (!btn) return null
    btn.click()
    return btn.innerText.trim()
  })
  check('详情窗里有「开始阅读」', !!readBtn, String(readBtn))
  await wait(7000)
  check('点开始阅读才进阅读器', (await p.evaluate(() => location.hash)) === '#reader')

  const after = await shelfKeys()
  const added = after.filter(key => !before.includes(key))
  check('显式开始阅读会加架（上游语义）', added.length === 1, `新增 ${added.length} 本`)

  // 收尾：只删这次新增的那本，用户在架的书一本不动
  if (added.length) {
    const cleaned = await p.evaluate(async (keys, token) => {
      const list = await (await fetch('/api/bookshelf')).json()
      const targets = list.filter(item => keys.includes(`${item.sourceId}|${item.bookUrl}`))
      const codes = []
      for (const item of targets) {
        const r = await fetch(`/api/bookshelf?sourceId=${encodeURIComponent(item.sourceId)}&bookUrl=${encodeURIComponent(item.bookUrl)}`, {
          method: 'DELETE',
          headers: { 'X-CSRF-Token': token },
        })
        codes.push(`${item.name}=${r.status}`)
      }
      return codes
    }, added, csrf)
    console.log('ℹ 清理测试加架项：' + JSON.stringify(cleaned))
    check('测试痕迹已清理', (await shelfKeys()).length === before.length)
  }
}

check('页面无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '))
await b.close()
const failed = lines.filter(l => l.startsWith('✘')).length
fs.writeFileSync(path.join(OUT, 'explore-detail-check.txt'), lines.join('\n') + '\n')
console.log(`\n合计 ${lines.length} 项，失败 ${failed} 项`)
process.exit(failed ? 1 : 0)
