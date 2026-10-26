// 「运行日志」弹窗的界面门禁。
//
// 为什么单开一条（用户 2026-10-02：「优化日志」）：这一轮把服务端日志从"刷屏的三千米 ERROR"
// 改成了单行 + 同类合并 + 诚实级别，界面这边加了合并计数、上下文芯片、自动跟随、导出，
// 并且把「取失败」和「确实没有」分开。四条都是**只有跑起来才验得了**的东西，
// 而单测只能证明组件函数怎么写就怎么返。
//
// 判的六件事（序号与下面的分段一致）：
//   ① 服务端真的在合并：同源闸门连拒三次只占一行，行上写着 ×N，顶部写着"合并前 M 条"；
//   ② 类别下拉真的在筛，而且换类别确实换了请求；
//   ③ 最能定位的那个上下文挂在行上（取一张注定失败的图，行上要出现域名芯片，且级别是警告）；
//   ④ 导出走的确实是屏幕上这一份：行数一致、带着合并次数、文件名说的是这个应用；
//   ⑤ 取失败与"确实没有"分开 —— 同一个列表位，503 出错误条 + 重试，200 空数组才出空态；
//   ⑥ 弹窗里不出现装饰字形（清单以 web/test/CopyStyle.test.ts 为唯一来源，不在这里另抄一份）。
// 上下文芯片（域名 / 状态码）那一段要喂假数据才看得见，放在 web/test/LogsModal.test.ts 里判。
//
// 只往 /api/logs 发几条**跨站写请求**让闸门拒绝它们（返回 403，不动任何书源/书架数据），
// 也不点「清空」—— 那是用户的日志历史，门禁没有资格删。
// 跑法：node tools/verify/logs-ui-check.mjs
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, OUT, SHOTS, BASE, launchOptions } from './env.mjs'

const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')

const STAMP = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 禁字形清单从界面判据里读，两边不许各存一份。 */
const copyGate = fs.readFileSync(path.join(ROOT, 'web/test/CopyStyle.test.ts'), 'utf8')
const bannedList = /const BANNED_GLYPHS = \[([\s\S]*?)\]\.map/.exec(copyGate)?.[1] ?? ''
const BANNED = [...bannedList.matchAll(/0x([0-9A-Fa-f]{2,6})/g)].map(m => String.fromCodePoint(Number.parseInt(m[1], 16)))

const clickByText = (page, scope, label) => page.evaluate(({ scope, label }) => {
  const root = document.querySelector(scope) ?? document
  const hit = [...root.querySelectorAll('button')].find(node => (node.textContent ?? '').trim().includes(label))
  if (!hit) return false
  hit.click()
  return true
}, { scope, label })

/** 自定义下拉（不是原生 select）：按 aria-label 找到触发器，再点里面的选项。 */
const pickOption = async (page, ariaLabel, optionLabel) => {
  const opened = await page.evaluate(label => {
    const trigger = document.querySelector(`.ui-select-trigger[aria-label="${label}"]`)
    if (!trigger) return false
    trigger.click()
    return true
  }, ariaLabel)
  if (!opened) return false
  await sleep(120)
  const picked = await page.evaluate(label => {
    const hit = [...document.querySelectorAll('.ui-select-option')].find(node => (node.textContent ?? '').trim() === label)
    if (!hit) return false
    hit.click()
    return true
  }, optionLabel)
  await sleep(500)
  return picked
}

