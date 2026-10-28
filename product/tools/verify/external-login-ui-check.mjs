/**
 * 「真浏览器」页签的界面实测：在部署中的 1234 上，用真 Chrome 点一遍。
 * 证明的是用户能点到、点了确实起浏览器、抓取确实入库、关闭确实收尾 —— 不是接口能通就算数。
 * 探针源用自建的本机页面（会下 HttpOnly Cookie），不碰任何真实站点与用户凭据；跑完自己删干净。
 */
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, OUT, SHOTS, BASE, launchOptions } from './env.mjs'

const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')
const STAMP = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
const TOKEN = 'ui-' + STAMP

let pass = 0
let fail = 0
const ok = (label, condition, detail = '') => {
  if (condition) {
    pass++
    console.log(`  PASS ${label}${detail ? '  — ' + detail : ''}`)
  } else {
    fail++
    console.log(`  FAIL ${label}  — ${detail || '断言不成立'}`)
  }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function startCookieSite() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': [`pb_login=${TOKEN}; Path=/; HttpOnly`],
      })
      res.end(`<!doctype html><title>探针</title>ok`)
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

const site = await startCookieSite()
const SOURCE_ID = `http://127.0.0.1:${site.port}/`

const browser = await puppeteer.launch(launchOptions())
const page = await browser.newPage()
// PWA 的 service worker 会插手 fetch：不绕开它，验证读到的是缓存而不是刚部署的包。
await page.setBypassServiceWorker(true)
const errors = []
page.on('pageerror', error => errors.push(error.message))
await page.setViewport({ width: 1440, height: 900 })
await page.goto(`${BASE}/#sources`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.source-list-item', { timeout: 30000 })

const imported = await page.evaluate(async body => {
  const csrfToken = '' // 不设身份：写操作只看同源
  const r = await fetch('/api/sources/import', { method: 'POST', headers: { 'content-type': 'application/json', 'X-CSRF-Token': csrfToken }, body })
  return { status: r.status, json: await r.json().catch(() => null) }
}, JSON.stringify({
  sources: [JSON.stringify({
    bookSourceUrl: SOURCE_ID,
    bookSourceName: `页签探针 ${STAMP}`,
    bookSourceGroup: '探针',
    bookSourceType: 0,
    enabled: false,
    loginUrl: SOURCE_ID,
    ruleSearch: { bookList: '.book' },
  })],
}))
ok('探针源已入库', imported.status === 200 && imported.json?.imported === 1, JSON.stringify(imported))

// 找到它并打开登录浮层
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('.source-list-item', { timeout: 30000 })

// 真浏览器是服务级单例：上一轮（或用户手动点的）可能还开着窗口——先收掉，
// 后面断言「没打开时抓取/关闭禁用」才有意义。
const reset = await page.evaluate(async id => {
  const r = await fetch(`/api/sources/${encodeURIComponent(id)}/browser/external-login`, { method: 'DELETE', headers: { 'X-CSRF-Token': '' } })
  return r.status
}, SOURCE_ID)
ok('先收掉上一轮可能还开着的真浏览器', reset === 204, `HTTP ${reset}`)
const clicked = await page.evaluate(name => {
  const input = document.querySelector('.sources-page input')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(input, name)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}, `页签探针 ${STAMP}`)
await sleep(1200)
const rowCount = await page.evaluate(() => document.querySelectorAll('.source-list-item').length)
ok('列表已筛到探针源（不是对着全库点第一行）', clicked && rowCount === 1, `${rowCount} 行`)

// 打开浮层要走两跳：先点行标题展开详情，再点详情里的「登录」按钮
await page.evaluate(name => {
  const row = [...document.querySelectorAll('.source-list-item')].find(x => x.textContent.includes(name))
  ;(row.querySelector('.source-list-item-title') || row).click()
}, `页签探针 ${STAMP}`)
await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '登录'), { timeout: 20000 })
await page.evaluate(() => { [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '登录').click() })
await page.waitForSelector('.source-login-dialog', { timeout: 20000 })
await page.waitForSelector('.source-login-method-tab', { timeout: 20000 })
await sleep(400)

