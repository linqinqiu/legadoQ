// 书源结构化编辑器 + 登录浏览器整屏化：交付前在真实浏览器里点一遍。
// 用法：node tools/verify/source-editor-check.mjs
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { BASE, OUT, SHOTS, ROOT, acceptAgreement, launchOptions } from './env.mjs'

const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')

const wait = ms => new Promise(r => setTimeout(r, ms))
const lines = []
const say = (...parts) => { const line = parts.join(' '); lines.push(line); console.log(line) }
const check = (label, ok, detail = '') => say(`${ok ? '✔' : '✘'} ${label}${detail ? ' — ' + detail : ''}`)

const RUN = process.env.LEGADO_RUN || String(Date.now()).slice(-6)
fs.mkdirSync(SHOTS, { recursive: true })
const b = await puppeteer.launch(launchOptions())
const p = await b.newPage()
await p.setViewport({ width: 1440, height: 900 })
p.on('dialog', d => d.accept().catch(() => undefined))
const errors = []
p.on('pageerror', e => errors.push(String(e.message || e)))

const TEST_URL = 'https://ui-check.example.com'
const TEST_NAME = '界面自检临时源'

// ---------- 1. 书源页：新建入口 ----------
await p.goto(`${BASE}/#sources`, { waitUntil: 'domcontentloaded', timeout: 40000 })
// 首次协议浮层会挡住真鼠标点击，而本门禁大量用 `p.click` / `p.type`；先标记已同意再重载。
await acceptAgreement(p)
await p.reload({ waitUntil: 'domcontentloaded', timeout: 40000 })
await wait(2500)
const hasCreate = await p.$('.source-create-btn')
check('书源侧栏出现「新建书源」按钮', !!hasCreate)
const createLabel = hasCreate ? await p.evaluate(el => el.innerText.trim(), hasCreate) : ''
check('按钮文案正确', createLabel.includes('新建书源'), createLabel)

// ---------- 2. 打开新建表单 ----------
await p.click('.source-create-btn')
await wait(600)
const tabs = await p.$$eval('.source-form-tabs button', els => els.map(e => e.innerText.trim()))
say(`ℹ 表单分栏：${tabs.join(' / ')}`)
check('上游八段 + JSON 原文分栏齐全', tabs.length === 9 && tabs[0] === '基础' && tabs[tabs.length - 1] === 'JSON')
check('分栏里含「段评」（上游有，我们照抄字段）', tabs.includes('段评'))

const urlField = await p.$('#source-field-root-bookSourceUrl')
check('「基础」栏渲染出源域名输入框', !!urlField)
const labelCount = await p.$$eval('.source-field-label', els => els.length)
check('字段按上游清单渲染（基础栏 14 条）', labelCount === 14, `实际 ${labelCount}`)
const requiredBadges = await p.$$eval('.source-field-required', els => els.length)
check('必填字段带标记', requiredBadges >= 3, `${requiredBadges} 个`)
const codes = await p.$$eval('.source-field-label code', els => els.slice(0, 3).map(e => e.innerText))
say(`ℹ 字段同时标出 JSON 路径：${codes.join('、')}`)

// ---------- 2b. 分组折叠与跨组搜索（用户 2026-10-03：「字段太多太乱，要分组/折叠/搜索」）----------
const groupHeads = await p.$$eval('.source-field-group-head', els => els.map(e => ({
  label: e.innerText.replace(/\s+/g, ' ').trim(),
  open: e.getAttribute('aria-expanded') === 'true',
})))
check('八段分组都作为可折叠段挂在同一页上（不再一屏只给一组）', groupHeads.length === 8, `${groupHeads.length} 段`)
check('默认只展开第一段，其余收起', groupHeads.filter(head => head.open).length === 1,
  groupHeads.map(head => `${head.label}${head.open ? '*' : ''}`).join(' '))
check('收起的那一段也报"几条有值"，不展开也知道这组填没填',
  groupHeads.every(head => /\d+ \/ \d+ 条有值/.test(head.label)), groupHeads[3]?.label ?? '')

