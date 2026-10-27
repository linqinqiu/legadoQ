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
 * 因此走方案 B：直接读源码，断言三层关键契约仍在，防止回退档 / 重构把它悄悄改坏。
 *
 * 锁定的契约：
 *  1. 默认沉浸式 —— `toolbarsVisible` 初始为 `false`（顶/底栏默认收起，不抢正文）。
 *  2. 纯阅读入口存在 —— `ReaderScreen` 提供 `onTogglePureReading` 并接到 `Md3BottomBar`。
 *  3. 纯阅读退出可发现 —— 有 `reader-immersive-handle` 把手，且 Esc 优先退出纯阅读。
 *  4. 沉浸 pill 文案存在 —— `Md3BottomBar` 的「沉浸」按钮带「纯阅读：隐藏所有控件」语义。
 *  5. 顶/底栏是 overlay —— 样式里 `.md3-topbar, .md3-bottombar` 为 `position: fixed`，
 *     不挤占正文文档流；正文 `.reading-content` 有顶部留白避开它们。
 */

const testDir = dirname(fileURLToPath(import.meta.url))
const webRoot = dirname(testDir)
const readerDir = join(webRoot, 'src', 'reader')
const readerScreenSrc = readFileSync(join(readerDir, 'ReaderScreen.tsx'), 'utf8')
const md3ChromeSrc = readFileSync(join(readerDir, 'Md3Chrome.tsx'), 'utf8')
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

test('P1-T3 纯阅读入口存在并接到底栏：onTogglePureReading', () => {
  assert.ok(
    readerScreenSrc.includes('onTogglePureReading'),
    'ReaderScreen 应提供/使用 onTogglePureReading（纯阅读切换入口）',
  )
  assert.ok(
    md3ChromeSrc.includes('onTogglePureReading'),
    'Md3BottomBar 应接收 onTogglePureReading 回调',
  )
  // 底栏的 onTogglePureReading 必须真的从 ReaderScreen 传下来，否则按钮点了没反应。
  assert.ok(
    /onTogglePureReading=\{togglePureReading\}/.test(readerScreenSrc),
    'ReaderScreen 应把 togglePureReading 接到 Md3BottomBar 的 onTogglePureReading',
  )
})

test('P1-T3 纯阅读退出可发现：有边缘把手且 Esc 优先退出', () => {
  // 常驻可见的退出把手：这是纯阅读里唯一常驻控件，必须存在且带可理解文案。
  assert.ok(
    readerScreenSrc.includes('reader-immersive-handle'),
    '纯阅读模式下应有 reader-immersive-handle 退出把手',
  )
  assert.ok(
    readerScreenSrc.includes('退出沉浸 · Esc') || readerScreenSrc.includes('退出纯阅读'),
    '退出把手应展示可发现的退出提示（「退出沉浸 · Esc」）',
  )
  // Esc 退出：快捷键处理函数里，纯阅读时 Esc（close 动作）优先 setPureReading(false)。
  assert.ok(
    /if \(pureReading\) \{ setPureReading\(false\); break \}/.test(readerScreenSrc),
    'Esc（close）应优先退出纯阅读，保证退出可发现、不会卡在纯阅读里',
  )
})

test('P1-T3 沉浸 pill 文案：Md3BottomBar 含「纯阅读」语义的沉浸按钮', () => {
  assert.ok(md3ChromeSrc.includes('沉浸'), 'Md3BottomBar 应渲染「沉浸」pill 文案')
  assert.ok(
    md3ChromeSrc.includes('纯阅读') && md3ChromeSrc.includes('隐藏所有控件'),
    '沉浸按钮的 aria-label 应说明它是「纯阅读：隐藏所有控件」',
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

/**
 * 纯阅读的**样式**必须存在。
 *
 * 这条判据补的是上面几条漏掉的一环：入口、把手、Esc 都在，但 `.pure-reading` /
 * `.reader-immersive-handle` 的样式一度完全缺失 —— 按了「沉浸」画面不变，
 * 用户 2026-10-27 直接反馈「纯阅读功能好像没有用」。只有 JSX 没有样式等于功能不存在。
 */
test('P1-T3 纯阅读真的收起控件：样式里定义了隐藏规则与退出把手', () => {
  const hide = stylesSrc.match(/\.reader-workspace\.pure-reading[^{]*\{[^}]*display:\s*none/s)
  assert.ok(hide !== null, 'styles.css 应定义 .reader-workspace.pure-reading 的 display:none 隐藏规则')
  assert.ok(/\.reader-workspace\.pure-reading \.md3-topbar/.test(stylesSrc), '纯阅读应隐藏 MD3 顶栏')
  assert.ok(/\.reader-workspace\.pure-reading \.md3-bottombar/.test(stylesSrc), '纯阅读应隐藏 MD3 底栏')
  assert.ok(/body\.reader-pure \.ai-fab/.test(stylesSrc), '纯阅读应隐藏全局 AI 悬浮球')
  const handle = ruleBlock(stylesSrc, '.reader-immersive-handle')
  assert.ok(handle !== null, '应定义退出把手 .reader-immersive-handle 的样式')
  assert.ok(/position:\s*fixed/.test(handle ?? ''), '退出把手应贴在视口边缘（position: fixed）')
})
