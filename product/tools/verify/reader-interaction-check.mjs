// 阅读器「正文渲染 + 分页测量」的**交互**判据（2026-11-08 补）。
//
// 为什么补这条：这两块要从 `ReaderScreen.tsx`（3,200 行）里拆出去，而现有判据全是
// 「静态渲染 + 读源码字符串」——拆错了它们照样绿。`ReaderScreenSmoke` 只证明能渲染出骨架，
// `paginate-flow-check` 只判分页几何（栏对齐、跨章、页脚页数），两者都不碰**手指落下去之后**
// 发生什么。真正会在这轮拆分里被改坏的，恰好是这几条：
//
//   ① 点右三分之一 = 下一页、点左 = 上一页、点中间 = 收放工具栏（`runTapAction` 的分区派发）；
//   ② 点正文里的图 = 开预览层，且**不能**顺手翻一页（`stopPropagation` 一丢就会翻）；
//   ③ 手上正选着字时点一下**不该**翻页（`onPointerUp` 里那条 `getSelection()` 早退）；
//   ④ 页脚报的页数必须等于栏流真实宽度量出来的页数（交互翻页与测量的接缝）。
//
// 夹具是一本自己造的 EPUB：`![图片]()` 那一行只有 EPUB 的内嵌插图能造出来（在线书要联网，
// 而图片代理明确拒回环地址，本机起个图片服务器也没用）。所以这里带了一个最小 ZIP 写入器 +
// 最小 PNG 编码器，不引第三方依赖，Windows / Linux 都能跑。
//
// 跑法：node tools/verify/reader-interaction-check.mjs（服务需在 1234 上跑着）
import path from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { BASE, launchOptions, requireService, acceptAgreement } from './env.mjs'

const puppeteer = createRequire(path.join(import.meta.dirname, '../../web/package.json'))('puppeteer-core')
const STAMP = Date.now().toString(36)
const BOOK_NAME = `交互探针-${STAMP}`
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ── 最小 ZIP（只 store、不压缩）────────────────────────────────────────────
// EPUB 就是 zip。只用 STORE 意味着不需要 deflate，条目小、结构一目了然；
// ZipFile/ZipInputStream 对 STORE 与 DEFLATE 一视同仁。
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

const crc32 = buffer => {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** `entries` 顺序即写入顺序：`mimetype` 必须是第一条，否则不是合法 EPUB。 */
function zipStore(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)          // version needed
    local.writeUInt16LE(0, 6)           // flags
    local.writeUInt16LE(0, 8)           // method = store
    local.writeUInt16LE(0, 10)          // time
    local.writeUInt16LE(0x0021, 12)     // date = 1980-01-01（固定值：两次跑出的包逐字节相同）
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)        // version made by
    central.writeUInt16LE(20, 6)        // version needed
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x0021, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + data.length
  }
  const centralBuffer = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuffer, end])
}

