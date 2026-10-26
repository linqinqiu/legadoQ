// 本地书内嵌插图的端到端门禁（用户 2026-10-02：「重点研究本地阅读功能…支持图片」）。
//
// 原来 EPUB 正文走 `doc.body()?.text()`，`<img>` 整个消失 —— 解析阶段就把图丢了，
// 后面再怎么渲染也救不回来。现在解析阶段换成 `![图片](/api/books/local/asset?…)` 占位行，
// 由一条只读路由按 zip entry 回字节。
//
// 这条门禁判四件事：
//   ① 造一本真带图的 EPUB 导入，正文里要出现指向取图路由的占位行（相对路径按当前那篇 XHTML 解析）；
//   ② 那个地址真的回得来字节，且类型是图片；
//   ③ 安全边界：`..` 穿越、非导入生成的 bookId 形状、包里不存在的名字、svg 内容 —— 一律 404；
//   ④ 浏览器里真的画出来了（`naturalWidth > 0`，不是"标签在但图裂"）。
//
// 探针书跑完从书架删掉（服务端那份原始文件跟着清），不给用户留垃圾。
// 跑法：node tools/verify/local-image-check.mjs
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { OUT, SHOTS, BASE, launchOptions } from './env.mjs'
import { makeZip } from './zip-make.mjs'

const require = createRequire(path.join(import.meta.dirname, '../../web/package.json'))
const puppeteer = require('puppeteer-core')

const STAMP = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)
const BOOK_NAME = `本地插图探针-${STAMP}`
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail })
const note = (name, detail) => results.push({ name, ok: null, detail })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 一张真能解码的 1x1 PNG（公认那份 base64，别手拼十六进制 ——
 * 上一版手拼的 67 字节"PNG"服务端照常回 200 image/png，浏览器却解不出来，
 * 于是一条产品门禁红在了探针自己的夹具上）。
 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>', 'utf8')

const text = value => Buffer.from(value, 'utf8')

