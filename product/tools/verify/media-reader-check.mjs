// A4 的落地实测：非文本书源的「类型徽标 + 阅读器分流」。
//
// 不量源码、量界面：把一本**真音频源**的书加进书架（用完删掉），
// 断言 ① 书架卡片带「音频」徽标；② 点开阅读器后章节正文渲染成 `<audio>` 播放器（而不是把地址当段落排出来）。
//
// 跑法：node tools/verify/media-reader-check.mjs（需要服务已在 BASE 上跑）
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, SHOTS, BASE, launchOptions } from './env.mjs'

const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail })
const note = (name, detail) => results.push({ name, ok: null, detail })

const AUDIO_SID = 'https://m.lrts.me/'
fs.mkdirSync(SHOTS, { recursive: true })

const browser = await puppeteer.launch(launchOptions())
let added = null
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error.message)))
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  await page.goto(`${BASE}/#shelf`, { waitUntil: 'domcontentloaded' })
  await sleep(2000)

  // 加一本音频书到书架（真源搜索 → 详情 → 入架）
  added = await page.evaluate(async sid => {
    const post = async (p, b) => (await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json()
    const s = await post('/api/search', { keyword: '斗破苍穹', sourceIds: [sid] })
    if (!Array.isArray(s) || !s[0]) return { error: '音频源搜索无结果' }
    const r = s[0]
    const d = await post('/api/books/details', { sourceId: sid, bookUrl: r.bookUrl })
    await post('/api/bookshelf', { sourceId: sid, bookUrl: r.bookUrl, name: r.name, author: r.author, tocUrl: d.tocUrl, coverUrl: r.coverUrl })
    return { sourceId: sid, bookUrl: r.bookUrl, name: r.name, type: r.sourceType }
  }, AUDIO_SID)
  // 这条是**外部依赖**：它靠 `https://m.lrts.me/` 这个具体音频站能不能搜出书。
  // 站点改版 / 反爬 / 下线都会让这里搜不出结果 —— 那不是本产品坏了。
  // 所以搜不出时**记 NOTE（跳过）而不是 FAIL**：让"没测到"与"测了但坏了"分开，
  // 否则 CI 会因为别人的网站改版一直红，所有人开始忽略红。
  // 真坏了（能搜到书、但界面没渲染成播放器）后面那几条仍然会红。
  if (added?.error) {
    note('音频书源搜索能出结果（跳过）', `外部音频源 ${AUDIO_SID} 搜不出结果（站点可能改版/下线）—— 后面几条无从验证`)
  } else {
    check('音频书源搜索能出结果', true, `《${added?.name}》 searchResult.sourceType=${added?.type}`)
  }

  if (added && !added.error) {
    const key = added.name.slice(0, 4)
    // 真 reload：时间戳必须放在 hash **外面**（`#shelf?t=` 只是同文档 hash 跳，React 不重挂、书架不会重取）
    await page.goto(`${BASE}/?t=${Date.now()}#shelf`, { waitUntil: 'domcontentloaded' })
    await sleep(2500)

    const badge = await page.evaluate(k => {
      const card = [...document.querySelectorAll('article')].find(c => c.querySelector('.shelf-card-name')?.textContent?.includes(k))
      return card?.querySelector('.book-type-badge')?.textContent?.trim() ?? null
    }, key)
    check('书架卡片带「音频」类型徽标', badge === '音频', `badge=${JSON.stringify(badge)}`)

    const opened = await page.evaluate(k => {
      const card = [...document.querySelectorAll('article')].find(c => c.querySelector('.shelf-card-name')?.textContent?.includes(k))
      const cover = card?.querySelector('.shelf-card-cover')
      if (!cover) return false
      cover.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return true
    }, key)
    check('能从书架点开这本书', opened)
    await sleep(4000)

    const audio = await page.evaluate(() => {
      const el = document.querySelector('.reader-media audio')
      return el ? { src: el.getAttribute('src') ?? '', controls: el.hasAttribute('controls') } : null
    })
    check('音频章节渲染出 <audio> 播放器', !!audio && !!audio.src, audio ? `src=${audio.src.slice(0, 72)}` : '没找到 .reader-media audio')
    check('播放器带 controls', !!audio?.controls)

    // A5：非文本章节不参与朗读 —— 朗读入口应是灰的（标题栏那颗按 aria-label 找，移动端那颗按文案找）
    const tts = await page.evaluate(() => {
      const header = document.querySelector('[data-testid="reader-header"] button[aria-label="本类型不支持朗读"]')
      const nav = [...document.querySelectorAll('.mobile-reader-nav button')].find(b => b.textContent?.includes('朗读'))
      return { header: !!header && header.disabled, nav: nav ? nav.disabled : null }
    })
    check('音频章节的朗读入口被禁用', tts.header || tts.nav === true, `header=${tts.header} nav=${tts.nav}`)

    await page.screenshot({ path: path.join(SHOTS, 'media-reader-audio.png') })
  }

  check('全程没有页面 JS 异常', errors.length === 0, errors.slice(0, 2).join(' / '))
} finally {
  if (added && !added.error) {
    try {
      await fetch(`${BASE}/api/bookshelf?sourceId=${encodeURIComponent(added.sourceId)}&bookUrl=${encodeURIComponent(added.bookUrl)}`, { method: 'DELETE', headers: { Origin: BASE } })
    } catch { /* 清理失败不影响结论 */ }
  }
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
for (const item of results) if (item.ok === true) console.log(`  PASS ${item.name}  — ${item.detail}`)
console.log(`\nmedia-reader-check: PASS ${pass} / FAIL ${fail} / NOTE ${skips}`)
process.exit(fail > 0 ? 1 : 0)
