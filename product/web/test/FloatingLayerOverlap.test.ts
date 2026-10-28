import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 悬浮球（AI 入口）与浮层之间的让位关系。
 *
 * 球是**常驻**控件，于是它跟谁叠在一起就成了一个长期问题，而这类问题在源码审查看不出来 ——
 * 要看层级数字与几何数字对不对得上。2026-10-26 实测到两处：
 *
 *  1. 球的 z 是 60，`.overlay-backdrop` 是 100（模态盖得住球，对），但底部抽屉那一档
 *     `.overlay-backdrop.is-sheet` 特意降到 38、阅读器抽屉 `.reader-drawer` 是 30 ——
 *     两者都压在球**下面**。抽屉是从底部/侧边滑出来的操作面，球正好盖在它上面，
 *     用户点抽屉里靠右那颗键时点到的是球。
 *  2. 窄屏下球停在 `bottom: 14px`，而阅读器底部那条 `.mobile-reader-nav` 高
 *     `calc(58px + 安全区)`、五颗键铺满整行 —— 球压住最右边那颗（手机上点不到）。
 *     注释当时写着"避免挡住底部操作条"，实际没做到。
 *
 * 这份判据钉的是**数字关系**（谁在谁上面、抬多少才够），不是某条规则的字面文本，
 * 所以改样式实现方式不会误红，改错了才会红。
 */

const here = import.meta.dirname
const raw = fs.readFileSync(path.resolve(here, '../src/styles.css'), 'utf8')
/** 注释里也会出现选择器字面量，先剥掉，免得把注释当成规则。 */
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')

/** 扫出所有"选择器 { 声明 }"。@ 规则只当容器：钻进去继续扫，不当成一条规则。 */
function rulesIn(text: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = []
  let i = 0
  while (i < text.length) {
    const open = text.indexOf('{', i)
    if (open < 0) break
    let depth = 1
    let j = open + 1
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth++
      else if (text[j] === '}') depth--
      j++
    }
    const prev = Math.max(text.lastIndexOf('}', open), text.lastIndexOf(';', open))
    const selector = text.slice(prev + 1, open).trim()
    if (selector.startsWith('@')) { i = open + 1; continue }
    out.push({ selector, body: text.slice(open + 1, j - 1) })
    i = j
  }
  return out
}

/** 取出某个 @media 查询下所有块的内部文本（同一查询在文件里出现了 11 次，
 *  导航在其中一个、球在另一个，只取第一个必然读错）。按花括号配平，不按行号。 */
function mediaBlock(query: string): string {
  const chunks: string[] = []
  let from = 0
  for (;;) {
    const at = css.indexOf(query, from)
    if (at < 0) break
    const open = css.indexOf('{', at)
    let depth = 1
    let j = open + 1
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++
      else if (css[j] === '}') depth--
      j++
    }
    chunks.push(css.slice(open + 1, j - 1))
    from = j
  }
  assert.ok(chunks.length > 0, `styles.css 里找不到 ${query}`)
  return chunks.join('\n')
}

const rules = rulesIn(css)
const narrow = rulesIn(mediaBlock('@media (max-width: 720px)'))

/** 取某个选择器那条规则的声明体。同名多条时取最后一条（层叠里后者生效）。 */
function bodyOf(list: Array<{ selector: string; body: string }>, selector: string): string {
  const hits = list.filter((r) => r.selector === selector)
  assert.ok(hits.length > 0, `少了规则：${selector}`)
  return hits[hits.length - 1]!.body
}

/** 从声明体里读一个像素数（`bottom: calc(66px + var(--safe-bottom))` 这种也读得出来）。
 *  属性名前面加了否定后顾：不然 `height` 会先命中 `min-height` / `max-height`，读出错的那个数。 */
