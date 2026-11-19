// 正文取用去重端到端判据（R3 出口）：续接窗口与预取对同一章只发一次请求。
//
// D1 现场：滚动到 70% 触发 preloadNextChapter(取 index+1)；同一时刻续接窗口也在取 index+1。
// 旧实现里 preload 用 preloadedRef.has || preloadingRef.has 去重，续接窗口只查 preloadedRef，
// 于是同一章在飞时会各发一次。R3 把两条路径收进 hook 的 fetchContent（在飞复用同一 Promise）。
//
// 本脚本复现那个并发：先让续接窗口对「第 2 章」的请求停在在飞状态，再滚到 70% 触发 preload
// 对同一章的请求，断言该章仍只被请求一次。若未来移除去重，这里会变 2 次并红。
//
// 需要隔离的 Vite dev origin（LEGADO_WEB_URL，默认 http://127.0.0.1:5174）：
//   cd product/web && npm run dev            # 另开终端，固定 127.0.0.1:5174
//   LEGADO_CHROME=<chrome/edge 路径> node product/tools/verify/reader-content-dedup-check.mjs
// 连不上 origin 时按「没测到」处理（NOTE + exit 0），与「测了但坏了」分开。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { SHOTS as DEFAULT_SHOTS, chromePath, launchOptions } from './env.mjs'

const require = createRequire(path.join(import.meta.dirname, '../../web/package.json'))
const puppeteer = require('puppeteer-core')
const BASE = new URL(process.env.LEGADO_WEB_URL || 'http://127.0.0.1:5174')
const SHOTS = path.resolve(process.env.SHOTS || DEFAULT_SHOTS)
const FIXTURE_PATH = '/__reader-content-dedup-check'
const TIMEOUT = 15000
const SOURCE = 'reader-content-dedup-source'
const BOOK = 'https://reader-content-dedup.invalid/book'
const START = 0 // 锚点第 1 章：续接窗口取 index 1/2，preloadNextChapter 也取 index 1 —— 正是 D1 碰撞点。
const chapters = Array.from({ length: 5 }, (_, index) => ({
  index, title: `第${index + 1}章 去重验证`, url: `${BOOK}/chapter/${index}`,
}))
const contents = chapters.map(chapter => Array.from({ length: 64 }, (_, paragraph) =>
  `〔验证${chapter.index + 1}-${paragraph + 1}〕这是专为浏览器回归编写的中文排版材料，不是小说摘录。`
  + '今天我们记录窗边的光线、纸张的位置和翻阅时的停留点。每段文字都有明确编号，便于检查画面确实移动。'
  + '阅读器在滚动到后段时会预取下一章，同时续接窗口也会取同一章；两者不应重复向服务端要同一份正文。',
).join('\n\n'))
const details = { sourceId: SOURCE, name: '正文去重测试夹具', author: '回归脚本', tocUrl: `${BOOK}/toc`, sourceType: 0, coverUrl: '' }
const openBook = { details, bookUrl: BOOK, chapters }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function eventually(predicate, message, timeout = TIMEOUT) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await pause(35)
  }
  throw new Error(`超时：${message}`)
}

function validateIdentity(body) {
  assert.equal(body.sourceId, SOURCE, 'sourceId 必须属于夹具')
  assert.equal(body.bookUrl, BOOK, 'bookUrl 必须属于夹具')
}

