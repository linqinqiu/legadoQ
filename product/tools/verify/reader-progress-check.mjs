// Requires an isolated Vite origin (LEGADO_WEB_URL); all API responses are intercepted.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { SHOTS as DEFAULT_SHOTS, chromePath, launchOptions } from './env.mjs'

const require = createRequire(path.join(import.meta.dirname, '../../web/package.json'))
const puppeteer = require('puppeteer-core')
const BASE = new URL(process.env.LEGADO_WEB_URL || 'http://127.0.0.1:5174')
const SHOTS = path.resolve(process.env.SHOTS || DEFAULT_SHOTS)
const FIXTURE_PATH = '/__reader-progress-check'
const THROTTLE = 1200
const TIMEOUT = 10000
const SOURCE = 'reader-progress-check-source'
const BOOK = 'https://reader-progress-check.invalid/book'
const START = 1 // Nonzero chapter index catches accidental/default chapter-zero saves.
const chapters = Array.from({ length: 3 }, (_, index) => ({
  index, title: `第${index + 1}章 进度验证记录`, url: `${BOOK}/chapter/${index}`,
}))
const contents = chapters.map(chapter => Array.from({ length: 64 }, (_, paragraph) =>
  `〔验证${chapter.index + 1}-${paragraph + 1}〕这是专为浏览器回归编写的中文排版材料，不是小说摘录。`
  + '今天我们记录窗边的光线、纸张的位置和翻阅时的停留点。每段文字都有明确编号，便于检查画面确实移动。'
  + '即使保存请求暂时失败，读者仍应能够继续阅读；网络恢复以后，最后停下的位置应当被完整记住。',
).join('\n\n'))
const details = { sourceId: SOURCE, name: '阅读进度测试夹具', author: '回归脚本', tocUrl: `${BOOK}/toc`, sourceType: 0, coverUrl: '' }
const openBook = { details, bookUrl: BOOK, chapters }
const mangaContent = Array.from({ length: 6 }, (_, index) => `![页${index + 1}](/api/reader-progress-check-image/${index}.svg)`).join('\n\n')
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

function validateProgress(body, chapterIndex = START) {
  validateIdentity(body)
  assert.equal(body.chapterIndex, chapterIndex, '保存的章节 index 错误')
  assert.equal(body.chapterUrl, chapters[chapterIndex]?.url, '保存的章节 URL 错误')
  assert.equal(typeof body.scrollPosition, 'number')
  assert.ok(Number.isFinite(body.scrollPosition) && body.scrollPosition >= 0 && body.scrollPosition <= 1)
  assert.ok(body.updatedAt > 0, '保存时间不能为空')
  if (body.charOffset != null) {
    assert.ok(Number.isInteger(body.charOffset) && body.charOffset >= 0)
    assert.equal(body.positionVersion, 1)
  }
}

function assertPosition(row, snapshot) {
  assert.ok(row, '必须实际收到 PUT，不能把空请求列表当成功')
  validateProgress(row.body, snapshot.chapterIndex)
  assert.ok(row.body.scrollPosition > 0, '必须保存非零位置')
  assert.ok(Math.abs(row.body.scrollPosition - snapshot.fraction) < 0.008,
    `不是最新 DOM 位置：saved=${row.body.scrollPosition}, visible=${snapshot.fraction}`)
}