await p.evaluate(() => {
  const head = [...document.querySelectorAll('.source-field-group-head')].find(node => node.innerText.includes('目录'))
  head?.click()
})
await wait(400)
const afterToggle = await p.evaluate(() => ({
  tocOpen: [...document.querySelectorAll('.source-field-group-head')]
    .find(node => node.innerText.includes('目录'))?.getAttribute('aria-expanded') === 'true',
  tocFields: document.querySelectorAll('#source-group-directory .source-field-label').length,
  baseStill: document.querySelectorAll('#source-group-base .source-field-label').length,
}))
check('点一段的标题就展开它（目录组 8 条字段出来）', afterToggle.tocOpen && afterToggle.tocFields >= 5,
  JSON.stringify(afterToggle))
check('展开新的那段不会把正在填的基础组挤掉', afterToggle.baseStill === 14, `基础 ${afterToggle.baseStill} 条`)

const searchBox = await p.$('.source-field-search input')
check('编辑器上有跨分组的字段搜索框', !!searchBox)
await searchBox.type('规则')
await wait(500)
const searched = await p.evaluate(() => ({
  groups: [...document.querySelectorAll('.source-field-group.is-matched > header span:first-child')].map(e => e.innerText.trim()),
  fields: document.querySelectorAll('.source-field-group.is-matched .source-field-label').length,
  heads: document.querySelectorAll('.source-field-group-head').length,
}))
check('搜一个词能把散在多个分组里的同类字段一次捞出来',
  searched.groups.length >= 4 && searched.fields >= 10 && searched.heads === 0,
  JSON.stringify(searched))
