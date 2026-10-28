import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 壁纸模式下的"表面材质"判据。
 *
 * 背景：壁纸打开后，一屏里允许出现的材质只有两种 —— 压在图上的半透明玻璃（面板/卡片/浮层），
 * 以及必须保证可读性的不透明控件（输入框、按钮、阅读正文）。实际做的时候只给前三处
 * （顶栏、设置行、书架卡）加了玻璃，其它页面的内容面板还是 `--surface` 一整块白，
 * 同一套壁纸设置在不同路由下看起来像两种产品；设置页还把分区容器也铺了底，
 * 「阅读」标题到「快捷键」之间多出一条横贯全宽的色带。
 *
 * 判的就是这条规则有没有被下一处新面板悄悄绕开。
 */
const cssPath = path.resolve(import.meta.dirname, '..', 'src', 'styles.css')
const css = fs.readFileSync(cssPath, 'utf8')

/** 取出 `.settings-row` 所在的那条玻璃规则（选择器列表 + 声明），找不到时返回空串。 */
const glassRule = /html\[data-wallpaper="on"\] \.settings-row,[\s\S]*?\{[\s\S]*?\}/.exec(css)?.[0] ?? ''

const mustHaveGlass = [
  '.settings-row',
  '.shelf-card',
  '.shelf-resume',
  '.library-idle a',
  '.library-results',
  '.explore-results',
  '.subscription-panel',
  '.source-editor',
  '.reading-desk',
  '.source-sidebar',
]

test('壁纸玻璃规则覆盖各路由的主要面板，而不是只有设置页和书架', () => {
  assert.ok(glassRule.length > 200, '找不到壁纸玻璃规则（取空串时下面的断言对什么都成立）')
  for (const selector of mustHaveGlass) {
    assert.ok(
      glassRule.includes(`html[data-wallpaper="on"] ${selector}`),
      `${selector} 没有进玻璃规则：壁纸模式下它仍是一整块 --surface 白底，和其它页断成两套`,
    )
  }
})

test('设置页分区容器不铺底：标题到第一张卡片之间不再有长条', () => {
  assert.ok(!glassRule.includes('html[data-wallpaper="on"] .settings-section,'),
    '.settings-section 又回到玻璃规则里了：它一铺底就是「阅读 → 快捷键」那条横贯全宽的色带')
})

test('设置行容器让出底色：玻璃行不能隔着 --line 底盘采样', () => {
  const rows = /html\[data-wallpaper="on"\] \.settings-rows \{([\s\S]*?)\}/.exec(css)?.[1] ?? ''
  assert.match(rows, /background: transparent/,
    '行容器还铺 --line：行卡片的 backdrop-filter 只能模糊到这层底色，玻璃会发灰')
  assert.match(rows, /gap: 0/,
    '行容器还留 1px 缝：缝里透出的是壁纸而不是分隔线，滚动时像一道亮缝')
  assert.match(css, /html\[data-wallpaper="on"\] \.settings-rows > \.settings-row \+ \.settings-row \{[^}]*border-top/,
    '去掉父级底之后必须给后续行补上边线，否则两张行卡片糊成一整块')
})

test('内容面板不做 backdrop-filter：模糊只留给顶栏、标题胶囊与弹层', () => {
  // 实测：面板 35% + 毛玻璃 18px 时，发现页滚动 9fps、订阅 14fps、设置 28fps。
  // 内容面跟着页面滚，每帧都要重采样整块视口；关掉它们的模糊后三页回到 61/59/61fps。
  assert.ok(!/backdrop-filter/.test(glassRule),
    '内容面板/卡片又加回 backdrop-filter 了：大面积滚动面每帧重采样，整页交互会发滞')
  const chrome = /html\[data-wallpaper="on"\] \.app-page-header,[\s\S]*?\{[\s\S]*?\}/.exec(css)?.[0] ?? ''
  assert.match(chrome, /backdrop-filter: blur\(var\(--wallpaper-glass-blur/,
    '顶栏/底栏这类小面积固定层应当保留毛玻璃，否则用户调的毛玻璃值就完全没效果了')
})

test('面板里的格子不再各自铺白：探索结果与书源搜索共用面板的玻璃', () => {
  const cells = /html\[data-wallpaper="on"\] \.explore-card,\s*html\[data-wallpaper="on"\] \.search-results button \{([\s\S]*?)\}/.exec(css)?.[1] ?? ''
  assert.match(cells, /background: transparent/,
    '面板是玻璃、格子里又是白底，等于一屏两套材质')
  assert.match(css, /html\[data-wallpaper="on"\] \.explore-card:hover,\s*html\[data-wallpaper="on"\] \.search-results button:hover \{[^}]*color-mix\(in srgb, var\(--ink\) 6%, transparent\)/,
    '格子透明后 hover 还回落到 --surface-muted 的不透明底，鼠标一过就闪出一块白')
})

/**
 * 书源左栏在常规主题里是不透明的贴边分栏，贴边没问题；壁纸模式下它透出壁纸，
 * 就成了一整块四角全直的色带（桌面 280×832、窄屏通栏 390×612），
 * 和右边圆角的编辑器并排时像两种产品（用户 2026-10-28：「还有一部分纯方形的不好」）。
 * 判据钉三件事：卡片有圆角与描边、桌面让出页边、窄屏不铺通栏。
 */
test('壁纸下书源左栏是一张内缩圆角卡，不是贴边方角色带', () => {
  const card = /html\[data-wallpaper="on"\] \.sources-page \.source-sidebar \{([\s\S]*?)\}/.exec(css)?.[1] ?? ''
  assert.match(card, /border-radius:\s*var\(--r-3\)/,
    '左栏四角还是直的：壁纸透上来后就是一整块方形色带')
  assert.match(card, /border:\s*1px/,
    '卡片没有描边：大面积半透明色块不勾边，会和右边有描边的编辑器断成两种材质')
  assert.match(css,
    /@media \(min-width: 721px\) \{\s*html\[data-wallpaper="on"\] \.sources-page \{ padding: 14px 0 14px 14px; \}/,
    '桌面没给左栏让边：它仍然贴着视口左缘与顶栏，圆角只会贴在屏幕外面看不见')
  assert.match(css,
    /@media \(max-width: 720px\) \{\s*html\[data-wallpaper="on"\] \.sources-page \.source-sidebar \{ margin: 4px 18px 10px; \}/,
    '窄屏还把左栏摊成通栏：390px 宽的一整条贴边色带（18px 才和下面的编辑器卡片对齐）')
})

test('「新建书源」与分组/筛选/导入对齐，不再是一块贴墙的绿色方条', () => {
  const create = /\.source-create-btn \{([\s\S]*?)\}/.exec(css)?.[1] ?? ''
  assert.ok(create, '找不到 .source-create-btn 规则')
  assert.doesNotMatch(create, /width:\s*100%/,
    '按钮又铺满整栏：绿色方块贴着两侧墙，和 16px 内缩的筛选/导入不在一条线上')
  assert.match(create, /margin:\s*0 16px/,
    '按钮缺少与兄弟控件一致的 16px 边距')
})
