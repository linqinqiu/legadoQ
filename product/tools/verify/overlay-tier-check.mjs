// 浮层并档的**实测**门禁（PROPOSAL-018 W2）—— 量的是屏幕上画出来的那一档。
//
// 为什么静态判据不够：`UiContract` 那几条扫的是样式表与 TSX 文本（第 17 套外壳几何、
// 第三条遮罩、inline 宽高）。但"改一处被另一处顶掉"是这个样式表的常态 ——
// 全局 `button { min-height: 34px }` 把 30×30 的关闭键拉成 30×34（0.5.1 实测）、
// 后置的同特异性规则覆盖前面的、`createPortal` 的浮层取不到主题变量（0.4.0 实测）。
// 所以这条门禁打开真的弹窗，读 `getComputedStyle` 与矩形：宽度必须落在三档之一、
// 圆角/阴影/高度上限/遮罩底色必须全表同一个数、关闭键必须是方的 30×30。
//
// 跑法：node tools/verify/overlay-tier-check.mjs   （只读界面；只改 localStorage 的偏好，跑完还原）
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, BASE, launchOptions, acceptAgreement } from './env.mjs'

const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
const note = (name, detail) => console.log(`NOTE  ${name}  — ${detail}`)

const clickIn = (page, scope, label) => page.evaluate(({ scope, label }) => {
  const root = scope ? document.querySelector(scope) : document
  if (!root) return false
  const hit = [...root.querySelectorAll('button')].find(node => (node.textContent ?? '').trim().includes(label))
  if (!hit) return false
  hit.click()
  return true
}, { scope, label })

const waitFor = async (page, selector, ms = 25_000) => {
  const started = Date.now()
  while (Date.now() - started < ms) {
    if (await page.$(selector)) return true
    await new Promise(resolve => setTimeout(resolve, 120))
  }
  return false
}

/** 把当前打开的那一张弹窗量一遍：外壳档位 + 遮罩 + 关闭键。
 *
 * 尺寸一律读**计算值**，不读 `getBoundingClientRect()`：外壳与关闭键都挂着 `scaleUp`
 * 入场动画（`from { transform: scale(.95) }`），第一版拿矩形量，量到的是"动画进行到哪一帧"
 * —— 实测把 680 读成 646、30×30 读成 28×29，四条判据一起红在探针上而不是产品上。
 * 计算值不受 transform 影响，量的才是样式真正给的那一档。 */
const measure = page => page.evaluate(() => {
  const backdrop = document.querySelector('.overlay-backdrop')
  if (!backdrop) return null
  const shell = backdrop.querySelector('.dialog-shell')
  const px = value => Math.round(parseFloat(value))
  const read = node => {
    const style = getComputedStyle(node)
    return {
      width: px(style.width),
      height: px(style.height),
      maxHeight: style.maxHeight,
      radius: style.borderRadius,
      shadow: style.boxShadow,
      background: style.backgroundColor,
      blur: style.backdropFilter || 'none',
      animation: style.animationName,
    }
  }
  const close = backdrop.querySelector('.overlay-close')
  const classes = shell ? shell.className.split(/\s+/).filter(Boolean) : []
  return {
    vh: window.innerHeight,
    backdrops: document.querySelectorAll('.overlay-backdrop').length,
    sizeClass: classes.find(name => /^size-[sml]$/.test(name)) ?? '',
    hasShell: !!shell,
    shell: shell ? read(shell) : null,
    backdropStyle: read(backdrop),
    close: close ? (() => { const s = getComputedStyle(close); return { w: px(s.width), h: px(s.height), border: s.borderStyle, radius: s.borderRadius } })() : null,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }
})

// 三档宽度与实际屏宽取小值 —— 样式表里那句 `min(--dw, 94vw)` 的算法，这里独立算一遍
const DW = { s: 480, m: 680, l: 940 }
const expectWidth = (size, vw) => {
  const base = DW[String(size).replace('size-', '')]
  return base === undefined ? null : Math.round(Math.min(base, vw * 0.94))
}