await p.evaluate(() => {
  const input = document.querySelector('.source-field-search input')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(input, '绝不存在的字段名')
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
await wait(400)
const noMatch = await p.evaluate(() => document.querySelector('.source-field-no-match')?.innerText.trim() ?? '')
check('搜不到时说实话，并指一条退路（不是留一片空白）', noMatch.includes('没有名字') && noMatch.includes('JSON'), noMatch)
await p.evaluate(() => {
  const button = [...document.querySelectorAll('.source-field-search button')].find(node => node.innerText.includes('清除'))
  button?.click()
})
await wait(400)
const restored = await p.evaluate(() => ({
  groups: document.querySelectorAll('.source-field-group').length,
  query: document.querySelector('.source-field-search input')?.value ?? '',
}))
check('清除搜索就回到折叠视图（八段都在，输入框清空）',
  restored.groups === 8 && restored.query === '', JSON.stringify(restored))

// ---------- 3. 填表并保存 ----------
await p.type('#source-field-root-bookSourceUrl', TEST_URL)
await p.type('#source-field-root-bookSourceName', TEST_NAME)
await p.type('#source-field-root-bookSourceGroup', '自检临时')
await wait(300)
const nameInHeader = await p.$eval('.source-editor h2', el => el.innerText.trim())
check('表头实时跟随「源名称」', nameInHeader === TEST_NAME, nameInHeader)

const clickTab = async name => {
  const hit = await p.evaluate(label => {
    const btn = [...document.querySelectorAll('.source-form-tabs button')].find(e => e.innerText.trim() === label)
    if (!btn) return false
    btn.click()
    return true
  }, name)
  await wait(350)
  if (!hit) throw new Error(`没有这个分栏：${name}`)
}

/** React 受控输入要用原生 setter 赋值，否则 onChange 收不到（triple-click + type 在数字/受控框上不总灵）。 */
const setInputValue = (sel, value) => p.evaluate((s, v) => {
  const el = document.querySelector(s)
  if (!el) return false
  const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}, sel, value)

/** 列表有 4,800+ 条且分页渲染，靠滚动找新源不现实：用筛选框定位。 */
const filterList = async value => {
  await setInputValue('.source-filter input', value)
  await wait(1400)
}

// 换栏填规则：验证命名空间写入 ruleSearch.*
await clickTab('搜索')
await p.type('#source-field-ruleSearch-checkKeyWord', '测试')
await clickTab('JSON')
const jsonAfterRule = await p.$eval('.source-editor-raw', el => el.value)
let draft = null
try { draft = JSON.parse(jsonAfterRule) } catch { /* 下面断言会报出来 */ }
check('规则字段写进 ruleSearch.checkKeyWord', draft?.ruleSearch?.checkKeyWord === '测试')
check('基础字段没有因为换栏丢失', draft?.bookSourceUrl === TEST_URL && draft?.bookSourceName === TEST_NAME)
say(`ℹ 草稿 JSON ${jsonAfterRule.length} 字符`)

// 校验：未保存的草稿也要能被校验（送的是编辑器内容）
await p.evaluate(() => [...document.querySelectorAll('.editor-actions button')].find(e => e.innerText.trim() === '校验')?.click())
await wait(1200)
const validateStatus = await p.$eval('.source-editor footer', el => el.innerText.trim())
check('「校验」对未保存草稿给出结论', validateStatus.includes('校验通过') || validateStatus.includes('；'), validateStatus)

// 存盘
await p.evaluate(() => [...document.querySelectorAll('.editor-actions button')].find(e => e.innerText.trim() === '保存')?.click())
await wait(1800)
const savedStatus = await p.evaluate(() => document.querySelector('.source-editor footer')?.innerText.trim() ?? '(状态栏不见了)')
check('保存成功', savedStatus.includes('已保存'), savedStatus)
const inList = await (async () => {
  await filterList('ui-check')
  return p.evaluate(name => {
    const row = [...document.querySelectorAll('.source-list button')].find(el => el.innerText.includes(name))
    return !!row && row.className.includes('selected')
  }, TEST_NAME)
})()
check('新书源出现在列表里并被选中', inList)
await p.screenshot({ path: path.join(SHOTS, `v6-source-editor-form-${RUN}.png`) })

// ---------- 4. 行内启停开关（只动本次自造的临时源，不碰用户的启用位） ----------
const switchBefore = await p.evaluate(name => {
  const row = [...document.querySelectorAll('.source-list button')].find(el => el.innerText.includes(name))
  const sw = row?.querySelector('.source-enable-switch')
  const cs = sw ? getComputedStyle(sw) : null
  return sw ? { on: sw.getAttribute('aria-checked'), pos: cs.position, right: cs.right, rowPos: getComputedStyle(row).position } : null
}, TEST_NAME)
check('行内有启停开关且定位在行内', !!switchBefore && switchBefore.rowPos === 'relative' && switchBefore.pos === 'absolute', JSON.stringify(switchBefore))
if (switchBefore) {
  await p.evaluate(name => {
    const row = [...document.querySelectorAll('.source-list button')].find(el => el.innerText.includes(name))
    row.querySelector('.source-enable-switch').click()
  }, TEST_NAME)
  await wait(1400)
  const after = await p.evaluate(name => {
    const row = [...document.querySelectorAll('.source-list button')].find(el => el.innerText.includes(name))
    return { on: row?.querySelector('.source-enable-switch')?.getAttribute('aria-checked'), badge: /已停用/.test(row?.innerText || '') }
  }, TEST_NAME)
  check('点开关即停用（带「已停用」角标）', after.on === 'false' && after.badge, JSON.stringify(after))
  await p.evaluate(name => {
    const row = [...document.querySelectorAll('.source-list button')].find(el => el.innerText.includes(name))
    row.querySelector('.source-enable-switch').click()
  }, TEST_NAME)
  await wait(1400)
  const back = await p.evaluate(name => {
    const row = [...document.querySelectorAll('.source-list button')].find(el => el.innerText.includes(name))
    return row?.querySelector('.source-enable-switch')?.getAttribute('aria-checked')
  }, TEST_NAME)
  check('再点一次恢复启用', back === 'true', String(back))
}

// ---------- 5. 换址警告（书源以域名为主键） ----------
await clickTab('基础')
await setInputValue('#source-field-root-bookSourceUrl', TEST_URL + 'x')
await wait(400)
const warn = await p.$$eval('.source-editor-broken', els => els.map(e => e.innerText.trim()))
check('改域名会提示「会新增一条书源」', warn.some(t => t.includes('新增一条书源')), warn[0]?.slice(0, 40))
await setInputValue('#source-field-root-bookSourceUrl', TEST_URL)
await wait(400)
const warnGone = await p.$$eval('.source-editor-broken', els => els.length)
check('改回原域名后警告消失', warnGone === 0, `${warnGone} 条`)

// ---------- 6. 登录浏览器整屏化 ----------
await filterList('')
const loginRow = await p.evaluate(() => {
  const row = [...document.querySelectorAll('.source-list button')].find(el => el.innerText.includes('登录'))
  if (!row) return null
  row.click()
  return row.innerText.replace(/\s+/g, ' ').slice(0, 30)
})
say(`ℹ 选中带登录标记的书源：${loginRow ?? '列表里没有带登录标记的源'}`)
if (loginRow) {
  await wait(1500)
  const entry = await p.$('.source-login-entry-btn')
  if (entry) {
    await entry.click()
    await wait(1500)
    const opened = await p.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(e =>
        (e.innerText || '').includes('用内置浏览器登录') || (e.getAttribute('title') || '').includes('用内置浏览器登录'))
      if (!btn) return 'no-webview-button'
      btn.click()
      return 'clicked'
    })
    await wait(2500)
    const geometry = await p.evaluate(() => {
      const dialog = document.querySelector('.source-webview-dialog')
      const backdrop = document.querySelector('.overlay-backdrop.is-flush')
      const frame = document.querySelector('.source-webview-frame')
      const picker = document.querySelector('.source-webview-viewport-picker')
      if (!dialog) return { missing: true, opened: true }
      const r = dialog.getBoundingClientRect()
      const cs = getComputedStyle(dialog)
      const bs = backdrop ? getComputedStyle(backdrop) : null
      return {
        vw: innerWidth, vh: innerHeight,
        w: Math.round(r.width), h: Math.round(r.height),
        radius: cs.borderRadius,
        backdropPadding: bs ? bs.padding : 'n/a',
        picker: !!picker,
        frameW: frame ? Math.round(frame.getBoundingClientRect().width) : 0,
        frameH: frame ? Math.round(frame.getBoundingClientRect().height) : 0,
        transform: frame ? getComputedStyle(frame).transform : 'none',
      }
    })
    if (geometry.missing) {
      check('内置浏览器弹窗已挂载', false, opened)
    } else {
      check('弹窗宽度铺满视口', Math.abs(geometry.w - geometry.vw) <= 1, `${geometry.w}×${geometry.h} vs ${geometry.vw}×${geometry.vh}`)
      check('弹窗高度铺满视口', Math.abs(geometry.h - geometry.vh) <= 1, `${geometry.h}`)
      check('遮罩不再留内边距', geometry.backdropPadding === '0px', geometry.backdropPadding)
      check('弹窗不再有圆角/缩放', geometry.radius === '0px' && (geometry.transform === 'none' || !geometry.transform), `radius=${geometry.radius} transform=${geometry.transform}`)
      check('手机/平板/铺满切换器已删除', geometry.picker === false)
      check('iframe 拿到弹窗全部宽度', geometry.frameW >= geometry.w - 1, `${geometry.frameW}px`)
      // 安装横幅层级 999 压过弹窗 100，正好盖在移动站提交按钮的位置
      const bannerVisible = await p.evaluate(() => {
        const el = document.querySelector('.pwa-install-banner')
        if (!el) return 'none'
        const cs = getComputedStyle(el)
        const r = el.getBoundingClientRect()
        return cs.display === 'none' || !r.width ? 'hidden' : `visible@${Math.round(r.top)}`
      })
      check('整屏登录时安装横幅让路', bannerVisible === 'hidden' || bannerVisible === 'none', bannerVisible)
      await p.screenshot({ path: path.join(SHOTS, `v6-webview-fullscreen-${RUN}.png`) })
      const close = await p.$('.source-webview-dialog .source-webview-icon-btn:last-of-type')
      if (close) await close.click()
      await wait(400)
    }
    await p.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(e => (e.getAttribute('aria-label') || '') === '关闭' || (e.innerText || '').trim() === '✕')
      btn?.click()
    })
    await wait(400)
  }
}

