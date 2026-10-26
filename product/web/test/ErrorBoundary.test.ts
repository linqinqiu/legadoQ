import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BoundaryFallback, ErrorBoundary, boundarySummary } from '../src/components/ErrorBoundary'

/**
 * 渲染崩掉的兜底（AI-2 任务 C·模块「阅读器渲染」第一条发现：全站原来一处错误边界都没有，
 * 任何渲染期抛错会把整棵树卸载成白屏 —— 0.6.23 那轮 `saveReaderSettings` 在隐私模式"炸整棵树"
 * 就是同形状的病）。
 *
 * 钉四件：① 各种 throw 值都收成一句人话；② 兜底面板本身画得出、按钮不落在表单里当提交键；
 * ③ 两处挂载点都在（阅读器一支 + 根）；④ 面板样式里引用的令牌真在 `:root` 里定义过
 * —— 编一个不存在的 `var(--x)` 不报错，只是那条样式永远不生效。
 */

const SRC = path.resolve(import.meta.dirname, '..', 'src')

test('boundarySummary - Error / 字符串 / 什么都没有都收成一句能给人看的话', () => {
  assert.equal(boundarySummary(new Error('分栏算术越界')), '分栏算术越界')
  assert.equal(boundarySummary('直接抛的字符串'), '直接抛的字符串')
  // 反向对照：空 message 的 Error 不能渲染成"崩了 ："这种半截话
  assert.equal(boundarySummary(new Error('   ')), '界面在这里抛了一个没有信息的错误')
  assert.equal(boundarySummary(undefined), '界面在这里抛了一个没有信息的错误')
  assert.equal(boundarySummary(0), '界面在这里抛了一个没有信息的错误')
  assert.equal(boundarySummary({ oops: 1 }), '界面在这里抛了一个没有信息的错误')
})

test('BoundaryFallback - 说清"你的东西没丢"，两个出口都是 type="button"', () => {
  const html = renderToStaticMarkup(React.createElement(BoundaryFallback, {
    region: '阅读器',
    message: 'Cannot read properties of undefined',
    onRetry: () => {},
    onExit: () => {},
  }))
  assert.match(html, /阅读器崩了/)
  assert.match(html, /阅读进度与缓存都没有被这次错误改动/, '必须先说一句"东西还在"，白屏最吓人的就是这句没说')
  assert.match(html, /Cannot read properties of undefined/, '原文要露出来，否则提 issue 时没有线索')
  assert.doesNotMatch(html, /<(form|input type="submit")/, '不是表单，不该出现提交语义')
  const buttons = html.match(/<button[^>]*>/g) ?? []
  assert.equal(buttons.length, 2, '重试 + 返回两颗')
  for (const b of buttons) assert.match(b, /type="button"/, '辅助按钮必须显式 type="button"（AGENTS §5）')
  assert.match(html, /role="alert"/)
  // 反向对照：不传出口时不该画出一颗点了没反应的"返回书架"
  const noExit = renderToStaticMarkup(React.createElement(BoundaryFallback, { region: '页面', message: 'x', onRetry: () => {} }))
  assert.doesNotMatch(noExit, /返回书架/)
  assert.equal((noExit.match(/<button[^>]*>/g) ?? []).length, 1)
})

test('两处挂载点都在：阅读器那一支单独包，根上再兜一层', () => {
  const main = fs.readFileSync(path.join(SRC, 'main.tsx'), 'utf8')
  assert.match(main, /<ErrorBoundary region="阅读器"/, '阅读器崩了不该把外壳与书架一起带走')
  assert.match(main, /<ErrorBoundary region="页面">\s*<App \/>/, '根上没有兜底时，外壳自己抛错就只剩白屏')
  // 反向对照：裸挂载（没有边界）不许回来
  assert.doesNotMatch(main, /createRoot\([^)]*\)!\.render\(<App \/>\)/)
})

test('崩了要留痕：componentDidCatch 把堆栈打进 console，界面只给一句人话', () => {
  const src = fs.readFileSync(path.join(SRC, 'components', 'ErrorBoundary.tsx'), 'utf8')
  assert.match(src, /componentDidCatch\([\s\S]*console\.error/)
  assert.match(src, /getDerivedStateFromError/)
})

test('兜底面板用的令牌必须在 styles.css 里真定义过', () => {
  const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8')
  const block = css.match(/\.error-boundary \{[\s\S]*?\}/)?.[0] ?? ''
  assert.ok(block.length > 0, '.error-boundary 这一档得存在')
  const all = css.slice(css.indexOf('.error-boundary'))
  const used = [...all.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map(m => m[1])
  assert.ok(used.length >= 8, `这一档应当在用设计令牌（实际 ${used.length} 个）`)
  const declared = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1]))
  const missing = [...new Set(used)].filter(name => name !== '--font-mono' && !declared.has(name))
  assert.deepEqual(missing, [], `引用了没定义过的令牌：${missing.join(', ')}（不报错，只是那条声明永远不生效）`)
})
