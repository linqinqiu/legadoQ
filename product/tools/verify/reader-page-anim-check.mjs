import path from 'node:path'
import { createRequire } from 'node:module'
import { BASE, OUT, launchOptions } from './env.mjs'

/**
 * 翻页动画门禁（PROPOSAL-019 A：「翻页引擎」）。
 *
 * 要钉的是**逐页翻那一瞬屏幕上是什么**，光看代码看不出来：
 * ① `cover` 档：新页从一侧滑进来盖住旧页 —— 动画进行中**旧页与新页同帧存在**
 *    （主轨道 + 覆盖层），且页码**还没变**（真翻页要等动画收尾）；
 * ② 动画结束后覆盖层卸掉、只剩主轨道，页码 +1（「只剩新页」）；
 * ③ 往回翻同理（新页从左进来）；
 * ④ `slide` 档不许出现覆盖层（别把动画档串了）。
 *
 * 自带一本探针书（本地导入、跑完删掉），不依赖书架上有没有缓存书。
 * 跑法：node tools/verify/reader-page-anim-check.mjs
 */
const puppeteer = createRequire(path.join(import.meta.dirname, '../../web/package.json'))('puppeteer-core')
const STAMP = Date.now().toString(36)
const BOOK_NAME = `翻页动画探针-${STAMP}`
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`) }

const syntheticBook = () => {
  // 首章（前言）要够长，第一下翻页才是**同章内**的逐页翻，页码才可比；
  // 否则"前言只有一页"会让第一次翻页直接落到第 1 章，页脚从「前言 1/N」变成「第1章 1/M」。
  const preface = Array.from({ length: 40 }, (_, part) =>
    `前言第${part + 1}段。${'这一句要写得足够长，好让它在默认字号下真的占满大半栏。'.repeat(4)}`).join('\n\n')
  const chapters = Array.from({ length: 6 }, (_, index) => {
    const paragraphs = Array.from({ length: 16 }, (_, part) =>
      `这是第${index + 1}节的第${part + 1}段落。${'这一句要写得足够长，好让它在默认字号下真的占满大半栏。'.repeat(4)}`).join('\n\n')
    return `第${index + 1}章 动画探针\n\n${paragraphs}`
  }).join('\n\n')
  return `${BOOK_NAME}\n作者：门禁探针\n\n${preface}\n\n${chapters}\n`
}

const importBook = async () => {
  const form = new FormData()
  form.append('file', new Blob([syntheticBook()], { type: 'text/plain; charset=utf-8' }), `${BOOK_NAME}.txt`)
  const response = await fetch(`${BASE}/api/bookshelf/import-local?tocRule=builtin`, { method: 'POST', body: form })
  return (await response.json().catch(() => null))?.results?.[0]
}

const removeProbe = async bookUrl => {
  if (!bookUrl) return false
  await fetch(`${BASE}/api/bookshelf?sourceId=loc_book&bookUrl=${encodeURIComponent(bookUrl)}`, { method: 'DELETE' })
  const after = await (await fetch(`${BASE}/api/bookshelf`)).json().catch(() => [])
  return !after.some(entry => entry.bookUrl === bookUrl)
}

/** 打开阅读器并停在第 1 页；`anim` 写进阅读设置。 */
async function openReader(page, book, anim) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app-page-header', { timeout: 30000 })
  await new Promise(r => setTimeout(r, 400))
  await page.evaluate(({ anim }) => localStorage.setItem('legado-reader-settings-v2',
    JSON.stringify({ theme: 'light', pageMode: 'paginate', pageAnim: anim, scriptMode: 'off' })), { anim })
  await page.goto(`${BASE}/?t=${Date.now()}#shelf`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(name => [...document.querySelectorAll('.shelf-card-name')]
    .some(node => node.textContent?.trim() === name), { timeout: 60000 }, book.name)
  await page.evaluate(name => {
    const card = [...document.querySelectorAll('.shelf-card')].find(node => node.querySelector('.shelf-card-name')?.textContent?.trim() === name)
    card?.querySelector('.shelf-card-cover')?.click()
  }, book.name)
  await page.waitForSelector('.reader-paginated-column-body', { timeout: 60000 })
  await new Promise(r => setTimeout(r, 1500))
}

const pageNo = page => page.evaluate(() => {
  const [cur] = (document.querySelector('.reader-paginated-footer span:last-child')?.textContent ?? '').split('/')
  return Number((cur ?? '').trim())
})