function px(body: string, prop: string): number {
  const m = new RegExp(`(?<![-\\w])${prop}:\\s*(?:calc\\()?\\s*(-?\\d+)px`).exec(body)
  assert.ok(m, `规则里读不到 ${prop} 的像素值：${body.slice(0, 80)}`)
  return Number(m![1])
}

const zOf = (selector: string) => Number(/z-index:\s*(\d+)/.exec(bodyOf(rules, selector))?.[1] ?? '0')

test('悬浮球让位：底部抽屉与阅读器抽屉打开时，球不吃点击（它们的 z 都比球低）', () => {
  // 前提要先成立，否则"让位"这件事根本没意义
  const fab = zOf('.ai-fab')
  assert.ok(fab > 0, '.ai-fab 没有 z-index')
  assert.ok(zOf('.overlay-backdrop') > fab, '模态遮罩必须盖得住球（常驻 ≠ 最上）')
  assert.ok(zOf('.overlay-backdrop.is-sheet') < fab, '底部抽屉那一档确实压在球下面，所以才要让位')
  assert.ok(zOf('.reader-drawer') < fab, '阅读器抽屉确实压在球下面，所以才要让位')

  // 让位规则本身：两种浮层各一条，合在一个选择器组里也算
  const yielding = rules.filter((r) => /\.ai-fab:not\(\.ai-fab-open\)/.test(r.selector))
  const coversSheet = yielding.some((r) => r.selector.includes('body:has(.overlay-backdrop.is-sheet)'))
  const coversDrawer = yielding.some((r) => r.selector.includes('body:has(.reader-drawer.open)'))
  assert.ok(coversSheet, '底部抽屉打开时球要让位（body:has(.overlay-backdrop.is-sheet)）')
  assert.ok(coversDrawer, '阅读器抽屉打开时球要让位（body:has(.reader-drawer.open)）')

  // 让位要是真让位：看不见 + 点不到。只改 opacity 的话，球还在原地吃点击。
  for (const r of yielding) {
    assert.match(r.body, /pointer-events:\s*none/, `${r.selector} 只藏了样子，还在吃点击`)
    assert.match(r.body, /opacity:\s*0/, `${r.selector} 没有真的隐去`)
  }
  // 面板开着时那颗球是"收起"的把手，不能被自己让位掉
  assert.ok(yielding.every((r) => r.selector.includes(':not(.ai-fab-open)')),
    '让位规则要排除 .ai-fab-open —— 面板开着时球就是收起键')
})

test('窄屏：底部导航在屏上时，球 / 面板都抬到它上面，两者互不相压', () => {
  const navHeight = px(bodyOf(narrow, '.mobile-reader-nav'), 'height')
  const fabSize = px(bodyOf(narrow, '.ai-fab'), 'height')
  const GAP = 4

  const when = 'body:has(.reader-workspace:not(.toolbars-hidden) .mobile-reader-nav)'
  const fabRaised = px(bodyOf(narrow, `${when} .ai-fab`), 'bottom')
  const panelRaised = px(bodyOf(narrow, `${when} .ai-fab-panel`), 'bottom')

  assert.ok(fabRaised >= navHeight + GAP,
    `球抬到 ${fabRaised}px，压不住 ${navHeight}px 高的导航（至少要 ${navHeight + GAP}px）`)
  assert.ok(panelRaised >= fabRaised + fabSize + GAP,
    `面板底边 ${panelRaised}px 会与抬起来后的球（${fabRaised}+${fabSize}px）叠在一起`)

  // 阅读器是提前 return 的独立壳，PwaManager 不挂在那里，安装条不可能出现 ——
  // 旧版为"阅读器里的安装条"写过一套叠加档位，那是死样式（与组件实际渲染树对不上）。
  assert.ok(!narrow.some((r) => r.selector.includes('.pwa-install-banner') && r.selector.includes('reader-workspace')),
    '阅读器里没有安装条，不该再有"阅读器 + 安装条"的叠加抬高档位')

  // 沉浸态下导航是收起来的，那时球该回到贴底的位置 —— 条件里必须带这个否定
  assert.ok(narrow.every((r) => !r.selector.includes('.mobile-reader-nav)') || r.selector.includes(':not(.toolbars-hidden)')),
    '抬高的条件要排除沉浸态（.toolbars-hidden），否则导航收起后球还悬在半空')

  // 默认位置（没进阅读器 / 导航不在）仍然是贴底那颗，别把全局都抬了
  assert.equal(px(bodyOf(narrow, '.ai-fab'), 'bottom'), 14, '窄屏默认球位应保持 bottom:14px')
})

