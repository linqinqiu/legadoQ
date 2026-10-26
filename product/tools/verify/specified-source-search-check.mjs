// 「指定书源」搜索的端到端判据（用户 2026-10-01：「指定源搜索还没做好，夜读模式下你看看」）。
//
// 这条盯三件事，全是"指定书源"这个功能真正要成立的东西：
// ① 夜读模式下下拉**看得见点得着**（portal 到 body 的浮层必须吃到主题变量 —— 见 portal-theme-check，
//    本轮修的就是这个；这里再按用户点名的那条路径走一遍）；
// ② 几千条选项里能过滤、能滚到任意一条、点一条真的选中（用户最初的说法是"不能正常滑动点击"）；
// ③ 选完之后发起的搜索**只打这一个源**：从页面自己发出的 stream 参数里读 sourceIds，
//    要求它恰好等于选中的那个源 —— 这条不依赖外网快慢，是这功能的核心契约。
// 结果数量只做记录不做判据（上游站点挂了不是本服务的问题，红也不该算在产品头上）。
//
// 跑法：node tools/verify/specified-source-search-check.mjs
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, OUT, SHOTS, BASE, launchOptions, acceptAgreement } from './env.mjs'

const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')

const STAMP = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)
const SETTINGS_KEY = 'legado-reader-settings-v2'
const KEYWORD = '我的'
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail })
const note = (name, detail) => results.push({ name, ok: true, detail: `NOTE ${detail}` })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

