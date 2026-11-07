import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { clampSidebarWidth, SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from '../src/lib/sidebarWidth.ts'

/**
 * 书源页左栏宽度（用户 2026-11-07：「书源管理界面，左侧位置太狭窄」）。
 *
 * 左栏原来写死 280px：5,574 个书源里长名字一大片，280 只放得下「四字书名 + 两个徽标」，
 * 其余被截成「这个反派有点良…」，选源全靠猜。这份判据盯四件事：
 *
 *  1. 宽度是变量、默认值比 280 宽，栅格真的用了这个变量；
 *  2. 夹取边界有效（拖到负数不会把左栏拖没，拖过头不会把右栏挤成一条缝）；
 *  3. 把手存在且可访问（role=separator + 方向键 + 双击复位），窄屏堆叠时不出现在版面里；
 *  4. 宽度会持久化，且只在松手时写一次存储。
 */

const here = import.meta.dirname
const raw = fs.readFileSync(path.resolve(here, '../src/styles.css'), 'utf8')
/** 注释里也有选择器字面量，先剥掉。 */
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')
const page = fs.readFileSync(path.resolve(here, '../src/features/source-editor/SourcesPage.tsx'), 'utf8')

test('左栏宽度是变量，默认值比原来那档宽', () => {
  assert.ok(SIDEBAR_WIDTH_DEFAULT > 280, `默认宽度应比 280 宽，实际 ${SIDEBAR_WIDTH_DEFAULT}`)
  assert.ok(SIDEBAR_WIDTH_MIN < SIDEBAR_WIDTH_DEFAULT, '下限要低于默认值，否则拖窄没有意义')
  assert.ok(SIDEBAR_WIDTH_MAX > SIDEBAR_WIDTH_DEFAULT, '上限要高于默认值')

  assert.match(
    css,
    /\.sources-page \{[^}]*grid-template-columns: var\(--source-sidebar-width, \d+px\) minmax\(0, 1fr\)/,
    '栅格第一列必须读 CSS 变量，并且留一个 px 兜底',
  )
  assert.match(page, /'--source-sidebar-width': `\$\{sidebarWidth\}px`/, '宽度要由状态下发成 CSS 变量')
})

test('夹取边界：负数/超限/NaN 都不会写出坏值', () => {
  assert.equal(clampSidebarWidth(0), SIDEBAR_WIDTH_MIN)
  assert.equal(clampSidebarWidth(-500), SIDEBAR_WIDTH_MIN)
  assert.equal(clampSidebarWidth(9999), SIDEBAR_WIDTH_MAX)
  assert.equal(clampSidebarWidth(Number.NaN), SIDEBAR_WIDTH_DEFAULT, 'NaN 会原样进 style，必须回落')
  assert.equal(clampSidebarWidth(Number.POSITIVE_INFINITY), SIDEBAR_WIDTH_DEFAULT)
  assert.equal(clampSidebarWidth(321.6), 322, '取整，避免半像素宽度')
})

test('把手可访问，且窄屏堆叠时不出现在版面里', () => {
  assert.match(page, /className="source-sidebar-resizer"/)
  assert.match(page, /role="separator"/)
  assert.match(page, /aria-orientation="vertical"/)
  assert.match(page, /aria-valuenow=\{sidebarWidth\}/)
  assert.match(page, /tabIndex=\{0\}/, '要能用键盘调，不能只支持鼠标')
  assert.match(page, /event\.key === 'ArrowRight'/, '方向键微调')
  assert.match(page, /onDoubleClick=\{resetSidebarWidth\}/, '双击回到默认宽度')

  // 窄屏是纵向堆叠，没有两栏比例可调：把手必须藏起来，否则会盖在列表上。
  const narrow = /@media \(max-width: 720px\) \{[\s\S]*?\n\}/.test(css)
  assert.ok(narrow, '窄屏断点要存在')
  assert.match(css, /\.source-sidebar-resizer \{ display: none; \}/, '窄屏必须隐藏把手')

  // 把手靠栅格定位而不是绝对定位：壁纸模式会给 .sources-page 加内边距，绝对定位会错位。
  assert.match(css, /\.source-sidebar-resizer \{[^}]*grid-column: 1;[^}]*justify-self: end;/, '要锚在第一列右缘')
  assert.doesNotMatch(css, /\.source-sidebar-resizer \{[^}]*position: absolute;/, '不能用绝对定位')
})

test('宽度会持久化，且只在松手时写一次', () => {
  assert.match(page, /useState\(readStoredSidebarWidth\)/, '初值来自存储')
  assert.match(page, /storeSidebarWidth\(sidebarWidthRef\.current\)/, '松手时落盘')
  assert.match(page, /window\.addEventListener\('pointerup', onEnd\)/)

  const onMove = /const onMove = \(moveEvent: PointerEvent\) => ([^\n]+)/.exec(page)?.[1] ?? ''
  assert.ok(onMove.length > 0, '要能找到拖动回调')
  assert.doesNotMatch(onMove, /storeSidebarWidth/, '拖动过程中不要每帧写存储')

  // 原点取左栏自己的左缘，不是整页的 —— 壁纸模式下两者差 14px。
  assert.match(page, /const originLeft = sidebar\.getBoundingClientRect\(\)\.left/)
})