// ---------- 7. 备份页：WebDAV 删掉之后，恢复入口只剩"选包即导入" ----------
await p.goto(`${BASE}/#backup`, { waitUntil: 'domcontentloaded', timeout: 40000 })
await wait(1200)
// 0.6.27 起备份是悬浮层：标题在层头（.dialog-head h2），正文不再重复一遍 h1。
// 用户 2026-09-30：「手机恢复这个名词解释有些难听，咱们这是电脑啊」——标题是「备份包」，主语是包不是手机
const backupHead = await p.$eval('.page-dialog .dialog-head h2', el => el.innerText.trim()).catch(() => '')
check('备份悬浮层标题就叫「备份包」', backupHead === '备份包', backupHead)
const backupButtons = await p.$$eval('.backup-actions button', nodes => nodes.map(n => n.innerText.replace(/\s+/g, ' ').trim()))
check('页上有选包导入按钮，且不再承诺任何网络服务', backupButtons.some(t => t.includes('选择备份包导入')), backupButtons.join(' / '))
const backupBody = await p.$eval('.backup-page', el => el.innerText)
check('备份页不再出现 WebDAV 字样', !/webdav/i.test(backupBody), /webdav/i.exec(backupBody)?.[0] ?? '无')
check('备份页不把主语安在手机上', !/手机恢复|手机端恢复|手机导入/.test(backupBody), /手机\S{0,4}/.exec(backupBody)?.[0] ?? '无')
// #64：备份密码从主操作行撤掉了 —— 判据按**行为**判，不按措辞判。
// 原来这条只匹配「填备份密码」这个字符串，界面上那句话换成「需要解开包里的登录凭据？」
// 之后它就红了，而用户在意的事实（默认没有密码框、点开才有）其实一直没变。
// 换成三段可核对的行为：默认无密码框 + 有一个提到"凭据"的开关 + 点开确实出现密码框
// （第三条防的是"折叠=把功能删了"这种反方向糊弄）。
const pwBefore = await p.evaluate(() => {
  const buttons = [...document.querySelectorAll('.backup-page button')]
  return {
    toggle: buttons.map(n => (n.innerText ?? '').replace(/\s+/g, ' ').trim()).find(t => /凭据/.test(t)) ?? '',
    hasInput: !!document.querySelector('.backup-password, .backup-page input[type=password]'),
  }
})
check('备份密码默认折叠：主操作行上没有密码框，只有一个提到「凭据」的开关',
  !pwBefore.hasInput && pwBefore.toggle.length > 0,
  `开关文案=${pwBefore.toggle || '没找到'} · 默认已有密码框=${pwBefore.hasInput}`)
