// 快捷键的实测门禁（用户 2026-10-02：「加入一些快捷键快捷方式」）。
//
// 表与实现会不会各说一套，`web/test/Shortcuts.test.ts` 已经按源码扫过了；这里判的是另一件事：
// **真的按下那个键，屏幕上有没有发生那件事**。两边都要，因为漂移的方向不同：
// 单测看得见"表里写了没人实现"，看不见"实现了但被别的处理器先吃掉"（焦点在按钮上、
// 输入框判定过宽、preventDefault 漏了都会这样，而这三种都没有报错）。
//
// 夹具是自己造的一本三章本地书，跑完删掉。
// 跑法：node tools/verify/shortcut-check.mjs
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { OUT, SHOTS, BASE, launchOptions, acceptAgreement } from './env.mjs'

const require = createRequire(path.join(import.meta.dirname, '../../web/package.json'))
const puppeteer = require('puppeteer-core')

const STAMP = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)
const FILE_NAME = `快捷键探针${STAMP}`
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function probeTxt() {
  const lines = []
  for (let chapter = 1; chapter <= 3; chapter += 1) {
    lines.push(`第${'一二三'[chapter - 1]}章 快捷键第${chapter}站`)
    for (let p = 1; p <= 24; p += 1) lines.push(`这是第${chapter}章第${p}段，够长以便页面能滚。`.repeat(3))
  }
  return Buffer.from(lines.join('\n'), 'utf8')
}

/** 屏幕上此刻能被快捷键看到的状态：字号、主题类名、哪张抽屉开着、焦点在哪。 */
const readState = page => page.evaluate(() => {
  const content = document.querySelector('.reading-content')
  const focused = document.activeElement
  return {
    fontSize: content ? Number(getComputedStyle(content).fontSize.replace('px', '')) : 0,
    themeClass: (document.querySelector('.reader-workspace')?.className ?? '').split(' ').filter(c => c.startsWith('theme-')).join(','),
    tocOpen: !!document.querySelector('.reader-drawer-backdrop') && !!document.querySelector('.reader-chapters'),
    settingsOpen: !!document.querySelector('.setting-section'),
    helpOpen: !!document.querySelector('.shortcut-modal'),
    helpRows: document.querySelectorAll('.shortcut-modal kbd').length,
    focusTag: focused ? focused.tagName.toLowerCase() : '',
    focusPlaceholder: focused?.getAttribute?.('placeholder') ?? '',
    hash: location.hash,
  }
})

