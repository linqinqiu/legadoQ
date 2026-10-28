// 旧版外壳 + 「自定义」皮肤 + 应用内「更新日志」的界面门禁。
//
// 来历：2026-10-01 先做了「界面框架 v2」（侧栏 + 页头条 + 全宽），同日用户拍板
// 「整个应用回旧版，撤掉 v2」→ 侧栏那一套整条删除，本文件的前身 `ui-layout-check.mjs`
// 判的是"两套外壳入口集合相等"，现在没有两套了，所以改名并改成判**一件新事**：
//   ① 界面只有旧版这一套外壳（侧栏/页头条的文件与类名都不许再出现）；
//   ② 「更新日志」页读的是随包的 CHANGELOG.md，结构、当前版本高亮、来源都真的在；
//   ③ 「自定义」里的自定义皮肤**真的生效**，而且是**叠**在内置皮肤之上的
//      （只写一个变量也不许花屏）—— 这条带反向对照，摘掉基类必须立刻取不到变量；
//   ④ 「我的」菜单的条目集合（用户 2026-10-03：「顶栏『我的』菜单堆太多」——
//      「更新日志」「快捷键」收进「关于」，这里按新的分法判，旧的两条要判为"不在菜单里"）。
//
// 只读界面 + 只改 localStorage 里的设置，不动任何书源/书架数据，跑完自己清干净。
// 跑法：node tools/verify/ui-shell-check.mjs
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, OUT, SHOTS, BASE, launchOptions } from './env.mjs'

const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')

const STAMP = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)
const SETTINGS_KEY = 'legado-reader-settings-v2'
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const clickIn = (page, scope, label) => page.evaluate(({ scope, label }) => {
  const root = scope ? document.querySelector(scope) : document
  if (!root) return false
  const hit = [...root.querySelectorAll('button')].find(node => (node.textContent ?? '').trim().includes(label))
  if (!hit) return false
  hit.click()
  return true
}, { scope, label })

/**
 * 开「我的」菜单，并（给了 label 就）点其中一项。
 *
 * 为什么不是一句 `clickIn(..., '我的')` 加 `sleep`：这个菜单靠 `pointerdown` 判"点到外面去了"
 * 再关，而 `page.evaluate` 里的 `node.click()` 只派发 click、**不派发 pointerdown**。
 * 于是合成点击永远关不掉它 —— 上一段开着的菜单会一直挂着，下一次点「我的」就变成"反手关掉"，
 * 接着等 `.about-page` 必然超时（2026-10-04 门禁 ③ 的 FAIL 就是这么来的，不是产品坏了：
 * 同一套按钮在真鼠标下先收到 pointerdown，菜单先关，路径是通的）。
 * 所以这里每次开之前先用挡片的 click 把残留收掉，开合一律按条件等，不再用固定 sleep 猜时间。
 */
const openUserMenu = async (page, label = '') => {
  await page.evaluate(() => document.querySelector('.overlay-backdrop.is-menu')?.click())
  await page.waitForFunction(() => !document.querySelector('.header-menu-dropdown'), { timeout: 8000 }).catch(() => null)
  // 「我的」按钮是图标按钮（aria-label 带「我的」、正文为空），所以按类名点，
  // 不能再用 clickIn 按文字找 —— 那样永远找不到，报出来像是"菜单坏了"。
  const opened = await page.evaluate(() => {
    const button = document.querySelector('.header-menu-btn')
    if (!button) return false
    button.click()
    return true
  })
  if (!opened) return false
  try {
    await page.waitForSelector('.header-menu-dropdown', { timeout: 8000 })
  } catch {
    return false
  }
  if (!label) return true
  const clicked = await page.waitForFunction(
    ({ label }) => [...document.querySelectorAll('.header-menu-dropdown button')]
      .some(node => (node.textContent ?? '').trim().includes(label)),
    { timeout: 8000 }, { label },
  ).then(() => clickIn(page, '.header-menu-dropdown', label)).catch(() => false)
  return clicked
}

/** React 受控输入：必须走原生 setter + input 事件，直接改 .value 界面不认。 */
const typeInto = (page, selector, value) => page.evaluate(({ selector, value }) => {
  const el = document.querySelector(selector)
  if (!el) return false
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}, { selector, value })