// ── 最小 PNG（真彩、无滤波）──────────────────────────────────────────────
// 正文图是 `max-width: 100%` 的等比缩放：1×1 的占位图会缩成 1px，点不中。
// 所以这里编一张 480×640 的实色图，让它有真实的点击面积。
function solidPng(width, height, [r, g, b]) {
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * stride
    raw[row] = 0
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = r
      raw[row + 2 + x * 3] = g
      raw[row + 3 + x * 3] = b
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8    // bit depth
  ihdr[9] = 2    // color type = truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 三章、每章 14 段：一章在 1280×860 下要占两三页，翻页才有意义；第一章第 3 段插一张图。 */
function buildEpub() {
  const chapters = [1, 2, 3].map(index => ({
    title: `第${'一二三'[index - 1]}章 交互探针第${index}站`,
    paragraphs: Array.from({ length: 14 }, (_, part) =>
      `〔${index}-${part + 1}〕这一段是用来判断"翻页到底翻没翻"的填充文字，`
      + `写长一点好让它真的占满半栏：第${index}章第${part + 1}段。`
      + '分页测量把一段话按栏切开时，切点落在这里也看得出来。'),
  }))

  const xhtml = (chapter, index) => `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${chapter.title}</title></head>
<body>
${chapter.paragraphs.map((text, part) => {
    const body = `<p>${text}</p>`
    // 图放在第一章第 3 段之后：首屏就能看见，不必先翻页
    return index === 1 && part === 2 ? `${body}\n<img src="images/p1.png" alt="探针插图"/>` : body
  }).join('\n')}
</body></html>`

  const manifest = chapters
    .map((_, index) => `    <item id="c${index + 1}" href="ch${index + 1}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('\n')
  const spine = chapters.map((_, index) => `    <itemref idref="c${index + 1}"/>`).join('\n')
  const navPoints = chapters.map((chapter, index) => `    <navPoint id="n${index + 1}" playOrder="${index + 1}">
      <navLabel><text>${chapter.title}</text></navLabel>
      <content src="ch${index + 1}.xhtml"/>
    </navPoint>`).join('\n')

  return zipStore([
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>` },
    { name: 'OEBPS/content.opf', data: `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${BOOK_NAME}</dc:title>
    <dc:creator>门禁探针</dc:creator>
    <dc:language>zh</dc:language>
    <dc:identifier id="bookid">urn:uuid:interaction-${STAMP}</dc:identifier>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
${manifest}
    <item id="img1" href="images/p1.png" media-type="image/png"/>
  </manifest>
  <spine toc="ncx">
${spine}
  </spine>
</package>` },
    { name: 'OEBPS/toc.ncx', data: `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:interaction-${STAMP}"/></head>
  <docTitle><text>${BOOK_NAME}</text></docTitle>
  <navMap>
${navPoints}
  </navMap>
</ncx>` },
    ...chapters.map((chapter, index) => ({ name: `OEBPS/ch${index + 1}.xhtml`, data: xhtml(chapter, index + 1) })),
    { name: 'OEBPS/images/p1.png', data: solidPng(480, 640, [90, 140, 200]) },
  ])
}

const importBook = async () => {
  const form = new FormData()
  form.append('file', new Blob([buildEpub()], { type: 'application/epub+zip' }), `${BOOK_NAME}.epub`)
  const response = await fetch(`${BASE}/api/bookshelf/import-local?tocRule=builtin`, { method: 'POST', body: form })
  const body = await response.json().catch(() => null)
  return { status: response.status, body }
}

const removeProbe = async bookUrl => {
  if (!bookUrl) return false
  await fetch(`${BASE}/api/bookshelf?sourceId=loc_book&bookUrl=${encodeURIComponent(bookUrl)}`, { method: 'DELETE' })
  const after = await (await fetch(`${BASE}/api/bookshelf`)).json().catch(() => [])
  return !after.some(entry => entry.bookUrl === bookUrl)
}

/** 页脚那格「3 / 7」。分页模式下它是唯一一处"当前第几页 / 一共几页"的真话。 */
const readPage = page => page.evaluate(() => {
  const text = document.querySelector('.reader-paginated-pagecount')?.textContent ?? ''
  const match = /(\d+)\s*\/\s*(\d+)/.exec(text)
  return { page: Number(match?.[1] ?? 0), total: Number(match?.[2] ?? 0), text: text.trim() }
})

const toolbarsVisible = page => page.evaluate(() => {
  const main = document.querySelector('.reader-workspace')
  return main?.classList.contains('toolbars-open') ?? null
})