let probeBookUrl = ''
let browser = null
const errors = []
try {
  const form = new FormData()
  form.append('file', new Blob([probeTxt()], { type: 'text/plain' }), `${FILE_NAME}.txt`)
  const imported = await fetch(`${BASE}/api/bookshelf/import-local`, { method: 'POST', body: form })
  const body = await imported.json().catch(() => null)
  probeBookUrl = body?.results?.[0]?.bookUrl ?? ''
  const bookName = body?.results?.[0]?.name ?? FILE_NAME
  check('夹具导入成功', imported.status === 200 && !!probeBookUrl, `HTTP ${imported.status}`)

  browser = await puppeteer.launch(launchOptions())
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1 })
  page.on('pageerror', error => errors.push(String(error.message)))

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  // 首次协议浮层会挡住真鼠标点击；先标记已同意（见 env.mjs 的 acceptAgreement）
  await acceptAgreement(page)
  await page.evaluate(async () => {
    const regs = await navigator.serviceWorker?.getRegistrations?.() ?? []
    await Promise.all(regs.map(reg => reg.unregister()))
    const keys = await caches?.keys?.() ?? []
    await Promise.all(keys.map(key => caches.delete(key)))
  })
  await page.goto(`${BASE}/?t=${Date.now()}#shelf`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForFunction(name => !!document.querySelector(`[aria-label="继续阅读 ${name}"]`), { timeout: 45000 }, bookName)

  // ─────────────── 全局那一半（不进阅读器就该有效） ───────────────
  const globalBefore = await readState(page)
  await page.evaluate(() => document.body.focus())
  await page.keyboard.press('Digit3')
  await sleep(700)
  const afterDigit = await readState(page)
  check('数字键切页（3 → 书源）', afterDigit.hash === '#sources' && globalBefore.hash !== '#sources', `${globalBefore.hash} → ${afterDigit.hash}`)

  await page.goto(`${BASE}/?t=${Date.now()}#library`, { waitUntil: 'domcontentloaded' })
  // 这一跳之后要按的是**全局快捷键**，而那个 keydown 处理器是 React 挂载之后才 addEventListener 上去的。
  // 原来这里只有一句 sleep(1200)：刚清过 SW 与 caches 的首屏在冷 JVM 上不止 1.2 秒，按键时应用还没挂载，
  // 于是 / L ? 三条一起红（2026-10-04 实测：同一套键在等到 .app-page-header 之后逐个都有效）。
  // 挂载这件事单独成一条判据：下次再塌，报的是"探针按早了"，不会让人去查产品。
  const mounted = await page.waitForSelector('.app-page-header', { timeout: 45000 })
    .then(() => true).catch(() => false)
  check('探针：#library 已挂载（没挂载时快捷键必然全空，先把这件事单独列出来）', mounted, '')
  await sleep(600)
  await page.keyboard.press('Slash')
  await sleep(300)
  const afterSlash = await readState(page)
  check('斜杠聚焦当前页的搜索框', afterSlash.focusTag === 'input', `焦点在 <${afterSlash.focusTag} ${afterSlash.focusPlaceholder}>`)

  // 上一步把焦点留在了输入框里 —— 那正是"打字不该被抢"的样子，所以接下来测别的单字母键之前要先散焦，
  // 否则红的不是快捷键，是探针自己没把上一个状态收干净（第一版就在这条上连红两次）。
  await page.evaluate(() => document.activeElement && document.activeElement.blur())
  await sleep(200)
  await page.keyboard.press('KeyL')
  await sleep(600)
  const logsOpen = await page.evaluate(() => !!document.querySelector('.logs-modal'))
  check('L 打开运行日志', logsOpen, logsOpen ? '开了' : '没开')
  await page.keyboard.press('Escape')
  await sleep(400)

  // `press('Shift+Slash')` 这套按键名表里不存在（会直接抛 Unknown key），要按组合键就自己按下 Shift
  await page.keyboard.down('Shift')
  await page.keyboard.press('Slash')
  await page.keyboard.up('Shift')
  await sleep(500)
  const help = await readState(page)
  const headings = await page.evaluate(() => [...document.querySelectorAll('.shortcut-modal .setting-label')]
    .map(node => node.textContent?.trim() ?? ''))
  // "表里每一条都渲染出来"由 web/test/Shortcuts.test.ts 按导入的那份表逐条核对（它能拿到数组本身）；
  // 这里只判这张表打得开、两组都在，不去数源码里写了几条字面量（数字键那几条是 map 出来的）。
  check('? 打开「快捷键」这张表，两组都列出来',
    help.helpOpen && help.helpRows >= 20 && headings.includes('阅读器') && headings.includes('全局'),
    `${help.helpRows} 行 · 分组 ${headings.join(' / ')}`)
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `shortcut-help-${STAMP}.png`) })
  await page.keyboard.press('Escape')
  await sleep(400)
  check('Esc 关掉这张表', !(await readState(page)).helpOpen, '')
  // ─────────────── 阅读器那一半 ───────────────
  await page.goto(`${BASE}/?t=${Date.now()}#shelf`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(name => !!document.querySelector(`[aria-label="继续阅读 ${name}"]`), { timeout: 45000 }, bookName)
  await page.evaluate(name => document.querySelector(`[aria-label="继续阅读 ${name}"]`).click(), bookName)
  await page.waitForSelector('.reading-content', { timeout: 45000 })
  await sleep(1800)

  const base = await readState(page)
  await page.keyboard.press('Equal')
  await sleep(400)
  const bigger = await readState(page)
  await page.keyboard.press('Minus')
  await sleep(400)
  const back = await readState(page)
  check('+ 加大一档字号，- 再减回来', bigger.fontSize > base.fontSize && Math.abs(back.fontSize - base.fontSize) < 0.51,
    `${base.fontSize}px → ${bigger.fontSize}px → ${back.fontSize}px`)

  await page.keyboard.press('KeyT')
  await sleep(500)
  const themed = await readState(page)
  check('T 换下一套主题（并当场落进 localStorage）', themed.themeClass !== base.themeClass && !!themed.themeClass,
    `${base.themeClass || '无'} → ${themed.themeClass}`)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.reading-content', { timeout: 45000 })
  await sleep(1200)
  check('换完的主题下次进来还是它（不是只改了一下界面）', (await readState(page)).themeClass === themed.themeClass, themed.themeClass)

  await page.keyboard.press('KeyD')
  await sleep(500)
  const tocOpen = await readState(page)
  await page.keyboard.press('KeyD')
  await sleep(500)
  const tocClosed = await readState(page)
  check('D 开目录抽屉，再按一次收起', tocOpen.tocOpen && !tocClosed.tocOpen, tocOpen.tocOpen ? '开→关都成立' : '第一次就没开')

  await page.keyboard.press('KeyS')
  await sleep(500)
  check('S 开阅读设置', (await readState(page)).settingsOpen, '')
  await page.keyboard.press('Escape')
  await sleep(400)

  // 反向对照：点过一次目录条目之后焦点留在那个按钮上，字母键必须仍然有效
  // （曾经的写法把整个 button 当"正在输入"，于是点过一次目录之后 T/D/S 全哑，没有任何报错）。
  // 用真鼠标点：程序化 .click() 不会把焦点放上去，那样这条反向对照就成了空判。
  await page.keyboard.press('KeyD')
  await sleep(500)
  const box = await page.evaluate(() => {
    const item = document.querySelector('.reader-chapter-item')
    if (!item) return null
    const rect = item.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  })
  if (box) await page.mouse.click(box.x, box.y)
  await sleep(600)
  const focusedTag = await page.evaluate(() => document.activeElement?.tagName?.toLowerCase() ?? '')
  const themeBeforeButton = (await readState(page)).themeClass
  await page.keyboard.press('KeyT')
  await sleep(500)
  const afterButton = await readState(page)
  check('反向对照：焦点真的停在按钮上时，字母快捷键照样生效',
    focusedTag === 'button' && afterButton.themeClass !== themeBeforeButton,
    `点完之后焦点在 <${focusedTag}> · 主题 ${themeBeforeButton} → ${afterButton.themeClass}`)

  // 反向对照：在输入框里打字不许被当成快捷键
  await page.keyboard.press('KeyD')
  await sleep(500)
  await page.evaluate(() => document.querySelector('input[placeholder="搜索章节"]')?.focus())
  const typingBefore = await readState(page)
  await page.keyboard.type('ttds', { delay: 40 })
  await sleep(500)
  const typingAfter = await readState(page)
  check('搜索框里打 t/t/d/s 不触发快捷键（那是用户在打字）',
    typingAfter.themeClass === typingBefore.themeClass && typingAfter.tocOpen === true,
    `主题 ${typingAfter.themeClass} · 目录还开着=${typingAfter.tocOpen}`)

  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `shortcut-${STAMP}.png`) })
  check('全程没有页面异常', errors.length === 0, errors.slice(0, 3).join(' | '))
} catch (error) {
  check('探针脚本自身异常', false, error.message)
} finally {
  if (browser) await browser.close().catch(() => null)
  if (probeBookUrl) {
    const removed = await fetch(`${BASE}/api/bookshelf?sourceId=loc_book&bookUrl=${encodeURIComponent(probeBookUrl)}`, { method: 'DELETE' })
    const left = await fetch(`${BASE}/api/bookshelf`).then(res => res.json()).catch(() => [])
    check('收尾删掉探针书', removed.status < 400 && !(left ?? []).some(item => item.bookUrl === probeBookUrl), `HTTP ${removed.status}`)
  }
  fs.mkdirSync(OUT, { recursive: true })
  const failed = results.filter(row => !row.ok)
  fs.writeFileSync(path.join(OUT, `shortcut-${STAMP}.json`), JSON.stringify({ stamp: STAMP, base: BASE, results }, null, 2))
  for (const row of results) console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name}${row.detail ? '   [' + row.detail + ']' : ''}`)
  console.log(`\n${results.length - failed.length}/${results.length} PASS · 详情 tools/verify/out/shortcut-${STAMP}.json`)
  process.exit(failed.length ? 1 : 0)
}