/** 按一下翻页键，然后**尽快**轮询，抓"动画进行中"的那一帧。 */
async function turnAndCatch(page, key) {
  const before = await pageNo(page)
  await page.keyboard.press(key)
  let caught = null
  const deadline = Date.now() + 500
  while (Date.now() < deadline) {
    const frame = await page.evaluate(() => ({
      cover: document.querySelector('.reader-page-cover')?.className ?? null,
      base: !!document.querySelector('.reader-paginated-track'),
      baseTrack: document.querySelector('.reader-paginated-track')?.getAttribute('style') ?? '',
      coverTrack: document.querySelector('.reader-page-cover .reader-paginated-track')?.getAttribute('style') ?? '',
      page: Number((document.querySelector('.reader-paginated-footer span:last-child')?.textContent ?? '').split('/')[0]?.trim()),
    }))
    if (frame.cover) { caught = frame; break }
    await new Promise(r => setTimeout(r, 8))
  }
  // 等动画收尾
  await page.waitForFunction(() => !document.querySelector('.reader-page-cover'), { timeout: 4000 }).catch(() => null)
  await new Promise(r => setTimeout(r, 120))
  const after = await page.evaluate(() => ({
    cover: !!document.querySelector('.reader-page-cover'),
    page: Number((document.querySelector('.reader-paginated-footer span:last-child')?.textContent ?? '').split('/')[0]?.trim()),
    bodies: document.querySelectorAll('.reader-paginated-column-body').length,
  }))
  return { before, caught, after }
}

let probeBookUrl = ''
let browser
try {
  const first = await importBook()
  probeBookUrl = first?.bookUrl ?? ''
  check('探针书已导入', !!first?.success && !!probeBookUrl, `${first?.name ?? ''} · ${first?.totalChapters ?? 0} 章`)
  if (!first?.success) throw new Error('导入失败')

  browser = await puppeteer.launch(launchOptions())
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 860 })
  const errors = []
  page.on('pageerror', event => errors.push(String(event.message)))
  await openReader(page, first, 'cover')

  check('cover 档下阅读器起来了（分栏 + 页码）', await pageNo(page) >= 1)

  // —— ① 往后翻：动画进行中旧页与新页同帧存在、页码还没变 ——
  const forward = await turnAndCatch(page, 'ArrowRight')
  check('cover · 动画进行中挂上了覆盖层（新页）', !!forward.caught, forward.caught ? forward.caught.cover : '整段没抓到覆盖层')
  check('cover · 动画进行中主轨道（旧页）还在 —— 旧页与新页同帧存在', !!forward.caught?.base, `base=${forward.caught?.base}`)
  check('cover · 动画进行中页码**还没变**（真翻页要等动画收尾）',
    forward.caught?.page === forward.before, `进行中第 ${forward.caught?.page} 页 / 翻之前第 ${forward.before} 页`)
  check('cover · 覆盖层展示的是**另一页**（内层位移 ≠ 主轨道位移，不是旧页的副本）',
    !!forward.caught && forward.caught.coverTrack !== forward.caught.baseTrack,
    `主轨 ${forward.caught?.baseTrack} · 覆盖 ${forward.caught?.coverTrack}`)
  check('cover · 动画结束后覆盖层卸掉、只剩主轨道', !forward.after.cover && forward.after.bodies === 1, `覆盖层=${forward.after.cover} · 正文层数=${forward.after.bodies}`)
  check('cover · 动画结束后页码 +1（真的翻到新页了）', forward.after.page === forward.before + 1, `${forward.before} → ${forward.after.page}`)
  check('cover · 往后翻的新页从右侧进来（is-from-next）', (forward.caught?.cover ?? '').includes('is-from-next'), forward.caught?.cover ?? '')

  // —— ③ 往回翻：新页从左侧进来 ——
  const back = await turnAndCatch(page, 'ArrowLeft')
  check('cover · 往回翻也走覆盖层、且从左侧进来（is-from-prev）',
    !!back.caught && back.caught.cover.includes('is-from-prev'), back.caught?.cover ?? '没抓到')
  check('cover · 往回翻结束后页码 -1', back.after.page === back.before - 1, `${back.before} → ${back.after.page}`)

  // —— ④ slide 档不许出现覆盖层 ——
  await openReader(page, first, 'slide')
  const slideTurn = await turnAndCatch(page, 'ArrowRight')
  check('slide 档不挂覆盖层（动画档不串）', !slideTurn.caught && !slideTurn.after.cover,
    slideTurn.caught ? `却抓到了 ${slideTurn.caught.cover}` : '全程没有覆盖层')
  check('slide 档翻页照常 +1', slideTurn.after.page === slideTurn.before + 1, `${slideTurn.before} → ${slideTurn.after.page}`)

  check('全程没有页面异常', errors.length === 0, errors.slice(0, 2).join(' | '))
} catch (error) {
  check(`门禁自身出错：${error.message}`, false)
} finally {
  if (browser) await browser.close().catch(() => null)
  const removed = await removeProbe(probeBookUrl)
  check('探针书已删除', removed, removed ? '已清' : '没删掉，需要手工清')
  const failed = results.filter(item => !item.ok)
  console.log(`\nreader-page-anim-check: PASS ${results.length - failed.length} / FAIL ${failed.length}`)
  if (failed.length) process.exitCode = 1
}
