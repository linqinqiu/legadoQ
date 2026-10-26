/**
 * 阶段 3 交付前自检：订阅页可用性 + 站内下拉控件（打真服务，验证部署后的界面）。
 *
 * 断的是"界面在说什么、能不能点"，不是代码写了什么：
 * ① 「订阅」这一页只有 RSS，书源订阅在「书源」页里开出的一档（不是弹窗）—— 两边的数字都要与服务端一致
 *    （"看着像空的"必须能一眼分辨）；
 * ② 同步失败落在一行结论 + 可展开的原始报错，英文异常不再糊满页面；
 * ③ 空态的去处是可点按钮，不是"去某某页"的文字指引；
 * ④ 原生 select 在这五张页面上全部消失，分组筛选能看到计数、能选、能筛；
 * ⑤ 全程只用自建探针源与探针订阅，收尾按主键删掉并复查，绝不动用户真数据。
 *
 * 跑法：node tools/verify/subscription-check.mjs
 */
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import { BASE, SHOTS, launchOptions, acceptAgreement } from './env.mjs'
import { mkdirSync } from 'node:fs'

const require = createRequire(path.join(process.cwd(), 'web/package.json'))
const puppeteer = require('puppeteer-core')

const PORT = Number(new URL(BASE).port || 80)
const HOST = new URL(BASE).hostname
const STAMP = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).toLowerCase()
const RSS_HOST = `probe-sub-rss-${STAMP}.test`
const RSS_ID = `https://${RSS_HOST}/`
const RSS_NAME = `探针订阅源-${STAMP}`
// 订阅探针要"存得进去、但同步一定失败"，所以域名用可解析的 example.com，token 留在路径里
// （界面按 'probe-sub-list' 找这一行）。解析不到的 `.test` 与内网地址现在**创建时**就被 SSRF 闸门拒掉，
// 那是另一条判据（见下面的"内网/解析不到"），不能拿来当"同步失败有交代"的样本 —— 那种地址根本进不了库。
const SUB_TOKEN = `probe-sub-list-${STAMP}`
const SUB_HOST = 'example.com'
const SUB_URL = `https://${SUB_HOST}/${SUB_TOKEN}.json`
const SUB_BLOCKED_LOOPBACK = `http://127.0.0.1:${PORT + 1}/${SUB_TOKEN}.json`
const SUB_BLOCKED_DNS = `https://probe-sub-blocked-${STAMP}.test/${SUB_TOKEN}.json`
const GROUP = `探针分组${STAMP}`

mkdirSync(SHOTS, { recursive: true })

let cookie = ''
let csrf = ''
let pass = 0
let fail = 0
const skipped = []
function ok(label, condition, detail = '') {
  if (condition) { pass++; console.log(`  PASS ${label}${detail ? '  — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL ${label}  — ${detail || '断言不成立'}`) }
}
function skip(label, why) { skipped.push(label); console.log(`  SKIP ${label}  — ${why}`) }

function raw(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers }
    if (cookie) h.cookie = cookie
    if (csrf) h['X-CSRF-Token'] = csrf
    if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json'
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
    if (payload) h['content-length'] = String(payload.length)
    const req = http.request({ host: HOST, port: PORT, path: urlPath, method, headers: h }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        let json = null
        try { json = JSON.parse(buf.toString('utf8')) } catch { /* 非 JSON 响应留给 status 判断 */ }
        resolve({ status: res.statusCode, headers: res.headers, text: buf.toString('utf8'), json })
      })
    })
    req.on('error', reject)
    req.setTimeout(60000, () => req.destroy(new Error('timeout')))
    if (payload) req.write(payload)
    req.end()
  })
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const listRss = async () => (await raw('GET', '/api/rss/sources')).json ?? []
const listSubs = async () => (await raw('GET', '/api/subscriptions')).json ?? []