const DIALOGS = [
  {
    name: '「自定义」',
    expectSize: 'size-s',
    open: async page => {
      await page.evaluate(() => document.querySelector('.overlay-backdrop.is-menu')?.click())
      if (!await clickIn(page, '.app-page-header', '我的')) return false
      if (!await waitFor(page, '.header-menu-dropdown')) return false
      const done = await clickIn(page, '.header-menu-dropdown', '自定义')
      return done && await waitFor(page, '.customize-dialog')
    },
  },
  {
    name: '「快捷键」那张表',
    expectSize: 'size-m',
    open: async page => {
      await page.keyboard.press('Escape')
      await page.evaluate(() => document.body.focus())
      await page.keyboard.press('?')
      return waitFor(page, '.shortcut-modal')
    },
  },
  {
    name: '运行日志',
    expectSize: 'size-l',
    open: async page => {
      await page.keyboard.press('Escape')
      await page.evaluate(() => document.body.focus())
      await page.keyboard.press('l')
      return waitFor(page, '.logs-modal')
    },
  },
  {
    name: '「本地书分章规则」',
    expectSize: 'size-m',
    open: async page => {
      await page.keyboard.press('Escape')
      await page.evaluate(() => { location.hash = '#shelf' })
      if (!await waitFor(page, '.shelf-page')) return false
      const done = await clickIn(page, '.shelf-page', '分章规则')
      return done && await waitFor(page, '.toc-rules-modal')
    },
  },
  // 0.6.27：规则 / 备份 / 更新日志 / 关于 从整页搬进悬浮层（PageDialog / 规则弹窗），
  // 也走共用外壳 —— 这里量它们的档位、遮罩、关闭键是否与其它浮层同一套。深链即入口。
  {
    name: '「替换净化规则」',
    expectSize: 'size-l',
    open: async page => {
      await page.keyboard.press('Escape')
      await page.evaluate(() => { location.hash = '#rules' })
      return waitFor(page, '.rules-search-wrap')
    },
  },
  {
    name: '「备份」悬浮层',
    expectSize: 'size-l',
    open: async page => {
      await page.keyboard.press('Escape')
      await page.evaluate(() => { location.hash = '#backup' })
      return waitFor(page, '.backup-page')
    },
  },
  {
    name: '「更新日志」悬浮层',
    expectSize: 'size-l',
    open: async page => {
      await page.keyboard.press('Escape')
      await page.evaluate(() => { location.hash = '#changelog' })
      return waitFor(page, '.changelog-page')
    },
  },
  {
    name: '「关于」悬浮层',
    expectSize: 'size-l',
    open: async page => {
      await page.keyboard.press('Escape')
      await page.evaluate(() => { location.hash = '#about' })
      return waitFor(page, '.about-page')
    },
  },
]

const browser = await puppeteer.launch(launchOptions())
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
const errors = []
page.on('pageerror', error => errors.push(String(error.message ?? error)))

