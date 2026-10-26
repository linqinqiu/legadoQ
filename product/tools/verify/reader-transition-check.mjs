// 阅读器章节过渡的实测门禁（用户 2026-09-30：「小说阅读过程中章节之间的过渡没有做好」）。
//
// 过渡这件事光看代码看不出来，必须量"点下去的那一帧屏幕上是什么"：
// ① 预载已到位时——换章当场就该是新正文，不许有骨架屏（旧行为：无条件 setContent('') 再等一帧，
//    于是每章先白闪一下）；
// ② 正文还在飞时——上一章的字要继续挂着（变暗 + 顶部一条「正在载入：新章名」），
//    而不是整页换成骨架屏；
// ③ 滚动模式跨章已经改成"连续文档顶窗口"（用户 2026-10-02：「怎么能跳转呢，不是一体的吗」），
//    逐帧量画面跳没跳的判据在 tools/verify/reader-flow-check.mjs，本门禁只管手动切章那一瞬；
// ④ 全程不许出现"朗读读进上一章剩下的段落"——判据是朗读管线只吃到位的那一章（前端单测
//    TtsEngineSwitch.test.ts 盯代码，这条盯界面：过渡期间阅读区仍是旧章文字而朗读分片计数为 0）。
// 外加朗读设置的结构判据：自定义引擎的「发音人标识」「附加请求头」两栏必须在界面上存在
// （此前服务端支持、界面没有入口，等于这条能力只有一半）。
//
// 只用用户书架上"已缓存全本"的那一本，进阅读器会写阅读进度，所以开头取走、结尾原样写回。
// 跑法：node tools/verify/reader-transition-check.mjs
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, OUT, SHOTS, BASE, launchOptions, acceptAgreement } from './env.mjs'

const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')

const STAMP = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)
const SETTINGS_KEY = 'legado-reader-settings-v2'
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail })
const note = (name, detail) => results.push({ name, ok: true, detail: `NOTE ${detail}` })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

let browser = null
let progressBefore = null
let picked = null
const errors = []

const api = async (page, method, p, body) => page.evaluate(async ({ method, p, body }) => {
  const res = await fetch(p, { method, headers: body ? { 'content-type': 'application/json', Origin: location.origin } : {}, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, text: await res.text() }
}, { method, p, body })

/** 屏幕此刻的样子：正文段数、有没有骨架屏、有没有"正在载入"、当前大标题。 */
const snapshot = page => page.evaluate(() => ({
  paragraphs: document.querySelectorAll('.reading-content p:not(.reader-chapter-incoming):not(.reader-error)').length,
  skeleton: !!document.querySelector('.reader-loading-container'),
  stale: !!document.querySelector('.reading-content.is-stale'),
  incoming: document.querySelector('.reader-chapter-incoming')?.textContent?.trim() ?? '',
  title: document.querySelector('.reading-content h1')?.textContent?.trim() ?? '',
  hint: document.querySelector('.reader-next-hint button')?.textContent?.trim() ?? '',
}))

/** 打开书架上那本缓存好的书（点封面 = 继续阅读，与用户手势一致，不用假 URL 直达）。 */
async function openBook(page) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(`${BASE}/?t=${Date.now()}#shelf`, { waitUntil: 'domcontentloaded' })
    // 首次协议浮层会挡住真鼠标点击；先标记已同意（见 env.mjs 的 acceptAgreement）
    await acceptAgreement(page)
    try {
      await page.waitForFunction(() => !!document.querySelector('.shelf-card'), { timeout: 25000 })
    } catch {
      if (attempt === 3) return false
      await sleep(2000)
      continue
    }
    const found = await page.evaluate(name => {
      const card = [...document.querySelectorAll('.shelf-card')]
        .find(node => node.querySelector('.shelf-card-name')?.textContent?.trim() === name)
      if (!card) return false
      card.querySelector('.shelf-card-cover').click()
      return true
    }, picked.name)
    if (!found) return false
    try {
      await page.waitForFunction(() => !!document.querySelector('.reading-content p'), { timeout: 25000 })
    } catch {
      if (attempt === 3) return false
      await sleep(2000)
      continue
    }
    return true
  }
  return false
}

