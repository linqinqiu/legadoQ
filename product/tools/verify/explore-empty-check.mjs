/**
 * #41 的界面实测：发现页某一栏返回 0 本时，说的话必须分得清「缺凭据」和「真的空」。
 *
 * 这一条原来靠碰运气：它假定首屏选中的就是番茄源、并且栏目标题正好叫「番茄书架」。
 * 本机 5,574 个源全启用后，首屏落到按名字排第一的源上，于是天天假红（#55）。
 * 现在先在接口里认出番茄那个源，在**界面上**把它选上，再点那一栏；
 * 番茄没启用、没有那一栏、或那一栏其实有凭据（不是空态）时判 SKIP —— 环境不满足不是界面说谎。
 * 全程只读，不动书源启用位、不写凭据。
 */
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, SHOTS, BASE, launchOptions, acceptAgreement } from './env.mjs'

const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')
const STAMP = new Date().toISOString().replace(/\D/g, '').slice(0, 12)
const FANQIE_HOST = 'fq-book.netsite.cc'
const SHELF_TAB = '番茄书架'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

let pass = 0
let fail = 0
let skips = 0
const ok = (label, condition, detail = '') => {
  if (condition) { pass++; console.log(`  PASS ${label}${detail ? '  — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL ${label}  — ${detail || '断言不成立'}`) }
}
const skip = (label, detail) => { skips++; console.log(`  SKIP ${label}  — ${detail}`) }

/** React 受控输入：直接改 value 不触发 onChange，必须走原生 setter。 */
const typeInto = (page, selector, value) => page.evaluate((sel, text) => {
  const node = document.querySelector(sel)
  if (!node) return false
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(node, text)
  node.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}, selector, value)