await p.evaluate(() => {
  ;[...document.querySelectorAll('.backup-page button')].find(n => /凭据/.test(n.innerText ?? ''))?.click()
})
await wait(500)
const pwAfter = await p.evaluate(() => !!document.querySelector('.backup-password, .backup-page input[type=password]'))
check('点开开关才出现密码框（折叠不等于没有这个能力）', pwAfter, pwAfter ? '密码框出现了' : '仍没有出现')

// ---------- 8. 体检进度条：静态取证 ----------
// 弹窗一挂载就自动开测整库（这里 4,800+ 源），不能在自检脚本里点开，
// 所以只验编译产物里进度条已改成按 progress.checked 计算，而不是恒 100%。
const bundleHtml = await (await fetch(`${BASE}/`)).text()
const bundleName = /assets\/(index-[\w-]+\.js)/.exec(bundleHtml)?.[1]
const bundleJs = bundleName ? await (await fetch(`${BASE}/assets/${bundleName}`)).text() : ''
check('前端产物已更新（含 progressbar 语义）', bundleJs.includes('progressbar') && bundleJs.includes('source-create-btn'))
check('体检改成分批推进（源码里进度条不再写死 100%）', !/running \? '100%' : '100%'/.test(fs.readFileSync(path.join(ROOT, 'web/src/sources/SourceHealthModal.tsx'), 'utf8')))

