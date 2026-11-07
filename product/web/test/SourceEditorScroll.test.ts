import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 书源页的滚动结构（用户 2026-11-07：
 * 「书源管理 / 导入、校验与维护你的阅读来源。这个为什么固定位置不随书源编辑上滑」
 * 「基础 搜索 发现 … JSON 这些为什么不随下滑进度改变」）。
 *
 * 原来右栏被切成两截：上面 `.editor-region`（页头）钉死不动，下面 `.sources-content` 自己滚。
 * 页头是"这一页叫什么"，看过一次就够了，钉着等于每条书源都少一截可用高度。
 * 现在整列一起滚，页签条改成粘性 + 跟着滚动高亮。
 *
 * 这份判据盯的是结构事实，不判像素。
 */
const here = import.meta.dirname
const raw = fs.readFileSync(path.resolve(here, '../src/styles.css'), 'utf8')
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')
const panel = fs.readFileSync(path.resolve(here, '../src/features/source-editor/SourceEditorPanel.tsx'), 'utf8')

/** 取某个 @media 块里的规则文本（同一查询可能出现多次，按花括号配平全取）。 */
function mediaBlock(query: string): string {
  const chunks: string[] = []
  let from = 0
  for (;;) {
    const at = css.indexOf(query, from)
    if (at < 0) break
    const open = css.indexOf('{', at)
    let depth = 1
    let i = open + 1
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') depth--
      i++
    }
    chunks.push(css.slice(open + 1, i - 1))
    from = i
  }
  return chunks.join('\n')
}

test('宽屏整列一起滚：页头不再是钉死的一块', () => {
  const wide = mediaBlock('@media (min-width: 721px)')
  const main = /(?:^|\n)\s*\.sources-main \{([\s\S]*?)\}/.exec(wide)?.[1] ?? ''
  assert.ok(main, '找不到宽屏下的 .sources-main 规则')
  assert.match(main, /overflow-y: auto/, '右栏自己滚，页头才会跟着上移')

  const content = /\.sources-page \.sources-content \{([\s\S]*?)\}/.exec(wide)?.[1] ?? ''
  assert.match(content, /overflow: visible/, '内层不能再有独立滚动，否则页头还是钉住的')
  assert.match(content, /flex: 0 0 auto/, '内层按内容高度参与外层滚动')
})

test('页签条粘在滚动容器顶端，且不被卡片的 overflow 挡住', () => {
  const wide = mediaBlock('@media (min-width: 721px)')
  assert.match(
    wide,
    /\.source-form-toolbar \{ position: sticky; top: 0;/,
    '页签条要粘住，否则滚到表单深处就没法跳组了',
  )

  const card = /\.source-editor, \.reading-desk \{([\s\S]*?)\}/.exec(css)?.[1] ?? ''
  assert.match(card, /overflow: clip/, '`hidden` 会把卡片变成滚动容器，里面的 sticky 就粘不住外层')
  assert.doesNotMatch(card, /overflow: hidden/, '不能退回 hidden')
})

test('滚动时高亮跟着换组，点页签时不被联动打断', () => {
  assert.match(panel, /spyLockUntil/, '要有一把锁挡住平滑滚动期间的高亮抖动')
  assert.match(panel, /const line = barBottom \+ Math\.max\(24,/, '判定线按可视区比例算，不是紧贴页签下沿')
  assert.match(panel, /setTab\(previous => \(previous === current \? previous : current\)\)/, '滚到哪组亮哪组')
  assert.match(panel, /spyLockUntil\.current = Date\.now\(\) \+ 800/, '点页签时上锁')
  // JSON 栏没有分组区块，联动要能自己退出
  assert.match(panel, /\.filter\(\(node\): node is HTMLElement => Boolean\(node\)\)/)
})

test('点页签只滚右栏，不把整个窗口滚走', () => {
  // scrollIntoView 会滚所有可滚祖先（含 window），顶栏会跟着消失。
  assert.match(panel, /scroller\.scrollTo\(\{ top: Math\.max\(0, top\), behavior: 'smooth' \}\)/, '要自己算位置滚容器')
  const fn = /const scrollToGroup = \(key: string\) => \{([\s\S]*?)\n  \}/.exec(panel)?.[1] ?? ''
  assert.ok(fn, '找不到 scrollToGroup')
  assert.match(fn, /scrollable/, '窄屏没有那个容器时才退回 scrollIntoView')
  assert.match(fn, /const offset = sticky\?\.getBoundingClientRect\(\)\.height/, '要让开粘性页签条的高度')
})

test('安装横幅的底部余量不在书源页生效，否则整页能滚 92px', () => {
  const wide = mediaBlock('@media (min-width: 721px)')
  assert.match(
    wide,
    /body:has\(\.pwa-install-banner\) \.app-shell:has\(\.sources-page\) \{ padding-bottom: 0; \}/,
    '定高两栏的页面不该再给横幅留余量',
  )
  assert.match(wide, /\.sources-page \.source-list \{ padding-bottom: 72px; \}/, '改成给列表留位置，末行不被横幅盖住')
})