const tabs = await page.evaluate(() => [...document.querySelectorAll('.source-login-method-tab')].map(t => ({
  text: t.textContent.trim(),
  h: Math.round(t.getBoundingClientRect().height),
})))
// 页签文字里会带「推荐」角标，比顺序要用前缀匹配，不能全等
const indexOfTab = label => tabs.findIndex(t => t.text.startsWith(label))
ok('登录方式只剩「真浏览器」与「粘贴 Cookie」两条',
  tabs.length === 2 && indexOfTab('真浏览器') === 0 && indexOfTab('粘贴 Cookie') === 1,
  tabs.map(t => t.text).join(' | '))
ok('页签没有表情符号且高度≥30px', tabs.every(t => !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(t.text) && t.h >= 30),
  JSON.stringify(tabs.map(t => `${t.text}:${t.h}`)))
// 480px 浮层里页签必须完整可见：以前页签多到要横向滚动，最后一个被切掉半截
const clippedTabs = await page.evaluate(() => {
  const row = document.querySelector('.source-login-method-tabs').getBoundingClientRect()
  return [...document.querySelectorAll('.source-login-method-tab')]
    .filter(tab => tab.getBoundingClientRect().right > row.right + 1)
    .map(tab => tab.textContent.trim())
})
ok('两个页签都完整可见（没有被切掉）', clippedTabs.length === 0, clippedTabs.join('、') || '全部在浮层内')

// loginUrl 型登录源（库内 2000+ 个登录源的主流形态）：默认就该落在真浏览器页签。
const activeTab = await page.evaluate(() =>
  document.querySelector('.source-login-method-tab.is-active')?.textContent.trim() ?? '')
ok('URL 型登录源默认选中并推荐「真浏览器」', activeTab.startsWith('真浏览器') && activeTab.includes('推荐'), activeTab || '(无选中)')

await page.evaluate(() => {
  [...document.querySelectorAll('.source-login-method-tab')].find(t => t.textContent.trim() === '真浏览器')?.click()
})
await sleep(600)
const panel = await page.evaluate(() => ({
  text: document.querySelector('.source-login-panel')?.innerText ?? '',
  startTitle: [...document.querySelectorAll('.source-login-external-actions button')]
    .find(b => b.textContent.includes('打开真浏览器'))?.getAttribute('title') ?? '',
  buttons: [...document.querySelectorAll('.source-login-external-actions button')].map(b => ({
    label: b.textContent.trim(),
    h: Math.round(b.getBoundingClientRect().height),
    disabled: b.disabled,
  })),
}))
ok('页签只留一句操作说明（长解释已删）',
  !panel.text.includes('任何本地程序都贴不上去') && panel.text.includes('抓取并入库'),
  panel.text.slice(0, 80))
ok('登录档隔离说明仍在按钮提示里', /独立且持久/.test(panel.startTitle), panel.startTitle)
ok('三个动作按钮在位且不缩水', panel.buttons.length === 3 && panel.buttons.every(b => b.h >= 30), JSON.stringify(panel.buttons))
ok('没打开浏览器时「抓取/关闭」是禁用的（不是点了报错）',
  panel.buttons.filter(b => b.label !== '打开真浏览器登录').every(b => b.disabled), JSON.stringify(panel.buttons.map(b => `${b.label}:${b.disabled}`)))