const browser = await puppeteer.launch(launchOptions())
const page = await browser.newPage()
const errors = []
page.on('pageerror', e => errors.push(e.message))
await page.setViewport({ width: 1440, height: 900 })
try {
  await page.goto(`${BASE}/#explore`, { waitUntil: 'domcontentloaded' })
  // 首次协议浮层会挡住真鼠标点击；先标记已同意（见 env.mjs 的 acceptAgreement）
  await acceptAgreement(page)
  await page.waitForSelector('.explore-page', { timeout: 40000 })
  await sleep(2500)

  const availability = await page.evaluate(async host => {
    const list = await (await fetch('/api/explore/sources')).json()
    const hit = list.find(item => String(item.id ?? item.url ?? '').includes(host))
    return { total: list.length, id: hit?.id ?? null, name: hit?.name ?? null }
  }, FANQIE_HOST)

  if (!availability.id) {
    skip('番茄源的发现页在位', `可发现的书源 ${availability.total} 个里没有 ${FANQIE_HOST}（本机没启用它，或它没配 exploreUrl）`)
  } else {
    // 发现页上有**两个** Select：左边「按分组筛选」（`.explore-group-select`），
    // 右边「搜索并选择发现页书源」。原来这里点的是 `.explore-source-picker .ui-select-trigger`，
    // 那是**第一个**命中 —— 分组选择器。于是搜索词填进分组框，源选项列表自然为空
    // （实测候选 []），判据报"选不到番茄源"。
    // 用 ariaLabel 精确点源选择器，不靠"第几个"。
    const sourceTrigger = '.explore-source-picker .ui-select:not(.explore-group-select) .ui-select-trigger'
    const hasTrigger = await page.$(sourceTrigger)
    if (!hasTrigger) skip('界面上能选到番茄源', '找不到「搜索并选择发现页书源」那个选择器')
    else {
      await page.click(sourceTrigger)
      await page.waitForSelector('.ui-select-menu', { timeout: 20000 })
      // 搜索词用稳定的「番茄」，不用接口返回的完整 name ——
      // 那个名字可能带 emoji / 换行 / 更新地址，填进搜索框反而一个都匹配不上。
      await typeInto(page, '.ui-select-search', '番茄')
      await sleep(900)
      // 按**名字**逐字匹配太脆：书源名里可能带 emoji、换行，甚至把更新地址拼进去
      // （实测「番茄听书（优++）」这个名字里就带着两行 URL）。
      // 这条判据要证明的是"选源控件能把番茄源选出来"，不是"名字必须逐字相等"。
      const picked = await page.evaluate(name => {
        const options = [...document.querySelectorAll('.ui-select-option')]
        const labelOf = item => item.querySelector('span')?.textContent?.trim() ?? item.textContent?.trim() ?? ''
        const exact = options.find(item => labelOf(item) === name)
        if (exact) { exact.click(); return { ok: true, how: '逐字' } }
        const loose = options.find(item => /番茄|🍅/.test(labelOf(item)))
        if (loose) { loose.click(); return { ok: true, how: '含番茄', picked: labelOf(loose).slice(0, 30) } }
        return { ok: false, how: '没找到', options: options.slice(0, 8).map(labelOf) }
      }, availability.name)
      ok('界面上能选到番茄源（发现页的选源控件按名字找得到它）', picked.ok,
        picked.ok
          ? `${availability.name}（${picked.how}${picked.picked ? '：' + picked.picked : ''}）`
          : `找不到 · 候选 ${JSON.stringify(picked.options)}`)
      await sleep(9000)
    }

    const clicked = await page.evaluate(label => {
      const nodes = [...document.querySelectorAll('.explore-tab')]
      const shelf = nodes.find(node => node.textContent?.includes(label))
      if (!shelf) return { found: false, names: nodes.slice(0, 14).map(node => node.textContent?.trim() ?? '') }
      shelf.click()
      return { found: true, name: shelf.textContent?.trim() ?? '' }
    }, SHELF_TAB)

    if (!clicked.found) {
      skip(`点得到「${SHELF_TAB}」这一栏`, `该书源的发现页里没有这栏：${JSON.stringify(clicked.names).slice(0, 170)}`)
    } else {
      ok(`点得到「${SHELF_TAB}」这一栏`, true, clicked.name)

      // 先问接口：这一栏的地址在注册域上到底有没有凭据 —— 这是"界面上那句话该是哪句"的判据
      const truth = await page.evaluate(async (id, label) => {
        const tabs = await (await fetch(`/api/sources/${encodeURIComponent(id)}/explore`)).json().catch(() => [])
        const shelf = (tabs ?? []).find(item => item.title === label)
        if (!shelf?.url?.startsWith('http')) return { state: 'no-http', detail: shelf?.url ?? '(取不到栏目地址)' }
        const res = await (await fetch(`/api/sources/${encodeURIComponent(id)}/credential?u=${encodeURIComponent(shelf.url)}`)).json().catch(() => null)
        return { state: res?.has ? 'has-credential' : 'missing-credential', domain: res?.domain ?? '', url: shelf.url }
      }, availability.id, SHELF_TAB)

      let message = ''
      for (let tick = 0; tick < 30; tick++) {
        await sleep(1000)
        message = await page.evaluate(() => {
          const texts = [...document.querySelectorAll('p, div, span')].map(node => node.textContent?.trim() ?? '')
          return texts.find(text => /这一栏|这个分栏/.test(text) && text.length < 220) ?? ''
        })
        if (message) break
      }
      await page.screenshot({ path: path.join(SHOTS, `explore-empty-${STAMP}.png`) })

      if (truth.state === 'missing-credential') {
        ok('空栏说出了真实原因（缺凭据，不是"换一个试试"）',
          /需要登录/.test(message) && message.includes(truth.domain), message || '(没读到提示文案)')
        ok('没有把"已有凭据"的情况误报成要登录', !/换一个试试/.test(message), `凭据域=${truth.domain}`)
      } else if (truth.state === 'has-credential') {
        ok('已有凭据时这一栏不再喊"还没有凭据"', !/还没有凭据/.test(message),
          message.slice(0, 130) || `有凭据：${truth.domain}`)
      } else {
        skip('空栏文案的口径', truth.detail)
      }
    }
  }
  ok('全程没有页面异常', errors.length === 0, errors.slice(0, 2).join(' / '))
} finally {
  await browser.close()
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败${skips ? ` / ${skips} 跳过` : ''}  ·  截图 out/shots/explore-empty-${STAMP}.png`)
if (fail > 0) process.exitCode = 1