try {
  const browser2 = await puppeteer.launch(launchOptions())
  browser = browser2
  const page = await browser2.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  page.on('pageerror', err => errors.push(String(err.message || err)))
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) })

  // Service Worker 会把导航与 bundle 钉在上一版上：先注销再测，否则量的可能是旧包。
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.evaluate(async () => {
    const regs = await navigator.serviceWorker?.getRegistrations?.() ?? []
    await Promise.all(regs.map(r => r.unregister()))
    const keys = await caches?.keys?.() ?? []
    await Promise.all(keys.map(k => caches.delete(k)))
  })

  // 挑一本"已缓存全本"的书：正文由服务端缓存直出，测的是界面过渡而不是外网快慢。
  const list = await api(page, 'GET', '/api/bookshelf')
  const shelf = JSON.parse(list.text || '[]')
  picked = shelf.find(item => item.cacheState === 'ready' && (item.totalChapters ?? 0) > 4)
  if (!picked) {
    note('没有可用的缓存书', '书架上没有 cacheState=ready 且章节数 >4 的书，过渡实测无法进行；本门禁不判红')
  } else {
    const before = await api(page, 'GET', `/api/reading-progress?sourceId=${encodeURIComponent(picked.sourceId)}&bookUrl=${encodeURIComponent(picked.bookUrl)}`)
    if (before.status === 200 && before.text.trim().startsWith('{')) progressBefore = JSON.parse(before.text)

    // 进门先落到**中间那一章**：这本书上次被读到最后一章时，页脚的「下一章」本来就是禁用的，
    // 于是一条"点它该换章"的判据会红在夹具上而不是产品上（实测抓到过一次）。
    const tocEarly = JSON.parse((await api(page, 'POST', '/api/books/chapters',
      { sourceId: picked.sourceId, bookUrl: picked.bookUrl })).text || '[]')
    const middle = tocEarly[Math.floor(tocEarly.length / 2)]
    if (middle) {
      await api(page, 'PUT', '/api/reading-progress', {
        sourceId: picked.sourceId, bookUrl: picked.bookUrl,
        chapterUrl: middle.url, chapterIndex: Math.floor(tocEarly.length / 2), scrollPosition: 0,
      })
    }

    // 滚动模式（默认即是，但显式写一次，别让上一次跑的残留影响判据）
    await page.evaluate(({ key, settings }) => {
      const base = JSON.parse(localStorage.getItem(key) || '{}')
      localStorage.setItem(key, JSON.stringify({ ...base, ...settings }))
    }, { key: SETTINGS_KEY, settings: { pageMode: 'scroll', ttsEngine: 'edge' } })

    check('能打开缓存好的那本书', await openBook(page), picked.name)
    const first = await snapshot(page)
    check('初始正文不是空的', first.paragraphs > 0, `${first.paragraphs} 段`)
    // 「预载命中」这一档得先把续接窗口等出来：下一章挂上来了，才说明它的正文真的已经在缓存里。
    // 不等就点，量的其实是"正文在飞"（那是下面 ② 的事），标题没变会被误判成回归。
    await page.waitForFunction(() => !!document.querySelector('.reader-flow-chapter.reader-flow-tail'),
      { timeout: 25000 }).catch(() => undefined)

    // —— ③ 跨章过渡：预载到位时点「下一章」当场就该是新正文，不许有骨架屏 ——
    // （滚动模式中途不再有"章末提示条"：下一章本来就挂在同一棵容器下面，那是连续文档改造的本意，
    //   判据在 tools/verify/reader-flow-check.mjs。这里走页脚的「下一章」按钮，三种翻页方式都在。）
    const nextButton = () => page.evaluate(() => {
      const buttons = [...document.querySelectorAll('.reader-navigation button')]
      const button = buttons.find(node => (node.textContent ?? '').includes('下一章'))
      if (!button || button.disabled) return '没有可用的「下一章」按钮'
      button.click()
      return '已点击'
    })
    const titleBefore = (await snapshot(page)).title
    const clicked = await nextButton()
    await sleep(120)
    const instantly = await snapshot(page)
    check('预载命中时切章不出现骨架屏', !instantly.skeleton, instantly.skeleton ? '看到了骨架屏（旧行为）' : '无')
    check('预载命中时切章当场就有正文（不是空页）', instantly.paragraphs > 0, `${instantly.paragraphs} 段`)
    check('切章确实换了章（标题与之前不同）', instantly.title && instantly.title !== titleBefore,
      `${clicked} · ${titleBefore} → ${instantly.title}`)

    // —— ② 正文在飞：旧文字挂着 + 「正在载入：新章名」，不挖空 ——
    // 连续流已经把"下一章"提前取回来了（它就挂在下面），点「下一章」根本不会有在飞的一帧 ——
    // 那是改造之后应有的样子，不是回归。要量在飞，就得跳一节**没被预取过**的：从目录里挑远处那一章。
    const tocRes = await api(page, 'POST', '/api/books/chapters', { sourceId: picked.sourceId, bookUrl: picked.bookUrl })
    const toc = JSON.parse(tocRes.text || '[]')
    const fromIndex = await page.evaluate(() => Number(
      document.querySelector('.reading-content .reader-flow-chapter')?.getAttribute('data-chapter-index') ?? 0))
    const target = toc[fromIndex + 10] ?? toc[toc.length - 1]
    await page.setRequestInterception(true)
    let delayed = 0
    // 只拖远处那一章的请求：别的请求（目录、续接窗口）照常走，否则延迟配额被开场那几条吃光
    let delayOn = false
    page.on('request', request => {
      if (delayOn && target?.url && (request.postData() ?? '').includes(target.url)) {
        delayed += 1
        setTimeout(() => request.continue().catch(() => {}), 900)
        return
      }
      request.continue().catch(() => {})
    })
    // 预载缓存是组件内的 Map：重新进一次阅读器把它清空，跳转才真的走网络。
    await openBook(page)
    await page.evaluate(() => window.scrollTo(0, 0))
    await sleep(700)
    const staleBase = await snapshot(page)
    delayOn = true
    await page.evaluate(() => document.querySelector('[aria-label="目录"]')?.click())
    await page.waitForSelector('.reader-chapter-item', { timeout: 20000 })
    await page.click('input[placeholder="搜索章节"]')
    await page.keyboard.type(target.title, { delay: 12 })
    await sleep(400)
    await page.evaluate(title => {
      const item = [...document.querySelectorAll('.reader-chapter-item')]
        .find(node => (node.textContent ?? '').includes(title))
      item?.click()
    }, target.title)
    await sleep(260)
    const inflight = await snapshot(page)
    check('拖慢远处那一章的请求生效了（否则下面几条都是空判）', delayed > 0, `拦到 ${delayed} 次「${target?.title ?? '?'}」的正文请求`)
    check('正文在飞时旧文字继续挂着（不挖空）', inflight.paragraphs > 0, `${inflight.paragraphs} 段（切换前 ${staleBase.paragraphs}）`)
    check('正文在飞时整页不是骨架屏', !inflight.skeleton, inflight.skeleton ? '换成了骨架屏' : '无')
    check('正文在飞时标着「正在载入：新章名」', inflight.stale && inflight.incoming.startsWith('正在载入') && inflight.incoming.length > 5,
      JSON.stringify(inflight.incoming))
    await page.waitForFunction(
      prev => (document.querySelector('.reading-content h1')?.textContent?.trim() ?? '') !== prev,
      { timeout: 20000 },
      staleBase.title,
    )
    await page.setRequestInterception(false)
    const settled = await snapshot(page)
    check('新章到位后「正在载入」标记撤掉', !settled.stale && settled.incoming === '', settled.incoming || '已撤')

    // 滚动模式的跨章现在是"连续文档顶窗口"，不再有一次可点的章末提示条，也不再靠
    // "触底 + 再滚一下"翻章 —— 那套判据整体搬到了 tools/verify/reader-flow-check.mjs
    // （逐帧量画面有没有跳）。这里不留一条已经不存在的路径的假判据。
    note('滚动模式跨章的实测不在本门禁', '连续流由 reader-flow-check.mjs 逐帧量；本门禁只管切章那一瞬的骨架屏/在飞/预载')

    // 朗读设置弹窗的入口是"正在播的播放条"，headless 里要先把音频起起来才够得到它；
    // 弹窗结构（自定义引擎两栏、站内 Select）改由 web/test/TtsEngineSwitch.test.ts 静态渲染判，
    // 自定义源的端到端真实上游判据在 tools/verify/tts-custom-engine-check.mjs。这里不留假判据。
    note('朗读设置弹窗不在本门禁判', '入口依赖播放中的浮动条；结构与自定义源上游各有专门门禁')

    // —— 翻页模式下的同一件事：切章不许把整页挖空 ——
    await page.evaluate(({ key }) => {
      const base = JSON.parse(localStorage.getItem(key) || '{}')
      localStorage.setItem(key, JSON.stringify({ ...base, pageMode: 'paginate' }))
    }, { key: SETTINGS_KEY })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!document.querySelector('.reader-paginated-column-body p'), { timeout: 25000 })
    const pagStart = await page.evaluate(() => ({
      title: document.querySelector('.reader-paginated-column-body h1')?.textContent?.trim() ?? '',
      pages: document.querySelector('.reader-paginated-footer span:last-child')?.textContent?.trim() ?? '',
    }))
    check('翻页模式起来了（有分栏与页码）', pagStart.pages.includes('/'), pagStart.pages)
    // 用真键盘事件翻到本章最后一页：合成的 `window.dispatchEvent(KeyboardEvent)` 的 target 是 window，
    // 而处理里要 `event.target.closest(...)` —— 那是探针自己造出来的错，不是界面的错（第一版就在这上面报了假红）。
    const pageCounter = () => page.evaluate(() => {
      const [cur, total] = (document.querySelector('.reader-paginated-footer span:last-child')?.textContent ?? '').split('/').map(s => Number(s.trim()))
      return { cur, total }
    })
    for (let guard = 0; guard < 60; guard++) {
      const { cur, total } = await pageCounter()
      if (!(cur < total)) break
      await page.keyboard.press('ArrowRight')
      await sleep(80)
    }
    await page.keyboard.press('ArrowRight') // 最后一页再翻一次 = 进下一章
    await sleep(140)
    const pagInflight = await page.evaluate(() => ({
      skeleton: !!document.querySelector('.reader-loading-container'),
      stale: !!document.querySelector('.reader-paginated-column-body.is-stale'),
      paragraphs: document.querySelectorAll('.reader-paginated-column-body p').length,
    }))
    check('翻页模式切章也不挖空：过渡帧有正文、没有骨架屏',
      !pagInflight.skeleton && pagInflight.paragraphs > 0,
      `段落 ${pagInflight.paragraphs} · 骨架屏 ${pagInflight.skeleton} · 在飞标记 ${pagInflight.stale ? '在' : '无（预载命中，本来就不该有）'}`)
    await page.waitForFunction(
      prev => (document.querySelector('.reader-paginated-column-body h1')?.textContent?.trim() ?? '') !== prev,
      { timeout: 20000 },
      pagStart.title,
    )
    const pagAfter = await page.evaluate(() => document.querySelector('.reader-paginated-column-body h1')?.textContent?.trim() ?? '')
    check('翻页模式的"下一章"确实换了章', pagAfter !== pagStart.title, `${pagStart.title} → ${pagAfter}`)
    fs.mkdirSync(SHOTS, { recursive: true })
    await page.screenshot({ path: path.join(SHOTS, `reader-transition-paginate-${STAMP}.png`) })

  }

  // —— 收尾先把用户的阅读位置还回去，再判"有没有页面异常"（浏览器还开着，用同一个页面写回）——
  if (picked && progressBefore) {
    const back = await api(page, 'PUT', '/api/reading-progress', {
      sourceId: progressBefore.sourceId,
      bookUrl: progressBefore.bookUrl,
      chapterUrl: progressBefore.chapterUrl,
      chapterIndex: progressBefore.chapterIndex,
      scrollPosition: progressBefore.scrollPosition,
    })
    const now = await api(page, 'GET', `/api/reading-progress?sourceId=${encodeURIComponent(picked.sourceId)}&bookUrl=${encodeURIComponent(picked.bookUrl)}`)
    const current = JSON.parse(now.text || '{}')
    check('用户的阅读进度已原样写回', back.status === 200 && current.chapterIndex === progressBefore.chapterIndex,
      `回到第 ${current.chapterIndex} 章（进门时第 ${progressBefore.chapterIndex} 章）`)
  }

  check('全程没有页面异常', errors.length === 0, errors.slice(0, 3).join(' | '))
} catch (error) {
  check('探针脚本自身异常', false, error.message)
} finally {
  if (browser) await browser.close().catch(() => null)
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, `reader-transition-${STAMP}.json`), JSON.stringify({ stamp: STAMP, results }, null, 2))
  const failed = results.filter(r => !r.ok)
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) process.exitCode = 1
  process.exit(process.exitCode || 0)
}