const started = await page.evaluate(async () => {
  [...document.querySelectorAll('.source-login-external-actions button')].find(b => b.textContent.includes('打开真浏览器'))?.click()
  return true
})
await sleep(6000)
const afterStart = await page.evaluate(() => document.querySelector('.source-login-panel')?.innerText ?? '')
const extState = await page.evaluate(async id => {
  const r = await fetch(`/api/sources/${encodeURIComponent(id)}/browser/external-login`)
  const text = await r.text()
  return { status: r.status, text }
}, SOURCE_ID)
ok('状态接口有内容（不是空响应）', extState.status === 200 && extState.text.length > 0, JSON.stringify(extState))
const extJson = extState.text ? JSON.parse(extState.text) : { pid: 0 }
ok('点一下真的起了浏览器并显示已打开', started && /已打开/.test(afterStart) && /等你在窗口里登录/.test(afterStart), afterStart.split('\n').find(l => l.includes('已打开')) ?? '(没有状态行)')
// 服务重启后附着到早先拉起的窗口时拿不到 pid，界面不该摆一个「进程 0」
ok('状态行只在拿得到进程号时才写进程号',
  extJson.pid > 0 ? new RegExp(`进程 ${extJson.pid}`).test(afterStart) : !/进程 0/.test(afterStart),
  `pid=${extJson.pid} · ${afterStart.split('\n').find(l => l.includes('已打开')) ?? '(没有状态行)'}`)

await page.evaluate(() => {
  [...document.querySelectorAll('.source-login-external-actions button')].find(b => b.textContent.trim() === '抓取并入库')?.click()
})
await sleep(4000)
const afterCapture = await page.evaluate(() => ({
  panel: document.querySelector('.source-login-panel')?.innerText ?? '',
  jar: [...document.querySelectorAll('.source-login-jar-row')].map(r => r.innerText.split('\n')[0]),
  toast: document.querySelector('.toast, .toast-stack')?.innerText ?? '',
}))
ok('抓取后面板写明入库的域', /本轮入库/.test(afterCapture.panel), afterCapture.panel.split('\n').find(l => l.includes('本轮入库')) ?? '(没有)')
ok('凭据明细里能看到那个域（HttpOnly 也在里面）', afterCapture.jar.length >= 1 && afterCapture.jar.some(x => x.includes('127.0.0.1')), JSON.stringify(afterCapture.jar))

const jarApi = await page.evaluate(async id => {
  const r = await fetch(`/api/sources/${encodeURIComponent(id)}/browser/cookies`)
  return r.json()
}, SOURCE_ID)
ok('回读值是探针自己下的那枚 HttpOnly Cookie', JSON.stringify(jarApi.cookies ?? {}).includes(TOKEN), JSON.stringify(Object.keys(jarApi.cookies ?? {})))

await page.evaluate(() => {
  [...document.querySelectorAll('.source-login-external-actions button')].find(b => b.textContent.trim() === '关闭浏览器')?.click()
})
await sleep(3000)
const afterStop = await page.evaluate(() => document.querySelector('.source-login-panel')?.innerText ?? '')
ok('关闭后状态回落成"还没打开浏览器"', /还没打开浏览器/.test(afterStop), afterStop.split('\n').find(l => l.includes('●') || l.includes('○')) ?? '')

await page.screenshot({ path: path.join(SHOTS, `external-login-tab-${STAMP}.png`), fullPage: false })
ok('全程没有页面异常', errors.length === 0, errors.slice(0, 2).join(' / '))

// 收尾
await page.keyboard.press('Escape')
await sleep(400)
const cleanup = await page.evaluate(async id => {
  const csrfToken = '' // 不设身份：写操作只看同源
  const del = await fetch(`/api/sources/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrfToken } })
  const cookies = await fetch(`/api/sources/${encodeURIComponent(id)}/browser/cookies?u=${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrfToken } })
  const gone = await fetch(`/api/sources/${encodeURIComponent(id)}`)
  return { del: del.status, cookies: cookies.status, gone: gone.status }
}, SOURCE_ID)
ok('探针源与凭据桶已回收', cleanup.del === 204 && cleanup.gone === 404, JSON.stringify(cleanup))
const strays = await page.evaluate(async () => {
  const r = await fetch('/api/sources?q=' + encodeURIComponent('页签探针'))
  return (await r.json()).length
})
await site.server.close()
await browser.close()
console.log(`\n结果：${pass} 通过 / ${fail} 失败  ·  残留复查 ${strays} 条  ·  截图 out/shots/external-login-tab-${STAMP}.png`)
if (fail > 0 || strays > 0) process.exitCode = 1
void OUT
