import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TapZoneEditor } from '../src/reader/TapZoneEditor'
import { DEFAULT_MAPS, type TapMap } from '../src/reader/tapZones'

/**
 * 「点击区域」编辑器（用户 2026-10-09：「区域设置改提供横竖虚线，自定义，但是要区分翻页方式的影响」
 * +「这个改成底下一小行，可以折叠进去，目的是显示更多书籍内容」）。
 *
 * 静态渲染钉三件：① 默认折叠成底部一行；② 分页画竖虚线、滚动画横虚线（区分翻页方式）；
 * ③ 分区徽标报的是动作名，不是空白。
 */

const render = (map: TapMap, mode: 'paginate' | 'scroll' = 'paginate') => renderToStaticMarkup(
  React.createElement(TapZoneEditor, {
    map, mode, onMap: () => {}, onMode: () => {}, onPreset: () => {}, onClose: () => {},
  }),
)

test('默认折叠：底部只有一行，动作按钮不铺出来（"改成底下一小行，可以折叠进去"）', () => {
  const html = render(DEFAULT_MAPS.paginate)
  assert.ok(html.includes('tap-zone-strip'), '要有底部控制条')
  assert.ok(html.includes('aria-expanded="false"'), '默认折叠')
  assert.ok(html.includes('点击区域'), '折叠时也要报当前编的是哪张表')
  assert.ok(!html.includes('tap-zone-actions'), '折叠时不该把动作按钮全铺出来')
  assert.ok(html.includes('完成'), '要有一颗完成键收工')
})

test('分页模式：两条竖虚线分左右列，三格是上一页 / 工具栏 / 下一页', () => {
  const html = render(DEFAULT_MAPS.paginate, 'paginate')
  assert.equal((html.match(/tap-zone-line is-v/g) || []).length, 2, '两条竖虚线')
  assert.equal((html.match(/tap-zone-line is-h/g) || []).length, 0, '分页模式不该有横虚线')
  assert.ok(html.includes('上一页') && html.includes('工具栏') && html.includes('下一页'), '三格徽标要报动作名')
})

test('滚动模式：两条横虚线分上下段（"区分翻页方式的影响"）', () => {
  const html = render(DEFAULT_MAPS.scroll, 'scroll')
  assert.equal((html.match(/tap-zone-line is-v/g) || []).length, 0, '滚动模式不该有竖虚线')
  assert.equal((html.match(/tap-zone-line is-h/g) || []).length, 2, '两条横虚线')
  assert.ok(html.includes('连续滚动'), '折叠行要报当前翻页方式')
})

test('编辑层盖在正文上、正文仍渲染：surface 是独立一层（不是把正文换掉）', () => {
  const html = render(DEFAULT_MAPS.paginate)
  assert.ok(html.includes('tap-zone-surface'), '要有覆盖层容器')
  assert.equal((html.match(/tap-zone-cell/g) || []).length, 3, '默认三格')
})