/** `rgb(15, 18, 19)` 与 `#0f1213` 比一下（meta 里的色可能被归一化成 rgb）。 */
function rgbEq(computed, hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(String(hex).trim())
  if (!m) return false
  const want = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
  const got = (String(computed).match(/\d+/g) ?? []).map(Number)
  return got.length >= 3 && got.slice(0, 3).join(',') === want.join(',')
}

let browser = null
const errors = []
try {
  browser = await puppeteer.launch(launchOptions())
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  page.on('pageerror', error => errors.push(String(error.message)))

  // 首启协议层会挡住真实点击（它盖满整屏）。这一条门禁不判协议，直接标记为已同意；
  // agreement-check 会在跑完后清掉这个标记，所以不能假设上一条门禁留下了它。
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('legadoq-agreement-v1', new Date().toISOString()) } catch { /* 隐私模式就让它挡着 */ }
  })

  // ─────────────────────── ① 只有一套外壳 ───────────────────────
  await page.goto(`${BASE}/#library`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app-page-header', { timeout: 45000 })
  const shell = await page.evaluate(() => ({
    topbar: !!document.querySelector('.app-page-header'),
    rail: !!document.querySelector('.app-rail'),
    pageBar: !!document.querySelector('.page-bar'),
    frame: !!document.querySelector('.app-frame'),
    htmlClass: document.documentElement.className,
    nav: [...document.querySelectorAll('.app-page-header nav button')].map(n => (n.textContent ?? '').trim()),
  }))
  check('①界面是旧版那一套顶栏外壳', shell.topbar, shell.topbar ? shell.nav.join(' / ') : '没找到 .app-page-header')
  // 一级入口的集合与顺序（用户 2026-10-08 定的框架，对齐 Legado-with-MD3：
  // 顶栏只留"有独立页面、会停下来管理"的目的地；2026-10-09 用户要求把「书源」放回顶栏，
  // 替换净化规则 / 备份 仍收进「设置」页）。
  // 判"整串相等"而不是"数一下有几个"：少一项、多一项、换了顺序都要红 —— 只数条目的话，
  // 把「书签」换成「设置」也能凑够数，等于没判。
  check('①顶栏六个一级入口，顺序与那张表一致',
    shell.nav.join('|') === '书库|书架|书源|发现|订阅|设置', shell.nav.join(' / '))
  check('①侧栏 / 页头条那套 v2 结构不在页面上',
    !shell.rail && !shell.pageBar && !shell.frame,
    `侧栏=${shell.rail} 页头条=${shell.pageBar} 框架=${shell.frame}`)
  check('①<html> 上挂着皮肤类（portal 出去的浮层只认根上的变量）',
    /theme-(light|paper|dark)/.test(shell.htmlClass), shell.htmlClass || '(空)')

  // ─────────────────── ② 「我的」菜单里的入口与皮肤 ───────────────────
  check('②「我的」点得开', await openUserMenu(page), '')
  await page.waitForFunction(() => document.querySelectorAll('.header-menu-dropdown .menu-theme-btn').length >= 3, { timeout: 8000 }).catch(() => null)
  const menu = await page.evaluate(() => {
    const swatch = document.querySelector('.header-menu-dropdown .theme-swatch')
    return {
      labels: [...document.querySelectorAll('.header-menu-dropdown button')].map(n => (n.textContent ?? '').trim()),
      skins: [...document.querySelectorAll('.header-menu-dropdown .menu-theme-btn .theme-name')].map(n => (n.textContent ?? '').trim()),
      swatchSize: swatch ? getComputedStyle(swatch).width : '',
      hasCustomize: !!document.querySelector('.menu-section-action'),
    }
  })
  check('②皮肤七档都在（晓白 / 护眼 / 夜读 / 青竹 / 暮蓝 / 玫瑰 / 石墨）', menu.skins.join('、') === '晓白、护眼、夜读、青竹、暮蓝、玫瑰、石墨', menu.skins.join('、') || '(取不到)')
  check('②菜单里有「自定义」入口', menu.labels.some(l => l.includes('自定义')) && menu.hasCustomize, menu.labels.join(' / '))
  // 「更新日志」「快捷键」两条从菜单里收掉了（用户 2026-10-03：「顶栏『我的』菜单堆太多」）：
  // 前者有顶栏版本芯片 + 「关于」两条路，后者改由「关于」进。这里按新的分法判。
  check('②菜单里有「关于」入口', menu.labels.some(l => l.includes('关于')), menu.labels.join(' / '))
  // 一级目的地不在菜单里留第二条路（「设置」是一级入口，规则/备份 收在「设置」页），
  // 否则改了这边忘了那边、两边指向不同实现只是时间问题。
  check('②菜单里不再重复一级入口与已收编条目（设置 / 规则 / 备份 都不在菜单里）',
    !menu.labels.some(l => /^(设置|规则|备份|替换净化规则|备份包)$/.test(l)), menu.labels.join(' / '))
  check('②菜单不再堆着一级入口与旧条目',
    !menu.labels.some(l => ['设置', '更新日志', '快捷键', '备份包', '运行日志', '替换净化规则', '本地离线缓存管理'].includes(l)),
    menu.labels.join(' / '))
  check('②色片是 22px 那一套（v2 的 9px 小点不该留下来）', menu.swatchSize === '22px', `实测 ${menu.swatchSize || '(取不到)'}`)

  // 「设置」是一级入口，所以从顶栏点进去；判的还是原来那件事：
  // 收纳/搬家不许少功能 —— 每一行都要真的开得开原弹窗/原页，才算"换了分类"而不是"删了功能"。
  // 这一段放在色片检查之后 —— 点「设置」会离开这一屏，插在中间会让上面那条读不到浮层。
  check('②「设置」在顶栏上点得开这一页', await clickIn(page, '.app-page-header nav', '设置'), '')
  await page.waitForSelector('.settings-page', { timeout: 8000 })
  await sleep(400)
  const settings = await page.evaluate(() => ({
    groups: [...document.querySelectorAll('.settings-section h2')].map(n => (n.textContent ?? '').trim()),
    rows: [...document.querySelectorAll('.settings-row')].map(row => ({
      title: row.querySelector('.settings-row-main strong')?.textContent?.trim() ?? '',
      hint: row.querySelector('.settings-row-main small')?.textContent?.trim() ?? '',
      action: row.querySelector('button')?.textContent?.trim() ?? '',
    })),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }))
  check('②「设置」分了组，每行都说得出它管什么（不是一排光秃秃的按钮）',
    settings.groups.length >= 4 && settings.rows.length >= 5
    && settings.rows.every(row => row.title && row.action && row.hint.length >= 8),
    `${settings.groups.join('/')} · ${settings.rows.length} 行`)
  // 2026-10-08：替换净化规则 / 备份包 从顶栏搬进「设置」页（书源 2026-10-09 回到顶栏）—— 搬完必须还找得到。
  check('②「设置」里收着 替换净化规则 / 备份包 两行',
    ['替换净化规则', '备份包'].every(t => settings.rows.some(row => row.title === t)),
    settings.rows.map(r => r.title).join(' / '))
  check('②这一页 1440 宽不横向溢出', settings.overflow <= 1, `溢出 ${settings.overflow}px`)
  check('②「设置 → 看日志」真的开得出运行日志弹窗（收进去的功能没坏）',
    await clickIn(page, '.settings-page', '看日志'), '')
  await page.waitForSelector('.logs-modal', { timeout: 8000 })
  await page.evaluate(() => document.querySelector('.logs-modal .overlay-close[aria-label="关闭"]')?.click())
  await sleep(300)
  check('②日志弹窗关得掉', await page.evaluate(() => !document.querySelector('.logs-modal')), '')

  // 书源已是顶栏一级入口：从顶栏点「书源」要真的导航过去，且顶栏高亮「书源」（不再归在「设置」名下）。
  check('②顶栏「书源」点得开这一页（一级入口是通的）',
    await clickIn(page, '.app-page-header nav', '书源'), '')
  await page.waitForFunction(() => location.hash === '#sources', { timeout: 8000 }).catch(() => null)
  const atSources = await page.evaluate(() => ({
    hash: location.hash,
    active: [...document.querySelectorAll('.app-page-header nav button.active')].map(n => (n.textContent ?? '').trim()),
  }))
  check('②打开书源后顶栏高亮「书源」',
    atSources.hash === '#sources' && atSources.active.join(',') === '书源',
    `hash=${atSources.hash} · 高亮=${atSources.active.join(',') || '(无)'}`)

  // ─────────────────────── ③ 应用内「更新日志」 ───────────────────────
  const api = await page.evaluate(async () => {
    const res = await fetch('/api/changelog')
    return { status: res.status, type: res.headers.get('content-type') ?? '', length: (await res.text()).length }
  })
  check('③ GET /api/changelog 给出随包的 markdown（非空）',
    api.status === 200 && api.type.startsWith('text/markdown') && api.length > 200,
    `HTTP ${api.status} · ${api.type} · ${api.length} 字符`)
  check('③从「关于」进「更新日志」（菜单里那条已收掉，这一条走的是新路径）',
    await openUserMenu(page, '关于'), '')
  await page.waitForSelector('.about-page', { timeout: 8000 })
  const about = await page.evaluate(() => ({
    actions: [...document.querySelectorAll('.about-actions button, .about-actions a')].map(n => (n.textContent ?? '').trim()),
  }))
  check('③「关于」给得出更新日志与快捷键这两个入口',
    about.actions.some(l => l === '更新日志') && about.actions.some(l => l === '快捷键'),
    about.actions.join(' / ') || '(没有动作按钮)')
  // 快捷键这张表就一条判据：点得开、真的画出按键表（内容与生效的键同源，由 shortcut-check 盯）
  check('③「快捷键」点得开那张表', await clickIn(page, '.about-actions', '快捷键'), '')
  await page.waitForSelector('.shortcut-modal', { timeout: 8000 })
  const shortcutRows = await page.evaluate(() => document.querySelectorAll('.shortcut-row, .shortcut-table tr').length)
  check('③那张表真的列出了按键（不是空弹窗）', shortcutRows > 0, `实测 ${shortcutRows} 行`)
  await page.evaluate(() => document.querySelector('.shortcut-modal .overlay-close')?.click())
  check('③那张表关得掉（不留一层挡住「关于」的挡片）',
    await page.waitForFunction(() => !document.querySelector('.shortcut-modal'), { timeout: 5000 }).then(() => true).catch(() => false), '')
  check('③「更新日志」点得动', await clickIn(page, '.about-actions', '更新日志'), '')
  await page.waitForSelector('.changelog-page', { timeout: 8000 })
  await page.waitForFunction(() => !!document.querySelector('.changelog-release') || !!document.querySelector('.changelog-empty'), { timeout: 15000 })
  const log = await page.evaluate(() => ({
    releases: document.querySelectorAll('.changelog-release').length,
    groups: document.querySelectorAll('.changelog-group').length,
    items: document.querySelectorAll('.changelog-group li').length,
    current: document.querySelectorAll('.changelog-release.current').length,
    flag: !!document.querySelector('.changelog-flag'),
    head: document.querySelector('.page-dialog .dialog-head h2')?.textContent?.trim() ?? '',
    version: document.querySelector('.changelog-release h2')?.textContent?.trim() ?? '',
    emptySaid: !!document.querySelector('.changelog-empty'),
    headP: document.querySelector('.changelog-page .page-lead')?.textContent ?? '',
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }))
  check('③层头是这一套浮层共用的那种式样（.dialog-head，0.6.27 起标题在层头）', log.head === '更新日志', `实测「${log.head || '(空)'}」`)
  check('③有版本段与条目，且没有把"没读到"说成"没有更新"',
    log.releases > 0 && log.items > 0 && log.groups > 0 && !log.emptySaid,
    `${log.releases} 个版本 · ${log.groups} 组 · ${log.items} 条`)
  check('③当前运行版本那一段被标出来', log.current === 1 && log.flag && /^\d+\.\d+\.\d+$/.test(log.version), `顶部版本 ${log.version || '(空)'}`)
  check('③页头不再解释"这一页读的就是 CHANGELOG.md…"（0.6.10 去掉那句元话术）',
    !/这一页读的|界面现编/.test(log.headP), log.headP || '(空)')
  check('③1440 宽下没有横向溢出', log.overflow <= 1, `溢出 ${log.overflow}px`)
  await page.screenshot({ path: path.join(SHOTS, `ui-changelog-${STAMP}.png`) }).catch(() => null)

  // ────────────────────── ④ 自定义皮肤真的生效 ──────────────────────
  await page.goto(`${BASE}/#library`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app-page-header', { timeout: 30000 })
  check('④「我的」→「自定义」点得开弹窗', await openUserMenu(page, '自定义'), '')
  await page.waitForSelector('.customize-dialog', { timeout: 8000 })
  await page.waitForFunction(() => !!document.querySelector('.customize-skin-editor input[type=text]')
    && !!document.querySelector('.customize-css'), { timeout: 8000 }).catch(() => null)
  const canvas = '#0f1213'
  const typed = await typeInto(page, '.customize-skin-editor input[type=text]', 'gateMidnight!!')
    && await typeInto(page, '.customize-css', `.theme-gatemidnight { --canvas: ${canvas}; }`)
  check('④皮肤 id 与 CSS 两栏都填进去了', typed, typed ? '' : '没找到 .customize-skin-editor input / .customize-css')
  const echo = await page.evaluate(() => document.querySelector('.customize-note code')?.textContent?.trim() ?? '')
  check('④id 过白名单，界面把清洗结果说出来（大写与感叹号被滤掉）', echo.includes('gatemidnight'), `回显 ${echo || '(无)'}`)
  // 叠在「夜读」上而不是默认的晓白：:root 现在有一份与浅色同值的中性基线，
  // 若叠在晓白上，摘掉基档后变量值一个都不变，反向对照就恒真、什么也证明不了。
  check('④把这套皮肤叠在「夜读」之上（基档要与中性基线不同，反向对照才有意义）',
    await clickIn(page, '[aria-label="自定义皮肤的基础皮肤"]', '夜读'), '')
  check('④「套用这套皮肤」点得动', await clickIn(page, '.customize-actions', '套用'), '')
  await page.waitForFunction(() => [...document.querySelectorAll('.customize-skin')].some(n => (n.textContent ?? '').includes('自定义（gatemidnight）')), { timeout: 8000 })
  check('④皮肤列表里选中新建的这一套', await clickIn(page, '.customize-skin-row', '自定义（gatemidnight）'), '')
  await sleep(400)
  const skin = await page.evaluate(() => {
    const html = document.documentElement
    const style = document.getElementById('legado-custom-skin')
    const cs = getComputedStyle(html)
    return {
      classes: html.className,
      mounted: !!style,
      text: (style?.textContent ?? '').trim().slice(0, 60),
      canvas: cs.getPropertyValue('--canvas').trim(),
      surface: cs.getPropertyValue('--surface').trim(),
      ink: cs.getPropertyValue('--ink').trim(),
      meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? '',
    }
  })
  check('④注入的 <style> 在文档里，内容就是填的那条规则', skin.mounted && skin.text.includes('--canvas'), skin.text || '(空)')
  check('④皮肤类是「内置基档 + 自定义」两个，自定义在后',
    /theme-dark\s+theme-gatemidnight/.test(skin.classes.trim()), skin.classes || '(空)')
  // 「夜读」的 --surface / --ink 与 :root 中性基线不同，所以下面同时证明了
  // "其余变量来自基档"和"摘掉基档就换源"，不会因为基线兜底而恒真。
  check('④只写一个变量，其余变量仍从基档解析下来（不花屏）',
    skin.canvas === canvas && skin.surface === '#292e2b' && skin.ink === '#eef1ec',
    `--canvas ${skin.canvas} · --surface ${skin.surface || '(空)'} · --ink ${skin.ink || '(空)'}`)
  check('④标题栏 meta 取的是算出来的 --canvas（不是写死的三档色表）',
    rgbEq(skin.meta, canvas) || skin.meta.toLowerCase() === canvas.toLowerCase(), `meta=${skin.meta || '(空)'}`)

  // 反向对照：摘掉基档类，未覆盖的变量必须从「夜读」落回 :root 的中性基线 ——
  // 若值不变，说明基档根本没参与解析（那条"叠加"就是恒真的）。
  await page.evaluate(() => {
    const html = document.documentElement
    for (const name of [...html.classList]) if (/^theme-(light|paper|dark)$/.test(name)) html.classList.remove(name)
  })
  await sleep(250)
  const noBase = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement)
    return { surface: cs.getPropertyValue('--surface').trim(), ink: cs.getPropertyValue('--ink').trim(), canvas: cs.getPropertyValue('--canvas').trim() }
  })
  check('④反向对照：摘掉「夜读」后 --surface / --ink 落回中性基线（证明"叠加"是活的）',
    noBase.surface === '#ffffff' && noBase.ink === '#202522' && noBase.canvas === canvas,
    `--canvas ${noBase.canvas || '(空)'} · --surface ${noBase.surface || '(取不到)'} · --ink ${noBase.ink || '(取不到)'}`)

  // 皮肤要存得住；清除自定义皮肤之后注入的 <style> 必须被摘掉（不留一条幽灵规则）
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app-page-header', { timeout: 30000 })
  const persisted = await page.evaluate(() => ({
    classes: document.documentElement.className,
    style: !!document.getElementById('legado-custom-skin'),
    stored: JSON.parse(localStorage.getItem('legado-reader-settings-v2') ?? '{}'),
  }))
  check('④皮肤设置存得住（重载之后还是这一套）',
    persisted.classes.includes('theme-gatemidnight') && persisted.style && persisted.stored.theme === 'gatemidnight',
    `类 ${persisted.classes || '(空)'} · 注入=${persisted.style}`)
  await page.screenshot({ path: path.join(SHOTS, `ui-custom-skin-${STAMP}.png`) }).catch(() => null)

  check('④「我的」→「自定义」再开一次（皮肤库的删除入口要点得到）', await openUserMenu(page, '自定义'), '')
  await page.waitForSelector('.customize-dialog', { timeout: 8000 })
  // 皮肤库扩成「增 / 改 / 删 / 切换」之后不再有全局「清除自定义皮肤」——删的是库里的那一条。
  // 删掉的正好是当前这套时，界面要退回它叠着的那一档内置皮肤（见 CustomizeModal.remove）。
  check('④皮肤库里这条自定义皮肤删得动', await clickIn(page, '.customize-skin-editor', '删除'), '')
  // 等到注入的 <style> 真的摘掉再读数：这一条只等"动作生效"，判据（回到内置档、类被摘掉）仍在下面实测
  await page.waitForFunction(() => !document.getElementById('legado-custom-skin'), { timeout: 5000 }).catch(() => null)
  const clearedSkin = await page.evaluate(() => ({
    style: !!document.getElementById('legado-custom-skin'),
    classes: document.documentElement.className,
    skins: [...document.querySelectorAll('.customize-skin')].length,
  }))
  check('④删掉之后 <style> 被摘掉、皮肤列表回到内置那七套',
    !clearedSkin.style && !clearedSkin.classes.includes('theme-gatemidnight') && clearedSkin.skins === 7,
    `注入=${clearedSkin.style} 类=${clearedSkin.classes} 档数=${clearedSkin.skins}`)

  // ─────────── ⑤ 分章规则的落点（搬出「自定义」，长在书架导入旁边） ───────────
  // ④ 收场时「自定义」弹窗还开着：不关掉就点下一颗按钮，点到的其实是挡片底下的控件。
  await page.evaluate(() => document.querySelector('.customize-dialog .overlay-close')?.click())
  await page.goto(`${BASE}/#shelf`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.shelf-bar', { timeout: 30000 })
  const shelfBar = await page.evaluate(() => ({
    labels: [...document.querySelectorAll('.shelf-header-actions button')].map(n => (n.textContent ?? '').trim()),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }))
  check('⑤书架顶栏同时给得出「导入本地」与「分章规则」（规则入口长在它服务的动作旁边）',
    shelfBar.labels.some(l => l.includes('导入')) && shelfBar.labels.some(l => l.includes('分章规则')),
    shelfBar.labels.join(' / '))
  check('⑤加了一颗按钮之后 1440 宽仍不横向溢出', shelfBar.overflow <= 1, `溢出 ${shelfBar.overflow}px`)
  check('⑤「分章规则」点得开弹窗', await clickIn(page, '.shelf-header-actions', '分章规则'), '')
  await page.waitForSelector('.toc-rules-modal', { timeout: 8000 })
  // 弹窗先渲染「正在读取规则表…」，规则是随后一次请求回来的 —— 固定 sleep 在冷 JVM 上
  // 会量到 0 行（假红），而 0 行又让"每行都露出正则"那条判据空过（假绿）。等它落地或报错。
  const tocLoaded = await page.evaluate(async () => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const modal = document.querySelector('.toc-rules-modal')
      if (!modal) return 'gone'
      if (modal.querySelector('.toc-rule')) return 'rows'
      if (modal.querySelector('.toc-rules-failed')) return modal.querySelector('.toc-rules-failed').textContent
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    return 'timeout'
  })
  const toc = await page.evaluate(() => {
    const modal = document.querySelector('.toc-rules-modal')
    const cs = modal ? getComputedStyle(modal) : null
    const body = document.querySelector('.toc-rules-body')
    return {
      rows: modal ? modal.querySelectorAll('.toc-rule').length : 0,
      switches: modal ? modal.querySelectorAll('.toc-rule-switch input').length : 0,
      regexShown: [...(modal?.querySelectorAll('.toc-rule-main code') ?? [])].filter(n => n.textContent?.trim()).length,
      defaultSelect: !!modal?.querySelector('.customize-field'),
      importBtn: [...(modal?.querySelectorAll('button') ?? [])].some(n => (n.textContent ?? '').includes('按这条导入本地书')),
      note: (modal?.textContent ?? '').includes('手动选一条不需要先'),
      // 壳要真的成了一个有边框有圆角的浮层：样式表漏了类名的典型表现就是一段裸 div
      mounted: !!cs && cs.borderTopWidth !== '0px' && cs.borderRadius !== '0px',
      scrollable: !!body && body.scrollHeight >= body.clientHeight - 1,
      overflow: modal ? modal.scrollWidth - modal.clientWidth : -1,
    }
  })
  check('⑤规则表真的取回来了（不是停在"正在读取"或报错上）',
    tocLoaded === 'rows' && toc.rows > 0, `落地=${tocLoaded} · ${toc.rows} 行`)
  check('⑤弹窗列出全部规则（26 条里编得出正则的那些），不是只列启用的 12 条',
    toc.rows >= 20 && toc.switches === toc.rows, `${toc.rows} 行 · ${toc.switches} 个开关`)
  check('⑤每行把正则原文露出来（不写出来没人判断得了适不适合自己的书）',
    toc.rows > 0 && toc.regexShown >= toc.rows - 2, `${toc.regexShown}/${toc.rows} 行有正则`)
  check('⑤一屏给齐三样：默认规则选择器、接着导书的按钮、把两件事分开讲的说明',
    toc.defaultSelect && toc.importBtn && toc.note, '')
  check('⑤弹窗有壳、能滚、不横向溢出（样式表里那个类名是真的）',
    toc.mounted && toc.scrollable && toc.overflow <= 1,
    `壳=${toc.mounted} 可滚=${toc.scrollable} 溢出 ${toc.overflow}px`)
  await page.screenshot({ path: path.join(SHOTS, `toc-rules-modal-${STAMP}.png`) }).catch(() => null)
  check('⑤这颗关闭按钮关得掉弹窗（挡片不留在那儿挡住后面的操作）',
    await page.evaluate(() => { document.querySelector('.toc-rules-modal .overlay-close')?.click(); return !!document.querySelector('.toc-rules-modal') })
    && await page.waitForFunction(() => !document.querySelector('.toc-rules-modal'), { timeout: 5000 }).then(() => true).catch(() => false), '')
  // 「自定义」这一边：搬走了就必须在界面上真的看不见，不只是代码里删了
  check('⑤「自定义」弹窗还开得住（搬空之后不是空壳）', await openUserMenu(page, '自定义'), '')
  await page.waitForSelector('.customize-dialog', { timeout: 8000 })
  const customize = await page.evaluate(() => {
    const dialog = document.querySelector('.customize-dialog')
    return {
      text: dialog?.textContent ?? '',
      tocRows: dialog ? dialog.querySelectorAll('.toc-rule, .customize-toc-rule').length : -1,
      sections: [...(dialog?.querySelectorAll('.customize-section h3') ?? [])].map(n => (n.textContent ?? '').trim()),
    }
  })
  // 外观三节：皮肤 / 皮肤库 / 壁纸。壁纸与皮肤同一处改是刻意的（2026-10 加壁纸时定的），
  // 判据只盯"杂物"：分章规则不能再回来，也不许多出第四节。
  check('⑤「自定义」不再是杂物间：只剩皮肤与壁纸，没有分章规则',
    customize.tocRows === 0 && !customize.text.includes('分章规则')
    && customize.sections.join('、') === '皮肤、自定义皮肤库、壁纸',
    `${customize.sections.join('、') || '(没有分节)'} · 规则行 ${customize.tocRows}`)

  // ─────────────────────────── ⑥ 收尾 ──────────────────────────
  const cleared = await page.evaluate(() => {
    localStorage.removeItem('legado-reader-settings-v2')
    document.getElementById('legado-custom-skin')?.remove()
    return { stored: localStorage.getItem('legado-reader-settings-v2'), style: !!document.getElementById('legado-custom-skin') }
  })
  check('⑥探针留下的设置与注入的样式都清干净了（下次打开回到默认皮肤）',
    cleared.stored === null && !cleared.style, `残留设置=${String(cleared.stored)} 残留样式=${cleared.style}`)

  // 源码侧也钉一次：删掉的文件不许被谁又建回来（构建产物里同样不许有那套类名）
  const srcDir = path.join(ROOT, 'web', 'src')
  check('⑥ web/src 里没有侧栏/页头条那套组件文件',
    !fs.existsSync(path.join(srcDir, 'AppRail.tsx')) && !fs.existsSync(path.join(srcDir, 'PageBar.tsx')),
    [fs.existsSync(path.join(srcDir, 'AppRail.tsx')) && 'AppRail.tsx', fs.existsSync(path.join(srcDir, 'PageBar.tsx')) && 'PageBar.tsx'].filter(Boolean).join('、') || '干净')
  const css = fs.readFileSync(path.join(srcDir, 'styles.css'), 'utf8')
  // 「判代码有没有残留」这一类，通过时不许打印那句"命中了…"：
  // 一行写着 PASS、后面跟着 [命中了 v2 选择器]，读的人只会当成红了 —— 判据写得再对也没人信。
  const v2Left = ['.app-rail', '.rail-item', '.page-bar', '.app-frame', '.rail-tabs'].filter(name => css.includes(name))
  check('⑥样式表里没有 v2 的类名残留', v2Left.length === 0, v2Left.length ? `还留着 ${v2Left.join('、')}` : '干净')
  const tocBack = fs.readFileSync(path.join(srcDir, 'components', 'CustomizeModal.tsx'), 'utf8').includes('tocRules')
  check('⑥「自定义」弹窗的代码里没有分章规则那一段（判代码，不只是判界面）',
    !tocBack, tocBack ? 'CustomizeModal.tsx 又长回了 tocRules' : '干净')

  check('全程没有页面异常', errors.length === 0, errors.slice(0, 2).join(' | '))
} catch (error) {
  check('探针自身异常', false, error.message)
} finally {
  if (browser) await browser.close().catch(() => null)
  fs.mkdirSync(OUT, { recursive: true })
  const failed = results.filter(r => !r.ok)
  fs.writeFileSync(path.join(OUT, `ui-shell-${STAMP}.json`), JSON.stringify({ stamp: STAMP, base: BASE, results }, null, 2))
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`)
  console.log(`\n${results.length - failed.length}/${results.length} PASS · 详情 tools/verify/out/ui-shell-${STAMP}.json`)
  process.exit(failed.length ? 1 : 0)
}