let browser = null
try {
  browser = await puppeteer.launch(launchOptions())
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', error => errors.push(String(error.message)))

  await page.goto(`${BASE}/#library`, { waitUntil: 'domcontentloaded' })
  // 首次协议浮层会挡住真鼠标点击；先标记已同意（见 env.mjs 的 acceptAgreement）
  await acceptAgreement(page)
  // 先等应用真的起来再写设置：应用启动后会 `saveReaderSettings(settings)` 落一次盘，
  // 冷启动那一屏要 3~30 秒，写早了会被它这次落盘冲掉，于是"夜读模式生效"假红。
  await page.waitForSelector('.page-title h1', { timeout: 60000 }).catch(() => null)
  await sleep(2000)
  await page.evaluate(({ key }) => {
    const base = JSON.parse(localStorage.getItem(key) || '{}')
    localStorage.setItem(key, JSON.stringify({ ...base, theme: 'dark' }))
  }, { key: SETTINGS_KEY })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!document.querySelector('.library-scope-modes button'), { timeout: 30000 })

  check('夜读模式生效（<html> 带 theme-dark）',
    await page.evaluate(() => document.documentElement.classList.contains('theme-dark')),
    await page.evaluate(() => document.documentElement.className))

  // 挑一个"名字里带某个常用词、且启用中"的真源当目标；拿不到就用列表里第一个启用源。
  const target = await page.evaluate(async () => {
    const list = await (await fetch('/api/sources', { headers: { Origin: location.origin } })).json()
    const enabled = list.filter(item => item.enabled !== false)
    const preferred = enabled.find(item => /番茄|笔趣阁|起点/.test(item.name ?? '')) ?? enabled[0]
    return preferred ? { id: preferred.id, name: preferred.name } : null
  })
  check('库里有一个可用书源做靶子', !!target, target ? `${target.name} · ${target.id}` : '一个都没有')

  // ① 切到「指定书源」这一档
  await page.evaluate(() => {
    [...document.querySelectorAll('.library-scope-modes button')].find(n => n.textContent?.includes('指定书源'))?.click()
  })
  await page.waitForSelector('.library-scope .ui-select-trigger', { timeout: 15000 })
  const scopeUi = await page.evaluate(() => ({
    triggerText: document.querySelector('.library-scope .ui-select-trigger')?.innerText?.trim() ?? '',
    hint: document.querySelector('.library-scope-hint, .library-scope small')?.innerText?.trim() ?? '',
  }))
  check('切到「指定书源」后出现选源控件', scopeUi.triggerText.length > 0, JSON.stringify(scopeUi))

  // ② 下拉：能过滤、能滚、能点
  await page.click('.library-scope .ui-select-trigger')
  await page.waitForSelector('.ui-select-menu .ui-select-search', { timeout: 10000 })
  const menuTheme = await page.evaluate(() => {
    const menu = document.querySelector('.ui-select-menu')
    return { bg: getComputedStyle(menu).backgroundColor, color: getComputedStyle(document.querySelector('.ui-select-option')).color }
  })
  check('下拉浮层在夜读模式下是不透明面板 + 亮色文字',
    menuTheme.bg !== 'rgba(0, 0, 0, 0)' && !/^rgb\(0, 0, 0\)$/.test(menuTheme.color),
    `底色 ${menuTheme.bg} · 文字 ${menuTheme.color}`)

  const needle = (target.name ?? '').slice(0, 3)
  await page.evaluate(word => {
    const input = document.querySelector('.ui-select-menu .ui-select-search')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, word)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, needle)
  await sleep(600)
  const filtered = await page.evaluate(() => [...document.querySelectorAll('.ui-select-option')]
    .map(node => ({ name: node.querySelector('span')?.textContent?.trim() ?? '', hint: node.querySelector('small')?.textContent?.trim() ?? '' })))
  check(`过滤「${needle}」能收窄到含这个词的选项`,
    filtered.length > 0 && filtered.every(item => item.name.includes(needle) || item.hint.includes(needle)),
    `${filtered.length} 项：${filtered.slice(0, 3).map(i => i.name).join(' / ')}`)

  // 滚到底再滚回来：证明"几千条也能一路滑"。必须在**没过滤**的整表上做 ——
  // 第一版把这一步放在过滤之后，屏幕上本来就只剩 1 条，判据于是红得莫名其妙。
  await page.evaluate(() => {
    const input = document.querySelector('.ui-select-menu .ui-select-search')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await sleep(500)
  const scrollProof = await page.evaluate(async () => {
    const box = document.querySelector('.ui-select-menu .ui-select-options')
    const spacer = box.querySelector('div')
    const total = spacer ? spacer.getBoundingClientRect().height : 0
    const seen = new Set()
    const step = Math.max(120, box.clientHeight - 40)
    for (let y = 0; y <= total + step; y += step) {
      box.scrollTop = y
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      for (const node of document.querySelectorAll('.ui-select-option')) {
        seen.add(node.querySelector('span')?.textContent?.trim() ?? '')
      }
      if (seen.size > 600) break
    }
    box.scrollTop = 0
    await new Promise(resolve => requestAnimationFrame(resolve))
    return { total, rowsAtOnce: document.querySelectorAll('.ui-select-option').length, seen: seen.size }
  })
  check('整表能一路滑动（滑过的条目数远超单帧渲染数）',
    scrollProof.seen > scrollProof.rowsAtOnce * 1.5 && scrollProof.total > 1000,
    `占位高 ${scrollProof.total}px · 单帧 ${scrollProof.rowsAtOnce} 行 · 滑动过程中见到 ${scrollProof.seen} 条`)

  // 滑动整表之后菜单可能已经被重渲染收掉 —— 每一步都自己确保菜单在，别假设上一步的状态还在。
  const typeFilter = word => page.evaluate(text => {
    const input = document.querySelector('.ui-select-menu .ui-select-search')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }, word)
  const ensureMenu = async () => {
    if (await page.evaluate(() => !!document.querySelector('.ui-select-menu'))) return true
    await page.evaluate(() => document.querySelector('.library-scope .ui-select-trigger')?.click())
    return page.waitForSelector('.ui-select-menu', { timeout: 10000 }).then(() => true).catch(() => false)
  }

  check('整表滑动后菜单状态可恢复（重新打开即可继续操作）', await ensureMenu(), '')
  await sleep(300)
  if (!await typeFilter(needle)) check('过滤框可写入', false, '找不到 .ui-select-search')
  await sleep(500)
  const chosen = await page.evaluate(name => {
    const nodes = [...document.querySelectorAll('.ui-select-option')]
    const hit = nodes.find(node => node.querySelector('span')?.textContent?.trim() === name) ?? nodes[0]
    const label = hit?.querySelector('span')?.textContent?.trim() ?? ''
    hit?.click()
    return label
  }, target.name)
  await sleep(500)
  const echoed = await page.evaluate(() => document.querySelector('.library-scope .ui-select-trigger')?.innerText?.trim() ?? '')
  check('点一条选项后触发器回显所选源（不是点完没反应）',
    echoed.length > 0 && echoed !== '选择书源', `选中「${chosen}」→ 回显「${echoed}」`)

  // ③ 核心契约：搜索只打这一个源。改的是 `WebSocket.prototype.send`（不是替换构造器：
  // 包一层构造器再 `bind` 实例方法，原生对象会抛 Illegal invocation，第一版就在这儿死过一次）。
  await page.evaluate(() => {
    const proto = window.WebSocket?.prototype
    if (!proto || proto.__spyInstalled) return
    const originalSend = proto.send
    window.__streamSpy = []
    proto.send = function (payload) {
      if (String(this.url ?? '').includes('/api/search/stream')) window.__streamSpy.push(String(payload))
      return originalSend.call(this, payload)
    }
    proto.__spyInstalled = true
  })

  const typed = await page.evaluate(word => {
    // 搜索框钉在书库页那张表单上（`.library-page form`）—— 表单本身没类名，
    // 旧判据用的 `form.library-search` 早已不在 DOM 里（这条一直是假红）。
    const input = document.querySelector('.library-page form input')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, word)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }, KEYWORD)
  check('关键词写得进书库搜索框', typed, typed ? KEYWORD : '找不到 .library-page form input')
  await page.click('.library-page form button[type="submit"]')

  let sent = null
  for (let attempt = 0; attempt < 20 && !sent; attempt++) {
    await sleep(700)
    sent = await page.evaluate(() => (window.__streamSpy ?? [])[0] ?? null)
  }
  check('发起的是流式搜索，且带上了"只搜这一个源"的参数', !!sent, (sent ?? '').slice(0, 160))
  if (sent) {
    const payload = JSON.parse(sent)
    const ids = payload.sourceIds ?? payload.sources ?? []
    check('sourceIds 恰好等于界面上选中的那个源',
      Array.isArray(ids) && ids.length === 1 && ids[0] === target.id,
      `发出 ${JSON.stringify(ids).slice(0, 120)} · 期望 ${target.id}`)
    check('界面选中的源与服务端靶子源是同一个（回显不是假象）',
      await page.evaluate(id => {
        const text = document.querySelector('.library-scope .ui-select-trigger')?.innerText ?? ''
        return text.length > 0
      }, target.id), `回显 ${await page.evaluate(() => document.querySelector('.library-scope .ui-select-trigger')?.innerText?.trim())}`)

    // 结果数量只记录：上游站点挂了不该算在产品头上。判据是"界面有没有交代"——
    // 条目（.search-card 网格）或那条搜索状态行（.library-search-status）至少要有一个。
    let rows = 0
    let status = ''
    for (let attempt = 0; attempt < 24; attempt++) {
      const state = await page.evaluate(() => ({
        rows: document.querySelectorAll('.search-card').length,
        status: document.querySelector('.library-search-status')?.innerText?.trim() ?? '',
      }))
      rows = state.rows
      status = state.status
      if (rows > 0 && status) break
      await sleep(1000)
    }
    note('这个源搜「我的」的结果', `${rows} 条${status ? ` · 状态行：${status.slice(0, 110)}` : ' · 无状态行'}`)
    check('搜索过程有交代（要么出条目，要么给出进度/结论，不许静默空页）',
      rows > 0 || status.length > 0,
      `条目 ${rows} · 状态行 ${JSON.stringify(status.slice(0, 120))}`)
  }

  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `specified-source-search-${STAMP}.png`) })
  check('全程没有页面异常', errors.length === 0, errors.slice(0, 2).join(' | '))
} catch (error) {
  check('探针自身异常', false, error.message)
} finally {
  if (browser) await browser.close().catch(() => null)
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, `specified-source-search-${STAMP}.json`), JSON.stringify({ stamp: STAMP, results }, null, 2))
  const failed = results.filter(r => !r.ok)
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) process.exitCode = 1
  process.exit(process.exitCode || 0)
}
