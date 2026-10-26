// 「登录按钮点不到」取证：打开指定书源的内置浏览器，收集页面自己回报的登录控件现场。
// 用法：node tools/verify/webview-login-probe.mjs [书名关键词]
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { BASE, OUT, SHOTS, ROOT, launchOptions } from './env.mjs'

const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')

const KEYWORD = process.argv[2] || '番茄'

const b = await puppeteer.launch(launchOptions())
const p = await b.newPage()
await p.setViewport({ width: 1440, height: 900 })
const pageErrors = []
p.on('pageerror', e => pageErrors.push(String(e.message || e)))

await p.goto(`${BASE}/#sources`, { waitUntil: 'domcontentloaded', timeout: 40000 })
await new Promise(r => setTimeout(r, 2500))

// 宿主页面先挂监听：iframe 的自检是 postMessage 给父窗口的，不改动产品代码就能收全。
await p.evaluate(() => {
  window.__diag = []
  window.addEventListener('message', event => {
    const d = event.data
    if (d && d.source === 'legado-webview') window.__diag.push({ ...d, at: Date.now() })
  })
})

const picked = await p.evaluate(keyword => {
  // 列表按名称排序且只渲染前 120 行，中文书名排在后面：先用筛选框定位
  const filter = document.querySelector('.source-filter input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(filter, keyword)
  filter.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}, KEYWORD)
await new Promise(r => setTimeout(r, 2200))

const found = await p.evaluate(keyword => {
  const rows = [...document.querySelectorAll('.source-list button')]
  const row = rows.find(el => el.innerText.includes(keyword) && el.innerText.includes('登录')) || rows.find(el => el.innerText.includes(keyword))
  if (!row) return { ok: false, reason: `筛选「${keyword}」后仍无结果（命中 ${rows.length} 行：${rows.slice(0, 3).map(r => r.innerText.replace(/\s+/g, ' ')).join(' | ')}）` }
  row.click()
  return { ok: true, row: row.innerText.replace(/\s+/g, ' ').slice(0, 40) }
}, KEYWORD)
if (!found.ok) { console.log(JSON.stringify(found, null, 1)); await b.close(); process.exit(1) }
console.log('选中书源：', found.row)
await new Promise(r => setTimeout(r, 1800))

const opened = await p.evaluate(() => {
  const entry = document.querySelector('.source-login-entry-btn')
  if (!entry) return '该书源没有登录入口（没有 loginUrl/loginCheckJs）'
  entry.click()
  return 'login-modal'
})
console.log('登录入口：', opened)
await new Promise(r => setTimeout(r, 1800))

const browserOpened = await p.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(e =>
    (e.innerText || '').includes('用内置浏览器登录') || (e.getAttribute('title') || '').includes('用内置浏览器登录'))
  if (!btn) return false
  btn.click()
  return true
})
console.log('内置浏览器：', browserOpened ? '已打开' : '没找到入口按钮')
const startedAt = Date.now()
while (Date.now() - startedAt < 20000) {
  await new Promise(r => setTimeout(r, 2000))
  const n = await p.evaluate(() => (window.__diag || []).filter(d => d.type === 'diagnostics').length)
  process.stdout.write(`\r收集自检回报 ${n} 份    `)
  if (n >= 3) break
}
console.log()

const reports = await p.evaluate(() => (window.__diag || []).filter(d => d.type === 'diagnostics'))
const navigated = await p.evaluate(() => (window.__diag || []).filter(d => d.type === 'navigated').map(d => d.url))
const shot = path.join(SHOTS, `webview-login-probe-${KEYWORD}-${Date.now().toString().slice(-6)}.png`)
fs.mkdirSync(SHOTS, { recursive: true })
await p.screenshot({ path: shot })

const footnote = await p.evaluate(() => document.querySelector('.source-webview-footnote')?.innerText.replace(/\s+/g, ' ').trim() ?? '')
const out = { keyword: KEYWORD, screenshot: shot, navigated, footnote, reports, pageErrors }
fs.writeFileSync(path.join(OUT, 'webview-login-probe.json'), JSON.stringify(out, null, 2))
console.log(JSON.stringify({ navigated, footnote, reports }, null, 1))
await b.close()
