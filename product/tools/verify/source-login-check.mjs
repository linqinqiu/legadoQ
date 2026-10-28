// 书源登录浮层交付前自检。用三条一次性探针书源跑，不碰用户真源的凭据：
//   A 登录入口是整段登录 JS（库内实测 208 个源这么写）→ 默认落在「真浏览器」
//   B loginUi 有账号/密码字段 → 表单已不再渲染，仍然只剩真浏览器 / 粘贴 Cookie 两条路
//   C 照番茄官方接口直连源的形状：书源主域是代理站，要登录的是另一个域，搜索又走第三个域
// 再验：页签固定两条、菜单不重复、图标按钮都有可访问名且不低于 30px、
// 粘贴 Cookie 就地展开并立刻反映到凭据明细、删掉书源时它的 Cookie 罐必须一起消失。跑法：
//   node tools/verify/preview.mjs --port 4399 && node tools/verify/source-login-check.mjs
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, OUT, SHOTS, BASE, launchOptions } from './env.mjs'

const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')
const STAMP = process.env.STAMP || new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)
const A = { id: `https://probe-a.login-${STAMP}.example`, name: `登录探针A ${STAMP}` }
const B = { id: `https://probe-b.login-${STAMP}.example`, name: `登录探针B ${STAMP}` }
const C = { id: `https://proxy.probe-c-${STAMP}.example`, name: `登录探针C ${STAMP}` }
const TAB_LABELS = '真浏览器|粘贴 Cookie'

const sourceJson = (fixture, loginUi, extra = {}) => JSON.stringify({
  bookSourceUrl: fixture.id,
  bookSourceName: fixture.name,
  bookSourceGroup: '自检探针',
  bookSourceType: 0,
  enabled: false,
  loginUrl: `${fixture.id}/login`,
  loginUi: JSON.stringify(loginUi),
  ruleSearch: { bookList: '.books div', name: '.title' },
  ...extra,
})

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail })
}

const browser = await puppeteer.launch(launchOptions())
const page = await browser.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
await page.goto(`${BASE}/#sources`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.source-list-item', { timeout: 30000 })

const imported = await page.evaluate(async ({ aJson, bJson, cJson }) => {
  const response = await fetch('/api/sources/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-CSRF-Token': '' },
    body: JSON.stringify({ sources: [aJson, bJson, cJson] }),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}, {
  aJson: sourceJson(A, [{ name: '打开登录网页', type: 'button', action: `${A.id}/login` }], {
    loginUrl: "function login(openBrowser, checkMode) { if (!checkMode) { java.startBrowserAwait('https://qr.probe-a.example/login?tk=7', '扫码登录'); } }",
  }),
  bJson: sourceJson(B, [{ name: '账号', key: 'username', type: 'text' }, { name: '密码', key: 'password', type: 'password' }]),
  cJson: sourceJson(C, [], {
    loginUrl: 'https://reader.probe-c-login.example/',
    searchUrl: 'https://api.probe-c-search.example/search?q={{key}}',
    exploreUrl: '书架::https://reader.probe-c-login.example/shelf|榜单::https://api.probe-c-search.example/rank',
  }),
})
check('三条探针书源已导入', imported.status === 200 && (imported.body?.imported ?? 0) + (imported.body?.updated ?? 0) >= 3, JSON.stringify(imported))

async function openLogin(fixture) {
  // 同一个 hash 再 goto 一次不会重新加载页面（只是同文档跳转），上一个浮层会留在屏幕上，
  // 于是读到的还是上一条源的状态。要真 reload 一次。
  await page.goto(`${BASE}/#sources`, { waitUntil: 'domcontentloaded' })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.source-list-item', { timeout: 30000 })
  await page.evaluate(v => {
    const input = document.querySelector('.sources-page input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, v)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, fixture.name)
  await page.waitForFunction(name => [...document.querySelectorAll('.source-list-item')].some(x => x.textContent.includes(name)), { timeout: 20000 }, fixture.name)
  await page.evaluate(name => {
    const row = [...document.querySelectorAll('.source-list-item')].find(x => x.textContent.includes(name))
    ;(row.querySelector('.source-list-item-title') || row).click()
  }, fixture.name)
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '登录'), { timeout: 20000 })
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '登录').click())
  await page.waitForSelector('.source-login-dialog', { timeout: 20000 })
  // 浮层刚挂载时还在 loading（登录判定 + Cookie 明细两个请求），只 sleep 固定时长会在冷启动下读到空壳
  await page.waitForSelector('.source-login-method-tab', { timeout: 20000 })
  await new Promise(resolve => setTimeout(resolve, 400))
}

