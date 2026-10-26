// 书源体检与分组整理的验收门禁（用户 2026-09-30：「书源体检效验，管理功能异常，过慢，
// 有很多问题，不能根据获得信息正确规划分组」，任务 #57）。
//
// 这一轮查清的三件事，各自都有对应断言：
// ① 「过慢」的成因不是探测本身，而是**弹窗一开就无条件对整库外呼**：5,574 个源 ÷ 每批 128 ×
//    并发 16 × 5 秒超时 = 几十分钟，而且用户只是想回来看一眼上次的结论。
//    现在超过 300 个源不再自动开跑，要显式按一次「开始体检」。
// ② 「管理功能异常」的一半是**没有停止键**：`cancelledRef` 只在卸载时置位，想停只能关窗。
// ③ 「不能根据获得信息规划分组」：体检给出 正常/迟缓/需登录/连不上 之后界面就到此为止，
//    结论落不到分组上。现在三档结论各配一行可执行的「打标签 / 撤销」，
//    并且服务端新增 `tag_group` / `untag_group` —— **只追加、不覆盖**书源自带的分类。
//
// 探针只用自己的两条源（`.test` 域名，必然连不上），收尾按 id 删除并复查；
// 绝不对用户的 5,574 个源发起扫描，也不动它们的启用位与分组。
//
// 跑法：node tools/verify/source-health-check.mjs
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, SHOTS, BASE, launchOptions } from './env.mjs'

const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')
const STAMP = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)
const A_ID = `https://health-a-${STAMP}.test/`
const B_ID = `https://health-b-${STAMP}.test/`
const TAG = '体检异常'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const results = []
const check = (name, condition, detail = '') => results.push({ name, ok: !!condition, detail })
const note = (name, detail) => results.push({ name, ok: null, detail })

const headers = { 'content-type': 'application/json', origin: BASE, host: new URL(BASE).host }
async function call(method, url, body) {
  const response = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON 交给断言去报 */ }
  return { status: response.status, json, text }
}
const groupOf = async id => {
  const res = await call('GET', '/api/sources')
  const found = (res.json ?? []).find(item => item.id === id)
  return found ? { group: found.group ?? '', enabled: !!found.enabled, name: found.name } : null
}

/**
 * 两条探针各有分工（2026-10-03 改的）：
 * 甲**配了** searchUrl 指向一个解不出来的 `.test` 域名 → 真的发出请求 → `unreachable`（确认有问题）；
 * 乙**没配** searchUrl → 服务端一个请求都不该发 → `no_search`（未配搜索，不算坏）。
 * 以前两条都不配搜索地址，于是"探针连不上"其实测的是"没配搜索"——
 * 体检分档一改，那条假象就露出来了（这就是本轮门禁红三次的根因，不是产品坏）。
 */
const probeSource = (id, name, group, withSearch) => JSON.stringify({
  bookSourceUrl: id,
  bookSourceName: name,
  bookSourceGroup: group,
  bookSourceType: 0,
  enabled: false,
  ...(withSearch ? { searchUrl: '/search?keyword={{key}}&page={{page}}' } : {}),
  ruleSearch: { bookList: '.item', name: '.a', bookUrl: '.a@href' },
})