// ---------- 9. 清理：删掉这次造的源 ----------
// 上一步停在 #webdav，直接 reload 会回到文件页：那里没有筛选框，清理会静默失败。
await p.goto(`${BASE}/#sources`, { waitUntil: 'domcontentloaded', timeout: 40000 })
await wait(1800)
await filterList('ui-check')
const removed = await p.evaluate(name => {
  const row = [...document.querySelectorAll('.source-list button')].find(el => el.innerText.includes(name))
  if (!row) return 'not-found'
  row.click()
  return 'selected'
}, TEST_NAME)
await wait(1200)
if (removed === 'selected') {
  // 「删除书源」这一档在**页头**（`.page-title-actions`）里，不在编辑器面板里 ——
  // 只翻 `.editor-actions` 会一条都找不到，于是清理静默失败、库里留下 `界面自检临时源`，
  // 下一次跑就被自己上一条"残留"判红（AGENTS §3 ②：崩溃/失败的那一次会留下探针）。
  //
  // ⚠ 这里**不能用 `p.$$(...)` 拿句柄再 `btn.click()`**：选中行之后 React 会重渲染页头，
  // 句柄指向的是已被卸载的旧节点，`btn.click()` 静默无效（实测：dialogs 一个都没弹，
  // 删除请求根本没发）。必须在页面里**现查现点**，拿当前挂着的那个节点。
  const deleteClicked = await p.evaluate(() => {
    const btn = [...document.querySelectorAll('.page-title-actions button')]
      .find(n => (n.textContent ?? '').includes('删除书源'))
    if (!btn) return 'no-button'
    btn.click()
    return 'clicked'
  })
  if (deleteClicked !== 'clicked') say(`⚠ 清理时没找到「删除书源」按钮（${deleteClicked}）`)
  // 等"这一行真的从列表消失"，而不是睡固定 1500ms ——
  // 删除要走 confirm → DELETE 请求 → 重新拉 5,597 条 → 虚拟列表重排，
  // 这几步叠起来常常超过 1.5 秒，睡固定时间就会误判成"残留"。
  await p.waitForFunction(
    name => ![...document.querySelectorAll('.source-list button')].some(el => el.innerText.includes(name)),
    { timeout: 15000 },
    TEST_NAME,
  ).catch(() => undefined)
  await filterList('ui-check')
}
const stillThere = await p.evaluate(name => [...document.querySelectorAll('.source-list button')].some(el => el.innerText.includes(name)), TEST_NAME)
// 「没找到行」也算清理失败：那说明前面几步造出来的源还留在库里。
check('自检临时源已清理', removed === 'selected' && stillThere === false, `${removed} / 残留=${stillThere}`)
// 清理失败时把现场打出来，便于判"是没选中"还是"删了没生效"
if (removed !== 'selected' || stillThere) {
  const scene = await p.evaluate(name => ({
    filter: document.querySelector('.source-filter input')?.value ?? '(无筛选框)',
    rows: document.querySelectorAll('.source-list button').length,
    rowTexts: [...document.querySelectorAll('.source-list button')].slice(0, 5).map(n => n.innerText.replace(/\s+/g, ' ').trim().slice(0, 24)),
    titleActions: [...document.querySelectorAll('.page-title-actions button')].map(n => n.textContent.trim()),
    hasTemp: document.body.innerText.includes(name),
  }), TEST_NAME)
  say(`ℹ 清理现场：${JSON.stringify(scene)}`)
}

check('页面运行无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '))

await b.close()
fs.writeFileSync(path.join(OUT, 'source-editor-check.txt'), lines.join('\n') + '\n')
const failed = lines.filter(l => l.startsWith('✘')).length
say(`\n合计 ${lines.filter(l => /^[✔✘]/.test(l)).length} 项，失败 ${failed} 项`)
process.exit(failed ? 1 : 0)
