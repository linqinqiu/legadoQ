import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { GLOBAL_SHORTCUTS, PRIMARY_PAGES, READER_SHORTCUTS, SHORTCUT_TABLES, isTypingTarget, normalizeKey, shortcutFor } from '../src/reader/shortcuts'
import { PAGES } from '../src/app/pageMeta'
import { ShortcutHelp } from '../src/reader/ShortcutHelp'

/**
 * 快捷键这张表与真正生效的处理器不许各说一套（用户 2026-10-02：「加入一些快捷键快捷方式」）。
 *
 * 这类漂移不会有任何运行时报错：界面上写着 `T` 换主题，处理器里那个 case 早就被删了，
 * 于是这张"可查的按键表"变成一份谎言清单。所以这里双向都判：表里列的每条都要有人实现，
 * 处理器引用的每个动作都要在表里露出来。
 */
const readerSource = fs.readFileSync(new URL('../src/reader/ReaderScreen.tsx', import.meta.url), 'utf8')
const appSource = fs.readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')

/** 带修饰键的那几条不走表里的匹配（表只负责"给人看"），但它们对应的代码必须真的在。 */
const HANDLER_PROBES: Record<string, string> = {
  'nav-cycle': 'event.altKey',
  'font-wheel': 'ctrlKey',
}

/**
 * 「快捷键快速点击切换，容易崩溃」（用户 2026-10-23）。
 *
 * 事件回调里抛出的异常 ErrorBoundary 兜不住（它只管渲染期），一旦冒到 window.onerror，
 * 界面会停在已经执行过的 `setLoading(true)` 上 —— 表现就是"按了几下之后书打不开了"。
 * 所以键盘动作整段必须被收在一道 try/catch 里，并且出错时要把加载态交还。
 * 这条判据用静态读源码的方式钉住（与本文件其余判据同形），不需要起浏览器。
 */