function fixtureModule() {
  return `const policy = document.createElement('meta');
policy.httpEquiv = 'Content-Security-Policy';
policy.content = "worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'";
document.head.appendChild(policy);
const NativeWebSocket = window.WebSocket;
window.WebSocket = class extends NativeWebSocket {
  constructor(url, protocols) {
    const target = new URL(url, location.href);
    const expected = new URL(location.origin); expected.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Request interception does not cover websocket frames: allow Vite HMR only, no API sockets.
    if (target.origin !== expected.origin || target.pathname !== '/' || protocols !== 'vite-hmr') {
      console.error('Fixture blocked websocket: ' + target.href);
      throw new Error('Unexpected websocket');
    }
    super(url, protocols);
  }
};
const { ReaderScreen } = await import('/src/features/reader/ReaderScreen.tsx');
const { defaultReaderSettings } = await import('/src/features/reader/settingsPanel/readerSettings.ts');
const { default: React } = await import('/node_modules/.vite/deps/react.js');
const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
await import('/src/styles.css');
await import('/src/ui/material/glass.css');
const book = ${JSON.stringify(openBook)};
function Fixture() {
  const [open, setOpen] = React.useState(true);
  const [settings, setSettings] = React.useState({ ...defaultReaderSettings,
    pageMode: 'scroll', pageAnim: 'none', columnMode: 'single', scriptMode: 'off', ttsEngine: 'webSpeech' });
  React.useLayoutEffect(() => {
    window.__contentDedupCheck = { isOpen: open, close: () => setOpen(false) };
  }, [open]);
  return open ? React.createElement(ReaderScreen, { openBook: book, startIndex: ${START}, settings,
    onSettingsChange: setSettings, onClose: () => setOpen(false), sources: [] })
    : React.createElement('p', { id: 'reader-closed' }, '阅读器已关闭');
}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Fixture));`
}

class DedupHarness {
  constructor(page) {
    this.page = page
    this.contentCounts = new Map() // chapterUrl -> 请求次数
    this.contentRows = []
    this.holdUrl = null
    this.heldRow = null
    this.gate = null
    this.tasks = new Set()
    this.violations = []
    this.errors = []
  }

  holdFirstFor(url) {
    assert.equal(this.holdUrl, null, '只能 hold 一个目标章节')
    let release
    this.holdUrl = url
    this.gate = { promise: new Promise(resolve => { release = resolve }), release: () => release() }
  }

  release() {
    if (this.gate) this.gate.release()
  }

  async install() {
    const page = this.page
    await page.setBypassServiceWorker(true)
    await page.setCacheEnabled(false)
    await page.setRequestInterception(true)
    page.on('pageerror', error => this.errors.push(String(error.stack || error)))
    page.on('request', req => {
      const task = this.route(req).catch(async error => {
        this.violations.push(`${req.method()} ${req.url()}: ${error.message}`)
        if (!req.isInterceptResolutionHandled()) await req.abort().catch(() => {})
      })
      this.tasks.add(task)
      void task.then(() => this.tasks.delete(task))
    })
  }

