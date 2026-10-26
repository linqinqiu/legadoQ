// 「搜索范围 / 选源 / 发现页直搜 / 目录展开 / 书架信息层」这一轮的验收门禁。
//
// 用户 2026-09-30 的原话是「指定书源-选择书源功能不能正常使用，发现页面也是同样问题」。
// 实测下来控件本身点得开、能过滤、能选中 —— 坏在**内容**：这台库 5,574 个源里只有几百个启用，
// 旧下拉把停用的也按名字混在一起，选到一个停用源就必然搜出 0 本，看上去等于"功能坏了"。
// 所以这一轮断言的是"界面在说什么"，不是"代码写了什么"：
// ① 品牌统一成「青阅」，页面上不许再出现「阅读服务器」；
// ② 选源默认只列启用中的，停用源要显式勾「含已停用」才出现，且出现时直说"搜不到"；
// ③ 发现页把"从两千多个配了发现页的源里挑到一个"做成搜索口（上一版的源内搜书名已按用户要求删掉）；
// ④ 目录预览的展开条看得出价、点得动，一次按千章推进；
// ⑤ 书架 hover 层交代进度/缓存/来源/分组，右键能直接归组。
//
// 全程只读：不改书源启用位、不动用户书架，右键菜单只展开不收尾就按 Esc 关掉。
//
// 跑法：node tools/verify/source-picker-check.mjs
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, SHOTS, BASE, launchOptions, acceptAgreement } from './env.mjs'

const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')

const results = []
const check = (name, condition, detail = '') => results.push({ name, ok: !!condition, detail })
const skip = (name, detail) => results.push({ name, ok: null, detail })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 等到某个 DOM 状态出现为止；到点还不满足就返回最后一次读到的值（由调用方判失败还是跳过）。 */
async function pollUntil(read, done, budgetMs, tickMs = 1000) {
  const deadline = Date.now() + budgetMs
  let last = null
  do {
    last = await read()
    if (done(last)) return last
    await sleep(tickMs)
  } while (Date.now() < deadline)
  return null
}

/** React 受控输入：直接改 value 不会触发 onChange，必须走原生 setter。 */
const typeInto = (page, selector, value) => page.evaluate((sel, text) => {
  const node = document.querySelector(sel)
  if (!node) return false
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(node, text)
  node.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}, selector, value)

const clickByText = (page, selector, text) => page.evaluate((sel, needle) => {
  const node = [...document.querySelectorAll(sel)].find(item => item.textContent?.includes(needle))
  if (!node) return false
  node.click()
  return true
}, selector, text)

