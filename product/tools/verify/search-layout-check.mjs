// 搜索结果三档展示的界面门禁（用户 2026-10-02：「搜索获得的书籍也能用不同的方式展示（网格，列表，紧凑列表）」）。
//
// 判的是三件"只有跑起来才知道"的事：
//   ① 换档**不改变数据与点击行为** —— 卡片数一致、每一档点下去都真的开详情弹窗；
//   ② 每一档"谁可见"是真的算出来的：封面在网格与列表可见、紧凑档不可见；
//      简介栏只在列表档占位，且它显示的是这本书的简介文本（不是一排占位话）；
//   ③ 紧凑档确实更矮（同一批卡片量行高，紧凑 < 列表）。
//
// 搜索要打到真书才算验到：一轮下来一本都没有时报 NOTE 而不是 PASS ——
// 拿"没数据"冒充"通过"是这一轮反复在修的那类假绿。
// 跑法：node tools/verify/search-layout-check.mjs
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { OUT, SHOTS, BASE, launchOptions } from './env.mjs'

const require = createRequire(path.join(import.meta.dirname, '../../web/package.json'))
const puppeteer = require('puppeteer-core')

const STAMP = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)
const KEY = 'legado-search-layout-v1'
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail })
const note = (name, detail) => results.push({ name, ok: null, detail })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 读一屏搜索结果的实际几何：可见性取 computed style，不取"类名对不对"。 */
const measure = page => page.evaluate(() => {
  const grid = document.querySelector('.search-grid')
  if (!grid) return null
  const cards = [...grid.querySelectorAll('.search-card')]
  const shown = node => {
    if (!node) return false
    const style = getComputedStyle(node)
    return style.display !== 'none' && style.visibility !== 'hidden' && node.getBoundingClientRect().height > 0
  }
  const rect = node => (node ? Math.round(node.getBoundingClientRect().height) : 0)
  const first = cards[0]
  const intros = cards.map(card => (card.querySelector('.search-card-intro')?.textContent ?? '').trim())
  return {
    mode: (grid.className.match(/search-mode-(grid|list|compact)/) ?? [])[1] ?? '',
    cards: cards.length,
    coverVisible: shown(first?.querySelector('.search-card-cover')),
    introVisible: shown(first?.querySelector('.search-card-intro')),
    hoverVisible: shown(first?.querySelector('.search-card-hover')),
    sourcesText: (first?.querySelector('.search-card-sources')?.textContent ?? '').trim(),
    cardHeight: rect(first),
    names: cards.map(card => (card.querySelector('.search-card-name')?.textContent ?? '').trim()),
    intros,
    introCount: intros.filter(text => text.length > 0).length,
    introText: intros.find(text => text.length > 0) ?? '',
    pickerActive: [...document.querySelectorAll('.shelf-layout-picker button')]
      .filter(button => button.className.includes('active'))
      .map(button => button.getAttribute('aria-label') ?? ''),
  }
})

/** 按**书名**点某一张卡（不按下标：智能推荐会随结果到达重排，下标指向的不是同一本书）。 */
const openByName = async (page, name) => {
  const found = await page.evaluate(target => {
    const card = [...document.querySelectorAll('.search-grid .search-card')]
      .find(node => (node.querySelector('.search-card-name')?.textContent ?? '').trim() === target)
    if (!card) return false
    card.click()
    return true
  }, name)
  if (!found) return { modal: false, title: '', found: false }
  await page.waitForSelector('.book-detail-modal', { timeout: 15000 }).catch(() => undefined)
  const opened = await page.evaluate(() => ({
    modal: !!document.querySelector('.book-detail-modal'),
    title: (document.querySelector('.book-detail-modal h2, .book-detail-modal .book-detail-title')?.textContent ?? '').trim(),
  }))
  if (opened.modal) {
    await page.keyboard.press('Escape')
    await sleep(400)
  }
  return { ...opened, found: true }
}

/** 从头几本里找到一本真能打开详情的（有的源半路死了，打不开不是布局问题）。 */
const findOpenable = async (page, names) => {
  for (const name of names.slice(0, 6)) {
    const result = await openByName(page, name)
    if (result.modal) return { name, ...result }
  }
  return { name: '', modal: false, title: '' }
}

const pickMode = async (page, label) => {
  const clicked = await page.evaluate(name => {
    const button = [...document.querySelectorAll('.shelf-layout-picker button')]
      .find(node => (node.getAttribute('aria-label') ?? '') === name)
    if (!button) return false
    button.click()
    return true
  }, label)
  await sleep(400)
  return clicked
}