const readModal = () => page.waitForSelector('.source-login-method-tab', { timeout: 20000 }).then(() => page.evaluate(() => {
  const tabs = [...document.querySelectorAll('.source-login-method-tab')]
  const headerButtons = [...document.querySelectorAll('.source-login-action-btn')]
  const status = document.querySelector('.source-login-status')
  const emoji = text => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u.test(text)
  return {
    title: document.querySelector('.source-login-title')?.textContent || '',
    tabs: tabs.map(tab => ({ label: tab.textContent.replace('推荐', '').trim(), active: tab.classList.contains('is-active'), recommended: tab.textContent.includes('推荐') })),
    tabRows: new Set(tabs.map(tab => Math.round(tab.getBoundingClientRect().top))).size,
    statusText: status?.innerText.replace(/\n+/g, ' · ') || '',
    statusClass: status?.className || '',
    headerButtons: headerButtons.map(button => ({
      label: button.getAttribute('aria-label') || '',
      svg: !!button.querySelector('svg'),
      emoji: button.querySelector('svg') === null && emoji(button.textContent),
      height: Math.round(button.getBoundingClientRect().height),
    })),
    formCount: [...document.querySelectorAll('.source-login-panel input')].filter(el => el.type === 'password').length,
    jarRows: [...document.querySelectorAll('.source-login-jar-row')].map(row => row.innerText.replace(/\s+/g, ' ').trim()),
  }
}))

await openLogin(A)
const modalA = await readModal()
await page.screenshot({ path: path.join(SHOTS, `source-login-A-${STAMP}.png`) })
const activeA = modalA.tabs.find(tab => tab.active)
check('A：只剩两个登录方式', modalA.tabs.length === 2 && modalA.tabs.map(t => t.label).join('|') === TAB_LABELS, modalA.tabs.map(t => t.label).join('|'))
check('A：默认落在「真浏览器」并标推荐', activeA?.label === '真浏览器' && modalA.tabs.find(t => t.label === '真浏览器')?.recommended === true, activeA?.label || '')
check('A：状态行说明还没有凭据', /还没有任何凭据/.test(modalA.statusText), modalA.statusText)
check('A：不再渲染登录表单 / 内置浏览器残留', modalA.formCount === 0 && !/内置浏览器|填写表单|书签同步/.test(await page.$eval('.source-login-dialog', el => el.innerText)), String(modalA.formCount))
check('A：页签一排排得下', modalA.tabRows === 1, `${modalA.tabRows} 行`)
check('A：头部按钮全部换成图标组件并带可访问名', modalA.headerButtons.length >= 2 && modalA.headerButtons.every(b => b.svg && b.label && !b.emoji), JSON.stringify(modalA.headerButtons.map(b => `${b.label}:${b.svg ? 'svg' : 'text'}`)))
check('A：头部按钮不低于 30px（控件下限）', Math.min(...modalA.headerButtons.map(b => b.height)) >= 30, `${Math.min(...modalA.headerButtons.map(b => b.height))}px`)