const browser = await puppeteer.launch(launchOptions())
let failed = 0
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error.message)))
  await page.setViewport({ width: 1440, height: 950, deviceScaleFactor: 1 })
  await page.goto(`${BASE}/#library`, { waitUntil: 'domcontentloaded' })
  // 首次协议浮层会挡住真鼠标点击；先标记已同意（见 env.mjs 的 acceptAgreement）
  await acceptAgreement(page)
  await sleep(2000)

  const inventory = await page.evaluate(async () => {
    const list = await (await fetch('/api/sources')).json()
    const explore = await (await fetch('/api/explore/sources')).json()
    return {
      total: list.length,
      enabled: list.filter(source => source.enabled).length,
      // 找一个"停用 + 有名字特征"的源，用它验证默认列表里根本搜不到它
      disabledSample: list.find(source => !source.enabled && source.name.length >= 2),
      enabledSample: list.find(source => source.enabled && (source.group || '').trim().length > 0),
      enabledNames: list.filter(source => source.enabled).map(source => source.name),
      explore: explore.length,
    }
  })
  // 启用位由用户自己处置（他什么时候全开都可以），所以"有没有停用源"只当观测，不当失败。
  if (inventory.total > inventory.enabled) {
    check('库里同时存在启用与停用源', true, `共 ${inventory.total}，启用 ${inventory.enabled}，可发现 ${inventory.explore}`)
  } else {
    skip('库里同时存在启用与停用源', `本机 ${inventory.total} 个源已全部启用，可发现 ${inventory.explore}`)
  }

  // ── ① 品牌 ──────────────────────────────────────────────
  const brand = await page.evaluate(() => ({
    title: document.title,
    header: document.querySelector('.app-brand strong')?.textContent?.trim() ?? '',
    bodyHasOldName: document.body.innerText.includes('阅读服务器'),
  }))
  check('标签页标题是「青阅」', brand.title.includes('青阅'), brand.title)
  check('顶栏品牌位是「青阅」', brand.header === '青阅', brand.header)
  check('页面上不再有「阅读服务器」字样', !brand.bodyHasOldName)

  // ── ② 书库「指定书源」：默认只列启用中的 ──────────────────
  await clickByText(page, '.library-scope-modes button', '指定书源')
  await sleep(400)
  const trigger = await page.$('.library-scope .ui-select-trigger')
  check('切到「指定书源」后出现站内选源控件', !!trigger)
  check('范围提示说清了这层筛选的口径', await page.evaluate(() => {
    const hint = document.querySelector('.library-scope-hint')?.textContent ?? ''
    // 有停用源时要交代"只列启用中 + 怎么勾出来"；一个都没有时不许再提那个勾
    return hint.includes('启用') && (hint.includes('含已停用') || /全部|都在启用/.test(hint))
  }), await page.evaluate(() => document.querySelector('.library-scope-hint')?.textContent?.trim() ?? ''))

  await trigger.click()
  await page.waitForSelector('.ui-select-menu', { timeout: 15000 })
  await sleep(300)
  const disabledName = inventory.disabledSample?.name ?? ''
  const enabledName = inventory.enabledSample?.name ?? ''

  // 不依赖"这台库恰好有停用源"：直接拿界面上列出的每一项，回查它是不是启用中的源。
  const enabledNames = new Set(inventory.enabledNames)
  const listed = await page.evaluate(() => [...document.querySelectorAll('.ui-select-option')].map(node => node.querySelector('span')?.textContent?.trim() ?? ''))
  check('默认列表里的每一项都在"启用中的书源"集合里',
    listed.length > 0 && listed.every(name => enabledNames.has(name)),
    `${listed.length} 项，越界 ${listed.filter(name => !enabledNames.has(name)).slice(0, 3).join('/') || '0'}`)
  check('列表被截到渲染上限时把总数说清楚', await page.evaluate(() => {
    const more = document.querySelector('.ui-select-more')?.textContent?.trim() ?? ''
    return !more || /只显示前\s*\d+\s*项/.test(more)
  }), '无截断提示或提示含"只显示前 N 项"')

  if (disabledName) {
    await typeInto(page, '.ui-select-search', disabledName)
    await sleep(400)
    const hiddenCount = await page.evaluate(() => document.querySelectorAll('.ui-select-option').length)
    check('未勾「含已停用」时，停用源在列表里搜不到', hiddenCount === 0, `搜「${disabledName}」得到 ${hiddenCount} 项`)

    await page.click('.library-scope-toggle input')
    await sleep(500)
    await typeInto(page, '.ui-select-search', disabledName)
    await sleep(400)
    const shownDisabled = await page.evaluate(() => [...document.querySelectorAll('.ui-select-option')].slice(0, 3)
      .map(node => node.textContent?.trim() ?? ''))
    check('勾上「含已停用」后它出现了，并且副标题直说搜不到',
      shownDisabled.some(text => text.includes('已停用，搜不到')), shownDisabled[0]?.slice(0, 60) ?? '')
    await page.click('.library-scope-toggle input')
    await sleep(300)
  } else {
    skip('停用源的收纳与「含已停用」开关', `本机 ${inventory.total} 个源全部启用，没有停用源可验`)
    check('没有停用源时不摆一个括号里写 0 的开关，提示也换成实话', await page.evaluate(() => {
      const hint = document.querySelector('.library-scope-hint')?.textContent ?? ''
      return !document.querySelector('.library-scope-toggle') && /全部|都在启用/.test(hint)
    }), await page.evaluate(() => document.querySelector('.library-scope-hint')?.textContent?.trim() ?? ''))
  }
  await page.keyboard.press('Escape')
  await sleep(300)

  // 启用源的副标题给分组，用户才能按分组特征挑源
  await page.click('.library-scope .ui-select-trigger')
  await page.waitForSelector('.ui-select-menu', { timeout: 15000 })
  await typeInto(page, '.ui-select-search', enabledName)
  await sleep(400)
  const groupHint = await page.evaluate(() => [...document.querySelectorAll('.ui-select-option')].slice(0, 5)
    .some(node => (node.querySelector('small')?.textContent ?? '').trim().length > 0))
  check('启用源带分组副标题', groupHint, `样例「${enabledName}」`)

  // 选中它，真发一次搜索：这一条回答的是"选完之后到底跑不跑"
  await page.evaluate(() => document.querySelector('.ui-select-option')?.click())
  await sleep(400)
  const chosen = await page.evaluate(() => document.querySelector('.ui-select-trigger .ui-select-value')?.textContent?.trim() ?? '')
  check('点选项后触发按钮回显所选书源', chosen.length > 0 && (!enabledName || chosen === enabledName), chosen)
  await typeInto(page, '.library-hero form input', '我的')
  await page.evaluate(() => document.querySelector('.library-hero form')?.requestSubmit())
  await sleep(4000)
  const searchState = await page.evaluate(() => ({
    status: document.querySelector('.library-search-status')?.textContent?.trim() ?? '',
    cards: document.querySelectorAll('.search-card').length,
  }))
  check('选定单源后搜索真的跑起来了（进度行按 1 个源计）',
    /1\s*\/\s*1|已获得/.test(searchState.status) || searchState.cards > 0,
    `${searchState.cards} 本 · ${searchState.status.slice(0, 60)}`)
  await page.screenshot({ path: path.join(SHOTS, 'picker-library-single-source.png') })

  // ── ③ 发现页：把"从两千多个源里挑到一个"做成搜索口 ──────────
  // 用户 2026-09-30：「我发现页也用不到这个在这个源里搜书名，需要的是搜对应书源」。
  // 上一轮在此加的书名直搜打偏了，已删；这里验的是删干净 + 选源口真的能用。
  await page.goto(`${BASE}/#explore`, { waitUntil: 'domcontentloaded' })
  await sleep(3500)
  const exploreList = await page.evaluate(async () => (await (await fetch('/api/explore/sources')).json()))
  const SOURCE_TRIGGER = '.explore-source-picker .ui-select-trigger[aria-label="搜索并选择发现页书源"]'
  const exploreHeader = await page.evaluate(trigger => ({
    label: document.querySelector('.explore-source-picker > span')?.textContent?.trim() ?? '',
    aria: document.querySelector(trigger)?.getAttribute('aria-label') ?? '',
    count: document.querySelector('.explore-source-count')?.textContent?.trim() ?? '',
    value: document.querySelector(`${trigger} .ui-select-value`)?.textContent?.trim() ?? '',
    hasInSourceForm: !!document.querySelector('.explore-search'),
    mentionsInSource: document.body.innerText.includes('在这个源里搜'),
  }), SOURCE_TRIGGER)
  // 措辞判据跟着框架 v2 改口（AGENTS §3 ④：判据措辞会过期，别为了刷绿删断言）：
  // 页头那行「搜书源」的小标签并进了页头条，选择口的身份现在由 aria-label 与占位文案承担，
  // 用户在意的事实没变 —— 这是一个**搜书源**的口，且总数如实报出来。
  check('发现页的选源口就是搜书源，并把可发现的源总数如实报出来',
    /书源/.test(exploreHeader.aria) && exploreHeader.count === `${exploreList.length} 个书源配了发现页`,
    `aria=${exploreHeader.aria} · ${exploreHeader.count} · 接口 ${exploreList.length}`)
  check('选源口默认就选中并回显第一个源，不是一句"请选择"',
    exploreHeader.value.length > 0 && !/加载中|请选择/.test(exploreHeader.value), exploreHeader.value)
  check('源内搜书名的表单已删干净（发现页要的是搜书源，不是重摆一遍书库搜索）',
    !exploreHeader.hasInSourceForm && !exploreHeader.mentionsInSource)

  // 换源到底有没有真的重取配置 —— 在页面里拦 fetch，不用 puppeteer 的 request 事件：
  // 这一页走到这里时已经被 Service Worker 接管，实测 puppeteer 一条请求都不报（上一轮的假红就在这儿），
  // 而要断言的是"应用自己发起了对的那个源"，拦页面自己的 fetch 才量得准。
  await page.evaluate(() => {
    if (window.__exploreSpy) return
    window.__exploreSpy = []
    const original = window.fetch
    window.fetch = (...args) => {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url ?? ''
      const match = /\/api\/sources\/([^/]+)\/explore/.exec(url)
      if (match) window.__exploreSpy.push(decodeURIComponent(match[1]))
      return original(...args)
    }
  })
  await page.click(SOURCE_TRIGGER)
  await page.waitForSelector('.ui-select-menu', { timeout: 15000 })
  await sleep(400)
  const explorePickerShape = await page.evaluate(() => ({
    hasSearch: !!document.querySelector('.ui-select-search'),
    listed: [...document.querySelectorAll('.ui-select-option')].map(node => node.querySelector('span')?.textContent?.trim() ?? ''),
    disabledLeaked: [...document.querySelectorAll('.ui-select-option')].some(node => (node.textContent ?? '').includes('已停用')),
    // 虚拟滚动的"全量"证据不是 DOM 行数（那本来就只有视口附近十几行），而是撑起来的占位高度：
    // 占位高度 / 行高 == 列表里真有的条数。截断成 200 的老写法在这里会露馅。
    listHeight: document.querySelector('.ui-select-options > div')?.getBoundingClientRect?.().height ?? 0,
  }))
  const ROW_H = 34
  const implied = Math.round(explorePickerShape.listHeight / ROW_H)
  check('源下拉一打开就自带过滤框（不是等选项变多才冒出来）', explorePickerShape.hasSearch)
  check('发现页的源下拉是"全量可滚"而不是截断一屏',
    implied === exploreList.length,
    `占位高 ${explorePickerShape.listHeight}px ≈ ${implied} 条 vs 接口 ${exploreList.length} 条 · 同帧 DOM 里 ${explorePickerShape.listed.length} 行`)
  check('虚拟滚动下同一帧只渲染视口附近若干行（全量不等于全渲染）',
    explorePickerShape.listed.length > 0 && explorePickerShape.listed.length <= 60,
    `${explorePickerShape.listed.length} 行`)
  check('发现页下拉里没有停用源', !explorePickerShape.disabledLeaked)

  // 过滤框是真能用的：拿第 30 个源的名字当关键字，选项必须收窄且全部对得上这个词
  const needleSource = exploreList[Math.min(30, exploreList.length - 1)]
  const needle = (needleSource?.name ?? '').slice(0, 4)
  if (needle) {
    await typeInto(page, '.ui-select-search', needle)
    await sleep(500)
    // 过滤按"名字 + 分组副标题"匹配（聚合源的分组名常带"番茄""笔趣"这类词），
    // 所以断言也要按这两处判，不能只盯名字，否则是被自己的实现细节假红。
    const filtered = await page.evaluate(() => [...document.querySelectorAll('.ui-select-option')]
      .map(node => ({ name: node.querySelector('span')?.textContent?.trim() ?? '', hint: node.querySelector('small')?.textContent?.trim() ?? '' })))
    check('按名字过滤能把范围收窄，且筛出来的每一项都含这个关键字',
      filtered.length > 0 && filtered.length < implied
        && filtered.every(item => item.name.includes(needle) || item.hint.includes(needle)),
      `关键字「${needle}」→ ${filtered.length} 项：${filtered.slice(0, 3).map(item => item.name).join(' / ').slice(0, 70)}`)
    // 选中它：换源必须真的按新书源重取发现页配置，而不是只把按钮文字改了
    await page.evaluate(() => document.querySelector('.ui-select-option')?.click())
    await sleep(1500)
    const pickedName = await page.evaluate(trigger => document.querySelector(`${trigger} .ui-select-value`)?.textContent?.trim() ?? '', SOURCE_TRIGGER)
    check('点选项后回显所选书源', pickedName === filtered[0]?.name, `${pickedName} ← 期望 ${filtered[0]?.name ?? ''}`)
    // 同名源可能有好几个（聚合包常见），按名字回查 id 集合，别拿"第一个同名"当唯一答案
    const wantedIds = new Set(exploreList.filter(item => item.name === pickedName).map(item => item.id))
    const askedFor = await pollUntil(
      () => page.evaluate(() => (window.__exploreSpy ?? []).slice()),
      list => list.length > 0 && wantedIds.has(list.at(-1)),
      8000, 500,
    )
    check('选中后立刻按新书源重取发现页配置（请求打到那个源的 id 上）',
      !!askedFor, `页面发起过的源 ${askedFor?.join(',') || '无'} · 「${pickedName}」的 id ${[...wantedIds].join('/')}`)
  } else {
    skip('源下拉的按名过滤与换源', '接口没返回可发现的书源，无从取关键字')
  }
  const exploreGroupHint = await page.evaluate(trigger => {
    const node = document.querySelector(trigger)
    return node ? node.getAttribute('aria-label') : ''
  }, SOURCE_TRIGGER)
  check('选源口的无障碍名点明这是"搜索并选择"，读屏用户也知道能打字',
    (exploreGroupHint ?? '').includes('搜索'), exploreGroupHint)
  await page.screenshot({ path: path.join(SHOTS, 'picker-explore-source-search.png') })

  // ── ④ 目录预览（一次全给） ──────────────────────────────────
  // 2026-10-09 起目录预览不再分水位：弹窗打开就把整份目录挂出来。逐本试前几本，
  // 别因为第一本目录短就跳过。
  const openBookWithChapters = async () => {
    const handles = await page.$$('.search-card')
    for (let index = 0; index < Math.min(7, handles.length); index++) {
      await handles[index].click()
      let toc = { rows: 0, title: '' }
      for (let tick = 0; tick < 20; tick++) {
        await sleep(1500)
        toc = await page.evaluate(() => ({
          rows: document.querySelectorAll('.preview-chapters button').length,
          title: document.querySelector('.book-detail-section-title small')?.textContent?.trim() ?? '',
        }))
        if (toc.rows > 0) break
      }
      if (toc.rows > 0) return toc
      await page.keyboard.press('Escape')
      await sleep(800)
    }
    return null
  }
  await page.goto(`${BASE}/#library`, { waitUntil: 'domcontentloaded' })
  await sleep(1500)
  await clickByText(page, '.library-scope-modes button', '全部书源')
  await typeInto(page, '.library-hero form input', '我的')
  await page.evaluate(() => document.querySelector('.library-hero form')?.requestSubmit())
  await sleep(18000)
  const toc = await openBookWithChapters()
  if (toc) {
    const total = Number(toc.title.match(/\d+/)?.[0] ?? -1)
    check('标题行交代了总数（"共 N 章"）', /共\s*\d+\s*章/.test(toc.title), toc.title)
    check('目录一次全给（行数 = 总数，没有水位）', total >= 0 && toc.rows === total, `${toc.rows} 行 · ${toc.title}`)
    const visibility = await page.evaluate(() =>
      getComputedStyle(document.querySelector('.preview-chapters button')).contentVisibility)
    check('离屏章节行不参与布局（content-visibility 生效）', visibility === 'auto', visibility)
    await page.screenshot({ path: path.join(SHOTS, 'picker-toc-expand.png') })
    await page.keyboard.press('Escape')
    await sleep(600)
  } else {
    skip('目录预览', '前几本搜索结果都没有取到目录')
  }

  // ── ⑤ 书架信息层与右键归组 ──────────────────────────────
  await page.goto(`${BASE}/#shelf`, { waitUntil: 'domcontentloaded' })
  await sleep(2500)
  const shelfCard = await page.$('.shelf-card')
  if (shelfCard) {
    await page.evaluate(() => document.querySelector('.shelf-card-cover')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await sleep(250)
    const hover = await page.evaluate(() => {
      const card = document.querySelector('.shelf-card')
      const layer = card?.querySelector('.shelf-card-hover')
      const rows = [...(card?.querySelectorAll('.shelf-card-hover dt') ?? [])].map(node => node.textContent?.trim() ?? '')
      const values = [...(card?.querySelectorAll('.shelf-card-hover dd') ?? [])].map(node => node.textContent?.trim() ?? '')
      if (!layer) return { rows, values, spillTop: 0, spillBottom: 0, hint: false }
      layer.style.opacity = '1'
      const box = layer.getBoundingClientRect()
      const kids = [...layer.children]
      return {
        rows,
        values,
        spillTop: Math.round(box.top - (kids[0]?.getBoundingClientRect().top ?? box.top)),
        spillBottom: Math.round((kids.at(-1)?.getBoundingClientRect().bottom ?? box.bottom) - box.bottom),
        hint: document.body.innerText.includes('点封面继续阅读'),
      }
    })
    check('hover 层交代进度/缓存/上次/来源', ['进度', '缓存', '上次', '来源'].every(label => hover.rows.includes(label)), hover.rows.join(' '))
    check('hover 层的值不是空的', hover.values.length >= 4 && hover.values.every(value => value.length > 0), hover.values.join(' / ').slice(0, 90))
    // 这一层是 overflow: visible，scrollHeight 量不出溢出；只能拿最后一个子元素的底边对容器底边比。
    check('hover 层的行没有溢出封面（信息加到 6 行也必须看得见）',
      hover.spillTop <= 0 && hover.spillBottom <= 0,
      `上溢 ${hover.spillTop}px · 下溢 ${hover.spillBottom}px · ${hover.rows.length} 行`)
    check('那句用不上的"点封面继续阅读…"说明已删掉', !hover.hint)
    const box = await shelfCard.boundingBox()
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
    await sleep(400)
    const menu = await page.evaluate(() => [...document.querySelectorAll('.context-menu button')].map(node => node.textContent?.trim() ?? ''))
    check('右键里有"书籍管理 / 换源 / 缓存全本"这些既有动作',
      menu.some(item => item.includes('书籍管理')) && menu.some(item => item.includes('缓存')), menu.join(' | ').slice(0, 90))
    const hasGroupItem = menu.some(item => item.startsWith('移到「'))
    if (hasGroupItem) {
      check('右键能直接归组，不必先进弹窗', hasGroupItem, menu.filter(item => item.startsWith('移到「')).join(' '))
    } else {
      skip('右键归组快捷项', '本机还没有自建分组，快捷项按设计不出现')
    }
    await page.keyboard.press('Escape')
    await page.screenshot({ path: path.join(SHOTS, 'picker-shelf-hover.png') })
  } else {
    skip('书架信息层', '书架是空的，没有卡可验')
  }

  check('全程没有页面 JS 异常', errors.length === 0, errors.slice(0, 2).join(' / '))
} finally {
  await browser.close()
}

let pass = 0
let fail = 0
let skips = 0
for (const item of results) {
  if (item.ok === true) pass++
  else if (item.ok === false) { fail++; console.log(`  FAIL ${item.name}  — ${item.detail}`) }
  else { skips++; console.log(`  SKIP ${item.name}  — ${item.detail}`) }
}
for (const item of results) if (item.ok === true) console.log(`  PASS ${item.name}  — ${item.detail}`)
console.log(`\nsource-picker-check: PASS ${pass} / FAIL ${fail} / SKIP ${skips}`)
process.exit(fail > 0 ? 1 : 0)
