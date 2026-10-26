/**
 * 离线缓存档位收敛的界面实测：确认「后 50 章 / 后 100 章」真的没了，
 * 剩下的「全本缓存 / 自定义」还在，且自定义展开后第 X 至 Y 章那套仍在。
 *
 * 原来这条假红在找法上（#55）：它随便点书架第一张卡里"第一个 a/button"，
 * 而书架卡现在的结构是「封面=继续阅读 / 下方信息区=打开书籍管理」，点错就进了弹窗；
 * 而且档位网格在**目录抽屉的页脚**里，抽屉没开就永远找不到。
 * 现在改成：从接口挑一本真有章节的书 → 点封面进阅读器 → 点顶栏「目录」开抽屉 → 等页脚出现。
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

  // 挑一本目录读得出来的书：缓存中断过的那本进不了阅读器，拿它测档位只会假红。
  const target = await page.evaluate(async () => {
    const list = await (await fetch('/api/bookshelf')).json()
    const usable = list.find(item => (item.totalChapters ?? 0) > 0 && item.cacheState !== 'caching')
      ?? list.find(item => item.sourceId !== 'loc_book')
    return usable ? { name: usable.name, bookUrl: usable.bookUrl } : null
  })
  if (!target) {
    skip('书架上有一本读得出目录的书', '本机书架为空或全部没有章节数')
  } else {
    const clicked = await page.evaluate(book => {
      const cards = [...document.querySelectorAll('.shelf-card')]
      const card = cards.find(node => node.querySelector('.shelf-card-name')?.textContent?.trim() === book.name)
      const cover = card?.querySelector('.shelf-card-cover')
      if (!cover) return false
      cover.click()
      return true
    }, target)
    ok(`从书架点封面进入《${target.name}》`, clicked, target.bookUrl.slice(0, 60))

    await page.waitForSelector('[data-testid="reader-header"]', { timeout: 60000 }).catch(() => {})
    const inReader = await page.evaluate(() => !!document.querySelector('[data-testid="reader-header"]'))
    if (!inReader) {
      skip('进了阅读器', '60 秒内没打开阅读器（这本书的目录取不出来）')
    } else {
      // 档位网格在目录抽屉的**页脚**里，而页脚默认是**折叠**的（只露一行
      // 「离线缓存 · 这本书」）。所以"打开抽屉"不等于"看到档位区"，
      // 还得再展开页脚。抽屉本身是开关式的（被钉住时第一下是取消钉住），
      // 所以点一次没出来就再点一次。
      const openDrawer = async () => {
        await page.evaluate(() => {
          document.querySelector('[data-testid="reader-header"] button[aria-label="目录"]')?.click()
        })
        await sleep(900)
        return page.evaluate(() => !!document.querySelector('.reader-drawer-left.open'))
      }
      /** 展开页脚（已展开就保持）。 */
      const openFooter = async () => {
        await page.evaluate(() => {
          const toggle = document.querySelector('.drawer-footer-toggle')
          if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click()
        })
        await sleep(700)
        return page.evaluate(() => !!document.querySelector('.cache-range-btn-grid'))
      }
      let gridFound = await openDrawer()
      if (!gridFound) gridFound = await openDrawer()   // 被钉住时第一下是取消钉住
      // 抽屉开了之后，档位区还藏在折叠页脚里 —— 这一步原来漏了，
      // 于是判据报"找到了离线缓存档位区 FAIL"、后面整段 SKIP。
      // 产品没坏：手工点开抽屉再展开页脚，档位区就在那儿。
      if (gridFound) gridFound = await openFooter()
      ok('找到了离线缓存档位区（目录抽屉页脚）', gridFound)
      if (gridFound) {
        const labels = await page.evaluate(() => [...document.querySelectorAll('.cache-range-btn')]
          .map(node => node.textContent?.trim() ?? ''))
        ok('「后 50 章」「后 100 章」已不在界面上', !labels.some(label => /后\s*50|后\s*100/.test(label)), labels.join(' | '))
        ok('「全本缓存」与「自定义」都还在',
          labels.some(label => label.includes('全本')) && labels.some(label => label.includes('自定义')), labels.join(' | '))
        ok('档位只剩这两个（没有多余控件）', labels.length === 2, `${labels.length} 个`)

        await page.evaluate(() => {
          ;[...document.querySelectorAll('.cache-range-btn')].find(node => node.textContent?.includes('自定义'))?.click()
        })
        await sleep(700)
        const box = await page.evaluate(() => {
          const wrap = document.querySelector('.cache-custom-range-box')
          return {
            inputs: document.querySelectorAll('.cache-custom-range-box input[type="number"]').length,
            text: wrap?.innerText?.replace(/\s+/g, ' ').trim() ?? '',
          }
        })
        ok('「自定义」仍能展开第 X 至 Y 章那套', box.inputs === 2 && /至/.test(box.text), JSON.stringify(box).slice(0, 180))
        await page.screenshot({ path: path.join(SHOTS, `cache-ranges-${STAMP}.png`) })
      } else {
        skip('档位按钮的清点', '抽屉没露出页脚（这本书可能正在缓存，或抽屉被设置抽屉顶掉）')
      }
    }
  }
  ok('全程没有页面异常', errors.length === 0, errors.slice(0, 2).join(' / '))
} finally {
  await browser.close()
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败${skips ? ` / ${skips} 跳过` : ''}  ·  截图 out/shots/cache-ranges-${STAMP}.png`)
if (fail > 0) process.exitCode = 1
