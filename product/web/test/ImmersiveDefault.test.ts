import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * P1-T3「阅读三层解耦 + 沉浸式」收尾回归判据。
 *
 * 设计取舍：本仓库前端判据运行在 `tsx test/run-all.ts`（node:test + node:assert），
 * 依赖里**没有 jsdom**，纯组件渲染（方案 A）在此环境无法稳定跑通。
 * 因此走方案 B：直接读源码，断言关键契约仍在，防止回退档 / 重构把它悄悄改坏。
 *
 * 锁定的契约：
 *  1. 默认沉浸式 —— `toolbarsVisible` 初始为 `false`（顶/底栏默认收起，不抢正文）。
 *  2. 顶/底栏是 overlay —— 样式里 `.md3-topbar, .md3-bottombar` 为 `position: fixed`，
 *     不挤占正文文档流；正文 `.reading-content` 有顶部留白避开它们。
 */

const testDir = dirname(fileURLToPath(import.meta.url))
const webRoot = dirname(testDir)
const readerDir = join(webRoot, 'src', 'reader')
const readerScreenSrc = readFileSync(join(readerDir, 'ReaderScreen.tsx'), 'utf8')
const stylesSrc = readFileSync(join(webRoot, 'src', 'styles.css'), 'utf8')

/** 取某个 CSS 规则块（不含嵌套）的内容，便于在块内断言。 */
function ruleBlock(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 's')
  const m = css.match(re)
  return m ? m[1] : null
}

test('P1-T3 默认沉浸式：toolbarsVisible 初始为 false（顶/底栏默认收起，不抢正文）', () => {
  // 顶/底栏默认隐藏由 ReaderScreen 的 state 初值决定，是「默认安静」的源头。
  assert.ok(readerScreenSrc.includes('toolbarsVisible'), 'ReaderScreen 应有 toolbarsVisible 状态')
  assert.ok(
    /const \[toolbarsVisible, setToolbarsVisible\] = useState\(false\)/.test(readerScreenSrc),
    'toolbarsVisible 必须初始化为 false（沉浸式默认实现）',
  )
})

test('P1-T3 顶/底栏为 overlay 不挤占正文，正文有顶部留白避开', () => {
  // 顶栏与底栏必须浮在正文之上（fixed），而非占文档流把正文往下挤。
  // 精确匹配「.md3-topbar, .md3-bottombar { ... }」这一组（避免误命中 sidebar-pinned 之类的派生选择器）。
  const group = stylesSrc.match(/\.md3-topbar,\s*\.md3-bottombar\s*\{([^}]*)\}/s)
  assert.ok(group !== null, 'styles.css 应定义 .md3-topbar 与 .md3-bottombar 分组')
  assert.ok(/position:\s*fixed/.test(group![1]), '顶/底栏必须为 position: fixed（overlay，不挤占正文文档流）')
  assert.ok(/z-index:\s*20/.test(group![1]), '顶/底栏应有高于正文层的 z-index（浮在正文之上）')

  // 正文区顶部留白：保证首行不被渐隐浮层遮住（沉浸式下正文默认可见且不被压）。
  const contentBlock = ruleBlock(stylesSrc, '.reading-content')
  assert.ok(contentBlock !== null, '应定义 .reading-content 正文容器')
  assert.ok(
    /padding(-top)?:\s*(calc\()?clamp\(64px/.test(contentBlock ?? ''),
    '.reading-content 顶部应保留约 64–88px 留白，避开顶栏渐隐区',
  )
})