// A 的 loginUrl 是整段登录 JS：界面不再把脚本原文当网址贴出来，而是由「保存并登录」执行脚本，
// 脚本要求打开浏览器时交给真浏览器（openUrl 契约仍在服务端）。
const scriptPanel = await page.evaluate(() => ({
  hint: document.querySelector('.source-login-panel .source-login-hint')?.innerText || '',
  urlLine: !!document.querySelector('.source-login-url-line'),
}))
check('A：JS 登录源不往界面上倒脚本，也不给死链', !scriptPanel.urlLine && /真浏览器|Chrome|Edge/.test(scriptPanel.hint), scriptPanel.hint.slice(0, 70))
const awaitRounds = await page.evaluate(async id => {
  const call = async () => {
    const response = await fetch(`/api/sources/${encodeURIComponent(id)}/login-action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-CSRF-Token': '' },
      body: JSON.stringify({ action: 'login(true, false)', loginData: {}, isLongClick: false, browserCompleted: false }),
    })
    return response.json()
  }
  return call()
}, A.id)
check('A：登录脚本把要打开的地址交给界面（界面转交真浏览器）', awaitRounds.openUrl === 'https://qr.probe-a.example/login?tk=7', JSON.stringify(awaitRounds).slice(0, 120))

await page.evaluate(() => [...document.querySelectorAll('.source-login-action-btn')].find(b => b.getAttribute('aria-label') === '凭据管理')?.click())
await page.waitForSelector('.source-login-dropdown-menu', { timeout: 5000 })
const menu = await page.evaluate(() => [...document.querySelectorAll('.source-login-dropdown-menu button')].map(b => ({ text: b.textContent.trim(), svg: !!b.querySelector('svg') })))
check('菜单不再重复页签功能（Cookie / 书签都只有一处）', !menu.some(item => /Cookie|书签/.test(item.text)), menu.map(m => m.text).join(' | '))
check('菜单项都带图标', menu.every(item => item.svg), menu.map(m => m.text).join(' | '))
await page.screenshot({ path: path.join(SHOTS, `source-login-menu-${STAMP}.png`) })
await page.keyboard.press('Escape')
await new Promise(resolve => setTimeout(resolve, 400))

// 粘贴 Cookie：就地展开、保存后明细立刻反映，且按域名落库
await page.evaluate(() => [...document.querySelectorAll('.source-login-method-tab')].find(t => t.textContent.includes('粘贴 Cookie'))?.click())
await new Promise(resolve => setTimeout(resolve, 500))
const cookieTab = await page.evaluate(() => ({
  panel: !!document.querySelector('.direct-cookie-card'),
  nestedModals: document.querySelectorAll('.overlay-backdrop.is-topped').length,
  textarea: !!document.querySelector('.source-login-panel textarea'),
}))
check('粘贴 Cookie 就地展开，不叠第二层浮层', cookieTab.panel && cookieTab.nestedModals === 0 && cookieTab.textarea, JSON.stringify(cookieTab))
await page.evaluate(() => {
  const area = document.querySelector('.source-login-panel textarea')
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(area, 'probe_token=abc123; probe_sid=42')
  area.dispatchEvent(new Event('input', { bubbles: true }))
})
await page.evaluate(() => [...document.querySelectorAll('.source-login-panel button')].find(b => b.textContent.trim() === '保存 Cookie')?.click())
await new Promise(resolve => setTimeout(resolve, 1500))
const afterSave = await readModal()
await page.screenshot({ path: path.join(SHOTS, `source-login-cookie-${STAMP}.png`) })
check('保存后状态行改成「已存凭据」', /已存凭据/.test(afterSave.statusText) && afterSave.statusClass.includes('is-credential'), afterSave.statusText)
const jar = await page.evaluate(id => fetch(`/api/sources/${encodeURIComponent(id)}/browser/cookies`).then(r => r.json()), A.id)
check('凭据明细按主机摊开（不再只有一句结论）', afterSave.jarRows.length === 1 && /probe-a/.test(afterSave.jarRows[0]) && /2 项/.test(afterSave.jarRows[0]), JSON.stringify(afterSave.jarRows))
check('Cookie 按域名落库（2 项）', jar.count === 1 && /probe_token=abc123/.test(Object.values(jar.cookies)[0]) && /probe_sid=42/.test(Object.values(jar.cookies)[0]), JSON.stringify(jar))

// B：loginUi 里还有账号/密码字段，但表单这条路已按用户要求撤掉，不该再渲染任何输入框
await openLogin(B)
const modalB = await readModal()
await page.screenshot({ path: path.join(SHOTS, `source-login-B-${STAMP}.png`) })
check('B：仍然只有两个页签', modalB.tabs.length === 2 && modalB.tabs.map(t => t.label).join('|') === TAB_LABELS, modalB.tabs.map(t => t.label).join('|'))
check('B：登录表单不再渲染（无密码框 / 眼睛按钮）', modalB.formCount === 0 && (await page.evaluate(() => document.querySelectorAll('.source-login-panel input[type=password]').length)) === 0, String(modalB.formCount))
await page.keyboard.press('Escape')

// C：番茄那种「要登录的域 ≠ 书源主域」的源，粘贴 Cookie 必须能选对域名。
// 域名口径与上游 CookieStore 一致，是注册域（netsite.cc 而不是 fq-book.netsite.cc）。
await openLogin(C)
const modalC = await readModal()
check('C：配了 loginUrl 网址时默认落在「真浏览器」', modalC.tabs.find(t => t.active)?.label === '真浏览器', JSON.stringify(modalC.tabs))
// 必须等页签真的渲染出来再点：早先这里在浮层还处于 loading 分支时就 evaluate，
// `find(...)` 拿到 undefined、`?.click()` 静默无操作，于是后面整串 C 断言全读成空 —— 看着像产品坏了。
await page.waitForFunction(
  () => [...document.querySelectorAll('.source-login-method-tab')].some(t => t.textContent.includes('粘贴 Cookie')),
  { timeout: 20000 },
)
await page.evaluate(() => {
  const target = [...document.querySelectorAll('.source-login-method-tab')].find(t => t.textContent.includes('粘贴 Cookie'))
  target.click()
})
await page.waitForFunction(
  () => document.querySelector('.source-login-method-tab.is-active')?.textContent?.includes('粘贴 Cookie') === true,
  { timeout: 10000 },
).catch(async () => {
  const active = await page.evaluate(() => document.querySelector('.source-login-method-tab.is-active')?.textContent?.trim() ?? '(没有活动页签)')
  check('C：切换到粘贴 Cookie 页签成功', false, `活动页签仍是 ${active}`)
})
check('C：切换到粘贴 Cookie 页签成功', await page.evaluate(() =>
  document.querySelector('.source-login-method-tab.is-active')?.textContent?.includes('粘贴 Cookie') === true))
const cookieTabC = await page.evaluate(() => ({
  domains: [...(document.querySelector('#cookie-domain-options')?.children || [])].map(option => option.value),
  chosen: document.querySelector('#cookie-domain')?.value || '',
}))
check('C：候选主机把登录域排在最前', cookieTabC.domains[0] === 'reader.probe-c-login.example' && cookieTabC.domains.includes('api.probe-c-search.example') && cookieTabC.domains.length === new Set(cookieTabC.domains).size, JSON.stringify(cookieTabC))
check('C：默认就落在登录主机上（不是书源主域）', cookieTabC.chosen === 'reader.probe-c-login.example', cookieTabC.chosen)
const pasteState = await page.evaluate(() => ({
  tabs: [...document.querySelectorAll('.source-login-method-tab')].map(t => `${t.textContent}${t.classList.contains('is-active') ? '*' : ''}`),
  panels: document.querySelectorAll('.source-login-panel').length,
  area: !!document.querySelector('.source-login-panel textarea'),
}))
check('C：粘贴 Cookie 档已打开且 textarea 在位', pasteState.area && pasteState.tabs.some(t => t.endsWith('*') && t.includes('粘贴')), JSON.stringify(pasteState))
if (pasteState.area) {
  await page.evaluate(() => {
    const area = document.querySelector('.source-login-panel textarea')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(area, 'sessionid=fake-for-probe; uid=7')
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
} else {
  check('C：Cookie 存到了登录主机而不是书源主域', false, '粘贴档没打开，跳过写入')
}
await page.evaluate(() => [...document.querySelectorAll('.source-login-panel button')].find(b => b.textContent.trim() === '保存 Cookie')?.click())
await new Promise(resolve => setTimeout(resolve, 1500))
const jarC = await page.evaluate(id => fetch(`/api/sources/${encodeURIComponent(id)}/browser/cookies`).then(r => r.json()), C.id)
check('C：Cookie 存到了登录主机的注册域而不是书源主域', Object.keys(jarC.cookies).join() === 'probe-c-login.example', JSON.stringify(jarC.domains))
await page.screenshot({ path: path.join(SHOTS, `source-login-C-${STAMP}.png`) })

// 凭据明细：域名 + 条数要摊开能看，展开看键值，单域能删（上游只有「查看登录头」，看不到 Cookie 罐）
const jarPanel = await page.evaluate(() => ({
  rows: [...document.querySelectorAll('.source-login-jar-row')].map(row => row.innerText.replace(/\s+/g, ' ').trim()),
  hasDelete: !!document.querySelector('.source-login-jar-del'),
  hint: document.querySelector('.source-login-panel .source-login-hint.small')?.innerText || '',
}))
check('C：明细按主机列出条数', jarPanel.rows.length === 1 && /probe-c-login\.example/.test(jarPanel.rows[0]) && /2 项/.test(jarPanel.rows[0]), JSON.stringify(jarPanel.rows))
check('C：粘贴档说明合并语义与现状', /已存 2 项/.test(jarPanel.hint) && /按键合并/.test(jarPanel.hint), jarPanel.hint)
await page.evaluate(() => document.querySelector('.source-login-jar-toggle')?.click())
await new Promise(resolve => setTimeout(resolve, 400))
const expanded = await page.evaluate(() => ({
  open: document.querySelector('.source-login-jar-toggle')?.getAttribute('aria-expanded'),
  keys: [...document.querySelectorAll('.source-login-jar-detail code')].map(code => code.textContent.split('=')[0]),
}))
check('C：展开看得到键名（值打码）', expanded.open === 'true' && expanded.keys.join(',') === 'sessionid,uid', JSON.stringify(expanded))
await page.screenshot({ path: path.join(SHOTS, `source-login-jar-${STAMP}.png`) })
const dialogSeen = []
page.on('dialog', async dialog => { dialogSeen.push(dialog.message()); await dialog.accept() })
await page.evaluate(() => document.querySelector('.source-login-jar-del')?.click())
await new Promise(resolve => setTimeout(resolve, 1600))
const jarAfterDelete = await page.evaluate(id => fetch(`/api/sources/${encodeURIComponent(id)}/browser/cookies`).then(r => r.json()), C.id)
check('C：单域删除只清这一条并要求确认', jarAfterDelete.count === 0 && dialogSeen.some(msg => /probe-c-login\.example/.test(msg)), JSON.stringify({ 剩余: jarAfterDelete.count, 确认框: dialogSeen.length }))
await page.keyboard.press('Escape')

// 删掉探针源：它的凭据必须跟着走，不能留在库里
const cleanup = await page.evaluate(async ({ ids }) => {
  const response = await fetch('/api/sources/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-CSRF-Token': '' },
    body: JSON.stringify({ action: 'delete', ids }),
  })
  const removed = await response.json().catch(() => null)
  await new Promise(r => setTimeout(r, 800))
  const jarAfter = await fetch(`/api/sources/${encodeURIComponent(ids[2])}/browser/cookies`).then(r => r.json()).catch(() => null)
  return { status: response.status, removed, jarAfter }
}, { ids: [A.id, B.id, C.id] })
// 收尾必须走接口逐条复查 404：以前是"在界面列表里搜名字、搜不到就算已删"，
// 而 4,876 源的列表里那条搜索本身就不生效，于是三条探针源一直静静留在库里。
const teardown = await page.evaluate(async ids => {
  const perId = {}
  for (const id of ids) perId[id] = (await fetch(`/api/sources/${encodeURIComponent(id)}`)).status
  const search = await fetch('/api/sources?q=probe').then(r => r.json()).catch(() => null)
  return { perId, stillListed: (search ?? []).filter(s => /probe/i.test(s.id)).map(s => s.id) }
}, [A.id, B.id, C.id])
check('探针源已从库里删除（逐条复查 404）',
  Object.values(teardown.perId).every(status => status === 404) && teardown.stillListed.length === 0,
  `${JSON.stringify(teardown.perId)} 残留=${teardown.stillListed.join(',') || '无'}`)

// 域级共享罐之后，删书源**不再**连带清桶（桶是跨源共用的，这是有意的），所以探针必须自己
// 撤掉写进去的桶 —— 否则每跑一次就在用户库里堆一层垃圾，还会污染下一次运行
// （实测：A 的 `probe-a.example` 残留让下一次运行的"还没有凭据"断言直接变红）。
const bucketCleanup = await page.evaluate(async () => {
  const list = await (await fetch('/api/cookies')).json()
  const mine = (list.cookies ?? []).filter(c => /probe/i.test(c.domain) || /\.(example|test)$/.test(c.domain))
  for (const c of mine) {
    await fetch(`/api/cookies?u=${encodeURIComponent(c.domain)}`, { method: 'DELETE', headers: { 'X-CSRF-Token': '' } })
  }
  const after = await (await fetch('/api/cookies')).json()
  return {
    removed: mine.map(c => c.domain),
    left: (after.cookies ?? []).filter(c => /probe/i.test(c.domain) || /\.(example|test)$/.test(c.domain)).map(c => c.domain),
  }
})
check('探针写下的凭据桶已自行回收', bucketCleanup.left.length === 0,
  `撤了 ${bucketCleanup.removed.length} 桶，残留=${bucketCleanup.left.join(',') || '无'}`)
check('删书源时它的 Cookie 罐一起清掉', (cleanup.jarAfter?.count ?? -1) === 0, JSON.stringify(cleanup.jarAfter))
check('全程没有页面异常', errors.length === 0, errors.slice(0, 2).join(' / '))

await browser.close()
const failed = results.filter(result => !result.ok)
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? ` (${result.detail})` : ''}`)
fs.writeFileSync(path.join(OUT, `source-login-${STAMP}.json`), JSON.stringify({ base: BASE, modalA, modalB, modalC, menu, results }, null, 2))
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) process.exitCode = 1