function fixtureModule(mode) {
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
const book = ${JSON.stringify({ ...openBook, details: { ...details, sourceType: mode === 'manga' ? 2 : 0 } })};
function Fixture() {
  const [open, setOpen] = React.useState(true);
  const [settings, setSettings] = React.useState({ ...defaultReaderSettings,
    pageMode: ${JSON.stringify(mode === 'manga' ? 'scroll' : mode)}, pageAnim: 'none', columnMode: 'single',
    mangaSinglePage: true, mangaSpread: false, ttsEngine: 'webSpeech', scriptMode: 'off' });
  React.useLayoutEffect(() => {
    window.__readerProgressCheck = {
      pageMode: settings.pageMode, isOpen: open,
      setPageMode: pageMode => setSettings(previous => ({ ...previous, pageMode })),
      close: () => setOpen(false),
    };
  }, [open, settings.pageMode]);
  return open ? React.createElement(ReaderScreen, { openBook: book, startIndex: ${START}, settings,
    onSettingsChange: setSettings, onClose: () => setOpen(false), sources: [] })
    : React.createElement('p', { id: 'reader-closed' }, '阅读器已关闭');
}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Fixture));`
}

class FixtureBrowser {
  constructor(page, mode) {
    this.page = page
    this.mode = mode
    this.saves = []
    this.active = new Map()
    this.peak = 0
    this.replyStatus = 200
    this.nextGate = null
    this.gates = new Set()
    this.tasks = new Set()
    this.violations = []
    this.errors = []
    this.consoleErrors = []
    this.contentRequests = new Set()
  }

  holdNext() {
    assert.equal(this.nextGate, null, '不能覆盖尚未使用的延迟响应')
    let release
    const gate = { promise: new Promise(resolve => { release = resolve }), release: () => release(), row: null }
    this.nextGate = gate
    this.gates.add(gate)
    return gate
  }

  async install() {
    const page = this.page
    await page.setBypassServiceWorker(true)
    await page.setCacheEnabled(false)
    await page.setRequestInterception(true)
    page.on('pageerror', error => this.errors.push(String(error.stack || error)))
    page.on('console', message => {
      if (message.type() === 'error') this.consoleErrors.push({
        text: message.text(), url: message.location().url, args: message.args().length, at: Date.now(),
      })
    })
    const finish = req => {
      const row = this.active.get(req)
      if (row) { row.finishedAt = Date.now(); this.active.delete(req) }
    }
    page.on('requestfinished', finish)
    page.on('requestfailed', req => {
      finish(req)
      this.violations.push(`requestfailed ${req.method()} ${req.url()}: ${req.failure()?.errorText}`)
    })
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
    // data: and blob: contain no network data. Everything else must use the Vite origin.
    if (url.protocol === 'data:' || url.protocol === 'blob:') return req.continue()
    if (url.origin !== BASE.origin) throw new Error('禁止外部网络')
    // Keep Vite's real document response so local-network classification and React refresh stay intact.
    if (pathname === FIXTURE_PATH && method === 'GET') return req.continue()
    if (pathname === '/src/main.tsx' && method === 'GET') return req.respond({
      status: 200, contentType: 'application/javascript; charset=utf-8', body: fixtureModule(this.mode),
      headers: { 'Cache-Control': 'no-store' },
    })
    if (['/favicon.ico', '/favicon-32.png', '/favicon-48.png', '/apple-touch-icon.png'].includes(pathname)
      && method === 'GET') return req.respond({ status: 204 })
    const body = req.postData() ? JSON.parse(req.postData()) : {}
    const queryIdentity = () => validateIdentity(Object.fromEntries(url.searchParams))
    if (pathname === '/healthz' && method === 'GET') return json({ status: 'ok', version: 'fixture', rev: 0, sha: 'fixture' })
    if (pathname === '/api/auth/status' && method === 'GET') return json({ authenticated: true, csrfToken: 'fixture-only' })
    if (pathname === '/api/reading-progress' && method === 'PUT') {
      validateProgress(body)
      const gate = this.nextGate
      this.nextGate = null
      const row = { body, status: this.replyStatus, at: Date.now(), url: req.url(), replyAt: null, finishedAt: null }
      this.saves.push(row)
      this.active.set(req, row)
      this.peak = Math.max(this.peak, this.active.size)
      if (gate) {
        gate.row = row
        await gate.promise
        this.gates.delete(gate)
      }
      row.replyAt = Date.now()
      return json(row.status === 503 ? { message: 'fixture: intentional progress PUT failure' } : body, row.status)
    }
    if (pathname === '/api/reading-progress' && method === 'GET') {
      queryIdentity()
      return json(this.saves.findLast(row => row.status === 200 && row.replyAt)?.body ?? null)
    }
    if (pathname === '/api/books/content' && method === 'POST') {
      validateIdentity(body)
      const chapter = chapters.find(item => item.url === body.chapterUrl)
      assert.ok(chapter, '不允许读取夹具以外的正文')
      this.contentRequests.add(chapter.index)
      return json({ title: chapter.title, content: this.mode === 'manga' ? mangaContent : contents[chapter.index] })
    }
    if (/^\/api\/reader-progress-check-image\/[0-5]\.svg$/.test(pathname) && method === 'GET') return req.respond({
      status: 200, contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600" fill="#ddd"/></svg>',
    })
    if (pathname === '/api/books/details' && method === 'POST') {
      validateIdentity(body)
      return json({ ...details, sourceType: this.mode === 'manga' ? 2 : 0 })
    }
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
    if (pathname === '/api/bookshelf/cached-chapters' && method === 'GET') {
      queryIdentity()
      return json({ cachedChapterUrls: [], cachedWordCounts: [] })
    }
    if (pathname === '/api/notes' && method === 'GET') { queryIdentity(); return json([]) }
    if (['/api/replace-rules', '/api/tts/voices'].includes(pathname) && method === 'GET') return json([])
    if (pathname === '/api/reading-log' && method === 'POST') {
      validateIdentity(body)
      assert.ok(body.seconds > 0)
      return json({ ...body, id: 1, createdAt: Date.now() })
    }
    // Fail closed even for API methods/endpoints we did not anticipate. No proxy fallback.
    if (pathname === '/api' || pathname.startsWith('/api/') || pathname.startsWith('/healthz')) {
      throw new Error('未列入 stub 的 API')
    }
    const viteModule = ['/@vite/client', '/@react-refresh'].includes(pathname)
      || ((pathname.startsWith('/src/') || pathname.startsWith('/node_modules/'))
        && /\.(?:tsx?|jsx?|mjs|css|svg|png|woff2?|ttf)$/.test(pathname))
    if (method === 'GET' && viteModule && !pathname.split('/').includes('..')) return req.continue()
    throw new Error('未列入白名单的开发资源')
  }

  async ready() {
    await this.page.waitForFunction(mode => {
      if (mode === 'manga') {
        const image = document.querySelector('.manga-page-image')
        return window.__readerProgressCheck?.isOpen && image?.complete && image.naturalWidth > 0
          && document.querySelector('.manga-page-count')?.textContent === '1 / 6'
      }
      const root = document.querySelector('.reading-content, .reader-paginated-column-body')
      return window.__readerProgressCheck?.isOpen && root?.querySelectorAll('p').length >= 30
        && root.textContent.includes('〔验证2-1〕') && !document.querySelector('.reader-error')
    }, { timeout: 45000 }, this.mode)
    assert.ok(this.contentRequests.has(START), '必须真实请求 stub 正文，不能依赖缓存空跑')
    await this.quiet()
  }

  async quiet() {
    let count = this.saves.length
    let since = Date.now()
    await eventually(() => {
      if (count !== this.saves.length || this.active.size) { count = this.saves.length; since = Date.now() }
      return Date.now() - since >= THROTTLE + 180
    }, '等待节流保存结束')
  }

  async scroll(fraction) {
    return this.page.evaluate(async fraction => {
      const section = document.querySelector('.reading-content .reader-flow-chapter')
      if (!section || section.offsetHeight < innerHeight * 4) throw new Error('滚动夹具必须超过四屏')
      const movedAt = Date.now()
      const top = scrollY + section.getBoundingClientRect().top
      scrollTo({ top: top + fraction * (section.offsetHeight - innerHeight), behavior: 'instant' })
      // The real scroll listener schedules rAF. Do not call any product progress internals.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const current = document.querySelector('.reading-content .reader-flow-chapter')
      const currentTop = scrollY + current.getBoundingClientRect().top
      return { chapterIndex: Number(current.dataset.chapterIndex), movedAt, y: scrollY,
        fraction: Math.max(0, Math.min(1, (scrollY - currentTop) / (current.offsetHeight - innerHeight))) }
    }, fraction)
  }

  async savedAfter(count, snapshot) {
    const row = await eventually(() => this.saves.slice(count).findLast(item => item.status === 200
      && item.finishedAt && Math.abs(item.body.scrollPosition - snapshot.fraction) < 0.008), '最新位置保存成功')
    assert.ok(this.saves.length > count)
    assertPosition(row, snapshot)
    return row
  }

  async setMode(mode) {
    await this.page.evaluate(mode => window.__readerProgressCheck.setPageMode(mode), mode)
    await this.page.waitForFunction(mode => window.__readerProgressCheck.pageMode === mode
      && !!document.querySelector(mode === 'scroll' ? '.reading-content' : '.reader-paginated-viewport'), {}, mode)
    if (mode === 'paginate') await this.page.waitForFunction(() => {
      const numbers = document.querySelector('.reader-paginated-pagecount')?.textContent.match(/\d+/g)?.map(Number)
      return numbers?.length === 2 && numbers[1] > 4
    })
  }

  async pageNumber() {
    return this.page.$eval('.reader-paginated-pagecount', el => Number(el.textContent.match(/\d+/)?.[0]))
  }

  async turnPage() {
    const before = await this.pageNumber()
    const transform = await this.page.$eval('.reader-paginated-track', el => el.style.transform)
    await this.page.keyboard.press('PageDown')
    await this.page.waitForFunction(({ before, transform }) => {
      const current = Number(document.querySelector('.reader-paginated-pagecount')?.textContent.match(/\d+/)?.[0])
      return current === before + 1 && document.querySelector('.reader-paginated-track')?.style.transform !== transform
    }, {}, { before, transform })
    return before + 1
  }

  async status() {
    return this.page.evaluate(() => {
      const nodes = [...document.querySelectorAll('.reader-progress-save')]
      const el = nodes[0]
      const rect = el?.getBoundingClientRect()
      const button = el?.querySelector('button')
      return { count: nodes.length, role: el?.getAttribute('role'), text: el?.textContent ?? '',
        visible: !!rect?.height && !!rect?.width && getComputedStyle(el).visibility !== 'hidden'
          && getComputedStyle(el).display !== 'none' && Number(getComputedStyle(el).opacity) !== 0,
        disabled: button?.disabled ?? false }
    })
  }

  async failedStatus() {
    await eventually(async () => {
      const state = await this.status()
      return state.visible && state.text.includes('阅读进度未保存')
    }, '出现未保存状态条')
    const state = await this.status()
    assert.equal(state.count, 1, '错误提示不得重复堆叠')
    assert.equal(state.role, 'status')
    assert.equal(state.disabled, false)
    const button = await this.page.$('aria/[name="重试保存"][role="button"]')
    assert.ok(button, '重试按钮必须具有正确 accessible name')
    await button.dispose()
  }

  async failScroll(fraction = 0.32) {
    const count = this.saves.length
    this.replyStatus = 503
    const snapshot = await this.scroll(fraction)
    const row = await eventually(() => this.saves.slice(count).find(item => item.status === 503 && item.finishedAt), '刻意失败的 PUT')
    assertPosition(row, snapshot)
    await this.failedStatus()
    return { snapshot, row }
  }

  async retryHeld() {
    const count = this.saves.length
    this.replyStatus = 200
    const gate = this.holdNext()
    const button = await this.page.$('aria/[name="重试保存"][role="button"]')
    assert.ok(button)
    try { await button.click() } finally { await button.dispose() }
    await eventually(() => gate.row, '真实点击触发重试 PUT')
    // Keep the response pending beyond a complete throttle interval: optimistic hiding fails.
    await pause(THROTTLE + 100)
    const state = await this.status()
    assert.ok(state.visible && state.text.includes('正在重试'), '响应未返回时必须仍显示重试提示')
    assert.equal(state.role, 'status')
    assert.equal(state.disabled, true, '重试期间按钮必须 disabled')
    assert.equal(this.saves.length, count + 1, '等待重试期间不能重复提交')
    assert.equal(this.active.size, 1)
    gate.release()
    await eventually(() => gate.row.finishedAt, '重试响应结束')
    await eventually(async () => !(await this.status()).visible, '成功后隐藏状态条')
    assert.ok(await this.page.$eval('.reading-content', el => el.querySelectorAll('p').length >= 30
      && el.textContent.includes('〔验证2-1〕')), '恢复后真实正文仍应存在')
    validateProgress(gate.row.body)
    return gate.row
  }

  async closeReader() {
    await this.page.evaluate(() => window.__readerProgressCheck?.close())
    await this.page.waitForSelector('#reader-closed', { timeout: 5000 })
  }

  audit() {
    // Chromium resource errors are not application console.error calls (zero JS arguments).
    // Permit exactly one exact 503 message per deliberately failed PUT, at its exact URL and
    // response time. No blanket filtering of console errors or unrelated HTTP failures.
    const available = this.saves.filter(row => row.status === 503 && row.replyAt)
    const unexpected = []
    for (const error of this.consoleErrors) {
      const index = available.findIndex(row => error.args === 0 && error.url === row.url
        && error.text === 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)'
        && error.at >= row.replyAt && error.at - row.replyAt < 3000)
      if (index >= 0) available.splice(index, 1)
      else unexpected.push(`${error.url || '(console)'} ${error.text}`)
    }
    assert.deepEqual(this.violations, [], '网络白名单或拦截器错误')
    assert.deepEqual(this.errors, [], 'pageerror / unhandled rejection')
    assert.deepEqual(unexpected, [], '不允许非预期 console.error')
    assert.ok(this.saves.length > 0, '本项没有任何进度请求')
    for (const row of this.saves) validateProgress(row.body)
    assert.ok(this.peak <= 1, `PUT 最大并发为 ${this.peak}`)
  }

  async cleanup() {
    this.replyStatus = 200
    for (const gate of this.gates) gate.release()
    if (await this.page.evaluate(() => !!window.__readerProgressCheck?.isOpen)) await this.closeReader()
    await this.quiet()
    await Promise.all([...this.tasks])
    this.audit()
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
async function scenario(name, run, { mode = 'scroll', width = 1100 } = {}) {
  let context
  let harness
  const errors = []
  try {
    context = await browser.createBrowserContext() // Also isolates IndexedDB/offline chapter caches.
    const page = await context.newPage()
    page.setDefaultTimeout(TIMEOUT)
    await page.setViewport({ width, height: 844, deviceScaleFactor: 1 })
    harness = new FixtureBrowser(page, mode)
    await harness.install()
    await page.goto(new URL(FIXTURE_PATH, BASE.origin).href, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await harness.ready()
    await run(harness)
  } catch (error) {
    errors.push(error.message)
  } finally {
    if (harness) {
      try { await harness.cleanup() } catch (error) { errors.push(error.message) }
    }
    if (context) {
      try { await context.close() } catch (error) { errors.push(`context.close: ${error.message}`) }
    }
  }
  if (errors.length) {
    failures += 1
    console.error(`FAIL ${name}: ${[...new Set(errors)].join(' | ')}`)
  } else {
    passed += 1
    console.log(`PASS ${name}`)
  }
}

try {
  assert.ok(['http:', 'https:'].includes(BASE.protocol) && BASE.pathname === '/' && !BASE.search && !BASE.hash,
    'LEGADO_WEB_URL 必须是 Vite 服务 origin，不含路径、查询或 hash')
  assert.ok(chromePath(), '请通过 LEGADO_CHROME 指定 Chrome/Edge')
  fs.mkdirSync(SHOTS, { recursive: true })
  browser = await puppeteer.launch(launchOptions())

  await scenario('1 滚动：非零位置、书源/书籍/章节身份', async h => {
    const count = h.saves.length
    const snapshot = await h.scroll(0.21)
    assert.equal(snapshot.chapterIndex, START)
    await h.savedAfter(count, snapshot)
  })

  await scenario('2 延迟首个 PUT：串行、连续移动后保存最新快照', async h => {
    const count = h.saves.length
    const gate = h.holdNext()
    const first = await h.scroll(0.14)
    await eventually(() => gate.row, '首个 PUT 已进入延迟响应')
    assertPosition(gate.row, first)
    let latest
    for (const fraction of [0.23, 0.31, 0.39, 0.47, 0.55, 0.61]) {
      latest = await h.scroll(fraction)
      await pause(270) // More than one throttle interval while the first response is held.
    }
    assert.equal(h.peak, 1)
    assert.equal(h.saves.length, count + 1, '在途 PUT 未结束前不得并发发送')
    gate.release()
    await h.savedAfter(count + 1, latest)
    await h.quiet()
    assert.ok(h.saves.length >= count + 2)
    assertPosition(h.saves.at(-1), latest)
    assert.ok(h.saves.at(-1).body.scrollPosition > gate.row.body.scrollPosition)
    assert.equal(h.peak, 1)
  })

  await scenario('3 保存 503：单一状态条、不刷屏、错误态仍可实际翻页', async h => {
    const count = h.saves.length
    h.replyStatus = 503
    await h.turnPage()
    const failure = await eventually(() => h.saves.slice(count).find(row => row.status === 503 && row.finishedAt), '翻页产生失败 PUT')
    validateProgress(failure.body)
    assert.ok(failure.body.scrollPosition > 0)
    await h.failedStatus()
    const idleCount = h.saves.length
    await pause(THROTTLE * 2 + 150) // Negative assertion: an idle error must not retry-loop.
    assert.equal(h.saves.length, idleCount, '错误空闲期不能刷请求')
    await h.turnPage()
    await pause(THROTTLE + 150)
    await h.failedStatus()
    assert.ok(h.saves.length <= idleCount + 1, '一次移动不能触发多次失败请求')
  }, { mode: 'paginate' })

  await scenario('4 手动重试：在途提示不消失、按钮禁用、成功才隐藏', async h => {
    const { snapshot } = await h.failScroll()
    assertPosition(await h.retryHeld(), snapshot)
  })

  await scenario('5 online：不再移动也能补存失败快照', async h => {
    const { snapshot, row: failed } = await h.failScroll(0.38)
    const count = h.saves.length
    h.replyStatus = 200
    await h.page.evaluate(() => window.dispatchEvent(new Event('online')))
    const saved = await h.savedAfter(count, snapshot)
    for (const key of ['sourceId', 'bookUrl', 'chapterIndex', 'chapterUrl', 'scrollPosition', 'charOffset', 'paragraphAnchor', 'positionChecksum']) {
      assert.deepEqual(saved.body[key], failed.body[key], `online 重试丢失快照字段 ${key}`)
    }
    await eventually(async () => !(await h.status()).visible, 'online 成功隐藏状态条')
  })

  await scenario('6 待保存时切换模式：实际翻页保存，切回滚动定时器仍工作', async h => {
    const firstCount = h.saves.length
    const pending = await h.scroll(0.24)
    assert.equal(h.saves.length, firstCount, '切模式前必须仍有尚未触发的节流快照')
    await h.setMode('paginate')
    assert.ok(Date.now() - pending.movedAt < THROTTLE, '必须在旧滚动 timer 到期前切换')
    await h.quiet()
    const count = h.saves.length
    const before = h.saves.at(-1)?.body.scrollPosition ?? 0
    await h.turnPage()
    const saved = await eventually(() => h.saves.slice(count).find(row => row.status === 200
      && row.finishedAt && row.body.scrollPosition > before), '真实翻页后有新进度')
    validateProgress(saved.body)
    await h.quiet()
    const pendingCount = h.saves.length
    await h.turnPage()
    assert.equal(h.saves.length, pendingCount, '第二次翻页必须仍处于节流期')
    await h.setMode('scroll')
    await h.quiet()
    const scrollCount = h.saves.length
    const snapshot = await h.scroll(0.46)
    await h.savedAfter(scrollCount, snapshot)
  })

  await scenario('7 关闭 reader：未到定时立即 flush 最新位置、无未处理异常', async h => {
    const count = h.saves.length
    const snapshot = await h.scroll(0.43)
    assert.equal(h.saves.length, count, '卸载前不能已经保存这次位置')
    await h.closeReader()
    const saved = await h.savedAfter(count, snapshot)
    assert.ok(saved.at - snapshot.movedAt < THROTTLE - 100, '应由卸载 flush，不是等待 1200ms timer')
    await h.quiet() // Also catches delayed rejections after unmount.
    assertPosition(h.saves.at(-1), snapshot)
  })

  await scenario('8 390px：错误条不溢出、重试按钮可点、失败/恢复截图', async h => {
    const { snapshot } = await h.failScroll(0.29)
    await screenshot(h.page, 'reader-progress-390-failed.png')
    const geometry = await h.page.evaluate(() => {
      const bar = document.querySelector('.reader-progress-save')
      const button = bar.querySelector('button')
      const rect = bar.getBoundingClientRect()
      const b = button.getBoundingClientRect()
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
      return { width: innerWidth, documentWidth: document.documentElement.scrollWidth,
        left: rect.left, right: rect.right, barWidth: bar.clientWidth, barScroll: bar.scrollWidth,
        buttonLeft: b.left, buttonRight: b.right, buttonTop: b.top, buttonBottom: b.bottom,
        height: innerHeight, hit: !!hit && (hit === button || button.contains(hit)) }
    })
    assert.equal(geometry.width, 390)
    assert.ok(geometry.documentWidth <= 391 && geometry.left >= -1 && geometry.right <= 391,
      `页面或状态条横向溢出：${JSON.stringify(geometry)}`)
    assert.ok(geometry.barScroll <= geometry.barWidth + 1, '状态条内部横向溢出')
    assert.ok(geometry.buttonLeft >= 0 && geometry.buttonRight <= 390
      && geometry.buttonTop >= 0 && geometry.buttonBottom <= geometry.height && geometry.hit, '按钮必须在视口内且未被遮挡')
    assertPosition(await h.retryHeld(), snapshot)
    await screenshot(h.page, 'reader-progress-390-recovered.png')
  }, { width: 390 })

  await scenario('9 漫画：实际翻图保存位置，失败后保存最新图片及逻辑锚点', async h => {
    const turn = async index => {
      await h.page.keyboard.press('PageDown')
      await h.page.waitForFunction(index => {
        const page = document.querySelector('.manga-page')
        const image = page?.querySelector('img')
        return Number(page?.dataset.mangaIndex) === index && image?.complete && image.naturalWidth > 0
      }, {}, index)
    }
    const count = h.saves.length
    await turn(1)
    const first = await h.savedAfter(count, { chapterIndex: START, fraction: 0.2 })
    assert.ok(first.body.charOffset > 0 && first.body.positionChecksum)
    await h.quiet()
    h.replyStatus = 503
    await turn(2)
    await h.failedStatus()
    await turn(3)
    await h.quiet()
    assert.equal(h.saves.at(-1).status, 503)
    assertPosition(h.saves.at(-1), { chapterIndex: START, fraction: 0.6 })
    h.replyStatus = 200
    const retryCount = h.saves.length
    await h.page.click('.reader-progress-save button')
    const saved = await h.savedAfter(retryCount, { chapterIndex: START, fraction: 0.6 })
    assert.ok(saved.body.charOffset > first.body.charOffset)
    assert.equal(saved.body.positionChecksum, first.body.positionChecksum)
    assert.ok(saved.body.paragraphAnchor)
    await eventually(async () => !(await h.status()).visible, '漫画保存成功隐藏错误条')
    assert.equal(await h.page.$eval('.manga-page-count', el => el.textContent), '4 / 6')
  }, { mode: 'manga' })
} catch (error) {
  failures += 1
  console.error(`FAIL setup: ${error.message}`)
} finally {
  if (browser) {
    try { await browser.close() } catch (error) {
      failures += 1
      console.error(`FAIL browser.close: ${error.message}`)
    }
  }
  console.log(`reader-progress-check: ${passed} pass, ${failures} fail`)
  if (failures) process.exitCode = 1
}
