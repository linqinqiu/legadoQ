import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
// 用仓库内的相对位置解析 puppeteer-core，不写死绝对路径 ——
// 原来这里写死 E:/legado/legado/web/package.json（旧目录名 + 某台机器的盘符），
// 换台机器 / 改过目录名就 MODULE_NOT_FOUND，门禁直接崩。
// 从本文件位置推出仓库根，不依赖调用方的 cwd。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')
const { chromePath, OUT, BASE, requireService } = await import('./env.mjs')

// 前置：服务必须在跑（下面要导航到真界面）。范式同 stalled-client-check.mjs:105-109。
await requireService('webview-ui-check')

const b = await puppeteer.launch({ executablePath: chromePath(), headless: true, userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lg-wvui-')), args: ['--no-sandbox', '--disable-gpu'] })
const p = await b.newPage()
await p.setViewport({ width: 1440, height: 900 })
const errors = []
p.on('pageerror', e => errors.push(String(e.message).slice(0, 120)))

// 用 BASE 而不是写死的 http://127.0.0.1:1234 —— 否则 LEGADO_BASE_URL 指到隔离实例时，
// 这条门禁会静默打本机 1234（没起就是 ERR_CONNECTION_REFUSED，起了就是验错实例）。
await p.goto(`${BASE}/#sources`, { waitUntil: 'domcontentloaded', timeout: 40000 })
await p.waitForSelector('.source-list button', { timeout: 20000 })
await new Promise(r => setTimeout(r, 1500))
await p.type('.source-filter input', '番茄')
await new Promise(r => setTimeout(r, 2500))
// 番茄那个源（enabled + 有 exploreUrl），按名字找
const picked = await p.evaluate(() => {
  const row = [...document.querySelectorAll('.source-list button')].find(x => /登录/.test(x.innerText) && !x.className.includes('more'))
  if (!row) return null
  row.click()
  return row.innerText.replace(/\s+/g, ' ').slice(0, 34)
})
console.log('选中:', picked)
await new Promise(r => setTimeout(r, 2000))
const opened = await p.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(x => (x.innerText || '').trim() === '登录')
  if (!btn) return '没有登录按钮'
  btn.click()
  return 'ok'
})
await new Promise(r => setTimeout(r, 2500))
console.log('点登录:', opened)
const chooser = await p.evaluate(() => {
  const el = [...document.querySelectorAll('button')].find(x => (x.innerText || '').includes('内置浏览器'))
  if (!el) return '没有「用内置浏览器登录」选项'
  el.click()
  return 'ok'
})
console.log('选内置浏览器:', chooser)
await p.evaluate(() => { window.__msgs = []; window.addEventListener('message', e => { if (e.data && e.data.source === 'legado-webview') window.__msgs.push(JSON.parse(JSON.stringify(e.data))) }) })
await new Promise(r => setTimeout(r, 16000))
console.log('收到的回报:', JSON.stringify(await p.evaluate(() => window.__msgs || []), null, 1).slice(0, 700))
const foot = await p.evaluate(() => {
  const el = document.querySelector('.source-webview-footnote')
  return { cls: el?.className || '', text: (el?.innerText || '').replace(/\s+/g, ' ').slice(0, 300) }
})
console.log('\n脚注:', JSON.stringify(foot, null, 1))
await p.screenshot({ path: path.join(OUT, 'shots', 'webview-diagnostics.png') })
console.log('宿主 JS 报错:', errors.length ? [...new Set(errors)].slice(0, 3) : '无')
await b.close()
