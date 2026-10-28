import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 窄屏书源页的版面与行为（2026-10-28 截屏审查）。
 *
 * 390×844 的实测里有两处明显不对：
 *
 *  1. `<h1>书源管理</h1>` 出现在书源列表**下面**（y=561），列表自己只有 180px、
 *     从半条书源处切开；点一条书源，编辑器还在更下面，屏幕上没有任何变化。
 *  2. 分组名（emoji + `·` 串）没有截断，会一直流到右侧那颗**绝对定位**的启用开关下面 ——
 *     开关不会被文字推开，于是看起来像"文字压到了开关上"。
 *
 * 这份判据盯的是版面事实（谁在谁前面、列表给多高、副标题会不会截断），
 * 以及窄屏选中/新建后是否真的把编辑器滚进视野；不判具体文案与实现写法。
 */

const here = import.meta.dirname
const raw = fs.readFileSync(path.resolve(here, '../src/styles.css'), 'utf8')
/** 注释里也有选择器字面量，先剥掉。 */
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')

/** 取出某个 @media 查询下所有块的内部文本（同一查询在文件里出现多次，按花括号配平全取）。 */
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

/** 取一条选择器的声明体（精确匹配选择器文本）。 */
function ruleBody(text: string, selector: string): string {
  const at = text.indexOf(`${selector} {`)
  assert.ok(at >= 0, `找不到规则：${selector}`)
  const open = text.indexOf('{', at)
  const close = text.indexOf('}', open)
  return text.slice(open + 1, close)
}

const narrow = mediaBlock('@media (max-width: 720px)')
const sources = fs.readFileSync(path.resolve(here, '../src/pages/SourcesPage.tsx'), 'utf8')

test('书源列表副标题截断：长分组名不许流到绝对定位的开关下面', () => {
  const bodies = [...css.matchAll(/\.source-list small \{([^}]*)\}/g)].map(m => m[1]!)
  assert.ok(bodies.length > 0, '找不到 .source-list small 规则')
  const clipping = bodies.find(body => /overflow:\s*hidden/.test(body))
  assert.ok(clipping, '分组名没有 overflow:hidden —— 长文本会流到开关下面')
  assert.match(clipping!, /text-overflow:\s*ellipsis/, '截断要看得出来（省略号），不是硬切')
  assert.match(clipping!, /white-space:\s*nowrap/, '分组名是一行副标题，不该换行把行高撑起来')
})

test('窄屏纵向主从：页头在列表之前、列表不低于 220px、编辑器有顶栏补偿', () => {
  assert.match(ruleBody(narrow, '.sources-page .sources-main'), /display:\s*contents/,
    '窄屏要把 .sources-main 摊开，否则页头与编辑器始终排在侧栏后面')

  const orderOf = (selector: string) => {
    const m = /order:\s*(\d+)/.exec(ruleBody(narrow, selector))
    assert.ok(m, `${selector} 没有 order`)
    return Number(m![1])
  }
  const title = orderOf('.sources-page .editor-region')
  const list = orderOf('.sources-page .source-sidebar')
  const editor = orderOf('.sources-page .sources-content')
  assert.ok(title < list && list < editor,
    `顺序应为 页头(${title}) → 列表(${list}) → 编辑器(${editor})`)

  const listRule = ruleBody(narrow, '.sources-page .source-list')
  const minHeight = /max-height:\s*clamp\((\d+)px/.exec(listRule)
  assert.ok(minHeight, '窄屏书源列表应有一个按屏高给的 max-height')
  assert.ok(Number(minHeight![1]) >= 220,
    `列表最高才 ${minHeight![1]}px —— 180px 那档只装得下两条半`)

  const contentRule = ruleBody(narrow, '.sources-page .sources-content')
  const margin = Number(/scroll-margin-top:\s*calc\((\d+)px/.exec(contentRule)?.[1] ?? '0')
  assert.ok(margin >= 56,
    `编辑器滚到顶时只留 ${margin}px，会被 56px 的 sticky 顶栏盖住`)
})

test('窄屏选中 / 新建书源后，把编辑器滚进视野（内容长高后追一次）', () => {
  assert.match(sources, /const revealEditorOnPhone = \(\) => \{/, '缺少窄屏滚动助手')

  const helper = sources.slice(sources.indexOf('const revealEditorOnPhone'))
  const head = helper.slice(0, 1600)
  assert.match(head, /matchMedia\('\(max-width: 720px\)'\)/,
    '助手要先判断窄屏 —— 宽屏两栏并排，滚动会把人甩走')
  assert.match(head, /target\.scrollIntoView\(\{ block: 'start', behavior: 'auto' \}\)/,
    '助手要把编辑器顶部滚进视野；smooth 会因内容异步换上来而中断，要用即时')
  // 刚点下去编辑器还是空壳、文档高度不够，滚动会被截在半路：内容长高后要再对一次
  assert.match(head, /new ResizeObserver/, '编辑器异步长高后要重新对齐，否则只滚到列表底部')
  assert.match(head, /window\.addEventListener\('wheel', stop/, '用户自己滚动后要停手')
  assert.match(head, /window\.addEventListener\('touchstart', stop/, '用户自己滑动后要停手')

  const calls = sources.match(/onSelect\((?:source|null)\); revealEditorOnPhone\(\)/g) ?? []
  assert.ok(calls.length >= 3,
    `列表点击、长按菜单「编辑此书源」、新建书源三条入口都要滚，实际只找到 ${calls.length} 处`)
})