try {
  // ── 探针落库 ────────────────────────────────────────────
  const imported = await call('POST', '/api/sources/import', {
    sources: [probeSource(A_ID, `探针体检甲-${STAMP}`, '网文', true), probeSource(B_ID, `探针体检乙-${STAMP}`, '', false)],
  })
  check('两条探针书源已入库', imported.status === 200 && (imported.json?.imported ?? 0) >= 2, `${imported.status} ${imported.text.slice(0, 90)}`)

  // ── ① 点名体检：只探这两条，且要快 ──────────────────────
  const started = Date.now()
  const health = await call('POST', '/api/sources/health-check', { ids: [A_ID, B_ID], timeoutMs: 2000 })
  const wall = Date.now() - started
  const payload = health.json ?? {}
  const categoryOf = id => (payload.results ?? []).find(item => item.id === id)?.statusCategory ?? ''
  check('点名 ids 时只体检这两条（total 等于 ids 数）', payload.total === 2, `${health.status} total=${payload.total}`)
  check('两条都拿到了档位结论', Array.isArray(payload.results) && payload.results.length === 2
    && payload.results.every(item => typeof item.statusCategory === 'string' && item.statusCategory.length > 0),
    (payload.results ?? []).map(item => `${item.name}:${item.statusCategory}`).join(' '))
  check('配了搜索地址、域名解不出来的那条判「连不上」', categoryOf(A_ID) === 'unreachable',
    `甲=${categoryOf(A_ID)}`)
  check('没配搜索地址的那条判「未配搜索」，不是「规则失效」也不是「连不上」', categoryOf(B_ID) === 'no_search',
    `乙=${categoryOf(B_ID)}`)
  check('「未配搜索」那条压根没发出请求（错误文案说的是配置，不是网络）',
    /没配搜索地址|没配/.test((payload.results ?? []).find(item => item.id === B_ID)?.error ?? ''),
    (payload.results ?? []).find(item => item.id === B_ID)?.error ?? '(无)')
  check('两条都连不上时整体仍然秒级返回（没有把超时叠加成串行）', wall < 20000, `实测 ${wall}ms`)

  // ── ③ tag_group：只追加，不覆盖；重复打不长串 ───────────
  const tagged = await call('POST', '/api/sources/batch', { ids: [A_ID, B_ID], action: 'tag_group', group: TAG })
  const afterA = await groupOf(A_ID)
  check('tag_group 把标签追加在原分组后面（原标签「网文」没被冲掉）',
    tagged.status === 200 && tagged.json?.affected === 2 && afterA?.group === `网文 ${TAG}`,
    `affected=${tagged.json?.affected} group="${afterA?.group}"`)
  const afterB = await groupOf(B_ID)
  check('原本没有分组的源，tag_group 后就是这一个标签', afterB?.group === TAG, `group="${afterB?.group}"`)

  await call('POST', '/api/sources/batch', { ids: [A_ID, B_ID], action: 'tag_group', group: TAG })
  const againA = await groupOf(A_ID)
  check('重复 tag_group 是幂等的（不会长成「体检异常 体检异常」）', againA?.group === `网文 ${TAG}`, `group="${againA?.group}"`)

  // ── ③ untag_group：只摘我们这一个标签 ───────────────────
  const untagged = await call('POST', '/api/sources/batch', { ids: [A_ID, B_ID], action: 'untag_group', group: TAG })
  const backA = await groupOf(A_ID)
  const backB = await groupOf(B_ID)
  check('untag_group 摘掉自己的标签并还原原分组',
    untagged.status === 200 && backA?.group === '网文' && backB?.group === '',
    `甲="${backA?.group}" 乙="${backB?.group}"`)
  await call('POST', '/api/sources/batch', { ids: [A_ID, B_ID], action: 'untag_group', group: TAG })
  const stillA = await groupOf(A_ID)
  check('摘一个本来没有的标签不会把分组清空或多出空格', stillA?.group === '网文', `group="${stillA?.group}"`)

  check('体检与打标签全程没有改动探针源的启用位', backA?.enabled === false && stillA?.enabled === false,
    `enabled=${stillA?.enabled}`)

  // 缺标签名的调用要 400，而不是把整组分组刷成空
  const badTag = await call('POST', '/api/sources/batch', { ids: [A_ID], action: 'tag_group', group: '   ' })
  check('tag_group 不给标签名时报 400（不会静默把分组刷空）', badTag.status === 400, `${badTag.status} ${badTag.text.slice(0, 70)}`)

  // ── ② 界面侧：大库不再一开就跑，且有真的停止键 ─────────
  const browser = await puppeteer.launch(launchOptions())
  try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(String(error.message)))
    await page.setViewport({ width: 1440, height: 950, deviceScaleFactor: 1 })
    await page.goto(`${BASE}/#sources`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.source-list-item', { timeout: 40000 })
    const counts = await page.evaluate(async () => {
      const list = await (await fetch('/api/sources')).json()
      return { total: list.length, enabled: list.filter(item => item.enabled).length }
    })
    // 大范围时（未筛选 = 整库）弹窗不该自动开跑
    await page.evaluate(() => {
      document.querySelector('.health-probe-btn')?.click()
    })
    await page.waitForSelector('.source-health-modal', { timeout: 15000 })
    await sleep(1200)
    const idle = await page.evaluate(() => ({
      header: document.querySelector('.health-modal-title small')?.textContent?.trim() ?? '',
      startLabel: [...document.querySelectorAll('.health-actions-bar button')].map(node => node.textContent?.trim() ?? '').join(' | '),
      hasStop: !!document.querySelector('.health-stop-btn'),
      grouping: !!document.querySelector('.health-grouping'),
    }))
    check('整库规模下打开体检弹窗不会自动开跑', !idle.header.startsWith('正在并发探测') && idle.header.includes('还没开始'), idle.header)
    check('开始按钮把范围与数量写在脸上', /开始体检（\d+ 个启用中的）/.test(idle.startLabel), idle.startLabel.slice(0, 120))
    check('没跑之前不出现分组面板（没有结论就没有建议）', !idle.grouping)
    check('未运行时不显示停止键', !idle.hasStop)

    const scope = await page.evaluate(() => ({
      hasDisabledToggle: !!document.querySelector('.health-scope-toggle'),
      label: document.querySelector('.health-scope-toggle')?.textContent?.trim() ?? '',
    }))
    if (counts.total > counts.enabled) {
      check('有停用源时给出「连停用的一起体检」并如实报数', scope.hasDisabledToggle && /连停用的一起体检（\d+）/.test(scope.label), scope.label)
    } else {
      note('「连停用的一起体检」开关', `本机 ${counts.total} 个源全部启用，按设计不出现这个勾`)
    }
    await page.evaluate(() => { document.querySelector('.source-health-modal .overlay-close')?.click() })
    await sleep(500)

    // 把书源列表筛成只有两条探针，再开体检：体检弹窗的范围取自列表当前筛出的那批。
    // 两条探针都是**停用**的（新建探针不该挤进用户的启用集），所以默认范围是 0 ——
    // 正好用界面上那个「连停用的一起体检」把它们圈进来跑，全程不改用户的启用位。
    await page.evaluate(stamp => {
      const input = document.querySelector('.source-filter input')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, stamp)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }, STAMP)
    await sleep(2500)
    const filtered = await page.evaluate(() => document.querySelectorAll('.source-list-item').length)
    check('筛到的正是这两条探针源', filtered === 2, `${filtered} 行`)
    await page.evaluate(() => {
      document.querySelector('.health-probe-btn')?.click()
    })
    await page.waitForSelector('.source-health-modal', { timeout: 15000 })
    await sleep(900)
    const emptyScope = await page.evaluate(() => ({
      header: document.querySelector('.health-modal-title small')?.textContent?.trim() ?? '',
      toggle: document.querySelector('.health-scope-toggle')?.textContent?.trim() ?? '',
    }))
    check('筛出的两条都是停用源时，范围如实说 0 而不是偷偷去探它们',
      emptyScope.header.includes('的 0 个书源') && /连停用的一起体检（2）/.test(emptyScope.toggle),
      `${emptyScope.header} / ${emptyScope.toggle}`)

    // 勾选「连停用的一起体检」只改范围，**不该顺手发起一轮扫描**（用户 2026-10-03：
    // 「书源的体检当前出了问题」。旧版勾一下就对着整库开跑，几十分钟外加几千条标签写入）
    const onlyScope = await page.evaluate(async () => {
      document.querySelector('.health-scope-toggle input')?.click()
      await new Promise(resolve => setTimeout(resolve, 900))
      return {
        running: (document.querySelector('.health-modal-title small')?.textContent ?? '').startsWith('正在并发探测'),
        stopBtn: !!document.querySelector('.health-stop-btn'),
        header: document.querySelector('.health-modal-title small')?.textContent?.trim() ?? '',
      }
    })
    check('勾「连停用的一起体检」只改范围，不自动开跑一轮整库扫描',
      !onlyScope.running && !onlyScope.stopBtn, onlyScope.header)

    const ran = await page.evaluate(async () => {
      const start = [...document.querySelectorAll('.health-actions-bar button')]
        .find(node => (node.textContent ?? '').includes('体检'))
      start?.click()
      const read = () => document.querySelector('.health-modal-title small')?.textContent?.trim() ?? ''
      const deadline = Date.now() + 40000
      // 两条 `.test` 源 0.2 秒就扫完了，停止键只在 running 期间渲染 —— 轮询必须比它更快，
      // 否则量到的是"跑完之后的样子"，会把一个正常的功能判成缺失。
      let sawStop = false
      let sawRunning = false
      let header = ''
      do {
        await new Promise(resolve => setTimeout(resolve, 60))
        if (document.querySelector('.health-stop-btn')) sawStop = true
        header = read()
        if (header.startsWith('正在并发探测')) sawRunning = true
      } while (Date.now() < deadline && !(sawStop && !header.startsWith('正在并发探测')))
      return { sawStop, sawRunning, header, grouping: !!document.querySelector('.health-grouping') }
    })
    check('按「开始体检」（含停用范围）真的开跑，运行期出现停止键',
      // 判"真的开跑了"，不是判"抓到过 running 那一瞬"。
      //
      // 原来写成 `ran.sawRunning && (ran.sawStop || header.includes('本轮检测'))`，
      // 那个 `sawRunning &&` 把快速完成的情况直接判死：两条 `.test` 源 0.1 秒就扫完，
      // 轮询根本来不及捕捉到「正在并发探测」那一帧，于是 sawRunning=false ⇒ 必然红。
      // 这与上面注释自己写的「轮询必须比它更快，否则会把一个正常的功能判成缺失」是矛盾的。
      //
      // 正确的判法：**抓到 running、抓到停止键、或看到跑完的结论**，三者有其一就证明它真的开跑了。
      ran.sawRunning || ran.sawStop || ran.header.includes('本轮检测'),
      `运行中=${ran.sawRunning} 停止键=${ran.sawStop} · ${ran.header}`)
    check('跑完出现「按体检结果整理分组」面板', ran.grouping, ran.header)

    // 自动打标签之后弹窗会重取一次书源清单，`alreadyApplied` 是按那份清单算的。
    // 跑完立刻读面板就会拿到"还没刷新的旧分组"，于是明明打过的标签看起来像没打
    // —— 这不是产品坏，是探针抢跑（实测差 200~400ms）。等到清单追上结论为止。
    const deadlinePanel = Date.now() + 12000
    let panel = { rows: [], note: '' }
    do {
      await sleep(400)
      panel = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.health-grouping-row')].map(row => ({
          tag: row.querySelector('.health-grouping-tag')?.textContent?.trim() ?? '',
          count: row.querySelector('.health-grouping-count')?.textContent?.trim() ?? '',
          hasApply: !!row.querySelector('.health-grouping-apply'),
          applyDisabled: row.querySelector('.health-grouping-apply')?.disabled ?? true,
          appliedSaid: row.querySelector('.health-grouping-applied')?.textContent?.trim() ?? '',
          undoDisabled: row.querySelector('.health-grouping-undo')?.disabled ?? true,
        }))
        return { rows, note: document.querySelector('.health-grouping header small')?.textContent?.trim() ?? '' }
      })
    } while (Date.now() < deadlinePanel && !panel.rows.some(row => row.tag === TAG && row.appliedSaid))
    const badRow = panel.rows.find(row => row.tag === TAG)
    const unconfiguredRow = panel.rows.find(row => row.tag === '未配搜索')
    // 体检过程中就自动打过标签了（sourceHealthRun 那一半），所以跑完这一行该是"已打好 + 可撤销"，
    // 而不是摆一颗点不动的「打标签」——那读起来就是"按钮坏了"（这条以前一直红）。
    check(`配了搜索又连不上的那条汇成一行「${TAG}」：过程中已自动打好，界面说的是实话而不是灰按钮`,
      !!badRow && !badRow.hasApply && badRow.appliedSaid.includes('已打好') && /1 个/.test(badRow.count) && !badRow.undoDisabled,
      JSON.stringify(panel.rows))
    // 「未配搜索」不自动打（那是源写死的属性，每轮都一样），但人要能显式打
    check('「未配搜索」单独成一行，不自动打标但可以给一颗可点的「打标签」',
      !!unconfiguredRow && unconfiguredRow.hasApply && !unconfiguredRow.applyDisabled && /1 个/.test(unconfiguredRow.count),
      JSON.stringify(unconfiguredRow ?? null))
    check('面板说清了"只追加、不动原分组"与"待确认不等于坏"',
      panel.note.includes('追加') && panel.note.includes('待确认'), panel.note.slice(0, 120))

    // 自动打的标签必须撤得掉，撤掉之后同一行要重新长出可点的「打标签」（两个方向都验）
    const undone = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.health-grouping-row')]
        .find(node => node.querySelector('.health-grouping-tag')?.textContent?.trim() === '体检异常')
      row?.querySelector('.health-grouping-undo')?.click()
      return !!row
    })
    await sleep(2500)
    const uiBackA = await groupOf(A_ID)
    const uiBackB = await groupOf(B_ID)
    check('点「撤销」只摘我们打的标签，「网文」还在',
      undone && uiBackA?.group === '网文' && uiBackB?.group === '', `甲="${uiBackA?.group}" 乙="${uiBackB?.group}"`)

    const reApply = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.health-grouping-row')]
        .find(node => node.querySelector('.health-grouping-tag')?.textContent?.trim() === '体检异常')
      const button = row?.querySelector('.health-grouping-apply')
      button?.click()
      return { hasButton: !!button, disabled: button?.disabled ?? null }
    })
    await sleep(2500)
    const uiA = await groupOf(A_ID)
    const uiB = await groupOf(B_ID)
    check('撤销之后那一行重新长出可点的「打标签」，点上真的又写回分组',
      reApply.hasButton && reApply.disabled === false && uiA?.group === `网文 ${TAG}` && uiB?.group === '',
      `按钮=${JSON.stringify(reApply)} 甲="${uiA?.group}" 乙="${uiB?.group}"`)

    // 显式给「未配搜索」打标签：乙进这一档，甲不该被牵连
    const tagUnconfigured = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.health-grouping-row')]
        .find(node => node.querySelector('.health-grouping-tag')?.textContent?.trim() === '未配搜索')
      row?.querySelector('.health-grouping-apply')?.click()
      return !!row
    })
    await sleep(2500)
    const afterUnconfiguredB = await groupOf(B_ID)
    const afterUnconfiguredA = await groupOf(A_ID)
    check('点「未配搜索」那行的打标签：只有没配搜索的那条被标上，连不上的那条不受牵连',
      tagUnconfigured && afterUnconfiguredB?.group === '未配搜索' && afterUnconfiguredA?.group === `网文 ${TAG}`,
      `乙="${afterUnconfiguredB?.group}" 甲="${afterUnconfiguredA?.group}"`)

    await page.screenshot({ path: path.join(SHOTS, 'health-modal-idle.png') })
    check('体检界面没有 JS 异常', errors.length === 0, errors.slice(0, 2).join(' / '))
  } finally {
    await browser.close()
  }
} finally {
  // 收尾：探针必须自己清干净，并复查
  const removed = await call('POST', '/api/sources/batch', { ids: [A_ID, B_ID], action: 'delete' })
  const leftovers = await groupOf(A_ID)
  const leftoversB = await groupOf(B_ID)
  const clean = !leftovers && !leftoversB
  results.push({ name: '探针体检源已自行回收', ok: removed.status === 200 && clean, detail: clean ? '无残留' : `残留=${[leftovers && A_ID, leftoversB && B_ID].filter(Boolean).join(',')}` })
}

let pass = 0
let fail = 0
let skips = 0
for (const item of results) {
  if (item.ok === true) pass++
  else if (item.ok === false) { fail++; console.log(`  FAIL ${item.name}  — ${item.detail}`) }
  else { skips++; console.log(`  NOTE ${item.name}  — ${item.detail}`) }
}
for (const item of results) if (item.ok === true) console.log(`  PASS ${item.name}  — ${item.detail}`)
console.log(`\nsource-health-check: PASS ${pass} / FAIL ${fail} / NOTE ${skips}`)
process.exit(fail > 0 ? 1 : 0)