  async route(req) {
    const url = new URL(req.url())
    const method = req.method()
    const pathname = decodeURIComponent(url.pathname)
    const json = (body, status = 200) => req.respond({
      status, contentType: 'application/json; charset=utf-8',
      headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify(body),
    })
    if (url.protocol === 'data:' || url.protocol === 'blob:') return req.continue()
    if (url.origin !== BASE.origin) throw new Error('禁止外部网络')
    if (pathname === FIXTURE_PATH && method === 'GET') return req.continue()
    if (pathname === '/src/main.tsx' && method === 'GET') return req.respond({
      status: 200, contentType: 'application/javascript; charset=utf-8', body: fixtureModule(),
      headers: { 'Cache-Control': 'no-store' },
    })
    if (['/favicon.ico', '/favicon-32.png', '/favicon-48.png', '/apple-touch-icon.png'].includes(pathname)
      && method === 'GET') return req.respond({ status: 204 })
    const body = req.postData() ? JSON.parse(req.postData()) : {}
    if (pathname === '/healthz' && method === 'GET') return json({ status: 'ok', version: 'fixture', rev: 0, sha: 'fixture' })
    if (pathname === '/api/auth/status' && method === 'GET') return json({ authenticated: true, csrfToken: 'fixture-only' })
    if (pathname === '/api/books/content' && method === 'POST') {
      validateIdentity(body)
      const chapter = chapters.find(item => item.url === body.chapterUrl)
      assert.ok(chapter, '不允许读取夹具以外的正文')
      const count = (this.contentCounts.get(body.chapterUrl) ?? 0) + 1
      this.contentCounts.set(body.chapterUrl, count)
      const row = { url: body.chapterUrl, index: chapter.index, count, at: Date.now(), replyAt: null }
      this.contentRows.push(row)
      // 目标章节的首个请求停在在飞状态，让 preload 撞上同一章（D1 现场）。
      if (this.holdUrl === body.chapterUrl && count === 1) {
        this.heldRow = row
        await this.gate.promise
      }
      row.replyAt = Date.now()
      return json({ title: chapter.title, content: contents[chapter.index] })
    }
    if (pathname === '/api/books/details' && method === 'POST') { validateIdentity(body); return json(details) }
    if (pathname === '/api/books/chapters' && method === 'POST') {
      assert.equal(body.sourceId, SOURCE)
      assert.ok([BOOK, details.tocUrl].includes(body.bookUrl))
      return json(chapters)
    }
    if (pathname === '/api/bookshelf' && method === 'GET') return json([{
      sourceId: SOURCE, bookUrl: BOOK, name: details.name, author: details.author, tocUrl: details.tocUrl,
      chapterIndex: START, scrollPosition: 0, lastReadAt: 1, cachedChapters: 0,
      totalChapters: chapters.length, cacheState: 'idle', completed: false,
    }])
    if (pathname === '/api/bookshelf/cached-chapters' && method === 'GET') return json({ cachedChapterUrls: [], cachedWordCounts: [] })
    if (pathname === '/api/notes' && method === 'GET') return json([])
    if (['/api/replace-rules', '/api/tts/voices'].includes(pathname) && method === 'GET') return json([])
    if (pathname === '/api/reading-progress' && (method === 'PUT' || method === 'GET')) return json(null)
    if (pathname === '/api/reading-log' && method === 'POST') return json({ ...body, id: 1, createdAt: Date.now() })
    if (pathname === '/api' || pathname.startsWith('/api/') || pathname.startsWith('/healthz')) {
      throw new Error('未列入 stub 的 API')
    }
    const viteModule = ['/@vite/client', '/@react-refresh'].includes(pathname)
      || ((pathname.startsWith('/src/') || pathname.startsWith('/node_modules/'))
        && /\.(?:tsx?|jsx?|mjs|css|svg|png|woff2?|ttf)$/.test(pathname))
    if (method === 'GET' && viteModule && !pathname.split('/').includes('..')) return req.continue()
    throw new Error('未列入白名单的开发资源')
  }

  /** 等第 1 章渲染完成，且第 2 章请求已进入在飞（被 hold）。 */
  async ready() {
    await this.page.waitForFunction(() => {
      const root = document.querySelector('.reading-content')
      return window.__contentDedupCheck?.isOpen && root?.querySelectorAll('p').length >= 30
        && root.textContent.includes('〔验证1-1〕') && !document.querySelector('.reader-error')
    }, { timeout: 45000 })
    await eventually(() => this.heldRow, '第 2 章请求进入延迟响应')
  }

  /** 滚到锚点章指定比例，返回真实几何算出的 fraction。 */
  async scroll(fraction) {
    return this.page.evaluate(async fraction => {
      const section = document.querySelector('.reading-content .reader-flow-chapter')
      if (!section || section.offsetHeight < innerHeight * 4) throw new Error('滚动夹具必须超过四屏')
      const top = scrollY + section.getBoundingClientRect().top
      scrollTo({ top: top + fraction * (section.offsetHeight - innerHeight), behavior: 'instant' })
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const current = document.querySelector('.reading-content .reader-flow-chapter')
      const currentTop = scrollY + current.getBoundingClientRect().top
      return Math.max(0, Math.min(1, (scrollY - currentTop) / (current.offsetHeight - innerHeight)))
    }, fraction)
  }

