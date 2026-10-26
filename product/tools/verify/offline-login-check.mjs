/**
 * 「服务没答上话」时界面该说什么 —— 真浏览器 + 真离线。
 *
 * 用户的原始抱怨是"动不动要密码"。查清的真因之一是：会话探测没有 .catch，
 * 服务重启/离线时 `authenticated` 保持 false，于是直接渲染登录页 —— 明明是没问到服务，
 * 却让用户以为要密码。这里用 CDP 离线模拟复现那个窗口：Service Worker 照常吐出应用壳，
 * 而 /api 必然失败。断言的是"出现的是等待/重试，不是密码框"。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, SHOTS, BASE, launchOptions } from './env.mjs'

const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')
const STAMP = new Date().toISOString().replace(/\D/g, '').slice(0, 12)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

let pass = 0
let fail = 0
const ok = (label, condition, detail = '') => {
  if (condition) { pass++; console.log(`  PASS ${label}${detail ? '  — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL ${label}  — ${detail || '断言不成立'}`) }
}

const browser = await puppeteer.launch({ ...launchOptions(), userDataDir: path.join(ROOT, 'tools/verify/out/offline-profile') })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800 })

await page.goto(`${BASE}/#shelf`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.app-shell', { timeout: 30000 })
await sleep(2500)

// 这个 profile 是复用的：上一轮装好的 Service Worker 会先把**旧壳**吐出来（AGENTS.md 里那条 PWA 陷阱）。
// 不先「立即更新」，这里断言的其实是历史版本 —— 本轮改应用名时就见过"界面还写着旧名字"的假信号。
for (let attempt = 0; attempt < 3; attempt++) {
  const clicked = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(item => /立即更新/.test(item.textContent ?? ''))
    if (!button) return false
    button.click()
    return true
  })
  if (!clicked) break
  await sleep(4000)
  await page.goto(`${BASE}/#shelf`, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await sleep(2500)
}

const online = await page.evaluate(() => ({
  hasLoginForm: !!document.querySelector('input[type="password"]'),
  brand: document.querySelector('.app-brand strong')?.textContent?.trim() ?? '',
  oldName: document.body.innerText.includes('阅读服务器'),
  text: document.body.innerText.slice(0, 80).replace(/\s+/g, ' '),
}))
ok('在线时正常进应用（不是登录页）', !online.hasLoginForm, online.text)
ok('这台 profile 里跑的已是当前版本（顶栏品牌「legadoQ」，旧名字已消失）',
  online.brand === 'legadoQ' && !online.oldName, `品牌=${online.brand || '(没读到)'} 旧名=${online.oldName}`)

// 必须等 SW 真的**接管**（controller 非空），否则离线后显示的是 Chrome 的断网页，
// "没有密码框"就成了空判假绿。registerType 是 prompt，首装不接管，需要重载几轮。
let controlled = false
for (let attempt = 0; attempt < 6 && !controlled; attempt++) {
  controlled = await page.evaluate(() => !!navigator.serviceWorker.controller)
  if (controlled) break
  await page.reload({ waitUntil: 'domcontentloaded' })
  await sleep(2500)
}
ok('Service Worker 已接管（否则这条测试是假绿）', controlled, `controller=${controlled}`)
if (!controlled) {
  // 拿不到接管就别往下测 —— 继续测只会得到 Chrome 断网页的"没有密码框"这种空判
  await browser.close()
  console.log('\n结果：0 通过 / 1 失败  ·  SW 未接管，离线场景无法复现，测试中止（拒绝空判假绿）')
  process.exit(1)
}

await page.setOfflineMode(true)
await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
await sleep(4000)

const offline = await page.evaluate(() => ({
  // 用户 2026-10-08 明确要求删掉「连不上本机服务 / 不是你的密码」那张整屏页：服务没起来时
  // 该**自动重试**，不该把人挡在一张会让人以为要登录的死胡同页前（见 main.tsx 的启动探活）。
  // 所以这里不再找那句已被删掉的文案 —— 判"离线时不是死路、也不是密码框"。
  shellRendered: document.body.innerText.includes('legadoQ') || /书架|书库|正在打开阅读空间|正在等待本机服务/.test(document.body.innerText),
  chromeErrorPage: /ERR_INTERNET_DISCONNECTED|按空格键即可开始游戏/.test(document.body.innerText),
  hasLoginForm: !!document.querySelector('input[type="password"]'),
  loginText: /请输入密码|输入管理员密码/.test(document.body.innerText),
  retrying: /正在打开阅读空间|正在等待本机服务|正在准备/.test(document.body.innerText),
  entered: /书架|书库/.test(document.body.innerText),
  text: document.body.innerText.slice(0, 160).replace(/\s+/g, ' '),
}))
await page.screenshot({ path: path.join(SHOTS, `offline-no-login-prompt-${STAMP}.png`) })
ok('离线时应用壳真的渲染了（不是 Chrome 断网页）', offline.shellRendered && !offline.chromeErrorPage, offline.text)
ok('离线时不再甩出密码框', !offline.hasLoginForm && !offline.loginText, offline.text)
ok('离线时不是死路：在自动重试，或已经进界面（旧版这里是一张要密码的页）',
  offline.retrying || offline.entered, offline.text)

await page.setOfflineMode(false)
await page.reload({ waitUntil: 'domcontentloaded' })
await sleep(3500)
const back = await page.evaluate(() => ({
  login: !!document.querySelector('input[type="password"]'),
  shell: document.body.innerText.includes('legadoQ') || /书架|书库/.test(document.body.innerText),
}))
ok('服务恢复后能回到正常界面（且没有密码框）', !back.login && back.shell, `login=${back.login} shell=${back.shell}`)

await browser.close()
fs.mkdirSync(path.dirname(SHOTS), { recursive: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败  ·  截图 out/shots/offline-no-login-prompt-${STAMP}.png`)
if (fail > 0) process.exitCode = 1