test('阅读器的快捷键处理器兜得住异常，且出错时交还加载态', () => {
  const from = readerSource.indexOf('const onKeyDown = (event: KeyboardEvent)')
  const to = readerSource.indexOf("window.addEventListener('keydown', onKeyDown)")
  assert.ok(from >= 0 && to > from, '要能定位到 onKeyDown 这一段处理器（从定义到注册之间）')
  const handler = readerSource.slice(from, to)
  assert.match(handler, /try \{[\s\S]*switch \(hit\.action\)/, '快捷键动作必须整体包在 try 里')
  assert.match(handler, /catch \(/, 'catch 要在（异常只能落到 window.onerror 的那种默认路径不许有）')
  assert.match(handler, /setLoading\(false\)/, '出错必须把加载态清掉，不能把人留在"正在加载"')
  assert.match(handler, /setMessage\(/, '并且如实说一句，不静默吞掉')
})

test('表本身的形状：每条都有动作名、给人看的键名与一句说明', () => {
  for (const table of SHORTCUT_TABLES) {
    assert.ok(table.items.length > 0, `${table.title} 这一组不能是空的`)
    for (const item of table.items) {
      assert.ok(item.action, '动作名不能空')
      assert.ok(item.display.trim(), `${item.action} 没有给人看的键名`)
      assert.ok(item.label.trim().length > 4, `${item.action} 的说明太短，看不出按了会怎样`)
      assert.ok(item.group.trim(), `${item.action} 没分组`)
    }
  }
})

test('同一个作用域里两条抢同一个键 —— 后一条永远按不到，判红', () => {
  for (const table of SHORTCUT_TABLES) {
    const seen = new Map<string, string>()
    for (const item of table.items) {
      for (const key of item.keys) {
        assert.equal(seen.has(key), false, `${table.title}：键「${key}」被「${seen.get(key)}」和「${item.action}」同时占用`)
        seen.set(key, item.action)
      }
    }
  }
})

test('normalizeKey：空格与 Esc 归一，带 Ctrl/⌘/Alt 一律不当快捷键，Shift 放行（? 与 + 本来就要按）', () => {
  assert.equal(normalizeKey({ key: ' ' }), 'space')
  assert.equal(normalizeKey({ key: 'Escape' }), 'esc')
  assert.equal(normalizeKey({ key: 'ArrowRight' }), 'arrowright')
  assert.equal(normalizeKey({ key: 'T' }), 't')
  assert.equal(normalizeKey({ key: '?', shiftKey: true } as never), '?')
  assert.equal(normalizeKey({ key: 'f', ctrlKey: true }), '', 'Ctrl+F 归浏览器/我们自己的分支，不走这张表')
  assert.equal(normalizeKey({ key: 'ArrowLeft', altKey: true }), '')
  assert.equal(shortcutFor(READER_SHORTCUTS, ''), null, '空键名不该命中任何东西')
})

test('输入框里的按键归那段文字；按钮只让空格与回车归它自己', () => {
  const fake = (selector: string) => ({ closest: (want: string) => (want.includes(selector) ? { tag: selector } : null) })
  assert.equal(isTypingTarget(fake('input'), 't'), true, '搜索框里打 t 不许换主题')
  assert.equal(isTypingTarget(fake('textarea'), 'space'), true)
  assert.equal(isTypingTarget(fake('button'), 'space'), true, '焦点在按钮上时空格是"按下这个按钮"')
  assert.equal(isTypingTarget(fake('button'), 'enter'), true)
  // 反向对照：点过一次目录条目之后焦点留在按钮上，这时 T/D/S 必须仍然有效
  assert.equal(isTypingTarget(fake('button'), 't'), false, '按钮上按字母不许被当成"正在输入"（否则快捷键全哑）')
  assert.equal(isTypingTarget(null, 't'), false)
})

test('表里列出来的每一条都真的有人实现（按键表不许说谎）', () => {
  const checks: [string, typeof READER_SHORTCUTS][] = [[readerSource, READER_SHORTCUTS], [appSource, GLOBAL_SHORTCUTS]]
  for (const [source, table] of checks) {
    for (const item of table) {
      // 带键名的走表里的匹配；空键名的是"靠修饰键手写"的说明行，得按 HANDLER_PROBES 核对它真的在
      const byAction = item.page
        ? source.includes('hit.page')
        : item.keys.length
          ? source.includes(`case '${item.action}'`) || source.includes(`hit.action === '${item.action}'`)
          : source.includes(`hit.action === '${item.action}'`)
      const byProbe = HANDLER_PROBES[item.action] ? source.includes(HANDLER_PROBES[item.action]) : false
      assert.ok(byAction || byProbe, `表里写着「${item.display}」= ${item.label}，但源码里找不到实现`)
    }
  }
  // 修饰键那几条是手写的：探针本身也得在源码里找得到，否则探针会悄悄失效
  for (const [action, probe] of Object.entries(HANDLER_PROBES)) {
    assert.ok(readerSource.includes(probe) || appSource.includes(probe), `「${action}」说要靠 ${probe} 实现，源码里却没有`)
  }
})

test('处理器引用的动作必须都在表里（改了键忘了改表，这里就红）', () => {
  const readerActions = new Set(READER_SHORTCUTS.map(item => item.action))
  for (const match of readerSource.matchAll(/case '([a-z-]+)':/g)) {
    const action = match[1]
    if (['scroll', 'paginate'].includes(action)) continue
    assert.ok(readerActions.has(action), `ReaderScreen 里处理了「${action}」，可这张表里没有它`)
  }
  const globalActions = new Set(GLOBAL_SHORTCUTS.map(item => item.action))
  for (const match of appSource.matchAll(/hit\.action === '([a-z-]+)'/g)) {
    assert.ok(globalActions.has(match[1]), `main.tsx 里处理了「${match[1]}」，可这张表里没有它`)
  }
})

test('一级入口只有一张表：顶栏、数字键、Alt 循环都从 PRIMARY_PAGES 取', () => {
  // 改之前是三份表：顶栏手写一排 <button>、main.tsx 的 NAV 一份（顺序还和顶栏相反）、
  // 这张表又一份 —— 三份各自漏过不同的页面。归属判据见 shortcuts.ts 的表头注释。
  const header = fs.readFileSync(new URL('../src/components/AppHeader.tsx', import.meta.url), 'utf8')
  assert.match(header, /PRIMARY_PAGES\.map/, '顶栏不再渲染这张表，就是有人手写了一排按钮')
  assert.match(appSource, /const NAV: Page\[\] = PRIMARY_PAGES\.map/, 'Alt + ←/→ 的循环顺序必须与顶栏同一份来源')
  // 顶栏里不许再出现手写的入口按钮（品牌位点回书库是另一件事）
  const handWritten = (header.match(/onNavigate\('(shelf|sources|explore|subscriptions|rules|backup|settings)'\)/g) ?? [])
  assert.deepEqual(handWritten, [], `顶栏里又出现手写的入口按钮：${handWritten.join(' / ')}`)
  // 数字键必须连续覆盖这张表（1..N，不缺号、不多写）
  const digitLabels = GLOBAL_SHORTCUTS.filter(item => item.action === 'navigate').map(item => item.display)
  assert.deepEqual(digitLabels, PRIMARY_PAGES.map((_, index) => String(index + 1)),
    '数字键与一级页面的条数不一致 —— 加了一页就得能按到它')
  // 表里的每一页都得在页面元数据表里（拼错一个字母就是点了没反应）
  for (const item of PRIMARY_PAGES) {
    assert.ok(PAGES.some(page => page.key === item.page), `PRIMARY_PAGES 里的「${item.page}」不在 PAGES 里`)
  }
})

test('「快捷键」那张表把每一条都渲染出来，一条都不落', () => {
  const html = renderToStaticMarkup(React.createElement(ShortcutHelp, { onClose: () => undefined }))
  for (const table of SHORTCUT_TABLES) {
    assert.ok(html.includes(table.title), `界面上看不到「${table.title}」这一组`)
    for (const item of table.items) {
      assert.ok(html.includes(item.display), `界面上没有「${item.display}」这一行`)
      assert.ok(html.includes(item.label), `界面上没有「${item.label}」这句说明`)
    }
  }
  // 判据本身要有牙：渲染出来的行数必须等于表里的条数，少渲染一条就红（而不是"看着都在"）
  const total = SHORTCUT_TABLES.reduce((sum, table) => sum + table.items.length, 0)
  assert.equal((html.match(/<kbd>/g) ?? []).length, total, '界面上渲染的键位数与表里的条数不等')
})
