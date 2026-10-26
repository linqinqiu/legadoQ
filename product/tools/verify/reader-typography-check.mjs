// 「阅读设置 · 排版」的落地实测：每一项都要真的改到渲染出来的正文，不看滑块。
//
// 用户 2026-09-30：「阅读设置里面的排版功能丰富完善检验一下，比如首行缩进」。
// 量出来的实情是：设置项存在不等于生效 —— 首行缩进以前压根没有；「左右边距」在 ≤720px
// 被一条写死的 `width: min(100% - 36px, 580px)` 覆盖掉，手机上是纯空控件。
// 所以这里逐条量 computed style 与实际盒宽，并且要求"改一档 → 数值真的变"。
//
// 只用用户书架里已缓存全本的那本书（正文走本地缓存，不发起上游抓取），只读 localStorage。
//
// 跑法：node tools/verify/reader-typography-check.mjs
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, SHOTS, BASE, launchOptions } from './env.mjs'

const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')
const SETTINGS_KEY = 'legado-reader-settings-v2'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const results = []
const check = (name, condition, detail = '') => results.push({ name, ok: !!condition, detail })
const note = (name, detail) => results.push({ name, ok: null, detail })

const browser = await puppeteer.launch(launchOptions())
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error.message)))
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })

  // 挑一本已经缓存全本的书：正文秒回，排版量测才不被网络抖动污染
  await page.goto(`${BASE}/#shelf`, { waitUntil: 'domcontentloaded' })
  await sleep(2500)
  const target = await page.evaluate(async () => {
    const list = await (await fetch('/api/bookshelf')).json()
    const ready = list.find(item => item.cacheState === 'ready' && (item.totalChapters ?? 0) > 3)
      ?? list.find(item => (item.totalChapters ?? 0) > 3)
    return ready ? { name: ready.name, sourceId: ready.sourceId, bookUrl: ready.bookUrl } : null
  })
  if (!target) {
    note('书架上有一本缓存好的书', '没有 cacheState=ready 且章节数 >3 的书，排版实测无法进行')
  } else {
    /**
     * 写设置 → 真的重新载入文档 → 量正文段落。
     *
     * 注意 URL 必须每次都不同：阅读器是 SPA 路由，打开书之后地址栏仍是 `#shelf`，
     * 于是 `goto(同一个 URL)` 只会是一次"同文档导航"，React 不重新挂载、
     * `loadReaderSettings()` 也不会再读一遍 —— 表现就是"改了 localStorage 但界面没变"，
     * 看着像产品 bug，其实是门禁自己没重载。加个时间戳查询参数才是真 reload。
     */
    const openWithSettings = async (patch, viewport) => {
      await page.evaluate(async ([key, body]) => {
        const defaults = {
          theme: 'light', fontSize: 19, lineHeight: 1.95, letterSpacing: 0, paragraphSpacing: 1.15,
          textIndent: 2, contentPadding: 80, font: 'song', pageMode: 'scroll', maxWidth: 860,
          columnMode: 'single', sidebarPinned: false, ttsEngine: 'edge', ttsVoice: '', ttsSpeed: 1,
          ttsPitch: 1, ttsAutoNextChapter: false, ttsFilterSymbols: true,
        }
        window.localStorage.setItem(key, JSON.stringify({ ...defaults, ...body }))
      }, [SETTINGS_KEY, patch])
      if (viewport) await page.setViewport({ width: viewport, height: 900, deviceScaleFactor: 1 })
      await page.goto(`${BASE}/?t=${Date.now()}#shelf`, { waitUntil: 'domcontentloaded' })
      // 冷启动这一屏要多久取决于机器多忙（实测 3~30 秒），固定 sleep 之后点不到卡就等于
      // 后面 60 秒等一个永远不会出现的 `.reading-content p`。先等卡片真挂上。
      await page.waitForSelector('.shelf-card', { timeout: 60000 }).catch(() => null)
      await sleep(2200)
      await page.evaluate(name => {
        const card = [...document.querySelectorAll('.shelf-card')]
          .find(node => node.querySelector('.shelf-card-name')?.textContent?.trim() === name)
        card?.querySelector('.shelf-card-cover')?.click()
      }, target.name)
      await page.waitForSelector('.reading-content p, .reader-paginated-column-body p', { timeout: 60000 })
      await sleep(1200)
      return page.evaluate(() => {
        const content = document.querySelector('.reading-content, .reader-paginated-column-body')
        const paragraph = document.querySelector('.reading-content p, .reader-paginated-column-body p')
        const title = document.querySelector('.reading-content h1, .reader-paginated-column-body h1')
        if (!content || !paragraph) return null
        const style = getComputedStyle(paragraph)
        return {
          textIndent: style.textIndent,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          letterSpacing: style.letterSpacing,
          marginBottom: style.marginBottom,
          textAlign: style.textAlign,
          titleIndent: title ? getComputedStyle(title).textIndent : '(无标题)',
          contentWidth: Math.round(content.getBoundingClientRect().width),
          docOverflowX: document.documentElement.scrollWidth - window.innerWidth,
        }
      })
    }

    const wide = await openWithSettings({})
    if (!wide) {
      note('进得了阅读器并量到正文', '段落没渲染出来，后面全部无法判定')
    } else {
      const px = size => Math.round(size * 100) / 100
      check('默认排下首行缩进 = 2 字（2 × 字号）',
        px(parseFloat(wide.textIndent)) === px(parseFloat(wide.fontSize) * 2),
        `text-indent ${wide.textIndent} · 字号 ${wide.fontSize}`)
      check('正文是两端对齐的', wide.textAlign === 'justify', wide.textAlign)
      check('章节标题不跟着首行缩进', wide.titleIndent === '0px', `h1 text-indent ${wide.titleIndent}`)

      const none = await openWithSettings({ textIndent: 0 })
      check('「不缩进」真的归零', !!none && none.textIndent === '0px', none?.textIndent ?? '(没量到)')
      const one = await openWithSettings({ textIndent: 1 })
      check('「1 字」= 一个字号', !!one && px(parseFloat(one.textIndent)) === px(parseFloat(one.fontSize)),
        one ? `${one.textIndent} vs ${one.fontSize}` : '(没量到)')

      const big = await openWithSettings({ fontSize: 26, textIndent: 2 })
      check('字号改到 26 后缩进跟着走（em 不是写死像素）',
        !!big && px(parseFloat(big.textIndent)) === px(26 * 2), big ? `${big.textIndent} vs ${big.fontSize}` : '(没量到)')

      const metrics = await openWithSettings({ lineHeight: 2.2, letterSpacing: 1, paragraphSpacing: 1.8 })
      check('行距 / 字距 / 段间距都落到了 computed style',
        !!metrics
        && px(parseFloat(metrics.lineHeight) / parseFloat(metrics.fontSize)) === 2.2
        && metrics.letterSpacing === '1px'
        && px(parseFloat(metrics.marginBottom) / parseFloat(metrics.fontSize)) === 1.8,
        metrics ? `行 ${metrics.lineHeight} · 字 ${metrics.letterSpacing} · 段 ${metrics.marginBottom} / ${metrics.fontSize}` : '(没量到)')

      // 「左右边距」：宽屏与窄屏都要真的改版心宽度（以前 ≤720px 被写死，是空控件）。
      // 桌面这档要用 1000px 窗口量：版心是 min(860, 100% - 2×边距)，窗口比 860+2×边距 还宽时
      // 本来就该由「版心宽度」封顶，那不是边距的活，用它做判据只会得到"两个值一样"的假红。
      const padSmall = await openWithSettings({ contentPadding: 20 }, 1000)
      const padLarge = await openWithSettings({ contentPadding: 120 }, 1000)
      check('桌面档：左右边距 20 → 120 时版心变窄',
        !!padSmall && !!padLarge && padLarge.contentWidth < padSmall.contentWidth,
        `${padSmall?.contentWidth}px → ${padLarge?.contentWidth}px`)

      const phoneSmall = await openWithSettings({ contentPadding: 20 }, 390)
      const phoneLarge = await openWithSettings({ contentPadding: 120 }, 390)
      check('手机档：左右边距仍然改版心宽度（不再被写死的 width 覆盖）',
        !!phoneSmall && !!phoneLarge && phoneLarge.contentWidth < phoneSmall.contentWidth,
        `${phoneSmall?.contentWidth}px → ${phoneLarge?.contentWidth}px`)
      check('手机档：正文不撑出横向滚动', !!phoneLarge && phoneLarge.docOverflowX <= 1, `溢出 ${phoneLarge?.docOverflowX}px`)

      // 抽屉是「排版 / 颜色 / 行为」三标签页（0.7.0 起），排版是默认档；
      // 首行缩进行是 .setting-choice[aria-label=首行缩进]，按钮组沿用 .page-modes 观感。
      // 点按钮当场生效（用户是从这里操作的，不是从 localStorage）。
      await openWithSettings({ textIndent: 2 }, 1440)
      await page.evaluate(() => document.querySelector('[data-testid="reader-header"] button[aria-label="阅读设置"]')?.click())
      await sleep(900)
      const drawer = await page.evaluate(() => {
        const tabs = [...document.querySelectorAll('.settings-tab')].map(node => ({
          label: node.textContent?.trim() ?? '',
          selected: node.getAttribute('aria-selected') === 'true',
        }))
        const group = document.querySelector('.setting-choice[aria-label="首行缩进"]')
        return {
          tabs,
          typographySelected: tabs.find(tab => tab.label === '排版')?.selected === true,
          indentLabel: group?.getAttribute('aria-label') ?? '',
          buttons: [...(group?.querySelectorAll('button') ?? [])].map(node => ({ text: node.textContent?.trim() ?? '', selected: node.className.includes('selected') })),
        }
      })
      check('设置抽屉是三标签页且「排版」默认选中',
        drawer.tabs.map(tab => tab.label).join('/') === '排版/颜色/行为' && drawer.typographySelected,
        drawer.tabs.map(tab => `${tab.label}${tab.selected ? '*' : ''}`).join(' '))
      check('排版页里有「首行缩进」三档按钮，且当前档是选中态',
        drawer.indentLabel === '首行缩进'
        && drawer.buttons.length === 3
        && drawer.buttons.filter(button => button.selected).length === 1,
        `${drawer.indentLabel}: ${drawer.buttons.map(button => `${button.text}${button.selected ? '*' : ''}`).join(' ')}`)

      const clicked = await page.evaluate(async () => {
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
        const buttons = [...(document.querySelector('.setting-choice[aria-label="首行缩进"] .page-modes')?.querySelectorAll('button') ?? [])]
        const zero = buttons.find(node => node.textContent?.trim() === '不缩进')
        zero?.click()
        await wait(700)
        const paragraph = document.querySelector('.reading-content p, .reader-paginated-column-body p')
        return {
          textIndent: paragraph ? getComputedStyle(paragraph).textIndent : '(没量到)',
          selected: [...(document.querySelectorAll('.setting-choice[aria-label="首行缩进"] button') ?? [])]
            .map(node => `${node.textContent?.trim()}${node.className.includes('selected') ? '*' : ''}`).join(' '),
        }
      })
      check('在抽屉里点「不缩进」当场就生效并记住选中态',
        clicked.textIndent === '0px' && clicked.selected.includes('不缩进*'),
        `text-indent ${clicked.textIndent} · ${clicked.selected}`)
      const persisted = await page.evaluate(key => {
        try { return JSON.parse(window.localStorage.getItem(key) ?? '{}').textIndent } catch { return '(读不到)' }
      }, SETTINGS_KEY)
      check('点完就落盘（下次进阅读器还是这一档）', persisted === 0, `localStorage.textIndent = ${JSON.stringify(persisted)}`)

      await page.screenshot({ path: path.join(SHOTS, 'typography-drawer.png') })
    }
  }
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
for (const item of results) if (item.ok === true) console.log(`  PASS ${item.name}  — ${item.detail}`)
console.log(`\nreader-typography-check: PASS ${pass} / FAIL ${fail} / NOTE ${skips}`)
process.exit(fail > 0 ? 1 : 0)