const readModal = page => page.evaluate(() => {
  const modal = document.querySelector('.logs-modal')
  if (!modal) return null
  const rows = [...modal.querySelectorAll('.logs-row')].map(row => ({
    badge: (row.querySelector('.logs-badge')?.textContent ?? '').trim(),
    level: (row.querySelector('.logs-level')?.textContent ?? '').trim(),
    msg: (row.querySelector('.logs-msg')?.textContent ?? '').trim(),
    repeat: (row.querySelector('.logs-repeat')?.textContent ?? '').trim(),
    chips: [...row.querySelectorAll('.logs-chip')].map(chip => (chip.textContent ?? '').trim()),
    time: (row.querySelector('.logs-time')?.textContent ?? '').trim(),
  }))
  return {
    title: (modal.querySelector('.logs-modal-header h2')?.textContent ?? '').trim(),
    actions: [...modal.querySelectorAll('.logs-modal-actions .logs-btn')].map(node => (node.textContent ?? '').trim() || node.getAttribute('aria-label') || ''),
    count: (modal.querySelector('.logs-count')?.textContent ?? '').trim(),
    rows,
    empty: !!modal.querySelector('.logs-empty'),
    emptyText: (modal.querySelector('.logs-empty')?.textContent ?? '').trim(),
    errorBar: !!modal.querySelector('.logs-error'),
    errorText: (modal.querySelector('.logs-error')?.textContent ?? '').trim(),
    detail: (modal.querySelector('.logs-detail')?.textContent ?? '').trim(),
    // 连 title 与 aria-label 一起扫：字形藏在提示里同样是界面上的字
    visibleText: `${modal.innerText}\n${[...modal.querySelectorAll('[title],[aria-label]')].map(node => `${node.getAttribute('title') ?? ''} ${node.getAttribute('aria-label') ?? ''}`).join('\n')}`,
  }
})

/**
 * 等这一次 /api/logs 真的回来。
 * 固定 sleep 在这台机器上不可靠：300 条要查 SQLite + 解 JSON，900ms 读到的是"加载中"那一屏，
 * 于是上一版的四条断言全在拿"还没有数据"当"数据不对"。
 */
const takingLogs = page => page.waitForResponse(response => response.url().includes('/api/logs'), { timeout: 30000 }).catch(() => null)

/**
 * 等到"这一份新数据真的画上屏"：屏幕上那行计数（显示 N 条 / 加载中… / 没取到）与点之前不一样了。
 *
 * 为什么不能用"出现了行/空态/错误条"或"没有加载中"当落定信号：`load()` 在 state 已经是 ready 时
 * **不改 state**（LogsModal.tsx:72 `current === 'ready' ? 'ready' : 'loading'`），所以换筛选条件的时候
 * 旧的那 300 行会原样挂在 DOM 上、也没有任何转圈标记 —— 按"有没有东西"去等会立刻返回，
 * 读到的是上一份数据（2026-10-04 实测：② 读到 300 行混合类别、⑤ 真空那条读成"没有空态"）。
 * 按取到响应之后的计数文本变化等，才是"这一份落地了"。真的没变化（新旧计数恰好相同）就最多等 6 秒再读，
 * 那时读的仍是落地后的屏 —— 所以这条只会慢，不会假红。
 */
const readCount = page => page.evaluate(() => document.querySelector('.logs-modal .logs-count')?.textContent?.trim() ?? '')
const waitRepaint = (page, before) => page.waitForFunction(({ before }) => {
  const modal = document.querySelector('.logs-modal')
  if (!modal) return false
  return (modal.querySelector('.logs-count')?.textContent ?? '').trim() !== before
}, { timeout: 6000, polling: 150 }, { before }).catch(() => null)

/**
 * 等到这一屏真的落定：不是「加载中…」，且行 / 空态 / 错误条三者至少画出了一个。
 *
 * 只用在**第一次挂载**那一处：那时候 DOM 里还没有旧数据，"有没有东西"是可信的信号。
 * 换数据的那几次要用 waitRepaint，理由见上面。
 */
const waitSettled = page => page.waitForFunction(() => {
  const modal = document.querySelector('.logs-modal')
  if (!modal) return false
  if ((modal.textContent ?? '').includes('加载中')) return false
  return !!modal.querySelector('.logs-row, .logs-empty, .logs-error')
}, { timeout: 10000 }).catch(() => null)

/** 从 Node 侧发跨站写请求：浏览器里的 fetch 改不了 Origin，只能在这儿造闸门的拒绝。 */
const tripGuard = async count => {
  const url = `${BASE}/api/logs`
  const codes = []
  for (let index = 0; index < count; index += 1) {
    try {
      const response = await fetch(url, { method: 'DELETE', headers: { Origin: 'http://gate.invalid' } })
      codes.push(response.status)
    } catch (error) {
      codes.push(`err:${error.name}`)
    }
  }
  return codes
}

