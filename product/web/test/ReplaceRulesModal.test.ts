import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReplaceRulesModal } from '../src/components/ReplaceRulesModal'

// 0.6.27 起规则不再是整页（ReplaceRulesPage 已删，入口在「设置 → 规则」与阅读器，
// 都开这个弹窗）。静态渲染验结构与从整页版搬进来的批量启停按钮还在。
test('ReplaceRulesModal - 悬浮层结构与批量启停（整页并入后不许丢功能）', () => {
  const html = renderToStaticMarkup(
    React.createElement(ReplaceRulesModal, { isOpen: true, onClose: () => {} }),
  )
  assert.ok(!/section-kicker/.test(html), '不该再挂 kicker 说明行')
  assert.ok(html.includes('替换净化规则管理'), '应有标题')
  assert.ok(html.includes('新建规则'), '新建规则按钮')
  assert.ok(html.includes('导入'), '导入按钮')
  assert.ok(html.includes('全部启用'), '批量启用按钮（从整页版搬入）')
  assert.ok(html.includes('全部禁用'), '批量禁用按钮（从整页版搬入）')
  assert.ok(html.includes('搜索规则名'), '搜索框')
  assert.ok(html.includes('共 0 条'), '规则计数徽章（空数据也要如实显示）')
  assert.ok(html.includes('dialog-shell'), '走统一弹窗外壳')
})