// 冷 profile 的第一次导航在这台机器上要 30~50 秒（AGENTS §3 ③(a)），所以这里等 45 秒而不是猜 12 秒
await page.goto(`${BASE}/#library`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
if (!await waitFor(page, '.app-page-header', 45_000)) {
  check('应用外壳画得出来', false, '停在空白页上，下面全部无从量起')
  await browser.close()
  process.exit(1)
}
// 首次运行的「用户协议」浮层（0.6.46 引入）也是 `.overlay-backdrop` + 无 size-* 的 `.dialog-shell`，
// 不先关掉它，measure() 取到的就是它而不是要量的那一张（680px、无 .overlay-close 的假红）。
await acceptAgreement(page)
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
if (!await waitFor(page, '.app-page-header', 45_000)) {
  check('应用外壳画得出来（关掉协议浮层后）', false, '停在空白页上')
  await browser.close()
  process.exit(1)
}

const seen = []
for (const dialog of DIALOGS) {
  const opened = await dialog.open(page)
  if (!opened) {
    check(`${dialog.name}：开得出`, false, '入口没点到 / 弹窗没出现')
    continue
  }
  const box = await measure(page)
  seen.push({ name: dialog.name, ...box })
  check(`${dialog.name}：挡片只有一层、外壳是共用那一档`,
    box.hasShell && box.backdrops === 1,
    `挡片 ${box.backdrops} 层 · 外壳 ${box.hasShell ? 'dialog-shell' : '没套 —— 并档前的第 17 套几何就是这么长回来的'}`)
  const want = expectWidth(dialog.expectSize.replace('size-', ''), 1440)
  check(`${dialog.name}：还是设计里那一档（${dialog.expectSize} = ${want}px），且宽度实测等于 min(档, 94vw)`,
    box.sizeClass === dialog.expectSize && Math.abs(box.shell.width - want) <= 1,
    `实际挂 ${box.sizeClass || '没挂 size-*'} · 实测宽 ${box.shell.width}px，期望 ${want}px`)
  const wantMax = Math.round(Math.min(box.vh * 0.88, 760))
  check(`${dialog.name}：高度上限是共用那一档（min(88vh,760px) = ${wantMax}px）`,
    Number(box.shell.maxHeight.replace('px', '')) === wantMax
      && box.shell.radius === '12px' && /^scaleUp$/.test(box.shell.animation),
    `max-height=${box.shell.maxHeight} · radius=${box.shell.radius} · animation=${box.shell.animation}`)
  check(`${dialog.name}：遮罩是共用那一档（.45 + 4px 模糊）`,
    box.backdropStyle.background === 'rgba(0, 0, 0, 0.45)' && /blur\(4px\)/.test(box.backdropStyle.blur),
    `${box.backdropStyle.background} · ${box.backdropStyle.blur}`)
  check(`${dialog.name}：关闭键 30×30 且无边框`,
    !!box.close && box.close.w === 30 && box.close.h === 30 && box.close.border === 'none',
    box.close ? `${box.close.w}×${box.close.h} · border=${box.close.border}` : '这一张没找到 .overlay-close')
  check(`${dialog.name}：开着的时候不横向溢出`, box.overflow <= 1, `溢出 ${box.overflow}px`)
  await page.keyboard.press('Escape')
  const gone = await page.evaluate(() => !document.querySelector('.overlay-backdrop'))
  check(`${dialog.name}：Esc 关得掉`, gone, gone ? '' : 'Esc 之后挡片还挂在 DOM 上')
}

const distinct = pick => [...new Set(seen.map(pick))]
check(`${seen.length} 张弹窗量下来：max-height 只有一个值`,
  distinct(i => i.shell.maxHeight).length === 1, distinct(i => i.shell.maxHeight).join(' / ') || '(一张都没量到)')
check(`${seen.length} 张弹窗量下来：圆角与阴影只有一个值`,
  new Set(seen.map(i => i.shell.radius)).size === 1 && new Set(seen.map(i => i.shell.shadow)).size === 1,
  `radius=${[...new Set(seen.map(i => i.shell.radius))].join('/')}`)
check(`${seen.length} 张弹窗量下来：关闭键只有一档尺寸`,
  new Set(seen.filter(i => i.close).map(i => `${i.close.w}x${i.close.h}`)).size === 1,
  [...new Set(seen.filter(i => i.close).map(i => `${i.close.w}x${i.close.h}${i.close.border === 'none' ? '' : '(有边框)'}`))].join(' / '))

// 窄屏：三档都夹到 94vw，且不许溢出
await page.setViewport({ width: 390, height: 780 })
// 上面几条深链会留下 #about 之类的 hash —— 重载前先回到书库，否则「关于」悬浮层会先画出来，
// measure() 取到的是它而不是随后按 ? 开的快捷键表。
await page.goto(`${BASE}/#library`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
if (await waitFor(page, '.app-page-header')) {
  await page.keyboard.press('?')
  const small = await waitFor(page, '.shortcut-modal') ? await measure(page) : null
  if (small) {
    const want = expectWidth('size-m', 390)
    check(`390 宽下「快捷键」收进 94vw（期望 ${want}px）`,
      Math.abs(small.shell.width - want) <= 1 && small.overflow <= 1,
      `实测 ${small.shell.width}px · 溢出 ${small.overflow}px`)
    await page.keyboard.press('Escape')
  } else note('390 宽这一档', '快捷键表没开出来（可能是按键焦点还在别的控件上）')
}

check('全程没有页面 JS 异常', errors.length === 0, errors.slice(0, 3).join(' | '))

const failed = results.filter(item => !item.ok)
console.log(`\noverlay-tier-check: PASS ${results.length - failed.length} / FAIL ${failed.length}`)
for (const item of failed) console.log(`  ✗ ${item.name}${item.detail ? ` [${item.detail}]` : ''}`)
await browser.close()
process.exit(failed.length > 0 ? 1 : 0)