/** 一本合规的最小 EPUB：正文里三种图 —— 包内 png、包内 svg（该被路由拒）、远程图。 */
function epubWithImages() {
  return makeZip([
    { name: 'mimetype', data: text('application/epub+zip') },
    {
      name: 'META-INF/container.xml',
      data: text('<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    },
    {
      name: 'OEBPS/content.opf',
      data: text('<?xml version="1.0"?><package><metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">'
        + BOOK_NAME + '</dc:title></metadata>'
        + '<manifest><item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/></manifest>'
        + '<spine><itemref idref="c1"/></spine></package>'),
    },
    {
      name: 'OEBPS/text/ch1.xhtml',
      data: text('<html><body><h1>第一章 有图</h1><p>图前</p>'
        + '<p><img src="../images/p1.png"/></p>'
        + '<p><img src="../images/evil.svg"/></p>'
        + '<p>图后</p></body></html>'),
    },
    { name: 'OEBPS/images/p1.png', data: PNG },
    { name: 'OEBPS/images/evil.svg', data: SVG },
  ])
}

const api = async (pathname, options = {}) => {
  const response = await fetch(`${BASE}${pathname}`, options)
  return { status: response.status, body: await response.json().catch(() => null) }
}

let probeBookUrl = ''
let browser = null
try {
  // ─────────────────────── ① 导入并检查占位行 ───────────────────────
  const form = new FormData()
  form.append('file', new Blob([epubWithImages()], { type: 'application/epub+zip' }), `${BOOK_NAME}.epub`)
  const uploaded = await fetch(`${BASE}/api/bookshelf/import-local`, { method: 'POST', body: form })
  const importBody = await uploaded.json().catch(() => null)
  probeBookUrl = importBody?.results?.[0]?.bookUrl ?? ''
  check('①带插图的 EPUB 导入成功', uploaded.status === 200 && importBody?.imported === 1 && !!probeBookUrl,
    `HTTP ${uploaded.status} · imported=${importBody?.imported ?? 0} · ${importBody?.results?.[0]?.error ?? ''}`)

  const toc = await api('/api/books/chapters', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceId: 'loc_book', bookUrl: probeBookUrl }),
  })
  const firstUrl = toc.body?.[0]?.url ?? ''
  const contentRes = await api('/api/books/content', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceId: 'loc_book', bookUrl: probeBookUrl, chapterUrl: firstUrl }),
  })
  const body = contentRes.body?.content ?? ''
  const assetLines = [...body.matchAll(/!\[图片\]\((\/api\/books\/local\/asset\?[^)]+)\)/g)].map(match => match[1])
  check('①正文里图片变成了占位行（不是消失、也不是留一行 `<img>` 字面文本）',
    assetLines.length === 2 && !body.includes('<img'),
    `${assetLines.length} 个占位行 · 图前/图后仍在=${body.includes('图前') && body.includes('图后')}`)
  check('①相对路径按当前那篇 XHTML 解析（../images → OEBPS/images）',
    assetLines.some(line => decodeURIComponent(line).includes('OEBPS/images/p1.png')),
    assetLines.map(line => decodeURIComponent(line).replace(/.*path=/, '')).join(' | '))

  // ─────────────────────── ② 路由真的回得来字节 ───────────────────────
  const pngLine = assetLines.find(line => decodeURIComponent(line).endsWith('p1.png')) ?? ''
  const pngRes = await fetch(`${BASE}${pngLine}`)
  const pngBytes = Buffer.from(await pngRes.arrayBuffer())
  check('②包内那张 png 取回来了，字节与类型都对',
    pngRes.status === 200 && pngRes.headers.get('content-type')?.includes('image/png')
      && pngBytes.length === PNG.length && pngBytes.equals(PNG),
    `HTTP ${pngRes.status} · ${pngRes.headers.get('content-type')} · ${pngBytes.length} 字节`)
  check('②同源回图时明确写了 nosniff（类型是服务端定的，不让浏览器猜）',
    pngRes.headers.get('x-content-type-options') === 'nosniff',
    String(pngRes.headers.get('x-content-type-options')))

  // ─────────────────────── ③ 安全边界 ───────────────────────
  const svgLine = assetLines.find(line => decodeURIComponent(line).endsWith('evil.svg')) ?? ''
  const svgRes = await fetch(`${BASE}${svgLine}`)
  check('③同源 svg 一律不回（它能带脚本，而这是同源地址）', svgRes.status === 404, `HTTP ${svgRes.status}`)
  const bookId = decodeURIComponent(pngLine).match(/bookId=([^&]+)/)?.[1] ?? ''
  const traversal = await fetch(`${BASE}/api/books/local/asset?bookId=${bookId}&path=${encodeURIComponent('../../server.log')}`)
  check('③`..` 穿越取不到包外文件', traversal.status === 404, `HTTP ${traversal.status}`)
  const badId = await fetch(`${BASE}/api/books/local/asset?bookId=../../config&path=${encodeURIComponent('OEBPS/images/p1.png')}`)
  check('③bookId 形状不对直接拒（它同时是磁盘上的文件名）', badId.status === 404, `HTTP ${badId.status}`)
  const missing = await fetch(`${BASE}/api/books/local/asset?bookId=${bookId}&path=${encodeURIComponent('OEBPS/images/nope.png')}`)
  check('③包里不存在的名字 404（不做前缀匹配，也不去猜相近的文件）', missing.status === 404, `HTTP ${missing.status}`)
  const otherBook = await fetch(`${BASE}/api/books/local/asset?bookId=${'0'.repeat(32)}&path=${encodeURIComponent('OEBPS/images/p1.png')}`)
  check('③拿别人的 bookId 取不到这本的图（id 与文件是一对一的）', otherBook.status === 404, `HTTP ${otherBook.status}`)

  // ─────────────────────── ④ 浏览器里真的画出来了 ───────────────────────
  try {
    browser = await puppeteer.launch(launchOptions())
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 950, deviceScaleFactor: 1 })
    const errors = []
    page.on('pageerror', error => errors.push(String(error.message)))
    await page.goto(`${BASE}/#shelf`, { waitUntil: 'domcontentloaded', timeout: 90000 })
    await page.waitForSelector('.shelf-card', { timeout: 45000 })
    // 点卡片没打开阅读器（截图核对过：还停在书架）。这本探针书就是"上次读到"那本，
    // 顶部那条「继续阅读」是界面上最短、也最接近真人动作的一条路。
    const opened = await page.evaluate(name => {
      const buttons = [...document.querySelectorAll('button')]
      const resume = buttons.find(node => (node.textContent ?? '').includes('继续阅读'))
      const card = [...document.querySelectorAll('.shelf-card')]
        .find(node => (node.textContent ?? '').includes(name))
      const target = resume ?? card
      if (!target) return '书架上既没有「继续阅读」也没找到这本探针书'
      target.click()
      return resume ? '继续阅读' : '书架卡片'
    }, BOOK_NAME)
    check('④从书架进得去这本探针书', opened !== '书架上既没有「继续阅读」也没找到这本探针书', String(opened))
    await page.waitForSelector('.reader-paragraph-image', { timeout: 30000 }).catch(() => undefined)
    // 图是异步解码的：`complete && naturalWidth` 要等浏览器真的解完，不能一进来就读
    await page.waitForFunction(() => [...document.querySelectorAll('.reader-paragraph-image img')]
      .some(img => img.complete), { timeout: 20000 }).catch(() => undefined)
    await sleep(800)
    const painted = await page.evaluate(() => {
      const images = [...document.querySelectorAll('.reader-paragraph-image img')]
      return {
        count: images.length,
        loaded: images.filter(img => img.complete && img.naturalWidth > 0).length,
        local: images.filter(img => (img.currentSrc || img.src).includes('/api/books/local/asset')).length,
        // 0.7.7 起取失败的那张不再"整块收起"：它换成一行结论 + 一颗「重取这一张」。
        // 判据跟着换成钉这个 —— 意图没变（不许留破图框、成功的那张不许被误收），变的是实现。
        failedRows: [...document.querySelectorAll('.reader-image-failed')].length,
        retryButtons: [...document.querySelectorAll('.reader-image-failed button')]
          .filter(button => button.textContent.includes('重取')).length,
        brokenFrames: images.filter(img => img.complete && img.naturalWidth === 0).length,
        page: location.hash,
      }
    })
    check('④浏览器里图真的解码出来了（naturalWidth > 0，不是"标签在但图裂"）',
      painted.count >= 1 && painted.loaded >= 1 && painted.local >= 1,
      `占位 ${painted.count} · 解码成功 ${painted.loaded} · 站内资源 ${painted.local} · 失败行 ${painted.failedRows} · hash=${painted.page}`)
    // 取不到的那张（这里是 svg，路由按设计 404）不留破图框，换成一行"没取到 + 重取这一张"；
    // 取到的那张不许被误收 —— 所以期望是"恰好一行结论、恰好一颗按钮、恰好一张画出来"。
    check('④裂图换成一句结论和一条出路，且只换真取不到的那张',
      painted.count === 1 && painted.loaded === 1 && painted.brokenFrames === 0
        && painted.failedRows === 1 && painted.retryButtons === 1,
      `画出来 ${painted.loaded} / 占位 ${painted.count} · 破图框 ${painted.brokenFrames} · 失败行 ${painted.failedRows} · 重取按钮 ${painted.retryButtons}`)
    check('④阅读器没有 JS 异常', errors.length === 0, errors.slice(0, 2).join(' | '))
    fs.mkdirSync(SHOTS, { recursive: true })
    await page.screenshot({ path: path.join(SHOTS, `local-image-${STAMP}.png`) })
  } catch (error) {
    note('④浏览器这一段没跑成', error.message)
  }
} catch (error) {
  check('探针自身异常', false, error.message)
} finally {
  if (browser) await browser.close().catch(() => null)
  if (probeBookUrl) {
    const removed = await fetch(`${BASE}/api/bookshelf?sourceId=loc_book&bookUrl=${encodeURIComponent(probeBookUrl)}`, { method: 'DELETE' })
    const left = await api('/api/bookshelf').then(list => list.body?.some(item => item.bookUrl === probeBookUrl))
    check('收尾删掉探针书（原始文件也一起清）', removed.status < 400 && !left, `HTTP ${removed.status} · 还在=${left}`)
  }
  fs.mkdirSync(OUT, { recursive: true })
  const failed = results.filter(row => row.ok === false)
  const skipped = results.filter(row => row.ok === null)
  fs.writeFileSync(path.join(OUT, `local-image-${STAMP}.json`), JSON.stringify({ stamp: STAMP, base: BASE, results }, null, 2))
  for (const row of results) {
    const flag = row.ok === true ? 'PASS' : row.ok === false ? 'FAIL' : 'NOTE'
    console.log(`${flag}  ${row.name}${row.detail ? '   [' + row.detail + ']' : ''}`)
  }
  console.log(`\n${results.length - failed.length - skipped.length}/${results.length - skipped.length} PASS`
    + `${skipped.length ? ` · ${skipped.length} NOTE` : ''}${failed.length ? ` · ${failed.length} FAIL` : ''}`
    + ` · 详情 tools/verify/out/local-image-${STAMP}.json`)
  process.exit(failed.length ? 1 : 0)
}
