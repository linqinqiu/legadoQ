import path from 'node:path'
import { createRequire } from 'node:module'
import { BASE, launchOptions } from './env.mjs'

/**
 * 阅读记录门禁（PROPOSAL-019 D）。要钉的是那句承诺：**在阅读页停留 30 秒，时间轴多一条**。
 *
 * 光看代码看不出来 —— 计时在阅读器里、上报走 POST、聚合在服务端，任何一环断了都只是"记录不动"，
 * 没有任何报错。所以这里真开一本探针书、真停 30 秒以上，再回读 `/api/reading-log` 比对秒数增量。
 *
 * 只增不改 ⇒ 用**增量**判，不用绝对值（同一本书反复跑会累加）。
 * 跑法：node tools/verify/reading-log-check.mjs
 */
const puppeteer = createRequire(path.join(import.meta.dirname, '../../web/package.json'))('puppeteer-core')
const STAMP = Date.now().toString(36)
const BOOK_NAME = `阅读记录探针-${STAMP}`
const STAY_SECONDS = 34
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`) }

const syntheticBook = () => {
  const chapters = Array.from({ length: 5 }, (_, index) => {
    const paragraphs = Array.from({ length: 12 }, (_, part) =>
      `这是第${index + 1}节的第${part + 1}段落。${'写得足够长好让它占满大半栏。'.repeat(4)}`).join('\n\n')
    return `第${index + 1}章 记录探针\n\n${paragraphs}`
  }).join('\n\n')
  return `${BOOK_NAME}\n作者：门禁探针\n\n${chapters}\n`
}

const secondsFor = async bookUrl => {
  const list = await (await fetch(`${BASE}/api/reading-log?days=1`)).json().catch(() => [])
  return list.filter(row => row.bookUrl === bookUrl).reduce((sum, row) => sum + (row.seconds ?? 0), 0)
}

let probeBookUrl = ''
let browser
try {
  const form = new FormData()
  form.append('file', new Blob([syntheticBook()], { type: 'text/plain; charset=utf-8' }), `${BOOK_NAME}.txt`)
  const imported = await (await fetch(`${BASE}/api/bookshelf/import-local?tocRule=builtin`, { method: 'POST', body: form })).json()
  const first = imported?.results?.[0]
  probeBookUrl = first?.bookUrl ?? ''
  check('探针书已导入', !!first?.success && !!probeBookUrl, `${first?.name ?? ''} · ${first?.totalChapters ?? 0} 章`)
  if (!first?.success) throw new Error('导入失败')

  const before = await secondsFor(probeBookUrl)

  browser = await puppeteer.launch(launchOptions())
  const page = await browser.newPage()
  await page.setViewport({ width: 1200, height: 860 })
  const errors = []
  page.on('pageerror', event => errors.push(String(event.message)))
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app-page-header', { timeout: 30000 })
  await page.goto(`${BASE}/?t=${Date.now()}#shelf`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(name => [...document.querySelectorAll('.shelf-card-name')]
    .some(node => node.textContent?.trim() === name), { timeout: 60000 }, first.name)
  await page.evaluate(name => {
    const card = [...document.querySelectorAll('.shelf-card')].find(node => node.querySelector('.shelf-card-name')?.textContent?.trim() === name)
    card?.querySelector('.shelf-card-cover')?.click()
  }, first.name)
  // 阅读器真的挂上来了才算"在读"
  await page.waitForSelector('.reading-content p, .reader-paginated-column-body p', { timeout: 60000 })
  check('探针书已打开（阅读器起来了）', true)
  check('页面是可见态（不可见就不该计时）', await page.evaluate(() => document.visibilityState) === 'visible')

  // 真的停着读
  await new Promise(r => setTimeout(r, STAY_SECONDS * 1000))

  const after = await secondsFor(probeBookUrl)
  const delta = after - before
  check(`停留 ${STAY_SECONDS} 秒后，这本书的记录秒数 +≥30`, delta >= 30, `${before} → ${after}（+${delta}）`)

  const rows = await (await fetch(`${BASE}/api/reading-log?days=1`)).json().catch(() => [])
  const row = rows.find(item => item.bookUrl === probeBookUrl)
  check('记录里带上了书名（时间轴要显示读的哪本）', row?.bookName === first.name, row?.bookName ?? '（没有这一条）')
  check('记录带上今天的日期', /^\d{4}-\d{2}-\d{2}$/.test(row?.day ?? ''), row?.day ?? '')
  check('全程没有页面异常', errors.length === 0, errors.slice(0, 2).join(' | '))
} catch (error) {
  check(`门禁自身出错：${error.message}`, false)
} finally {
  if (browser) await browser.close().catch(() => null)
  if (probeBookUrl) {
    await fetch(`${BASE}/api/bookshelf?sourceId=loc_book&bookUrl=${encodeURIComponent(probeBookUrl)}`, { method: 'DELETE' })
    const after = await (await fetch(`${BASE}/api/bookshelf`)).json().catch(() => [])
    check('探针书已删除', !after.some(entry => entry.bookUrl === probeBookUrl), '已清')
  }
  const failed = results.filter(item => !item.ok)
  console.log(`\nreading-log-check: PASS ${results.length - failed.length} / FAIL ${failed.length}`)
  if (failed.length) process.exitCode = 1
}