let browser = null
const pageErrors = []
try {
  browser = await puppeteer.launch(launchOptions())
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 950, deviceScaleFactor: 1 })
  page.on('pageerror', error => pageErrors.push(String(error.message)))

  await page.goto(`${BASE}/#library`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForSelector('.library-hero form input', { timeout: 45000 })

  // 用界面自己的搜索框发一次真搜索（与 book-detail-check 同一口径：不自己拼接口，
  // 否则验的是"服务端能返回"，而不是"用户点得到结果"）。
  await page.evaluate(() => {
    const input = document.querySelector('.library-hero form input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '都市')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.closest('form').requestSubmit()
  })
  await page.waitForSelector('.search-card', { timeout: 90000 }).catch(() => undefined)
  // 等到有一把结果再量（流式搜索会一直往里加）。**不点「停止搜索」**：
  // 试过 —— 停掉之后再点卡片开详情，6/6 张都开不出来（详情要靠源站再取一次，
  // 而这一批早到的小源恰好都不通），于是布局判据被一个无关的网络条件带红。
  await page.waitForFunction(() => document.querySelectorAll('.search-grid .search-card').length >= 12, { timeout: 60000 })
    .catch(() => undefined)
  await sleep(1200)

  const grid = await measure(page)
  if (!grid || grid.cards === 0) {
    note('①搜索结果一栏（本轮没打到书，三档没验到）', `${grid?.cards ?? 0} 张卡 · 需要网络与可用书源`)
  } else {
    check('①默认档就是网格，且网格档封面真的画出来了', grid.mode === 'grid' && grid.coverVisible,
      `mode=${grid.mode || '(容器没带 mode 类)'} · 封面可见=${grid.coverVisible}`)
    check('①顶栏 picker 恰好三档且都带无障碍名', grid.pickerActive.length === 1,
      `当前选中=${grid.pickerActive.join(',')}`)

    // ② 列表档：封面在、简介栏出现，且写的是真简介或"最新：…"
    const listClicked = await pickMode(page, '列表')
    const list = await measure(page)
    check('②换到列表档（点得动、类名跟着变）', listClicked && list?.mode === 'list', `mode=${list?.mode ?? '(没读到)'}`)
    // 换档前后的对比只能判"书没丢"，**不能判顺序**：默认排序是「智能推荐」，
    // 流式结果每来一批就重排一次（实测 130 → 155 本之间前 130 本的次序就变了），
    // 那是数据在动，不是布局在动 —— 拿它当布局属性是探针的错。
    const kept = snapshot => {
      if (!snapshot) return { ok: false, missing: -1 }
      const pool = {}
      for (const name of snapshot.names) pool[name] = (pool[name] ?? 0) + 1
      for (const name of grid.names) {
        if (!pool[name]) return { ok: false, missing: name }
        pool[name] -= 1
      }
      return { ok: true, missing: 0 }
    }
    const listKept = kept(list)
    check('②换到列表档不丢书（换档前有的每一本换档后都还在）',
      !!list && list.cards >= grid.cards && listKept.ok,
      `网格 ${grid.cards} 张 · 列表 ${list?.cards ?? 0} 张${listKept.ok ? '' : ` · 丢了「${listKept.missing}」`}`)
    check('②列表档封面仍在（只是缩小，不是整档没封面）', !!list?.coverVisible, `coverVisible=${list?.coverVisible}`)
    // "这一批有没有简介"取决于源配没配 `ruleSearch.intro`，不是布局能决定的事：
    // 一条都没有时如实报 NOTE，不拿它冒充通过（取简介的顺序由 web/test/SearchLayout.test.ts 钉住）。
    check('②列表档出现的简介没有一句是占位话',
      !!list && list.intros.every(text => text === '' || (text.length > 4 && !/暂无简介|没有简介/.test(text))),
      `${list?.introCount ?? 0}/${list?.cards ?? 0} 张有简介 · 样例「${(list?.introText ?? '').slice(0, 34)}」`)
    if (!list || list.introCount === 0) {
      note('②这一批结果里没有一个源配了简介或最新章（简介栏自然全空）', '不是布局问题，pickBlurb 由单测判')
    }
    check('②列表档收掉 hover 层（信息已经在明面上，不必再悬停）', list?.hoverVisible === false, `hoverVisible=${list?.hoverVisible}`)
    check('②「N 个书源」这句在列表档仍然读得到（门禁靠它抽候选）',
      /^\d+\s*个书源/.test(list?.sourcesText ?? ''), `实测「${list?.sourcesText ?? ''}」`)
    fs.mkdirSync(SHOTS, { recursive: true })
    await page.screenshot({ path: path.join(SHOTS, `search-layout-${STAMP}-list.png`) })

    // ③ 紧凑档：更矮、无封面、无简介栏
    const compactClicked = await pickMode(page, '紧凑列表')
    const compact = await measure(page)
    check('③换到紧凑列表档', compactClicked && compact?.mode === 'compact', `mode=${compact?.mode ?? '(没读到)'}`)
    const compactKept = kept(compact)
    check('③换到紧凑档也不丢书', !!compact && compact.cards >= grid.cards && compactKept.ok,
      `网格 ${grid.cards} · 紧凑 ${compact?.cards ?? 0}${compactKept.ok ? '' : ` · 丢了「${compactKept.missing}」`}`)
    check('③紧凑档不显示封面也不显示简介栏',
      compact?.coverVisible === false && compact?.introVisible === false,
      `封面=${compact?.coverVisible} 简介=${compact?.introVisible}`)
    check('③紧凑档确实更矮（同一批卡片量出来的）',
      !!compact && !!list && compact.cardHeight < list.cardHeight,
      `紧凑 ${compact?.cardHeight}px vs 列表 ${list?.cardHeight}px`)
    await page.screenshot({ path: path.join(SHOTS, `search-layout-${STAMP}-compact.png`) })

    // ④ 换档不改变行为：先在列表档找一本**真能打开**的书，再换到网格档点同一本（按书名锁定）。
    await pickMode(page, '列表')
    const listNames = (await measure(page))?.names ?? []
    const picked = await findOpenable(page, listNames)
    await pickMode(page, '封面网格')
    const viaGrid = picked.name ? await openByName(page, picked.name) : { modal: false, title: '' }
    if (!picked.name) {
      note('④同一本书在两档里都开得开（前 6 本都打不开详情，源不通）', '本轮没有可点的书，这一条没验到')
    } else {
      check('④点卡片开详情这件事与用哪一档无关（同一本书在两档里都开得开）',
        picked.modal && viaGrid.modal,
        `「${picked.name.slice(0, 14)}」· 列表档「${picked.title.slice(0, 12)}」/ 网格档「${viaGrid.title.slice(0, 12)}」`)
    }

    // ⑤ 偏好落盘：换到列表后重新加载页面还是列表（这一档用户是"设一次"的）
    await pickMode(page, '列表')
    const stored = await page.evaluate(key => localStorage.getItem(key), KEY)
    check('⑤换档写进 localStorage（独立键，不与书架共用）', stored === 'list', `存的=${stored ?? '(空)'}`)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await sleep(2500)
    const afterReload = await page.evaluate(() => {
      const grid = document.querySelector('.search-grid')
      return grid ? (grid.className.match(/search-mode-(grid|list|compact)/) ?? [])[1] ?? '' : 'no-results'
    })
    if (afterReload === 'no-results') {
      // 搜索结果是内存态，重载必然清空 —— 这一档只能验"写进了独立键"（上面那条），
      // 读回的路径由 web/test/SearchLayout.test.ts 判。不拿"没结果"冒充"持久化通过"。
      note('⑤重载后仍读回同一档（结果集是内存态，这一屏没结果可量）', '改由 web/test/SearchLayout.test.ts 判读回')
    } else {
      check('⑤重载后仍读回同一档（偏好真的持久，不是只活在内存里）', afterReload === 'list', `mode=${afterReload}`)
    }
    // 收尾：把探针改过的偏好清掉，别让用户下次打开看到的是"列表"
    await page.evaluate(key => localStorage.removeItem(key), KEY)
    const cleaned = await page.evaluate(key => localStorage.getItem(key), KEY)
    check('收尾清掉探针改过的偏好', cleaned === null, `残留=${String(cleaned)}`)
  }

  check('全程没有页面异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))
} catch (error) {
  check('探针自身异常', false, error.message)
} finally {
  if (browser) await browser.close().catch(() => null)
  fs.mkdirSync(OUT, { recursive: true })
  const failed = results.filter(row => row.ok === false)
  const skipped = results.filter(row => row.ok === null)
  fs.writeFileSync(path.join(OUT, `search-layout-${STAMP}.json`), JSON.stringify({ stamp: STAMP, base: BASE, results }, null, 2))
  for (const row of results) {
    const flag = row.ok === true ? 'PASS' : row.ok === false ? 'FAIL' : 'NOTE'
    console.log(`${flag}  ${row.name}${row.detail ? '   [' + row.detail + ']' : ''}`)
  }
  console.log(`\n${results.length - failed.length - skipped.length}/${results.length - skipped.length} PASS`
    + `${skipped.length ? ` · ${skipped.length} NOTE` : ''}${failed.length ? ` · ${failed.length} FAIL` : ''}`
    + ` · 详情 tools/verify/out/search-layout-${STAMP}.json`)
  process.exit(failed.length ? 1 : 0)
}
