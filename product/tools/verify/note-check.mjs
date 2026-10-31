import path from 'node:path'
import { createRequire } from 'node:module'
import { BASE, launchOptions } from './env.mjs'

/**
 * 笔记 / 划线门禁（PROPOSAL-019 E）。要钉的是那句承诺：**划完线，刷新还在**。
 *
 * 光看代码看不出来 —— 选区换算、偏移存储、高亮定位、重新加载，任何一环断了都只是"高亮没出现"，
 * 没有任何报错。所以这里真开一本探针书、真选一段正文、真点保存，再**刷新一次**看高亮回不回来。
 *
 * 跑法：node tools/verify/note-check.mjs
 */
const puppeteer = createRequire(path.join(import.meta.dirname, '../../web/package.json'))('puppeteer-core')
const STAMP = Date.now().toString(36)
const BOOK_NAME = `笔记探针-${STAMP}`
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`) }

const syntheticBook = () => {
  const chapters = Array.from({ length: 4 }, (_, index) => {
    const paragraphs = Array.from({ length: 10 }, (_, part) =>
      `这是第${index + 1}节的第${part + 1}段落。${'这一句要写得足够长，好让人有地方可以选中划线。'.repeat(3)}`).join('\n\n')
    return `第${index + 1}章 笔记探针\n\n${paragraphs}`
  }).join('\n\n')
  return `${BOOK_NAME}\n作者：门禁探针\n\n${chapters}\n`
}

/** 选一段正文并把 mouseup 派发到段落上（合成的 `mouseup` 能触发 React 的处理）。 */
const selectParagraph = page => page.evaluate(() => {
  const paragraph = [...document.querySelectorAll('.reader-paragraph')].find(el => (el.textContent ?? '').trim().length > 24)
  if (!paragraph) return ''
  const textNode = [...paragraph.childNodes].find(node => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim().length > 12)
  if (!textNode) return ''
  const range = document.createRange()
  range.setStart(textNode, 0)
  range.setEnd(textNode, Math.min(12, (textNode.textContent ?? '').length))
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  return (textNode.textContent ?? '').slice(0, 12)
})

const openReader = async (page, book) => {
  await page.goto(`${BASE}/?t=${Date.now()}#shelf`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(name => [...document.querySelectorAll('.shelf-card-name')]
    .some(node => node.textContent?.trim() === name), { timeout: 60000 }, book.name)
  await page.evaluate(name => {
    const card = [...document.querySelectorAll('.shelf-card')].find(node => node.querySelector('.shelf-card-name')?.textContent?.trim() === name)
    card?.querySelector('.shelf-card-cover')?.click()
  }, book.name)
  await page.waitForSelector('.reader-paragraph', { timeout: 60000 })
  // 首屏先挂的是「前言」（只有书名/作者两行短段），够长的那几段要等下一章续接上来 ——
  // 不等就选，`selectParagraph` 找不到目标，后面全是空判。
  await page.waitForFunction(() => [...document.querySelectorAll('.reader-paragraph')]
    .some(el => (el.textContent ?? '').trim().length > 24), { timeout: 30000 })
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

  browser = await puppeteer.launch(launchOptions())
  const page = await browser.newPage()
  await page.setViewport({ width: 1200, height: 900 })
  const errors = []
  page.on('pageerror', event => errors.push(String(event.message)))

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app-page-header', { timeout: 30000 })
  await openReader(page, first)

  const excerpt = await selectParagraph(page)
  check('选中了一段正文（否则后面都是空判）', excerpt.length >= 8, excerpt)
  await page.waitForSelector('.reader-marking-menu', { timeout: 8000 }).catch(() => null)
  // 没弹出来时，把 buildSelectionDraft 那几道判据的实测值一起打出来：
  // 它任何一步 return null 表现都一样（没浮层 → 后面几条连锁红），只报"没找到"等于让人重新猜一遍。
  const shown = await page.evaluate(() => !!document.querySelector('.reader-marking-menu'))
  const why = await page.evaluate(() => {
    const sel = window.getSelection()
    const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null
    const node = range ? (range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer) : null
    const p = node ? node.closest('.reader-paragraph') : null
    return `paragraph=${!!p} paragraphIndex=${p?.dataset?.paragraphIndex ?? '无'} ` +
      `chapterIndex容器=${p?.closest('[data-chapter-index]')?.dataset?.chapterIndex ?? '无'} ` +
      `collapsed=${sel?.isCollapsed} 选区长度=${(sel?.toString() ?? '').length}`
  })
  check('选中后摆出了标记快捷条', shown, shown ? '' : why)
  // 0.0.6 起选中正文先摆的是「划线 / 笔记 / 复制 / AI」这条快捷条，点「笔记」才展开编辑器。
  // 判据从前假定选中即弹编辑器，UI 改版后一直红着，把这条真实形状钉下来。
  const menuLabels = await page.evaluate(() => [...document.querySelectorAll('.reader-marking-btn')]
    .map(node => node.getAttribute('aria-label') ?? '').filter(Boolean).join(','))
  check('快捷条给齐了那四个动作（外加关闭）',
    ['划线', '笔记', '复制', 'AI', '关闭'].every(name => menuLabels.includes(name)), menuLabels)

  // 点「划线」= 只留高亮、不写备注
  await page.evaluate(() => [...document.querySelectorAll('.reader-marking-btn')]
    .find(node => node.getAttribute('aria-label') === '划线')?.click())
  await page.waitForFunction(() => !!document.querySelector('.reader-note-highlight'), { timeout: 8000 }).catch(() => null)
  check('点划线后正文里出现了高亮', await page.evaluate(() => !!document.querySelector('.reader-note-highlight')))
  check('划完快捷条自己收掉了', await page.evaluate(() => !document.querySelector('.reader-marking-menu')))

  // 再走一遍「写笔记」那条：点笔记 → 编辑器展开 → 存文字
  await selectParagraph(page)
  await page.waitForSelector('.reader-note-toolbar', { timeout: 8000 }).catch(() => null)
  const editorShown = await page.evaluate(() => {
    const menu = [...document.querySelectorAll('.reader-marking-btn')]
      .find(node => node.getAttribute('aria-label') === '笔记')
    menu?.click()
    return true
  })
  await page.waitForSelector('.reader-note-toolbar textarea, .reader-note-toolbar input', { timeout: 8000 }).catch(() => null)
  const typed = await page.evaluate(() => {
    const box = document.querySelector('.reader-note-toolbar textarea, .reader-note-toolbar input')
    if (!box) return false
    const proto = box.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(box, '这一句想记下来')
    box.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })
  check('点「笔记」展开编辑器并能输入备注', editorShown && typed && await page.evaluate(() => !!document.querySelector('.reader-note-toolbar')))
  await page.evaluate(() => document.querySelector('.reader-note-toolbar .primary-button')?.click())
  await page.waitForFunction(() => !!document.querySelector('.reader-note-toolbar') === false, { timeout: 8000 }).catch(() => null)

  let stored = await (await fetch(`${BASE}/api/notes?sourceId=loc_book&bookUrl=${encodeURIComponent(probeBookUrl)}`)).json().catch(() => [])
  check('服务端存下了这两条', Array.isArray(stored) && stored.length === 2, `实际 ${Array.isArray(stored) ? stored.length : '?'} 条`)
  check('偏移是章节内字符偏移（数字、end ≥ start）',
    typeof stored?.[0]?.startOffset === 'number' && stored[0].endOffset >= stored[0].startOffset,
    `start=${stored?.[0]?.startOffset} end=${stored?.[0]?.endOffset}`)

  // —— 关键那一条：刷新之后高亮还得在 ——
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.reader-paragraph', { timeout: 60000 }).catch(() => null)
  await page.waitForFunction(() => !!document.querySelector('.reader-note-highlight'), { timeout: 15000 }).catch(() => null)
  const afterReload = await page.evaluate(() => document.querySelectorAll('.reader-note-highlight').length)
  check('刷新之后高亮还在（划线存住了）', afterReload >= 1, `${afterReload} 处`)

  // 「笔记」面板列得出来
  const panelOpened = await page.evaluate(() => {
    const button = [...document.querySelectorAll('.reader-drawer-left button')].find(node => (node.getAttribute('aria-label') ?? '').startsWith('笔记'))
    if (!button) return false
    button.click()
    return true
  })
  await page.waitForFunction(() => !!document.querySelector('.reader-notes-list'), { timeout: 8000 }).catch(() => null)
  const listed = await page.evaluate(() => document.querySelectorAll('.reader-note-item').length)
  check('抽屉里有「笔记」面板，两条都列得出（一条纯划线、一条带备注）', panelOpened && listed === 2, `列出 ${listed} 条`)

  check('全程没有页面异常', errors.length === 0, errors.slice(0, 2).join(' | '))
} catch (error) {
  check(`门禁自身出错：${error.message}`, false)
} finally {
  if (browser) await browser.close().catch(() => null)
  if (probeBookUrl) {
    // 删书会连带删掉它的笔记（服务端有这条清理）
    await fetch(`${BASE}/api/bookshelf?sourceId=loc_book&bookUrl=${encodeURIComponent(probeBookUrl)}`, { method: 'DELETE' })
    const notes = await (await fetch(`${BASE}/api/notes?sourceId=loc_book&bookUrl=${encodeURIComponent(probeBookUrl)}`)).json().catch(() => [])
    check('探针书已删除（笔记随之清掉）', notes.length === 0, `残留 ${notes.length} 条笔记`)
  }
  const failed = results.filter(item => !item.ok)
  console.log(`\nnote-check: PASS ${results.length - failed.length} / FAIL ${failed.length}`)
  if (failed.length) process.exitCode = 1
}