test('窄屏：安装提示条在时，球与面板抬到它上面，页面底部也留出等高的余量', () => {
  // 390×844 实测：安装条 bottom 16、高 63；默认球 bottom 14，点不到也看不见。
  const BANNER_H = 63
  const GAP = 4

  const banner = bodyOf(rules, '.pwa-install-banner')
  const bannerBottom = Number(/bottom:\s*max\((\d+)px/.exec(banner)?.[1])
  assert.ok(bannerBottom > 0, '安装条的 bottom 应有一个像素基线（max(16px, 安全区)）')
  assert.ok(zOf('.pwa-install-banner') > zOf('.ai-fab'), '前提：安装条的层级确实压在球上面')

  const fabWhenBanner = bodyOf(narrow, 'body:has(.pwa-install-banner) .ai-fab')
  const panelWhenBanner = bodyOf(narrow, 'body:has(.pwa-install-banner) .ai-fab-panel')
  const fabBottom = px(fabWhenBanner, 'bottom')
  const panelBottom = px(panelWhenBanner, 'bottom')
  const fabSize = px(bodyOf(narrow, '.ai-fab'), 'height')

  assert.ok(fabBottom >= bannerBottom + BANNER_H + GAP,
    `提示条在时球只抬到 ${fabBottom}px，仍被 ${BANNER_H}px 高的提示条（底边 ${bannerBottom}）盖住`)
  assert.ok(panelBottom >= fabBottom + fabSize + GAP,
    `面板底边 ${panelBottom}px 会与抬起来后的球（${fabBottom}+${fabSize}px）叠在一起`)

  // 内容也要让路：安装条是 fixed，最后一行滚到底时会落在它下面（390×844 实测被盖 34px）。
  const shellPadding = px(bodyOf(rules, 'body:has(.pwa-install-banner) .app-shell'), 'padding-bottom')
  assert.ok(shellPadding >= bannerBottom + BANNER_H,
    `.app-shell 只留了 ${shellPadding}px 底部余量，安装条底边 ${bannerBottom} + 高 ${BANNER_H}px 之外没有富余`)

  // 没有安装条时，球仍是贴底那颗（别把全局都抬了）
  assert.equal(px(bodyOf(narrow, '.ai-fab'), 'bottom'), 14, '窄屏默认球位应保持 bottom:14px')
})

test('死样式不许回来：实验室与浮动窗口那两套选择器已随组件一起删掉', () => {
  // 组件（features/settings/WindowPrefsSection.tsx、features/builtinSettings.ts）已经不在仓库里，
  // 这两套选择器在 src/ 与 index.html 里零引用。留着的代价不只是体积：
  // 它们描述的是一个"能拖动、能钉住、能最小化"的浮动窗口，而产品里根本没有这个东西。
  for (const family of ['lab-', 'fw-', 'settings-plugin', 'settings-section-plugin']) {
    assert.ok(!new RegExp(`\\.${family}`).test(css), `.${family}* 又回来了 —— 对应的组件早已删除`)
  }
  // 反向守一下：删的时候夹在死块中间的活样式不能被一起带走
  for (const live of ['ai-bubble-tools', 'ai-tool-list', 'ai-tool-item']) {
    assert.ok(rules.some((r) => r.selector.includes(`.${live}`)), `.${live} 是活样式，被误删了`)
  }
})
