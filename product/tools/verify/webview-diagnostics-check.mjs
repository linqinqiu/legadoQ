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
const { BASE, chromePath, OUT, requireService } = await import('./env.mjs')

// 前置：服务必须在跑。原来这里第 16 行直接 fetch，服务没起就是
// `TypeError: fetch failed` + 栈 —— 前置不满足被报成脚本坏了。范式同 stalled-client-check.mjs:105-109。
await requireService('webview-diagnostics-check')

const id = encodeURIComponent('https://www.fanqienovel.com')
const session = await fetch(BASE + '/healthz')
const cookie = (session.headers.getSetCookie() || []).map(c => c.split(';')[0]).join('; ')
const csrf = (await session.json()).csrfToken || ''
const info = await (await fetch(`${BASE}/api/sources/${id}/browser/session`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ url: 'https://fanqienovel.com' }),
})).json()
const frameUrl = `${BASE}/api/sources/${id}/browser/page?t=${encodeURIComponent(info.token)}&u=${encodeURIComponent('https://fanqienovel.com')}`

const b = await puppeteer.launch({ executablePath: chromePath(), headless: true, userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lg-diag-')), args: ['--no-sandbox', '--disable-gpu'] })
const p = await b.newPage()
await p.setViewport({ width: 1240, height: 820 })
const collected = p.evaluate(() => new Promise(resolve => {
  const got = []
  window.addEventListener('message', e => { if (e.data && e.data.source === 'legado-webview') got.push(JSON.parse(JSON.stringify(e.data))) })
  setTimeout(() => resolve(got), 14000)
}))
// 与 SourceWebViewModal 完全一致的 sandbox 组合
await p.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0">
<iframe src="${frameUrl}" style="width:1180px;height:760px;border:0"
  sandbox="allow-forms allow-scripts allow-popups allow-modals allow-downloads" referrerpolicy="no-referrer"></iframe></body>`)
const messages = await collected
console.log('宿主收到的回报', messages.length, '条:')
for (const m of messages) console.log(' ', m.type, m.type === 'diagnostics' ? JSON.stringify({ forms: m.forms, fields: m.fields, scripts: m.scripts, storage: m.storage, errors: m.errors }) : m.url)
await p.screenshot({ path: path.join(OUT, 'shots', 'webview-diag-live.png') })
await b.close()