let probeBookUrl = ''
let browser
await requireService('reader-interaction-check')
try {
  const imported = await importBook()
  const first = imported.body?.results?.[0]
  probeBookUrl = first?.bookUrl ?? ''
  check('探针 EPUB 已导入（否则后面全是空判）',
    imported.status === 200 && !!first?.success && !!probeBookUrl,
    `${imported.status} ${first?.name ?? ''} · ${first?.totalChapters ?? 0} 章`)
  if (!first?.success) throw new Error('导入失败，门禁无法继续')

  browser = await puppeteer.launch(launchOptions())
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 860 })
  const errors = []
  page.on('pageerror', event => errors.push(String(event.message)))

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await acceptAgreement(page)
  await page.evaluate(async () => {
    const registrations = await navigator.serviceWorker?.getRegistrations?.() ?? []
    await Promise.all(registrations.map(entry => entry.unregister()))
    const keys = await caches?.keys?.() ?? []
    await Promise.all(keys.map(key => caches.delete(key)))
  })
  // 分页模式 + 出厂分区表（左 1/3 上一页 / 中间收放工具栏 / 右 1/3 下一页）
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ theme: 'light', pageMode: 'paginate' })),
    'legado-reader-settings-v2')
  await page.goto(`${BASE}/?t=${Date.now()}#shelf`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(name => [...document.querySelectorAll('.shelf-card-name')]
    .some(node => node.textContent?.trim() === name), { timeout: 60000 }, first.name)
  await page.evaluate(name => {
    const card = [...document.querySelectorAll('.shelf-card')]
      .find(node => node.querySelector('.shelf-card-name')?.textContent?.trim() === name)
    card?.querySelector('.shelf-card-cover')?.click()
  }, first.name)
  await page.waitForSelector('.reader-paginated-column-body', { timeout: 60000 })
  await sleep(2500)

  // ① 正文渲染：EPUB 插图必须真的渲染成 <img>，且走站内资产路由（不过图片代理）
  const figure = await page.evaluate(() => {
    const img = document.querySelector('.reader-paragraph-image img')
    if (!img) return null
    const rect = img.getBoundingClientRect()
    return {
      src: img.getAttribute('src') ?? '',
      role: img.getAttribute('role'),
      cursor: getComputedStyle(img).cursor,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      naturalWidth: img.naturalWidth,
    }
  })
  check('EPUB 内嵌插图渲染成正文 <img>，地址走 /api/books/local/asset（站内资产不过代理）',
    !!figure && figure.src.startsWith('/api/books/local/asset') && figure.naturalWidth > 0,
    figure ? `${figure.src.slice(0, 48)}… 自然宽 ${figure.naturalWidth}` : '没找到 .reader-paragraph-image img')
  check('插图有真实的点击面积，并给了"可放大"的提示（role=button + cursor: zoom-in）',
    !!figure && figure.width >= 40 && figure.height >= 40 && figure.role === 'button' && figure.cursor === 'zoom-in',
    figure ? `${figure.width}×${figure.height} role=${figure.role} cursor=${figure.cursor}` : '没有图')

  // ② 点图 = 开预览层，且**不能**顺手翻一页（figure 里的 onClick 有 stopPropagation）
  const beforeImage = await readPage(page)
  const figureBox = await page.evaluate(() => {
    const rect = document.querySelector('.reader-paragraph-image img')?.getBoundingClientRect()
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
  })
  if (figureBox) await page.mouse.click(figureBox.x, figureBox.y)
  await sleep(300)
  const lightbox = await page.evaluate(() => {
    const overlay = document.querySelector('.overlay-backdrop.is-viewer')
    if (!overlay) return null
    return {
      label: overlay.getAttribute('aria-label'),
      src: overlay.querySelector('img')?.getAttribute('src') ?? '',
      hasClose: !!overlay.querySelector('.reader-image-lightbox-close'),
    }
  })
  check('点正文插图弹出预览层，且预览的就是这一张',
    !!lightbox && lightbox.src === figure?.src && lightbox.label === '图片预览',
    lightbox ? `${lightbox.label} · ${lightbox.src.slice(0, 40)}…` : '没有 .overlay-backdrop.is-viewer')
  const afterImage = await readPage(page)
  check('点图不翻页（图片的点击没有冒泡到分区派发）',
    afterImage.page === beforeImage.page, `${beforeImage.text} → ${afterImage.text}`)
  await page.evaluate(() => document.querySelector('.reader-image-lightbox-close')?.click())
  await sleep(250)
  check('预览层能关掉',
    await page.evaluate(() => !document.querySelector('.overlay-backdrop.is-viewer')))

  // ③ 分区派发：右 1/3 下一页、左 1/3 上一页、中间收放工具栏
  const wrapBox = await page.evaluate(() => {
    const rect = document.querySelector('.reader-paginated-wrap')?.getBoundingClientRect()
    return rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null
  })
  const tapAt = async ratio => {
    const x = wrapBox.left + wrapBox.width * ratio
    const y = wrapBox.top + wrapBox.height * 0.5
    await page.mouse.click(x, y)
    await sleep(450)
    return readPage(page)
  }

  const start = await readPage(page)
  const afterNext = await tapAt(0.84)
  check('点右侧三分之一 = 下一页（出厂分区表右格是 next）',
    afterNext.page === start.page + 1, `${start.text} → ${afterNext.text}`)
  const afterPrev = await tapAt(0.16)
  check('点左侧三分之一 = 上一页（回到刚才那一页，不是跳章）',
    afterPrev.page === start.page && afterPrev.total === start.total, `${afterNext.text} → ${afterPrev.text}`)

  const barsBefore = await toolbarsVisible(page)
  const afterToggle = await tapAt(0.5)
  const barsAfter = await toolbarsVisible(page)
  check('点中间 = 收放工具栏，且不翻页',
    barsBefore !== barsAfter && afterToggle.page === afterPrev.page,
    `toolbars ${barsBefore} → ${barsAfter} · ${afterPrev.text} → ${afterToggle.text}`)
  // 收回去，免得后面的截图/点击被工具栏挡住
  await tapAt(0.5)

  // ④ 手上选着字时点一下不该翻页（onPointerUp 里 getSelection() 那条早退）
  const beforeSelect = await readPage(page)
  const selected = await page.evaluate(() => {
    const paragraph = document.querySelector('.reader-page-chapter .reader-paragraph')
    if (!paragraph) return ''
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    return selection.toString().trim().slice(0, 12)
  })
  const afterSelectTap = await tapAt(0.84)
  check('选着字时点右侧不翻页（选择优先于分区派发）',
    !!selected && afterSelectTap.page === beforeSelect.page,
    `选中「${selected}」· ${beforeSelect.text} → ${afterSelectTap.text}`)
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await sleep(200)

  // ⑤ 交互翻页与测量的接缝：页脚总页数必须等于栏流真实宽度量出来的页数
  const geometry = await page.evaluate(() => {
    const body = document.querySelector('.reader-paginated-column-body')
    const viewport = document.querySelector('.reader-paginated-viewport')
    if (!body || !viewport) return null
    const style = getComputedStyle(body)
    const gap = parseFloat(style.columnGap)
    const stride = parseFloat(style.columnWidth) + gap
    return {
      pages: Math.ceil((body.scrollWidth + gap) / (viewport.clientWidth + gap)),
      scrollWidth: body.scrollWidth,
      viewportWidth: viewport.clientWidth,
      stride: Math.round(stride),
    }
  })
  const footer = await readPage(page)
  check('页脚报的总页数 = 栏流宽度量出来的页数（交互翻页与分页测量对得上）',
    !!geometry && Math.abs(footer.total - geometry.pages) <= 1,
    geometry ? `报 ${footer.total} 页，量出来 ${geometry.pages} 页（${geometry.scrollWidth}px / ${geometry.viewportWidth}px，栏距 ${geometry.stride}px）` : '量不到栏流')

  check('全程没有页面异常', errors.length === 0, errors.slice(0, 2).join(' | '))
} catch (error) {
  check(`门禁自身出错：${error.message}`, false)
} finally {
  if (browser) await browser.close()
  const removed = await removeProbe(probeBookUrl)
  check('探针书已删除（不留残留在用户书架上）', removed, removed ? '已清' : '没删掉，需要手工清')
}

const failed = results.filter(item => !item.ok)
console.log(`\nreader-interaction-check: PASS ${results.length - failed.length} / FAIL ${failed.length}`)
if (failed.length) process.exitCode = 1
