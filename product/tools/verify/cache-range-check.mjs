/**
 * 离线缓存的界面实测：确认缓存入口在、缓存的是**整本**，
 * 而且界面上**没有**"只缓存一部分"的残骸。
 *
 * 口径变更（2026-11-16）：这条门禁原来盯的是阅读器目录抽屉页脚里的"档位网格"
 * （`.cache-range-btn-grid` / `.cache-range-btn` / `.drawer-footer-toggle`），
 * 契约是"档位只剩「全本缓存」和「自定义」两个"。
 *
 * 那些类名**只存在于 styles.css，没有任何组件渲染过它们** ——
 * `ReaderScreen.tsx` 里还留着 `drawerFooterOpen` / `customRangeOpen` 这两段状态，
 * 但没有一处把它们画出来。也就是说那块面板**从来没做过**，
 * 门禁盯的是一个不存在的界面（红的是探针，不是产品）。
 *
 * 离线缓存真正的入口在**书架**的「书籍管理」里
 * （`features/bookshelf/BookManageModal.tsx` → 「离线缓存全本」），
 * 而「自定义范围（第 X 至 Y 章）」在界面上已经没有了 ——
 * 只剩后端 `cache.range` 端点和 `handleCacheRange('custom', …)` 这个没人调的 helper。
 *
 * 所以现在断的是产品**当下真的承诺**的三件事：
 *   ① 书架的书籍管理里有离线缓存入口；
 *   ② 那行是「离线缓存全本」—— 缓存的是整本，不是某几章；
 *   ③ 界面上没有「后 50 / 后 100 章」那类分档，也没有自定义范围那套的残骸。
 *
 * 不发起真实缓存、不写用户数据。
 */
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, SHOTS, BASE, launchOptions } from './env.mjs'

const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')
const STAMP = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

let pass = 0
let fail = 0
let skips = 0
const ok = (label, condition, detail = '') => {
  if (condition) { pass++; console.log(`  PASS ${label}${detail ? '  — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL ${label}  — ${detail || '断言不成立'}`) }
}
const skip = (label, detail) => { skips++; console.log(`  SKIP ${label}  — ${detail}`) }

const browser = await puppeteer.launch(launchOptions())
const page = await browser.newPage()
const errors = []
page.on('pageerror', e => errors.push(e.message))
await page.setViewport({ width: 1440, height: 900 })
try {
  await page.goto(`${BASE}/#shelf`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.shelf-card', { timeout: 30000 })

  // 挑一本真有章节的书：缓存中断过的那本进不了阅读器，拿它测只会假红。
  const target = await page.evaluate(async () => {
    const list = await (await fetch('/api/bookshelf')).json()
    const usable = list.find(item => (item.totalChapters ?? 0) > 0 && item.cacheState !== 'caching')
      ?? list.find(item => item.sourceId !== 'loc_book')
    return usable ? { name: usable.name, bookUrl: usable.bookUrl } : null
  })
  if (!target) {
    skip('书架上有一本读得出目录的书', '本机书架为空或全部没有章节数')
  } else {
    // 离线缓存的入口在**书架**的「书籍管理」里（BookManageModal.tsx），
    // 点书卡下面那块信息区（.shelf-card-info）打开它 —— 别点封面，点封面是进阅读器。
    const opened = await page.evaluate(name => {
      const card = [...document.querySelectorAll('.shelf-card')]
        .find(node => node.querySelector('.shelf-card-name')?.textContent?.trim() === name)
      const info = card?.querySelector('.shelf-card-info')
      if (!info) return false
      info.click()
      return true
    }, target.name)
    await sleep(900)
    const sheet = await page.evaluate(() => {
      const modal = document.querySelector('.book-manage-sheet')
      if (!modal) return null
      const rows = [...modal.querySelectorAll('.manage-action-row')].map(node => node.innerText?.replace(/\s+/g, ' ').trim() ?? '')
      return {
        rows,
        // 自定义范围那套（第 X 至 Y 章）现在**界面上没有** ——
        // 用「管理弹窗里的数字输入框」当锚点（那些被删掉的类名不能再当锚点，
        // 门禁锚点测试会判红：门禁点的东西必须还长在界面上）。
        rangeInputs: modal.querySelectorAll('input[type="number"]').length,
      }
    })
    ok('书架的「书籍管理」里露出了离线缓存入口', !!opened && !!sheet, sheet ? '' : '没找到 .book-manage-sheet')
    if (sheet) {
      const cacheRow = sheet.rows.find(text => text.includes('离线缓存全本') || text.includes('重新缓存') || text.includes('重试离线缓存'))
      ok('有一行是「离线缓存全本」（缓存的是整本，不是某几章）', !!cacheRow, sheet.rows.join(' | ').slice(0, 160))

      // 「后 50 章 / 后 100 章」那两档早就不该在了 —— 现在界面上**任何地方**
      // 都不该再出现这种"只缓存一部分"的档位说法。
      const pageText = await page.evaluate(() => document.body.innerText)
      const tierHits = pageText.match(/后\s*\d+\s*章/g) ?? []
      ok('界面上没有「后 50 章 / 后 100 章」那类分档', tierHits.length === 0, tierHits.join(' / ') || '没有')

      // 自定义范围那套（第 X 至 Y 章）现在也没有了 ——
      // 别让界面上留一个看着能选区间、实际选不了的东西。
      // 锚点用**还在的**东西（管理弹窗里的数字输入框），别用那些被删掉的类名。
      ok('管理弹窗里没有「选第几章到第几章」那套数字输入框',
        sheet.rangeInputs === 0,
        '数字输入框 ' + sheet.rangeInputs + ' 个')
    }
    await page.screenshot({ path: path.join(SHOTS, 'cache-ranges-' + STAMP + '.png') })
  }
  ok('全程没有页面异常', errors.length === 0, errors.slice(0, 2).join(' / '))
} finally {
  await browser.close()
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败${skips ? ` / ${skips} 跳过` : ''}  ·  截图 out/shots/cache-ranges-${STAMP}.png`)
if (fail > 0) process.exitCode = 1