let browser = null
const pageErrors = []
try {
  check('①禁字形清单读得到（读不到就是界面判据改了写法）', BANNED.length >= 20, `${BANNED.length} 个码位`)

  const guardCodes = await tripGuard(3)
  check('①探针确实被同源闸门挡住（没挡住就没有日志可验）',
    guardCodes.every(code => code === 403), guardCodes.join(' '))

  browser = await puppeteer.launch(launchOptions())
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  page.on('pageerror', error => pageErrors.push(String(error.message)))

  await page.goto(`${BASE}/#library`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForSelector('.app-page-header', { timeout: 45000 })

  // ─────────────────────── ① 入口与合并计数 ───────────────────────
  check('①「我的」菜单点得开', await clickByText(page, '.app-page-header', '我的'), '')
  await page.waitForSelector('.header-menu-dropdown', { timeout: 8000 })
  await sleep(200)
  const openedByMenu = takingLogs(page)
  // 「运行日志」的落点搬过两次：2026-10-03 从「我的」菜单收进「设置」，
  // 2026-10-04 「设置」本身提到顶栏一级导航（菜单里不再留第二条路，见 ui-shell-check ②）。
  // 入口换位置，判的还是同一件事：这一行点得到、开得出、开出来是真日志。
  check('①「设置」在顶栏点得开这一页', await clickByText(page, '.app-page-header nav', '设置'), '')
  await page.waitForSelector('.settings-page', { timeout: 8000 })
  check('①「设置」里那一行「看日志」点得开弹窗', await clickByText(page, '.settings-page', '看日志'), '')
  await page.waitForSelector('.logs-modal .logs-list', { timeout: 10000 })
  await openedByMenu
  // 首挂载没有"旧数据还挂着"的问题，等"画出了东西"就是等落定（换数据的那几次用 waitRepaint）
  await waitSettled(page)

  const first = await readModal(page)
  check('①弹窗标题是「运行日志」', first?.title === '运行日志', first?.title ?? '(弹窗没出现)')
  check('①四个动作都在：刷新 / 自动跟随 / 导出 / 清空（+ 关闭）',
    !!first && ['刷新', '自动跟随', '导出', '清空'].every(label => first.actions.some(text => text.includes(label))),
    first?.actions.join(' / ') ?? '')
  const guardRows = (first?.rows ?? []).filter(row => row.badge === '同源闸门')
  check('①闸门日志在列表里（多次拒绝该并成一行）', guardRows.length >= 1, `共 ${guardRows.length} 行闸门记录：${guardRows.map(r => r.msg.slice(0, 20)).join(' | ')}`)
  const mergedCount = Number.parseInt((guardRows[0]?.repeat ?? '').replace(/\D/g, '') || '0', 10)
  check('①最新那条写着合并次数 ×N（N 至少等于探针发的次数）', mergedCount >= 3, `实测「${guardRows[0]?.repeat ?? '(这一行没有 ×N)'}」`)
  check('①顶部报出"合并前"的条数，与逐条计数对得上',
    /显示 \d+ 条（合并前 \d+ 条）/.test(first?.count ?? '') &&
    Number(first.count.match(/显示 (\d+) 条/)[1]) === first.rows.length &&
    Number(first.count.match(/合并前 (\d+) 条/)[1]) >= first.rows.length,
    first?.count ?? '(取不到)')
  check('①等级念的是中文（不是裸 WARN/ERROR）',
    (first?.rows ?? []).every(row => ['错误', '警告', '信息', '调试'].includes(row.level)),
    [...new Set((first?.rows ?? []).map(row => row.level))].join('、'))
  check('①时间是相对说法（刚刚 / N 分钟前 / N 小时前）',
    (first?.rows ?? []).every(row => /^(刚刚|\d+ 分钟前|\d+ 小时前|\d{4}-\d{2}-\d{2})/.test(row.time)),
    (first?.rows ?? []).slice(0, 3).map(row => row.time).join(' | '))
  const openedDetail = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.logs-row')].find(node => (node.querySelector('.logs-badge')?.textContent ?? '').trim() === '同源闸门')
    if (!row) return false
    row.querySelector('.logs-row-main').click()
    return true
  })
  await sleep(250)
  const expanded = await readModal(page)
  check('①闸门那一行点得开，明细里带着方法与路径',
    openedDetail && /方法/.test(expanded?.detail ?? '') && /路径/.test(expanded?.detail ?? ''),
    expanded?.detail.slice(0, 70) ?? '(没有明细)')

  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `logs-ui-${STAMP}.png`) })

  // ─────────────────────── ② 类别筛选真的在筛 ───────────────────────
  const guardBefore = await readCount(page)
  const filteredByCategory = takingLogs(page)
  check('②类别下拉换成了「同源闸门」', await pickOption(page, '日志类别', '同源闸门'), '')
  await filteredByCategory
  await waitRepaint(page, guardBefore)
  const filtered = await readModal(page)
  check('②筛完之后列表里只剩这一个类别',
    !!filtered && filtered.rows.length > 0 && filtered.rows.every(row => row.badge === '同源闸门'),
    `${filtered?.rows.length ?? 0} 行：${[...new Set((filtered?.rows ?? []).map(r => r.badge))].join('、')}`)
  check('②筛选变了请求（带 category 参数）', await page.evaluate(async () => {
    const response = await fetch(`/api/logs?category=GUARD&limit=300`, { headers: { Accept: 'application/json' } })
    const list = await response.json()
    return Array.isArray(list) && list.every(item => item.category === 'GUARD')
  }), '')
  const allBack1Before = await readCount(page)
  const backToAll = takingLogs(page)
  await pickOption(page, '日志类别', '全部')
  await backToAll
  await waitRepaint(page, allBack1Before)

  // ─────────────── ③ 最能定位的那个上下文挂在行上 ───────────────
  // 取一张必然失败的图：`.invalid` 是 RFC 6761 保留的、保证解析不了的域，
  // 于是"有没有域名芯片"这件事不必依赖用户机器上恰好有一条网络日志。
  const probe = await fetch(`${BASE}/api/book/image?url=${encodeURIComponent('http://legado-gate-probe.invalid/x.png')}`)
  check('③探针取图确实失败（服务端该回 502）', probe.status === 502, `HTTP ${probe.status}`)
  const net1Before = await readCount(page)
  const networkReload = takingLogs(page)
  check('③类别换到「网络请求」', await pickOption(page, '日志类别', '网络请求'), '')
  await networkReload
  await waitRepaint(page, net1Before)
  const probed = await readModal(page)
  const probeRow = (probed?.rows ?? []).find(row => row.msg.includes('正文图片代理失败'))
  check('③这条网络日志进了列表，且级别是警告不是错误（取不到一张图不算事故）',
    !!probeRow && probeRow.level === '警告',
    probeRow ? `${probeRow.msg.slice(0, 24)} · ${probeRow.level}` : '(没找到「正文图片代理失败」这一行)')
  check('③域名芯片挂在行上，不点开也说得清是哪个站在失败',
    (probeRow?.chips ?? []).some(chip => chip.startsWith('域名 ') && chip.includes('legado-gate-probe.invalid')),
    probeRow?.chips.join(' | ') ?? '(这一行没有芯片)')
  await page.screenshot({ path: path.join(SHOTS, `logs-ui-${STAMP}-network.png`) })
  const allBack2Before = await readCount(page)
  const backToAllAgain = takingLogs(page)
  await pickOption(page, '日志类别', '全部')
  await backToAllAgain
  await waitRepaint(page, allBack2Before)

  // ─────────────────────── ④ 导出的就是屏幕上这一份 ───────────────────────
  // 这一条要判"导出里带类别标签、带合并次数"，所以自己先把素材造出来：
  // 同一 origin/method/path 的跨站写连发三次会被并成一行 count=3（实测），
  // 不这么做就只能指望"用户机器上恰好还留着一条闸门记录"——列表只取最近 300 行，
  // 别的门禁一跑就把那条挤出窗口，于是同一条判据会莫名轮流红（2026-10-04 实测两轮各红一处）。
  await tripGuard(3)
  const seedBefore = await readCount(page)
  const seedReload = takingLogs(page)
  await clickByText(page, '.logs-modal', '刷新')
  await seedReload
  // 等新那行计数画上屏再取行数：合并前的条数会因为上面那三次拒绝而变，
  // 早读一步比的就是"上一份的行数"与"这一份的导出"（旧行这时候还挂着，没有转圈标记可等）
  await waitRepaint(page, seedBefore)
  // 行数在点「导出」之前取：点完再读，中间只要有一条新日志挤进来，比的就是两份不同的东西
  const shownRows = (await readModal(page)).rows.length
  await page.evaluate(() => {
    window.__gateBlob = null
    const original = URL.createObjectURL
    URL.createObjectURL = function (blob) {
      window.__gateBlob = blob
      return original.call(URL, blob)
    }
    window.__gateFile = ''
    const click = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () {
      window.__gateFile = this.download ?? ''
      return click.call(this)
    }
  })
  check('④点得动「导出」', await clickByText(page, '.logs-modal', '导出'), '')
  await sleep(250)
  const exported = await page.evaluate(async () => {
    if (!window.__gateBlob) return null
    return { text: await window.__gateBlob.text(), name: window.__gateFile }
  })
  // 三个半分着报：只写一串 && 的话，红了只知道"有一条不对"，不知道是行数、类别还是合并次数掉了。
  const text = exported?.text ?? ''
  const lines = text ? text.split('\n').length : 0
  const missing = [
    lines === shownRows ? '' : `行数 ${lines} ≠ 屏上 ${shownRows}`,
    /同源闸门/.test(text) ? '' : '没有类别标签',
    /×\d+/.test(text) ? '' : '没有合并次数 ×N',
  ].filter(Boolean)
  check('④导出的是当前这一份，一行一条、带合并次数与上下文',
    !!exported && missing.length === 0,
    exported ? `${exported.name} · ${lines} 行${missing.length ? ` · 缺：${missing.join('、')}` : ''}` : '(没抓到 Blob)')
  check('④导出的文件名说的是这个应用', /^青阅运行日志-\d{8}-?\d{4}\.log$/.test(exported?.name ?? ''), exported?.name ?? '(没抓到)')

  // ─────────────────── ⑤ 取失败 ≠ 确实没有（同一条列表位） ───────────────────
  await page.setRequestInterception(true)
  // 这版 puppeteer 的 'request' 回调拿到的就是请求本身，不是 { request }。
  const block = request => request.url().includes('/api/logs')
    ? request.respond({ status: 503, contentType: 'application/json', body: '{"error":"门禁探针"}' })
    : request.continue()
  page.on('request', block)
  const blockedReload = takingLogs(page)
  await clickByText(page, '.logs-modal', '刷新')
  await blockedReload
  await page.waitForSelector('.logs-error', { timeout: 8000 }).catch(() => null)
  const failed = await readModal(page)
  check('⑤取失败时明说失败，而不是显示"没有日志"',
    !!failed && failed.errorBar && !failed.empty && /取日志失败/.test(failed.errorText),
    failed?.errorText.slice(0, 60) ?? '(既没有错误条也没有列表)')
  check('⑤取失败时计数位不写"0 条"这种误导说法', /没取到/.test(failed?.count ?? ''), failed?.count ?? '')
  check('⑤错误条上给了「重试」', (failed?.actions ?? []).length >= 0 && /重试/.test(failed?.errorText ?? ''), '')
  page.off('request', block)
  await page.setRequestInterception(false)

  const retried = await (async () => {
    const pending = takingLogs(page)
    await clickByText(page, '.logs-error', '重试')
    await pending
    // 等到"错误条没了、行回来了"为止；产品要是还把错误条挂着，这里等到超时，下面那条判据照样红 —— 不是恒真
    await page.waitForFunction(() => {
      const modal = document.querySelector('.logs-modal')
      if (!modal) return false
      if ((modal.textContent ?? '').includes('加载中')) return false
      return !!modal.querySelector('.logs-row') && !modal.querySelector('.logs-error')
    }, { timeout: 8000 }).catch(() => null)
    return readModal(page)
  })()
  check('⑤重试真的把数据取回来了（错误条消失、列表回来）',
    !!retried && !retried.errorBar && retried.rows.length > 0,
    `${retried?.rows.length ?? 0} 行 · 错误条=${retried?.errorBar}`)

  await page.setRequestInterception(true)
  const emptyHandler = request => request.url().includes('/api/logs')
    ? request.respond({ status: 200, contentType: 'application/json', body: '[]' })
    : request.continue()
  page.on('request', emptyHandler)
  const emptyBefore = await readCount(page)
  const emptyReload = takingLogs(page)
  await clickByText(page, '.logs-modal', '刷新')
  await emptyReload
  await waitRepaint(page, emptyBefore)
  // 关掉再打开请求拦截之后，那一次刷新有时根本不回来（2026-10-04 两轮里有一轮读到的是旧的 300 行）。
  // 补点一次：这治的是探针自己卡在拦截层，不是产品 —— 判的仍然是"空态出没出来、有没有谎称取失败"，
  // 产品真给不出空态时，补点之后照样红，而且 detail 会写明当时停在第几行。
  if ((await readCount(page)) === emptyBefore) {
    const secondTry = takingLogs(page)
    await clickByText(page, '.logs-modal', '刷新')
    await secondTry
    await waitRepaint(page, emptyBefore)
  }
  const empty = await readModal(page)
  check('⑤真空的时候才给空态，且不谎称取失败',
    !!empty && empty.empty && !empty.errorBar && /没有日志/.test(empty.emptyText),
    `${empty?.emptyText ?? '(没有空态)'} · 错误条=${empty?.errorBar} · 计数="${empty?.count ?? ''}" · ${empty?.rows.length ?? 0} 行`)
  page.off('request', emptyHandler)
  await page.setRequestInterception(false)
  const restoredReload = takingLogs(page)
  await clickByText(page, '.logs-modal', '刷新')
  await restoredReload
  await sleep(300)

  // ─────────────────────── ⑥ 界面文字合规 ───────────────────────
  const final = await readModal(page)
  const glyphs = (final?.visibleText ?? '').split('').filter(ch => BANNED.includes(ch))
  check('⑥弹窗可见文字里没有装饰字形', glyphs.length === 0, [...new Set(glyphs)].map(ch => 'U+' + ch.codePointAt(0).toString(16).toUpperCase()).join(' ') || '干净')
  check('⑥没有把裸 sourceId 当文字显示', !/\bsourceId=[0-9a-f]{8,}/i.test(final?.visibleText ?? ''), '')
  await page.keyboard.press('Escape')
  await sleep(400)
  check('⑥Esc 关得掉', await page.evaluate(() => !document.querySelector('.logs-modal')), '')
  await page.screenshot({ path: path.join(SHOTS, `logs-ui-${STAMP}-closed.png`) })

  check('全程没有页面异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))
} catch (error) {
  check('探针自身异常', false, error.message)
} finally {
  if (browser) await browser.close().catch(() => null)
  fs.mkdirSync(OUT, { recursive: true })
  const failed = results.filter(row => !row.ok)
  fs.writeFileSync(path.join(OUT, `logs-ui-${STAMP}.json`), JSON.stringify({ stamp: STAMP, base: BASE, results }, null, 2))
  for (const row of results) console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name}${row.detail ? '   [' + row.detail + ']' : ''}`)
  console.log(`\n${results.length - failed.length}/${results.length} PASS · 详情 tools/verify/out/logs-ui-${STAMP}.json`)
  process.exit(failed.length ? 1 : 0)
}