let browser
const results = []
try {
  const sess = await raw('GET', '/healthz')
  cookie = (sess.headers['set-cookie']?.[0] ?? '').split(';')[0]
  csrf = ''
  ok('服务在跑（不设身份，探活通过就能测）', sess.status === 200, `status=${sess.status}`)

  /*
    先把**历史残留的探针**清掉再取基线。上一轮如果崩在中途（超时被打断、Ctrl-C），
    收尾那两条 DELETE 就没跑，留下的 `probe-sub-*` 行会被这一次的界面查找 `find()` 先捞走
    ——2026-10-01 就红在这里：残的那一条是被上一轮点成「已停用」的，于是这一轮判据读到的是
    别人的状态，报出一条"订阅不能停用"的假红（AGENTS §3 第②条同一形状）。
    只删 url 里带 `probe-sub-` 的，真订阅一律不碰。
  */
  const staleSubs = (await listSubs()).filter(item => /probe-sub-/.test(item.url ?? ''))
  for (const item of staleSubs) await raw('DELETE', `/api/subscriptions/${item.id}`)
  const staleRss = (await listRss()).filter(item => /probe-sub-rss/.test(item.sourceUrl ?? ''))
  for (const item of staleRss) await raw('DELETE', `/api/rss/sources?sourceUrl=${encodeURIComponent(item.sourceUrl)}`)
  if (staleSubs.length || staleRss.length) {
    console.log(`  清扫历史探针：订阅 ${staleSubs.length} 条、RSS ${staleRss.length} 条（上一轮崩在中途留下的）`)
  }

  const rssBefore = (await listRss()).filter(item => !item.sourceUrl.includes(STAMP))
  const subsBefore = (await listSubs()).filter(item => !item.url.includes(STAMP))

  // ——— 服务端：探针数据 ———
  const added = await raw('POST', '/api/rss/sources', { sources: [JSON.stringify({
    sourceUrl: RSS_ID,
    sourceName: RSS_NAME,
    sourceGroup: GROUP,
    enabled: true,
    ruleArticles: 'div.item',
    ruleTitle: 'a@text',
    ruleLink: 'a@href',
  })] })
  ok('探针 RSS 源已写入', added.status === 200 && added.json?.imported === 1, `${added.status} ${added.text.slice(0, 70)}`)

  const rulelessId = `https://probe-sub-rss-norule-${STAMP}.test/`
  const addedRuleless = await raw('POST', '/api/rss/sources', { sources: [JSON.stringify({
    sourceUrl: rulelessId,
    sourceName: `探针无规则-${STAMP}`,
    sourceGroup: GROUP,
    enabled: true,
    ruleTitle: 'a@text',
  })] })
  ok('第二条"没配列表规则"的探针 RSS 源已写入', addedRuleless.status === 200 && addedRuleless.json?.imported === 1,
    `${addedRuleless.status} ${addedRuleless.text.slice(0, 60)}`)
  const rulelessListed = (await listRss()).find(item => item.sourceUrl === rulelessId)
  ok('服务端把它标成 hasListRule=false（默认收起的依据来自服务端，不是前端猜）',
    rulelessListed?.hasListRule === false, JSON.stringify({ hasListRule: rulelessListed?.hasListRule }))

  const listed = await listRss()
  ok('探针 RSS 源查得到', listed.some(item => item.sourceUrl === RSS_ID), `共 ${listed.length} 条`)

  // 这条是本轮顺手修的服务端 bug：`call.parameters["q"]` 读的是路径参数，永远 null
  const hitQ = await raw('GET', `/api/rss/sources?q=${encodeURIComponent(RSS_NAME)}`)
  const missQ = await raw('GET', `/api/rss/sources?q=${encodeURIComponent('绝对查不到-' + STAMP)}`)
  ok('RSS 列表的 ?q= 服务端筛选真的生效', (hitQ.json?.length ?? 0) >= 1 && (missQ.json?.length ?? 0) === 0,
    `命中 ${hitQ.json?.length ?? '?'} / 反查 ${missQ.json?.length ?? '?'}`)

  const subsBeforeBlocked = (await listSubs()).length
  const blockedLoopback = await raw('POST', '/api/subscriptions', { url: SUB_BLOCKED_LOOPBACK, enabled: true })
  const blockedDns = await raw('POST', '/api/subscriptions', { url: SUB_BLOCKED_DNS, enabled: true })
  const subsAfterBlocked = (await listSubs()).length
  ok('内网地址在创建时就被拒，且写明原因（这台服务不设身份，借它打内网是真实风险）',
    blockedLoopback.status === 400 && /内网|本机/.test(blockedLoopback.text),
    `${blockedLoopback.status} ${blockedLoopback.text.slice(0, 80)}`)
  ok('解析不到的域名也在创建时就被拒（不是存进去再永远转圈）',
    blockedDns.status === 400 && /无法解析|域名/.test(blockedDns.text),
    `${blockedDns.status} ${blockedDns.text.slice(0, 80)}`)
  ok('两条被拒的地址都没留下记录', subsAfterBlocked === subsBeforeBlocked,
    `${subsBeforeBlocked} → ${subsAfterBlocked}`)

  const subAdded = await raw('POST', '/api/subscriptions', { url: SUB_URL, enabled: true })
  ok('探针订阅地址已创建', subAdded.status === 200 && subAdded.json?.id, `${subAdded.status} ${subAdded.text.slice(0, 70)}`)
  const subId = subAdded.json?.id

  const syncResult = await raw('POST', `/api/subscriptions/${subId}/update`)
  const afterSync = (await listSubs()).find(item => item.id === subId)
  ok('同步失败的订阅会记下原因（不是静默成功）', syncResult.status >= 400 && !!afterSync?.lastError,
    `status=${syncResult.status} lastError=${(afterSync?.lastError ?? '').slice(0, 60)}`)

  // ——— 界面 ———
  browser = await puppeteer.launch(launchOptions())
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  const pageErrors = []
  page.on('pageerror', event => pageErrors.push(String(event.message)))
  if (cookie) await page.evaluateOnNewDocument(value => { document.cookie = value }, cookie)
  // 界面按**本轮自己的** token 找那一行（`window.__SUB_TOKEN`）。原来找的是常量前缀
  // 'probe-sub-list'，一旦库里有上一轮崩在中途留下的同前缀残留，`find()` 捞到的是别人的行。
  await page.evaluateOnNewDocument(token => { window.__SUB_TOKEN = token }, SUB_TOKEN)

  const goto = async hash => {
    await page.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' })
    // 首次协议浮层会挡住真鼠标点击；先标记已同意（见 env.mjs 的 acceptAgreement）
    await acceptAgreement(page)
    // 冷启动到第一屏要等多久取决于这台机器此刻多忙（同一台机器实测 3~36 秒不等）。
    // 只 sleep 固定 1.4 秒的话，负载高的那一次会把"应用还在载入"读成"这一类数据是空的"，
    // 于是假红一条"本机有真订阅时不显示空态"。先等外壳出现，再给内容一点时间。
    await page.waitForSelector('.page-title h1', { timeout: 60000 }).catch(() => null)
    await sleep(1400)
  }

  // ——— ① 「订阅」这一页：只剩 RSS，书源订阅不在这里 ———
  await goto('#subscriptions')
  await page.waitForSelector('.rss-panel .rss-source-main', { timeout: 40000 })
  const expectSubs = subsBefore.length + 1
  const expectRss = rssBefore.length + 2
  const rssPageState = await page.evaluate(() => ({
    pageHeading: document.querySelector('.rss-page > .page-title h1')?.textContent?.trim() ?? '',
    // 反向对照用属性选择器写：`.subscription-tabs` 这个类名现在**不该存在**，
    // 写成 `.x` 会被 UiContract 那条"门禁锚点必须还长在界面上"判成悬空锚点。
    tabs: document.querySelectorAll('[class*="subscription-tabs"]').length,
    // 书源订阅那张的唯一形状：那条带无障碍名字的地址输入框
    subForm: !!document.querySelector('input[aria-label="书源订阅地址"]'),
    nativeSelects: document.querySelectorAll('select').length,
    readableLabel: document.querySelector('.rss-readable-toggle')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  }))
  ok('「订阅」页的页头写着「订阅」，且不再有页签',
    rssPageState.pageHeading === '订阅' && rssPageState.tabs === 0,
    `页头=${rssPageState.pageHeading} 页签=${rssPageState.tabs}`)
  ok('这一页里没有书源订阅那一张（两件事已分家）', !rssPageState.subForm, `书源订阅输入框在不在=${rssPageState.subForm}`)
  ok('订阅页没有原生 select', rssPageState.nativeSelects === 0, `${rssPageState.nativeSelects} 个`)
  const rssListedTotal = Number(/（\d+ \/ (\d+)）/.exec(rssPageState.readableLabel)?.[1] ?? -1)
  ok('订阅页报的总数与服务端一致（「只看能读的（x / y）」里的 y）',
    rssListedTotal === expectRss, `界面「${rssPageState.readableLabel}」/ 服务端 ${expectRss}`)

  // ——— 书源订阅那一档：从「书源」页里开出来 ———
  await goto('#sources')
  await page.waitForSelector('.source-subscribe-btn', { timeout: 40000 })
  const paneOpened = await page.evaluate(() => {
    if (document.querySelector('input[aria-label="书源订阅地址"]')) return 'already'
    const button = document.querySelector('.source-subscribe-btn')
    button?.click()
    return button ? 'clicked' : 'missing'
  })
  await page.waitForSelector('input[aria-label="书源订阅地址"]', { timeout: 20000 })
  const paneState = await page.evaluate(() => ({
    expanded: document.querySelector('.source-subscribe-btn')?.getAttribute('aria-expanded') ?? null,
    // 它是页面流里的一档，不是浮在正文上的弹窗
    inDialog: !!document.querySelector('.dialog-shell input[aria-label="书源订阅地址"]'),
    heading: document.querySelector('.subscription-panel h2')?.textContent?.trim() ?? '',
    rows: document.querySelectorAll('.subscription-list article').length,
  }))
  ok('书源页里那颗「订阅地址」点得开，展开态写在 aria-expanded 上',
    paneOpened !== 'missing' && paneState.expanded === 'true', `${paneOpened} / aria-expanded=${paneState.expanded}`)
  ok('书源订阅那一档不是弹窗（没有 .dialog-shell 罩在正文上）', !paneState.inDialog, `inDialog=${paneState.inDialog}`)
  ok('展开的确实是书源订阅那张', paneState.heading === '书源订阅地址', paneState.heading)
  ok('书源订阅的行数与服务端一致', paneState.rows === expectSubs, `界面 ${paneState.rows} 行 / 服务端 ${expectSubs} 条`)

  // ② 失败行：一行结论 + 可展开原文
  const failureRow = await page.evaluate(() => {
    const article = [...document.querySelectorAll('.subscription-list article')]
      .find(node => node.textContent?.includes(window.__SUB_TOKEN))
    if (!article) return null
    const error = article.querySelector('.sub-error')
    const rawBlock = article.querySelector('.sub-raw')
    return {
      headline: error?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      hasDetails: !!rawBlock,
      rawText: rawBlock?.querySelector('code')?.textContent?.trim() ?? '',
      syncDisabled: [...article.querySelectorAll('button')].some(button => button.textContent?.trim() === '立即同步' && button.disabled),
    }
  })
  ok('失败订阅有一行结论', failureRow !== null && failureRow.headline.startsWith('同步失败：'), failureRow?.headline ?? '没找到探针行')
  ok('结论里说清了原因（域名/连接/状态码/内容格式之一，不是只写"失败"）',
    /域名解析不到|连不上|超时|HTTP|40[0-9]|50[0-9]|格式|JSON|不是|空/.test(failureRow?.headline ?? ''), failureRow?.headline ?? '')
  ok('英文异常原文没有糊在页面上', !/Exception|UnknownHost|at java\./.test(failureRow?.headline ?? ''), failureRow?.headline ?? '')
  ok('原始报错收进可展开的一栏', !!failureRow?.hasDetails && failureRow.rawText.length > 0,
    `details=${failureRow?.hasDetails} 原文 ${(failureRow?.rawText ?? '').slice(0, 50)}`)
  ok('停用/失败的订阅仍能手动点「立即同步」', failureRow?.syncDisabled === false, `disabled=${failureRow?.syncDisabled}`)

  // 停用后仍可同步（这条把"停用 = 只能等自动同步"的死角堵掉）
  const toggled = await page.evaluate(() => {
    const article = [...document.querySelectorAll('.subscription-list article')]
      .find(node => node.textContent?.includes(window.__SUB_TOKEN))
    const button = [...(article?.querySelectorAll('button') ?? [])].find(node => /已启用|已停用/.test(node.textContent ?? ''))
    button?.click()
    return button?.textContent?.trim() ?? ''
  })
  await sleep(1200)
  const afterToggle = await page.evaluate(() => {
    const article = [...document.querySelectorAll('.subscription-list article')]
      .find(node => node.textContent?.includes(window.__SUB_TOKEN))
    return {
      label: [...(article?.querySelectorAll('button') ?? [])].map(node => node.textContent?.trim()).join('/'),
      hasOffNote: !!article?.querySelector('.sub-muted'),
    }
  })
  ok('订阅可以停用，且明说自动同步会跳过', toggled === '已启用' && /已停用/.test(afterToggle.label) && afterToggle.hasOffNote,
    `${toggled} → ${afterToggle.label} 说明=${afterToggle.hasOffNote}`)
  await page.evaluate(() => {
    const article = [...document.querySelectorAll('.subscription-list article')]
      .find(node => node.textContent?.includes(window.__SUB_TOKEN))
    const button = [...(article?.querySelectorAll('button') ?? [])].find(node => /已启用|已停用/.test(node.textContent ?? ''))
    button?.click()
  })
  await sleep(900)

  // ③ 空态引导（书源订阅这张：本机有真订阅时断"不挡路"，没有时断引导可点）
  const sourcesEmpty = await page.evaluate(() => ({
    guide: !!document.querySelector('.subscription-list .panel-empty'),
    buttons: [...document.querySelectorAll('.subscription-list .panel-empty-actions button')].map(node => node.textContent?.trim()),
    rows: document.querySelectorAll('.subscription-list article').length,
  }))
  if (sourcesEmpty.rows === 0) {
    ok('书源订阅空态给了可点的去处', sourcesEmpty.guide && sourcesEmpty.buttons.length >= 2, JSON.stringify(sourcesEmpty.buttons))
  } else {
    ok('本机已有订阅时空态不挡路', !sourcesEmpty.guide, `rows=${sourcesEmpty.rows} guide=${sourcesEmpty.guide}`)
  }

  // RSS 那一张现在是自己的一页（`#subscriptions`），不再靠点页切过去
  await goto('#subscriptions')
  await page.waitForSelector('.rss-panel .rss-source-main', { timeout: 20000 })

  const rssState = await page.evaluate(() => ({
    filterSelect: !!document.querySelector('.rss-filter .ui-select'),
    nativeSelects: document.querySelectorAll('select').length,
    rows: document.querySelectorAll('.subscription-list article').length,
    guide: !!document.querySelector('.subscription-list .panel-empty'),
    guideButtons: [...document.querySelectorAll('.panel-empty-actions button')].map(node => node.textContent?.trim()),
  }))
  ok('RSS 列表有行（探针源在）', rssState.rows >= 1, `${rssState.rows} 行`)
  ok('RSS 分组筛选是站内控件', rssState.filterSelect && rssState.nativeSelects === 0,
    `ui-select=${rssState.filterSelect} 原生=${rssState.nativeSelects}`)
  ok('有数据时 RSS 空态不挡路', !rssState.guide, `guide=${rssState.guide}`)

  // 「只看能读的」：本机普查 176 条里只有 65 条配了 ruleArticles、16 条真出文章，
  // 让读不出的行占满列表就会被当成"这功能坏了"。默认收起它们，但数据一条都不删。
  const toggleState = await page.evaluate(() => ({
    label: document.querySelector('.rss-readable-toggle')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    checked: document.querySelector('.rss-readable-toggle input')?.checked ?? null,
    rows: [...document.querySelectorAll('.subscription-list article')].map(node => node.textContent ?? ''),
  }))
  ok('存在读不出的源时给出「只看能读的」并如实报数',
    /只看能读的（\d+ \/ \d+）/.test(toggleState.label) && toggleState.checked === true, toggleState.label)
  ok('默认视图收掉了没配规则的源，能读的那条仍在',
    toggleState.rows.every(row => !row.includes('探针无规则')) && toggleState.rows.some(row => row.includes(RSS_NAME)),
    `${toggleState.rows.length} 行可见`)
  await page.evaluate(() => document.querySelector('.rss-readable-toggle input')?.click())
  await sleep(500)
  const unfiltered = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.subscription-list article')]
    return {
      count: rows.length,
      shown: rows.some(node => node.textContent?.includes('探针无规则')),
      warn: rows.some(node => node.textContent?.includes('探针无规则') && node.querySelector('.rss-warn') !== null),
    }
  })
  ok('取消勾选后读不出的那条露出来，并写明"没写列表规则，只能打开原页"',
    unfiltered.shown && unfiltered.warn, `${unfiltered.count} 行可见`)
  await page.evaluate(() => document.querySelector('.rss-readable-toggle input')?.click())
  await sleep(400)

  // ④ 下拉能开、能看到分组计数、能筛
  await page.click('.rss-filter .ui-select-trigger')
  await sleep(400)
  const menu = await page.evaluate(() => {
    const options = [...document.querySelectorAll('.ui-select-menu .ui-select-option')].map(node => node.textContent?.replace(/\s+/g, ' ').trim())
    return { open: !!document.querySelector('.ui-select-menu'), options }
  })
  ok('下拉打开后列出全部分组与探针分组', menu.open && menu.options.some(text => text?.includes('全部分组')) && menu.options.some(text => text?.includes(GROUP)),
    menu.options.join(' | '))
  ok('分组选项带条数', menu.options.some(text => /（\d+）/.test(text ?? '')), menu.options.join(' | '))

  await page.evaluate(name => {
    const target = [...document.querySelectorAll('.ui-select-menu .ui-select-option')]
      .find(node => node.textContent?.includes(name))
    target?.click()
  }, GROUP)
  await sleep(900)
  const filtered = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('.subscription-list article strong')].map(node => node.textContent?.trim()),
    trigger: document.querySelector('.rss-filter .ui-select-trigger .ui-select-value')?.textContent?.trim() ?? '',
  }))
  ok('选中分组后只剩该分组的源', filtered.rows.length === 1 && filtered.rows[0] === RSS_NAME, JSON.stringify(filtered.rows))
  ok('控件上显示当前选中的分组', filtered.trigger.includes(GROUP), filtered.trigger)

  // 搜不到 → 给清空筛选
  await page.evaluate(() => {
    const input = document.querySelector('.rss-filter input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, '绝对查不到-' + Date.now())
    input?.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await sleep(1200)
  const noMatch = await page.evaluate(() => ({
    text: document.querySelector('.rss-no-match')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    hasClear: !!document.querySelector('.rss-no-match .link-button'),
  }))
  ok('筛不到时说清楚并给「清空筛选」', noMatch.text.includes('没有匹配') && noMatch.hasClear, JSON.stringify(noMatch))
  await page.evaluate(() => document.querySelector('.rss-no-match .link-button')?.click())
  await sleep(1200)
  const cleared = await page.evaluate(() => ({
    rows: document.querySelectorAll('.subscription-list article').length,
    trigger: document.querySelector('.rss-filter .ui-select-trigger .ui-select-value')?.textContent?.trim() ?? '',
  }))
  ok('清空筛选后列表和选择框都回到全部', cleared.rows >= 1 && cleared.trigger.includes('全部分组'), JSON.stringify(cleared))

  // 空态按钮：粘贴 JSON 添加会展开导入框
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('.rss-panel > header button')].find(node => node.textContent?.includes('粘贴'))
    button?.click()
  })
  await sleep(500)
  const importBox = await page.evaluate(() => ({
    open: !!document.querySelector('.rss-import'),
    focused: document.activeElement?.classList?.contains('rss-import-textarea') || document.activeElement?.tagName === 'TEXTAREA',
  }))
  ok('「粘贴 JSON 添加」真的展开导入框并聚焦', importBox.open && importBox.focused, JSON.stringify(importBox))

  await page.screenshot({ path: path.join(SHOTS, 'stage3-subscription-rss.png'), fullPage: true })

  // ——— 其余页面的原生 select 清扫 ———
  for (const [hash, label, extra] of [
    ['#shelf', '书架', '.shelf-sort .ui-select'],
    ['#explore', '发现', '.explore-source-picker .ui-select'],
    ['#sources', '书源', null],
    ['#library', '书库', null],
  ]) {
    await goto(hash)
    const scan = await page.evaluate(selector => ({
      native: document.querySelectorAll('select').length,
      control: selector ? !!document.querySelector(selector) : true,
    }), extra)
    ok(`${label}页没有原生 select`, scan.native === 0, `${scan.native} 个`)
    if (extra) ok(`${label}页的排序/选源控件是站内控件`, scan.control, `选择器 ${extra} 命中=${scan.control}`)
  }

  // 书架排序：换序真的生效（有 ≥2 本书时才断得出顺序变化）
  await goto('#shelf')
  // 书架的书是进页面后才取的；负载下这一刻还没回来，会被读成"本机 0 本"然后整条 SKIP。
  await page.waitForFunction(() => document.querySelectorAll('.shelf-card').length > 0, { timeout: 20000, polling: 400 }).catch(() => null)
  const shelfProbe = await page.evaluate(() => ({
    rows: document.querySelectorAll('.shelf-card').length,
  }))
  if (shelfProbe.rows >= 2) {
    const beforeOrder = await page.evaluate(() => [...document.querySelectorAll('.shelf-card-name')].slice(0, 3).map(node => node.textContent?.trim()))
    await page.click('.shelf-sort .ui-select-trigger')
    await sleep(300)
    await page.evaluate(() => {
      const target = [...document.querySelectorAll('.ui-select-menu .ui-select-option')].find(node => node.textContent?.includes('按书名'))
      target?.click()
    })
    await sleep(1200)
    const afterOrder = await page.evaluate(() => [...document.querySelectorAll('.shelf-card-name')].slice(0, 3).map(node => node.textContent?.trim()))
    const stored = await page.evaluate(() => localStorage.getItem('legado-shelf-sort-v1'))
    ok('书架排序换档后顺序或存值有变', JSON.stringify(beforeOrder) !== JSON.stringify(afterOrder) || stored === 'name',
      `${JSON.stringify(beforeOrder)} → ${JSON.stringify(afterOrder)} 存值=${stored}`)
  } else {
    skip('书架排序换档', `本机书架只有 ${shelfProbe.rows} 本，断不出顺序变化`)
  }

  // ——— 收尾：探针必须清干净 ———
  await raw('DELETE', `/api/rss/sources?sourceUrl=${encodeURIComponent(RSS_ID)}`)
  await raw('DELETE', `/api/rss/sources?sourceUrl=${encodeURIComponent(rulelessId)}`)
  await raw('DELETE', `/api/subscriptions/${subId}`)
  const rssLeft = (await listRss()).filter(item => item.sourceUrl.includes(STAMP))
  const subLeft = (await listSubs()).filter(item => item.url.includes(STAMP))
  ok('探针 RSS 源已删除', rssLeft.length === 0, `残留 ${rssLeft.length} 条`)
  ok('探针订阅已删除', subLeft.length === 0, `残留 ${subLeft.length} 条`)
  ok('用户原有数据没被动过',
    (await listRss()).length === rssBefore.length && (await listSubs()).length === subsBefore.length,
    `RSS ${(await listRss()).length}/${rssBefore.length}，订阅 ${(await listSubs()).length}/${subsBefore.length}`)
  // 书源订阅那一档在「书源」页里，收尾的空态要回那一页看
  await goto('#sources')
  await page.waitForSelector('.source-subscribe-btn', { timeout: 40000 })
  await page.evaluate(() => {
    if (document.querySelector('input[aria-label="书源订阅地址"]')) return
    document.querySelector('.source-subscribe-btn')?.click()
  })
  await page.waitForSelector('.subscription-panel h2', { timeout: 20000 })
  const afterCleanup = await page.evaluate(() => ({
    guide: !!document.querySelector('.subscription-list .panel-empty'),
    buttons: [...document.querySelectorAll('.panel-empty-actions button')].map(node => node.textContent?.trim()),
  }))
  if (subsBefore.length === 0) {
    ok('书源订阅删干净后空态引导回来了', afterCleanup.guide && afterCleanup.buttons.length >= 2, JSON.stringify(afterCleanup.buttons))
  } else {
    ok('本机有真订阅时不显示空态', !afterCleanup.guide, `guide=${afterCleanup.guide}`)
  }
  // RSS 那张的空态才是用户说"什么都没有"时看到的那一屏，必须单独断
  await goto('#subscriptions')
  await sleep(1400)
  // RSS 列表是进这一页后才去取的，负载下 1.4 秒可能还在飞 —— 等到"有行"或"明确空态"再读，
  // 而不是把"还没到"当成"一条都没有"。
  await page.waitForFunction(() => document.querySelectorAll('.subscription-list article').length > 0
    || !!document.querySelector('.subscription-list .panel-empty'), { timeout: 30000, polling: 400 }).catch(() => null)
  const rssEmpty = await page.evaluate(() => ({
    guide: !!document.querySelector('.subscription-list .panel-empty'),
    buttons: [...document.querySelectorAll('.panel-empty-actions button')].map(node => node.textContent?.trim()),
    rows: document.querySelectorAll('.subscription-list article').length,
  }))
  if (rssBefore.length === 0) {
    ok('RSS 清干净后给出两个可点的去处', rssEmpty.rows === 0 && rssEmpty.guide && rssEmpty.buttons.length >= 2, JSON.stringify(rssEmpty.buttons))
    // 空态上的「导入手机备份包」必须真的开出备份入口（阶段 2 的上传入口在那里）。
    // 0.6.27 起备份是悬浮层：不再跳页、hash 不变，判据改成「开出了悬浮层且有选包按钮」。
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('.panel-empty-actions button')].find(node => node.textContent?.includes('备份包'))
      button?.click()
    })
    await sleep(1200)
    const landed = await page.evaluate(() => ({
      hash: location.hash,
      dialog: !!document.querySelector('.dialog-shell'),
      hasUpload: [...document.querySelectorAll('button')].some(node => node.textContent?.includes('选择备份包导入')),
    }))
    ok('空态的「导入手机备份包」开出备份悬浮层且有选包入口', landed.dialog && landed.hasUpload, JSON.stringify(landed))
  } else {
    ok('本机有真 RSS 源时不显示空态', !rssEmpty.guide, `rows=${rssEmpty.rows} guide=${rssEmpty.guide}`)
  }

  ok('页面没有 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))
  await goto('#subscriptions')
  await page.screenshot({ path: path.join(SHOTS, 'stage3-subscription-sources.png'), fullPage: true })
} finally {
  if (browser) await browser.close()
}

console.log(`\nsubscription-check: PASS ${pass} / FAIL ${fail}${skipped.length ? ` / SKIP ${skipped.length}` : ''}`)
if (fail) process.exit(1)