  async waitFlowTail() {
    await this.page.waitForFunction(() => {
      const sections = document.querySelectorAll('.reading-content .reader-flow-chapter')
      return sections.length >= 2 && document.querySelector('.reading-content')?.textContent.includes('〔验证2-1〕')
    }, { timeout: 20000 })
  }

  countFor(url) {
    return this.contentCounts.get(url) ?? 0
  }

  async cleanup() {
    this.release()
    if (await this.page.evaluate(() => !!window.__contentDedupCheck?.isOpen).catch(() => false)) {
      await this.page.evaluate(() => window.__contentDedupCheck?.close()).catch(() => {})
    }
    await Promise.all([...this.tasks])
    assert.deepEqual(this.violations, [], '网络白名单或拦截器错误')
    assert.deepEqual(this.errors, [], 'pageerror / unhandled rejection')
  }
}

async function screenshot(page, filename) {
  const destination = path.join(SHOTS, filename)
  await page.screenshot({ path: destination, fullPage: false })
  console.log(`SHOT ${destination}`)
}

let browser
let failures = 0
let passed = 0

try {
  assert.ok(['http:', 'https:'].includes(BASE.protocol) && BASE.pathname === '/' && !BASE.search && !BASE.hash,
    'LEGADO_WEB_URL 必须是 Vite 服务 origin，不含路径、查询或 hash')
  // 连不上就按「没测到」处理，不把缺环境误判成产品坏了。
  const reachable = await fetch(new URL('/@vite/client', BASE.origin)).then(r => r.ok).catch(() => false)
  if (!reachable) {
    console.log(`NOTE reader-content-dedup-check: 未发现 Vite dev origin ${BASE.origin}（先 cd product/web && npm run dev）；跳过`)
    process.exit(0)
  }
  assert.ok(chromePath(), '请通过 LEGADO_CHROME 指定 Chrome/Edge')
  fs.mkdirSync(SHOTS, { recursive: true })
  browser = await puppeteer.launch(launchOptions())

  const context = await browser.createBrowserContext() // 隔离 IndexedDB/离线正文缓存
  const page = await context.newPage()
  page.setDefaultTimeout(TIMEOUT)
  await page.setViewport({ width: 1100, height: 844, deviceScaleFactor: 1 })
  const harness = new DedupHarness(page)
  const target = chapters[1].url // 第 2 章：续接窗口与 preloadNextChapter 的碰撞点
  harness.holdFirstFor(target)
  try {
    await harness.install()
    await page.goto(new URL(FIXTURE_PATH, BASE.origin).href, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await harness.ready()
    assert.equal(harness.countFor(target), 1, '第 2 章首个请求必须来自续接窗口（此时应只 1 次）')

    // 滚到 70%：scroll 监听触发 preloadNextChapter(0)，它也取第 2 章。
    const fraction = await harness.scroll(0.72)
    assert.ok(fraction >= 0.7, `滚动未到 70% 阈值，preload 不会被触发：fraction=${fraction}`)
    // 给 rAF + preload 足够时间：若去重失效，第二次请求会在这里发生。
    await pause(700)
    assert.equal(harness.countFor(target), 1,
      `在飞期间 preload 重复请求了同一章：期望 1 次，实际 ${harness.countFor(target)} 次`)

    // 放行在飞请求，续接窗口应正常把第 2、3 章挂到窗口下方（行为不变）。
    harness.release()
    await harness.waitFlowTail()
    // 续接窗口一次取 2 章：先断言第 2、3 章都在且索引对得上（滚动前，避免推进重排干扰）。
    const tailIndexes = await page.evaluate(() => [...document.querySelectorAll('.reading-content .reader-flow-chapter')]
      .map(node => Number(node.dataset.chapterIndex)))
    assert.ok(tailIndexes.includes(1) && tailIndexes.includes(2),
      `续接窗口应挂入第 2、3 章，实际索引 ${JSON.stringify(tailIndexes)}`)
    // 截图第 2 章
    await page.evaluate(() => {
      const second = document.querySelectorAll('.reading-content .reader-flow-chapter')[1]
      if (second) scrollTo({ top: scrollY + second.getBoundingClientRect().top - 16, behavior: 'instant' })
    })
    await pause(300)
    await screenshot(page, 'reader-content-dedup-flowtail.png')
    // 截图第 3 章：先把它滚进视口（可能触发续接推进 + holdScroll 校正），
    // 等重排稳定后按 data-chapter-index 重新定位它，滚到顶部截标题 + 首段。
    await page.evaluate(() => document.querySelector('.reading-content [data-chapter-index="2"]')?.scrollIntoView())
    await pause(800)
    await page.evaluate(() => {
      const third = document.querySelector('.reading-content [data-chapter-index="2"]')
      if (third) scrollTo({ top: scrollY + third.getBoundingClientRect().top - 16, behavior: 'instant' })
    })
    await pause(500)
    await screenshot(page, 'reader-content-dedup-flowtail-ch3.png')
    assert.equal(harness.countFor(target), 1, '放行后不应再补发第 2 章请求')

    // 第 4 章（index 3）不在初始续接窗口：推进到第 3 章后，续接窗口才会续取它。
    // 先看推进是否已带出第 4 章，不在则滚到第 3 章底部再推一次。
    const has4 = await page.evaluate(() => !!document.querySelector('.reading-content [data-chapter-index="3"]'))
    if (!has4) {
      await page.evaluate(() => {
        const third = document.querySelector('.reading-content [data-chapter-index="2"]')
        if (third) scrollTo({ top: scrollY + third.getBoundingClientRect().top + third.offsetHeight - innerHeight + 120, behavior: 'instant' })
      })
      await pause(900)
    }
    await page.waitForFunction(() => !!document.querySelector('.reading-content [data-chapter-index="3"]'), { timeout: 12000 })
    await page.evaluate(() => {
      const fourth = document.querySelector('.reading-content [data-chapter-index="3"]')
      if (fourth) scrollTo({ top: scrollY + fourth.getBoundingClientRect().top - 16, behavior: 'instant' })
    })
    await pause(500)
    await screenshot(page, 'reader-content-dedup-flowtail-ch4.png')

    // 第 5 章（index 4，末章）：推进到第 4 章后由续接窗口续取。
    const has5 = await page.evaluate(() => !!document.querySelector('.reading-content [data-chapter-index="4"]'))
    if (!has5) {
      await page.evaluate(() => {
        const fourth = document.querySelector('.reading-content [data-chapter-index="3"]')
        if (fourth) scrollTo({ top: scrollY + fourth.getBoundingClientRect().top + fourth.offsetHeight - innerHeight + 120, behavior: 'instant' })
      })
      await pause(900)
    }
    await page.waitForFunction(() => !!document.querySelector('.reading-content [data-chapter-index="4"]'), { timeout: 12000 })
    await page.evaluate(() => {
      const fifth = document.querySelector('.reading-content [data-chapter-index="4"]')
      if (fifth) scrollTo({ top: scrollY + fifth.getBoundingClientRect().top - 16, behavior: 'instant' })
    })
    await pause(500)
    await screenshot(page, 'reader-content-dedup-flowtail-ch5.png')
  } finally {
    try { await harness.cleanup() } catch (error) {
      failures += 1
      console.error(`FAIL cleanup: ${error.message}`)
    }
    await context.close().catch(() => {})
  }
  passed += 1
  console.log('PASS 续接窗口与预取对同一章只请求一次（D1 在飞去重）')
} catch (error) {
  failures += 1
  console.error(`FAIL reader-content-dedup-check: ${error.message}`)
} finally {
  if (browser) {
    try { await browser.close() } catch (error) {
      failures += 1
      console.error(`FAIL browser.close: ${error.message}`)
    }
  }
  console.log(`reader-content-dedup-check: ${passed} pass, ${failures} fail`)
  if (failures) process.exitCode = 1
}
